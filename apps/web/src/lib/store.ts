import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  ProfileInputSchema,
  QUOTA_BUDGET_MICRO_USD,
  utcMonthPeriodStart,
  type AstrologyToolName,
  type ConsultationMode,
  type LocationCandidate,
  type MessagePart,
  type MessageRecord,
  type ProfileInput,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
  type UsageRecord,
  type UserRecord,
} from '@vela-cf/shared';
import { auth, db, functions, handleFirestoreError, OperationType } from './firebase';

export interface ChartPlanet {
  key: string;
  nameZh: string;
  longitude: number;
  retrograde: boolean;
  signZh: string;
  formatted: string;
  house: number;
}

export interface ChartSnapshot {
  natal: {
    houseSystem: string;
    ascendant: { longitude: number; house: number; signZh: string; formatted: string };
    midheaven: { longitude: number; house: number; signZh: string; formatted: string };
    houses: Array<{ house: number; longitude: number; signZh: string; formatted: string }>;
    planets: ChartPlanet[];
    aspects: Array<{ pointA: string; pointB: string; aspect: string; orb: number }>;
  };
  transits?: {
    windowMonths: number;
    events: Array<{
      date: string;
      transitPlanet: string;
      aspect: string;
      natalPoint: string;
      orb: number;
    }>;
  } | null;
  bazi?: {
    trueSolarTime: string;
    dayMaster: string;
    pillars: Array<{ name: string; ganZhi: string; tenGod: string }>;
  } | null;
  ziwei?: {
    fiveElementsClass: string;
    soulStar: string;
    bodyStar: string;
    palaces: Array<{ name: string; earthlyBranch: string; majorStars: Array<{ name: string }> }>;
  } | null;
}

const chartKey = (uid: string, profileId: string) => `vela_chart_v1_${uid}_${profileId}`;

export function loadCachedChart(uid: string, profileId: string): ChartSnapshot | null {
  try {
    const raw = localStorage.getItem(chartKey(uid, profileId));
    return raw ? (JSON.parse(raw) as ChartSnapshot) : null;
  } catch {
    return null;
  }
}

export function saveCachedChart(uid: string, profileId: string, chart: ChartSnapshot): void {
  localStorage.setItem(chartKey(uid, profileId), JSON.stringify(chart));
}

export async function ensureUserRecord(
  uid: string,
  email: string,
  displayName: string,
): Promise<UserRecord> {
  const path = `users/${uid}`;
  const ref = doc(db, 'users', uid);
  try {
    const snap = await getDoc(ref);
    const now = new Date().toISOString();
    if (snap.exists()) {
      return snap.data() as UserRecord;
    }
    const payload: UserRecord = {
      email,
      displayName: displayName || email.split('@')[0] || '用户',
      acceptedTermsAt: now,
      confirmedAdultAt: now,
      createdAt: now,
    };
    await setDoc(ref, payload);
    return payload;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

const E2E_PROFILES_KEY = 'vela_e2e_profiles_v1';
const E2E_PROFILES_EVENT = 'vela-e2e-profiles-updated';

function readE2eProfiles(): ProfileRecord[] {
  try {
    const raw = localStorage.getItem(E2E_PROFILES_KEY);
    return raw ? (JSON.parse(raw) as ProfileRecord[]) : [];
  } catch {
    return [];
  }
}

function writeE2eProfiles(list: ProfileRecord[]): void {
  localStorage.setItem(E2E_PROFILES_KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(E2E_PROFILES_EVENT));
}

export function subscribeProfiles(
  uid: string,
  onData: (profiles: ProfileRecord[]) => void,
): () => void {
  if (import.meta.env.DEV && uid === 'e2e_test_user') {
    const emit = () => onData(readE2eProfiles());
    emit();
    window.addEventListener(E2E_PROFILES_EVENT, emit);
    return () => window.removeEventListener(E2E_PROFILES_EVENT, emit);
  }
  const path = `users/${uid}/profiles`;
  return onSnapshot(
    collection(db, 'users', uid, 'profiles'),
    (snap) => {
      const list: ProfileRecord[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<ProfileRecord, 'id'>),
      }));
      list.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
      onData(list);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, path),
  );
}

