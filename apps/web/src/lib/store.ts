import { deleteUser } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  DEFAULT_PRESETS_INFO,
} from './presetsInfo';
import {
  DEFAULT_PRODUCTS,
  ProfileInputSchema,
  QUOTA_LIMIT,
  utcMonthPeriodStart,
  type CatalogProduct,
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
import { auth, db, handleFirestoreError, OperationType } from './firebase';

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

const sessionsKey = (uid: string) => `vela_sessions_v1_${uid}`;
const messagesKey = (uid: string, sessionId: string) => `vela_messages_v1_${uid}_${sessionId}`;
const usageKey = (uid: string) => `vela_usage_v1_${uid}`;
const chartKey = (uid: string, profileId: string) => `vela_chart_v1_${uid}_${profileId}`;

export function loadLocalSessions(uid: string): SessionRecord[] {
  try {
    const raw = localStorage.getItem(sessionsKey(uid));
    if (!raw) return [];
    const list = JSON.parse(raw) as SessionRecord[];
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export function saveLocalSessions(uid: string, sessions: SessionRecord[]): void {
  localStorage.setItem(sessionsKey(uid), JSON.stringify(sessions));
}

export function loadLocalMessages(uid: string, sessionId: string): MessageRecord[] {
  try {
    const raw = localStorage.getItem(messagesKey(uid, sessionId));
    return raw ? (JSON.parse(raw) as MessageRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveLocalMessages(uid: string, sessionId: string, messages: MessageRecord[]): void {
  localStorage.setItem(messagesKey(uid, sessionId), JSON.stringify(messages));
}

export function loadLocalUsage(uid: string): UsageRecord {
  const periodStart = utcMonthPeriodStart();
  try {
    const raw = localStorage.getItem(usageKey(uid));
    if (!raw) return { periodStart, used: 0 };
    const parsed = JSON.parse(raw) as UsageRecord;
    if (parsed.periodStart < periodStart) {
      return { periodStart, used: 0 };
    }
    return parsed;
  } catch {
    return { periodStart, used: 0 };
  }
}

export function saveLocalUsage(uid: string, usage: UsageRecord): void {
  localStorage.setItem(usageKey(uid), JSON.stringify(usage));
}

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
      const data = snap.data() as UserRecord;
      return data;
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

export function subscribeProfiles(
  uid: string,
  onData: (profiles: ProfileRecord[]) => void,
): () => void {
  const path = `users/${uid}/profiles`;
  return onSnapshot(
    collection(db, 'users', uid, 'profiles'),
    (snap) => {
      const list: ProfileRecord[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<ProfileRecord, 'id'>),
      }));
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      onData(list);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, path),
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
    birthDateTime: validated.birthDateTime,
    locationName: validated.locationName,
    latitude: validated.latitude,
    longitude: validated.longitude,
    timezone: validated.timezone,
    gender: validated.gender,
    consentedOther: Boolean(validated.consentedOther),
    updatedAt: now,
  };

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
  const path = `users/${uid}/profiles/${profileId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'profiles', profileId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function fetchPublishedProducts(): Promise<CatalogProduct[]> {
  try {
    const snap = await getDocs(collection(db, 'products'));
    const fromDb = snap.docs
      .map((d) => {
        const data = d.data();
        const fallback = DEFAULT_PRODUCTS.find((p) => p.slug === d.id);
        return {
          slug: d.id,
          title: String(data.title ?? fallback?.title ?? d.id),
          description: String(data.description ?? fallback?.description ?? ''),
          minTier: (data.minTier as Tier) ?? fallback?.minTier ?? 'free',
          isPublished: Boolean(data.isPublished),
          sortOrder: Number(data.sortOrder ?? fallback?.sortOrder ?? 99),
          tools: fallback?.tools ?? ['natalWheel'],
          toolLabels: fallback?.toolLabels ?? ['西洋本命盘'],
          requiresGender: fallback?.requiresGender ?? false,
        } satisfies CatalogProduct;
      })
      .filter((p) => p.isPublished)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return fromDb.length > 0 ? fromDb : DEFAULT_PRODUCTS;
  } catch {
    return DEFAULT_PRODUCTS;
  }
}

export async function searchLocations(query: string): Promise<LocationCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const resp = await fetch(`/api/locations?q=${encodeURIComponent(q)}`);
  if (!resp.ok) throw new Error('城市搜索服务暂时不可用');
  const data = (await resp.json()) as { results?: LocationCandidate[] };
  return data.results ?? [];
}

export async function fetchNatalChart(
  uid: string,
  profile: ProfileRecord,
): Promise<ChartSnapshot> {
  const resp = await fetch('/api/astrology', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
  });
  if (!resp.ok) {
    throw new Error('排盘计算失败');
  }
  const data = (await resp.json()) as { natal: ChartSnapshot['natal'] };
  const prev = loadCachedChart(uid, profile.id);
  const next: ChartSnapshot = { ...prev, natal: data.natal };
  saveCachedChart(uid, profile.id, next);
  return next;
}

export function createConsultationSession(
  uid: string,
  product: CatalogProduct,
  profile: ProfileRecord,
): SessionRecord {
  const now = new Date().toISOString();
  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const preset = DEFAULT_PRESETS_INFO[product.slug] ?? DEFAULT_PRESETS_INFO['free-natal'];
  const session: SessionRecord = {
    id,
    productSlug: product.slug,
    productTitle: product.title,
    profileId: profile.id,
    profileName: profile.name,
    title: `${product.title} · ${profile.name}`,
    frozenPrompt: preset.summary,
    frozenModel: 'gemini-4-hydrogen',
    frozenTools: product.tools,
    createdAt: now,
    updatedAt: now,
  };
  const existing = loadLocalSessions(uid);
  saveLocalSessions(uid, [session, ...existing]);
  return session;
}

export async function streamConsultationReply(params: {
  uid: string;
  tier: Tier;
  session: SessionRecord;
  profile: ProfileRecord;
  userText: string;
  signal: AbortSignal;
  onUpdateMessages: (msgs: MessageRecord[]) => void;
  onUpdateChart: (chart: ChartSnapshot) => void;
  onUpdateUsage: (usage: UsageRecord) => void;
  onQuotaExceeded: () => void;
}): Promise<void> {
  const {
    uid,
    tier,
    session,
    profile,
    userText,
    signal,
    onUpdateMessages,
    onUpdateChart,
    onUpdateUsage,
    onQuotaExceeded,
  } = params;

  const usage = loadLocalUsage(uid);
  if (usage.used >= QUOTA_LIMIT[tier]) {
    onQuotaExceeded();
    return;
  }

  const prevMessages = loadLocalMessages(uid, session.id);
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

  let currentMsgs = [...prevMessages, userMsg, assistantMsg];
  saveLocalMessages(uid, session.id, currentMsgs);
  onUpdateMessages(currentMsgs);

  const nextUsage: UsageRecord = {
    periodStart: usage.periodStart,
    used: usage.used + 1,
  };
  saveLocalUsage(uid, nextUsage);
  onUpdateUsage(nextUsage);

  const history = prevMessages.map((m) => ({
    role: m.role,
    text: m.parts
      .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n'),
  }));

  let receivedAnyDelta = false;
  let fullText = '';
  const toolParts: MessagePart[] = [];

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productSlug: session.productSlug,
        profile,
        history,
        message: userText,
      }),
      signal,
    });

    if (!resp.ok || !resp.body) {
      throw new Error('对话服务请求失败');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const updateAssistant = (suggestions?: string[]) => {
      const cleanText = fullText.replace(/\n?SUGGESTIONS:\s*.+$/s, '').trim();
      const parts: MessagePart[] = [...toolParts];
      if (cleanText) {
        parts.push({ type: 'text', text: cleanText });
      }
      currentMsgs = currentMsgs.map((m) =>
        m.id === assistantId ? { ...m, parts, suggestions } : m,
      );
      saveLocalMessages(uid, session.id, currentMsgs);
      onUpdateMessages(currentMsgs);
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const lines = block.split('\n');
        let eventName = 'message';
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        const parsed = JSON.parse(dataLine) as Record<string, unknown>;

        if (eventName === 'tool') {
          toolParts.push({
            type: 'tool-call',
            toolName: parsed.toolName as SessionRecord['frozenTools'][number],
            label: String(parsed.label ?? ''),
          });
          updateAssistant();
        } else if (eventName === 'chart') {
          const chart = parsed as unknown as ChartSnapshot;
          saveCachedChart(uid, profile.id, chart);
          onUpdateChart(chart);
        } else if (eventName === 'delta') {
          receivedAnyDelta = true;
          fullText += String(parsed.text ?? '');
          updateAssistant();
        } else if (eventName === 'done') {
          const suggestions = Array.isArray(parsed.suggestions)
            ? (parsed.suggestions as string[])
            : [];
          updateAssistant(suggestions);
        } else if (eventName === 'error') {
          throw new Error(String(parsed.message ?? '生成失败'));
        }
      }
    }

    const sessions = loadLocalSessions(uid).map((s) =>
      s.id === session.id ? { ...s, updatedAt: new Date().toISOString() } : s,
    );
    saveLocalSessions(uid, sessions);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    if (!receivedAnyDelta) {
      const refunded: UsageRecord = {
        periodStart: nextUsage.periodStart,
        used: Math.max(0, nextUsage.used - 1),
      };
      saveLocalUsage(uid, refunded);
      onUpdateUsage(refunded);
    }
    throw err;
  }
}

export async function exportUserDataJson(uid: string): Promise<void> {
  const userSnap = await getDoc(doc(db, 'users', uid));
  const profilesSnap = await getDocs(collection(db, 'users', uid, 'profiles'));
  const sessions = loadLocalSessions(uid);
  const payload = {
    exportedAt: new Date().toISOString(),
    user: userSnap.data() ?? null,
    profiles: profilesSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    sessions: sessions.map((s) => ({
      ...s,
      messages: loadLocalMessages(uid, s.id),
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vela-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function deleteUserAccount(uid: string): Promise<void> {
  const profilesSnap = await getDocs(collection(db, 'users', uid, 'profiles'));
  for (const p of profilesSnap.docs) {
    await deleteDoc(doc(db, 'users', uid, 'profiles', p.id));
  }
  await deleteDoc(doc(db, 'users', uid)).catch(() => undefined);

  const sessions = loadLocalSessions(uid);
  for (const s of sessions) {
    localStorage.removeItem(messagesKey(uid, s.id));
  }
  localStorage.removeItem(sessionsKey(uid));
  localStorage.removeItem(usageKey(uid));

  if (auth.currentUser) {
    try {
      await deleteUser(auth.currentUser);
    } catch {
      await auth.signOut();
    }
  }
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
