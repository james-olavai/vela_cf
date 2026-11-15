import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  computeEffectiveBudget,
  extractVelaUiBlocks,
  summarizeQuestionTitle,
  type AnalysisDepth,
  type AstrologyToolName,
  type AstroUiBlock,
  type ConsultationMode,
  type MessagePart,
  type MessageRecord,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';
import { db, functions } from './firebase';
import { saveCachedChart, type ChartSnapshot } from './profileStore';

const e2eMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get('e2e') === '1';

export function subscribeSessions(
  uid: string,
  onData: (sessions: SessionRecord[]) => void,
  onError: (error: unknown) => void = console.error,
): () => void {
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
    onError,
  );
}

export function subscribeMessages(
  uid: string,
  sessionId: string,
  onData: (messages: MessageRecord[]) => void,
  onError: (error: unknown) => void = console.error,
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
    onError,
  );
}

export async function createConsultationSession(
  mode: ConsultationMode,
  profiles: ProfileRecord[],
  initialQuestion?: string,
): Promise<SessionRecord> {
  if (e2eMode) {
    const now = new Date().toISOString();
    const names = profiles.map((p) => p.name).join(' × ');
    const defaultTitle = mode === 'synastry' ? `合盘 · ${names}` : names;
    return {
      id: `e2e_s_${Date.now().toString(36)}`,
      mode,
      profileIds: profiles.map((p) => p.id),
      profileId: profiles[0].id,
      profileName: names,
      title: initialQuestion ? summarizeQuestionTitle(initialQuestion, defaultTitle) : defaultTitle,
      frozenPrompt: 'e2e',
      frozenModel: 'vertexai/gemini-4-hydrogen',
      frozenTools: ['natalWheel', 'transitEvents', 'baziPillars', 'ziweiPalaces', 'synastryAspects'],
      createdAt: now,
      updatedAt: now,
    };
  }
  const fn = httpsCallable<
    { mode: ConsultationMode; profileIds: string[]; initialQuestion?: string },
    { sessionId: string; session: SessionRecord }
  >(functions, 'createSession');
  const res = await fn({
    mode,
    profileIds: profiles.map((p) => p.id),
    ...(initialQuestion ? { initialQuestion } : {}),
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
  editLastTurn?: boolean;
  depth?: AnalysisDepth;
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
    editLastTurn,
    depth,
    signal,
    onUpdateMessages,
    onUpdateChart,
    onQuotaExceeded,
  } = params;
  const primaryProfile = profiles[0];
  signal.throwIfAborted();

  if (!usage.unlimited && usage.used >= computeEffectiveBudget(tier, usage.bonusMicroUsd ?? 0)) {
    onQuotaExceeded();
    return;
  }

  const lastUserIdx = editLastTurn
    ? existingMessages.map((m) => m.role).lastIndexOf('user')
    : -1;
  const baseMessages =
    editLastTurn && lastUserIdx >= 0 ? existingMessages.slice(0, lastUserIdx) : existingMessages;

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

  let currentMsgs = [...baseMessages, userMsg, assistantMsg];
  onUpdateMessages(currentMsgs);

  let fullText = '';
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  const toolParts: MessagePart[] = [];

  const updateAssistant = (suggestions?: string[], extraBlocks: AstroUiBlock[] = []) => {
    clearTimeout(updateTimer);
    updateTimer = undefined;
    const { cleanText, uiBlocks } = extractVelaUiBlocks(fullText);
    const parts: MessagePart[] = [...toolParts];
    if (cleanText) {
      parts.push({ type: 'text', text: cleanText });
    }
    for (const block of uiBlocks.length > 0 ? uiBlocks : extraBlocks) {
      parts.push(block);
    }
    currentMsgs = currentMsgs.map((m) =>
      m.id === assistantId ? { ...m, parts, suggestions } : m,
    );
    onUpdateMessages(currentMsgs);
  };

  const scheduleUpdate = () => { updateTimer ??= setTimeout(() => updateAssistant(), 50); };

  try {
    if (import.meta.env.DEV && uid === 'e2e_test_user') {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          tier,
          mode: session.mode,
          depth,
          profiles,
          message: userText,
          history: baseMessages.slice(-20).map((m) => ({
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
        if (done) { if (updateTimer) updateAssistant(); break; }
        signal.throwIfAborted();
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
              scheduleUpdate();
            } else if (currentEvent === 'error') {
              throw new Error(String(payload.message ?? '生成失败'));
            } else if (currentEvent === 'done') {
              updateAssistant(Array.isArray(payload.suggestions) ? (payload.suggestions as string[]) : []);
            }
          }
        }
      }
      return;
    }

    const callable = httpsCallable<
      { sessionId: string; message: string; editLastTurn?: boolean; depth?: AnalysisDepth },
      { text: string; suggestions?: string[]; uiBlocks?: AstroUiBlock[] },
      ChatStreamChunk
    >(functions, 'chat');
    const { stream, data } = await callable.stream(
      { sessionId: session.id, message: userText, ...(editLastTurn ? { editLastTurn: true } : {}), ...(depth ? { depth } : {}) },
      { signal },
    );

    for await (const chunk of stream) {
      signal.throwIfAborted();
      if (chunk.type === 'tool' && chunk.toolName) {
        toolParts.push({
          type: 'tool-call',
          toolName: chunk.toolName as AstrologyToolName,
          label: chunk.label ?? chunk.toolName,
        });
        updateAssistant();
      } else if (chunk.type === 'chart' && chunk.chart) {
        if (primaryProfile) {
          saveCachedChart(uid, primaryProfile, chunk.chart);
        }
        onUpdateChart(chunk.chart);
      } else if (chunk.type === 'text' && chunk.text) {
        fullText += chunk.text;
        scheduleUpdate();
      } else if (chunk.type === 'done') {
        updateAssistant(chunk.suggestions ?? []);
      }
    }

    const finalRes = await data;
    signal.throwIfAborted();
    if (finalRes?.text) fullText = finalRes.text;
    updateAssistant(finalRes?.suggestions ?? [], finalRes?.uiBlocks ?? []);
  } catch (err) {
    clearTimeout(updateTimer);
    const code = (err as { code?: string })?.code ?? '';
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError') || msg.includes('cancelled')) {
      if (fullText || toolParts.length) updateAssistant();
      else onUpdateMessages([...baseMessages, userMsg]);
      return;
    }
    if (code === 'functions/resource-exhausted' || msg.includes('QUOTA_EXCEEDED')) {
      onQuotaExceeded();
      return;
    }
    throw err;
  } finally {
    clearTimeout(updateTimer);
  }
}