export function subscribeSessions(
  uid: string,
  onData: (sessions: SessionRecord[]) => void,
): () => void {
  const path = `users/${uid}/sessions`;
  return onSnapshot(
    collection(db, 'users', uid, 'sessions'),
    (snap) => {
      const list: SessionRecord[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<SessionRecord, 'id'>),
      }));
      list.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      onData(list);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, path),
  );
}

export function subscribeMessages(
  uid: string,
  sessionId: string,
  onData: (messages: MessageRecord[]) => void,
): () => void {
  if (import.meta.env.DEV && uid === 'e2e_test_user') {
    return () => {};
  }
  const path = `users/${uid}/sessions/${sessionId}/messages`;
  const q = query(
    collection(db, 'users', uid, 'sessions', sessionId, 'messages'),
    orderBy('createdAt', 'asc'),
  );
  return onSnapshot(
    q,
    (snap) => {
      const list: MessageRecord[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<MessageRecord, 'id'>),
      }));
      onData(list);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, path),
  );
}

export function subscribeUsage(
  uid: string,
  onData: (usage: UsageRecord) => void,
): () => void {
  const path = `usage/${uid}`;
  return onSnapshot(
    doc(db, 'usage', uid),
    (snap) => {
      const currentStart = utcMonthPeriodStart();
      if (!snap.exists()) {
        onData({ periodStart: currentStart, used: 0 });
        return;
      }
      const raw = snap.data() as { periodStart?: string; used?: number };
      const periodStart = String(raw.periodStart ?? currentStart);
      if (periodStart < currentStart) {
        onData({ periodStart: currentStart, used: 0 });
        return;
      }
      onData({ periodStart, used: Number(raw.used ?? 0) });
    },
    (err) => handleFirestoreError(err, OperationType.GET, path),
  );
}

export async function saveProfile(
  uid: string,
  profileId: string | null,
  rawInput: ProfileInput,
): Promise<string> {
  const validated = ProfileInputSchema.parse(rawInput);
  const now = new Date().toISOString();
  const payload = {
    name: validated.name,
    entityType: validated.entityType,
    birthDateTime: validated.birthDateTime,
    locationName: validated.locationName,
    latitude: validated.latitude,
    longitude: validated.longitude,
    timezone: validated.timezone,
    gender: validated.gender,
    consentedOther: Boolean(validated.consentedOther),
    updatedAt: now,
  };

  if (import.meta.env.DEV && uid === 'e2e_test_user') {
    const list = readE2eProfiles();
    const id = profileId ?? `e2e_p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const nextRecord: ProfileRecord = {
      id,
      ...payload,
      createdAt: profileId ? list.find((p) => p.id === profileId)?.createdAt ?? now : now,
    };
    const nextList = profileId
      ? list.map((p) => (p.id === profileId ? nextRecord : p))
      : [...list, nextRecord];
    writeE2eProfiles(nextList);
    return id;
  }

  if (profileId) {
    const path = `users/${uid}/profiles/${profileId}`;
    try {
      await updateDoc(doc(db, 'users', uid, 'profiles', profileId), payload);
      return profileId;
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  } else {
    const path = `users/${uid}/profiles`;
    try {
      const created = await addDoc(collection(db, 'users', uid, 'profiles'), {
        ...payload,
        createdAt: now,
      });
      return created.id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  }
}

export async function removeProfile(uid: string, profileId: string): Promise<void> {
  if (import.meta.env.DEV && uid === 'e2e_test_user') {
    writeE2eProfiles(readE2eProfiles().filter((p) => p.id !== profileId));
    return;
  }
  const path = `users/${uid}/profiles/${profileId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'profiles', profileId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function searchLocations(queryText: string): Promise<LocationCandidate[]> {
  const q = queryText.trim();
  if (!q) return [];
  try {
    const fn = httpsCallable<{ query: string }, { results?: LocationCandidate[] }>(
      functions,
      'resolveLocation',
    );
    const res = await fn({ query: q });
    return res.data?.results ?? [];
  } catch {
    const resp = await fetch(`/api/locations?q=${encodeURIComponent(q)}`);
    if (!resp.ok) throw new Error('城市搜索服务暂时不可用');
    const data = (await resp.json()) as { results?: LocationCandidate[] };
    return data.results ?? [];
  }
}

export async function fetchNatalChart(
  uid: string | null,
  profile: ProfileRecord,
): Promise<ChartSnapshot> {
  let natal: ChartSnapshot['natal'] | null = null;
  try {
    const fn = httpsCallable<
      { birthDateTime: string; latitude: number; longitude: number; timezone: string },
      { natal: ChartSnapshot['natal'] }
    >(functions, 'previewNatalWheel');
    const res = await fn({
      birthDateTime: profile.birthDateTime,
      latitude: profile.latitude,
      longitude: profile.longitude,
      timezone: profile.timezone,
    });
    natal = res.data.natal;
  } catch {
    const resp = await fetch('/api/astrology', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    if (!resp.ok) throw new Error('排盘计算失败');
    const data = (await resp.json()) as { natal: ChartSnapshot['natal'] };
    natal = data.natal;
  }
  const prev = uid ? loadCachedChart(uid, profile.id) : null;
  const next: ChartSnapshot = { ...prev, natal };
  if (uid) {
    saveCachedChart(uid, profile.id, next);
  }
  return next;
}

export async function createConsultationSession(
  mode: ConsultationMode,
  profiles: ProfileRecord[],
): Promise<SessionRecord> {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('e2e') === '1') {
    const now = new Date().toISOString();
    const names = profiles.map((p) => p.name).join(' × ');
    return {
      id: `e2e_s_${Date.now().toString(36)}`,
      mode,
      profileIds: profiles.map((p) => p.id),
      profileId: profiles[0].id,
      profileName: names,
      title: profiles.length >= 2 ? `合盘 · ${names}` : names,
      frozenPrompt: 'e2e',
      frozenModel: 'vertexai/gemini-4-hydrogen',
      frozenTools: ['natalWheel', 'transitEvents', 'baziPillars', 'ziweiPalaces', 'synastryAspects'],
      createdAt: now,
      updatedAt: now,
    };
  }
  const fn = httpsCallable<
    { mode: ConsultationMode; profileIds: string[] },
    { sessionId: string; session: SessionRecord }
  >(functions, 'createSession');
  const res = await fn({
    mode,
    profileIds: profiles.map((p) => p.id),
  });
  return res.data.session;
}

type ChatStreamChunk =
  | { type: 'tool'; toolName?: string; label?: string }
  | { type: 'chart'; chart?: ChartSnapshot }
  | { type: 'text'; text?: string }
  | { type: 'done'; suggestions?: string[] };

export async function streamConsultationReply(params: {
  uid: string;
  tier: Tier;
  usage: UsageRecord;
  session: SessionRecord;
  profiles: ProfileRecord[];
  existingMessages: MessageRecord[];
  userText: string;
  signal: AbortSignal;
  onUpdateMessages: (msgs: MessageRecord[]) => void;
  onUpdateChart: (chart: ChartSnapshot) => void;
  onQuotaExceeded: () => void;
}): Promise<void> {
  const {
    uid,
    tier,
    usage,
    session,
    profiles,
    existingMessages,
    userText,
    signal,
    onUpdateMessages,
    onUpdateChart,
    onQuotaExceeded,
  } = params;
  const primaryProfile = profiles[0];

  if (usage.used >= QUOTA_BUDGET_MICRO_USD[tier]) {
    onQuotaExceeded();
    return;
  }

  const userMsg: MessageRecord = {
    id: `m_${Date.now()}_u`,
    role: 'user',
    parts: [{ type: 'text', text: userText }],
    createdAt: new Date().toISOString(),
  };
  const assistantId = `m_${Date.now()}_a`;
  const assistantMsg: MessageRecord = {
    id: assistantId,
    role: 'assistant',
    parts: [],
    createdAt: new Date().toISOString(),
  };

  let currentMsgs = [...existingMessages, userMsg, assistantMsg];
  onUpdateMessages(currentMsgs);

  let fullText = '';
  const toolParts: MessagePart[] = [];

  const updateAssistant = (suggestions?: string[]) => {
    const cleanText = fullText.replace(/\n?SUGGESTIONS:\s*.+$/s, '').trim();
    const parts: MessagePart[] = [...toolParts];
    if (cleanText) {
      parts.push({ type: 'text', text: cleanText });
    }
    currentMsgs = currentMsgs.map((m) =>
      m.id === assistantId ? { ...m, parts, suggestions } : m,
    );
    onUpdateMessages(currentMsgs);
  };

  try {
    if (import.meta.env.DEV && uid === 'e2e_test_user') {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          tier,
          mode: session.mode,
          profiles,
          message: userText,
          history: existingMessages.map((m) => ({
            role: m.role,
            text: m.parts
              .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
              .map((p) => p.text)
              .join('\n'),
          })),
        }),
      });
      if (!resp.ok || !resp.body) throw new Error('E2E chat request failed');
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let currentEvent = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            if (currentEvent === 'tool' && payload.toolName) {
              toolParts.push({
                type: 'tool-call',
                toolName: String(payload.toolName) as AstrologyToolName,
                label: String(payload.label ?? payload.toolName),
              });
              updateAssistant();
            } else if (currentEvent === 'chart') {
              onUpdateChart(payload as unknown as ChartSnapshot);
            } else if (currentEvent === 'delta' && payload.text) {
              fullText += String(payload.text);
              updateAssistant();
            } else if (currentEvent === 'done') {
              updateAssistant(Array.isArray(payload.suggestions) ? (payload.suggestions as string[]) : []);
            }
          }
        }
      }
      return;
    }

    const callable = httpsCallable<
      { sessionId: string; message: string },
      { text: string; suggestions?: string[] },
      ChatStreamChunk
    >(functions, 'chat');
    const { stream, data } = await callable.stream(
      { sessionId: session.id, message: userText },
      { signal },
    );

    for await (const chunk of stream) {
      if (chunk.type === 'tool' && chunk.toolName) {
        toolParts.push({
          type: 'tool-call',
          toolName: chunk.toolName as AstrologyToolName,
          label: chunk.label ?? chunk.toolName,
        });
        updateAssistant();
      } else if (chunk.type === 'chart' && chunk.chart) {
        if (primaryProfile) {
          saveCachedChart(uid, primaryProfile.id, chunk.chart);
        }
        onUpdateChart(chunk.chart);
      } else if (chunk.type === 'text' && chunk.text) {
        fullText += chunk.text;
        updateAssistant();
      } else if (chunk.type === 'done') {
        updateAssistant(chunk.suggestions ?? []);
      }
    }

    const finalRes = await data;
    if (!fullText && finalRes?.text) {
      fullText = finalRes.text;
      updateAssistant(finalRes.suggestions ?? []);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (err instanceof Error && err.message.includes('cancelled')) return;
    if (err instanceof Error && err.message.includes('QUOTA_EXCEEDED')) {
      onQuotaExceeded();
      return;
    }
    throw err;
  }
}

export async function exportUserDataJson(_uid: string): Promise<void> {
  const fn = httpsCallable<void, Record<string, unknown>>(functions, 'exportUserData');
  const res = await fn();
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vela-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function deleteUserAccount(_uid: string): Promise<void> {
  const fn = httpsCallable<void, { deleted: boolean }>(functions, 'deleteAccount');
  await fn();
  await auth.signOut().catch(() => undefined);
}

export async function createStripeCheckout(uid: string, tier: 'go' | 'pro'): Promise<string | null> {
  const priceId =
    tier === 'go'
      ? import.meta.env.VITE_STRIPE_PRICE_GO
      : import.meta.env.VITE_STRIPE_PRICE_PRO;

  if (!priceId) {
    return null;
  }

  const ref = await addDoc(collection(db, 'customers', uid, 'checkout_sessions'), {
    price: priceId,
    success_url: `${window.location.origin}/account?checkout=success`,
    cancel_url: `${window.location.origin}/account?checkout=cancel`,
  });

  return await new Promise<string | null>((resolve) => {
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.data();
      if (data?.url) {
        unsub();
        resolve(String(data.url));
      } else if (data?.error) {
        unsub();
        resolve(null);
      }
    });
    setTimeout(() => {
      unsub();
      resolve(null);
    }, 6000);
  });
}

export async function createStripePortal(): Promise<string | null> {
  try {
    const fn = httpsCallable<{ returnUrl: string }, { url?: string }>(
      functions,
      'ext-firestore-stripe-payments-createPortalLink',
    );
    const res = await fn({ returnUrl: window.location.href });
    return res.data?.url ?? null;
  } catch {
    return null;
  }
}
