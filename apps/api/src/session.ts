import { defaultBundle } from './prompt-bundle.js';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  CreateSessionRequestSchema,
  summarizeQuestionTitle,
  TIER_META,
  type Tier,
} from '@vela-cf/shared';
import { getServerPreset } from './presets.js';

export const DEFAULT_HISTORY_LIMIT = 20;
export const DEFAULT_SESSION_LOCK_TTL_MS = 120_000;

export function formatHistoryMessages(
  docs: Array<{ data: () => Record<string, unknown> | undefined }>,
): string {
  return docs
    .map((d) => {
      const msg = d.data() ?? {};
      const txt = Array.isArray(msg.parts)
        ? msg.parts
            .filter((p: { type?: string }) => p.type === 'text')
            .map((p: { text?: string }) => p.text ?? '')
            .join('\n')
        : '';
      return txt ? `${msg.role === 'user' ? '用户' : '顾问'}: ${txt}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export async function acquireSessionTurn(
  db: Firestore,
  params: {
    uid: string;
    sessionId: string;
    turnId: string;
    editLastTurn?: boolean;
    historyLimit?: number;
    now?: Date;
    lockTtlMs?: number;
  },
): Promise<{
  session: Record<string, unknown>;
  historyContext: string;
  replacedMessageIds: string[];
}> {
  const {
    uid,
    sessionId,
    turnId,
    editLastTurn = false,
    historyLimit = DEFAULT_HISTORY_LIMIT,
    now = new Date(),
    lockTtlMs = DEFAULT_SESSION_LOCK_TTL_MS,
  } = params;
  const nowMs = now.getTime();
  const sessionRef = db.collection('users').doc(uid).collection('sessions').doc(sessionId);

  const session = await db.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    const data = snap.data();
    if (!snap.exists || !data) {
      throw new HttpsError('not-found', 'SESSION_NOT_FOUND');
    }
    const activeTurnId = typeof data.activeTurnId === 'string' ? data.activeTurnId : '';
    const activeTurnExpiresAt = Number(data.activeTurnExpiresAt ?? 0);
    if (activeTurnId && activeTurnId !== turnId && activeTurnExpiresAt > nowMs) {
      throw new HttpsError('aborted', 'SESSION_BUSY');
    }
    tx.set(
      sessionRef,
      {
        activeTurnId: turnId,
        activeTurnExpiresAt: nowMs + lockTtlMs,
      },
      { merge: true },
    );
    return data as Record<string, unknown>;
  });

  // Fetch recent messages in descending order, then restore chronological order
  const fetchLimit = editLastTurn ? historyLimit + 6 : historyLimit;
  const recentSnap = await sessionRef
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(fetchLimit)
    .get();
  const chronologicalDocs = recentSnap.docs.slice().reverse();

  let replacedMessageIds: string[] = [];
  let contextDocs = chronologicalDocs;

  if (editLastTurn) {
    const lastUserIdx = chronologicalDocs.map((d) => d.data()?.role).lastIndexOf('user');
    if (lastUserIdx >= 0) {
      replacedMessageIds = chronologicalDocs.slice(lastUserIdx).map((d) => d.id);
      contextDocs = chronologicalDocs.slice(0, lastUserIdx);
    }
  }

  const boundedContextDocs = contextDocs.slice(-historyLimit);
  return {
    session,
    historyContext: formatHistoryMessages(boundedContextDocs),
    replacedMessageIds,
  };
}

export async function commitSessionTurn(
  db: Firestore,
  params: {
    uid: string;
    sessionId: string;
    turnId: string;
    replacedMessageIds: string[];
    userMessage: {
      text: string;
      createdAt: string;
    };
    assistantMessage: {
      parts: unknown[];
      suggestions?: string[];
      createdAt: string;
    };
  },
): Promise<{ userMessageId: string; assistantMessageId: string }> {
  const {
    uid,
    sessionId,
    turnId,
    replacedMessageIds,
    userMessage,
    assistantMessage,
  } = params;
  const sessionRef = db.collection('users').doc(uid).collection('sessions').doc(sessionId);
  const messagesCol = sessionRef.collection('messages');

  const userCreatedMs = Date.parse(userMessage.createdAt) || Date.now();
  const rawAssistantMs = Date.parse(assistantMessage.createdAt) || Date.now();
  const assistantCreatedAt = new Date(Math.max(rawAssistantMs, userCreatedMs + 1)).toISOString();
  const userCreatedAt = new Date(userCreatedMs).toISOString();

  return db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef);
    const sessionData = sessionSnap.data();
    if (!sessionSnap.exists || !sessionData) {
      throw new HttpsError('not-found', 'SESSION_NOT_FOUND');
    }
    if (sessionData.activeTurnId && sessionData.activeTurnId !== turnId) {
      throw new HttpsError('aborted', 'SESSION_TURN_SUPERSEDED');
    }

    for (const msgId of replacedMessageIds) {
      tx.delete(messagesCol.doc(msgId));
    }

    const userRef = messagesCol.doc();
    const assistantRef = messagesCol.doc();

    tx.set(userRef, {
      role: 'user',
      parts: [{ type: 'text', text: userMessage.text }],
      createdAt: userCreatedAt,
    });
    tx.set(assistantRef, {
      role: 'assistant',
      parts: assistantMessage.parts,
      suggestions: assistantMessage.suggestions ?? [],
      createdAt: assistantCreatedAt,
    });
    const currentTitle = String(sessionData.title ?? '').trim();
    const profileName = String(sessionData.profileName ?? '').trim();
    const isDefaultProfileTitle =
      !currentTitle || currentTitle === profileName || currentTitle === `合盘 · ${profileName}`;
    const nextTitle = isDefaultProfileTitle
      ? summarizeQuestionTitle(userMessage.text, currentTitle || profileName || '星盘咨询')
      : currentTitle;

    tx.set(
      sessionRef,
      {
        ...(isDefaultProfileTitle ? { title: nextTitle } : {}),
        updatedAt: assistantCreatedAt,
        activeTurnId: null,
        activeTurnExpiresAt: 0,
      },
      { merge: true },
    );

    return { userMessageId: userRef.id, assistantMessageId: assistantRef.id };
  });
}

export async function releaseSessionTurn(
  db: Firestore,
  params: {
    uid: string;
    sessionId: string;
    turnId: string;
  },
): Promise<void> {
  const { uid, sessionId, turnId } = params;
  const sessionRef = db.collection('users').doc(uid).collection('sessions').doc(sessionId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) return;
    if (snap.data()?.activeTurnId === turnId) {
      tx.set(
        sessionRef,
        {
          activeTurnId: null,
          activeTurnExpiresAt: 0,
        },
        { merge: true },
      );
    }
  });
}

export async function createFrozenSession(
  db: Firestore,
  params: {
    uid: string;
    tier: Tier;
    rawData: unknown;
    now?: Date;
  },
): Promise<{ sessionId: string; session: Record<string, unknown> }> {
  const { uid, tier, rawData, now = new Date() } = params;
  const input = CreateSessionRequestSchema.parse(rawData);
  const tierMeta = TIER_META[tier];

  if (input.mode === 'synastry') {
    if (tierMeta.maxSynastryProfiles < 2) {
      throw new HttpsError('permission-denied', 'SYNASTRY_REQUIRES_GO');
    }
    if (input.profileIds.length < 2 || input.profileIds.length > tierMeta.maxSynastryProfiles) {
      throw new HttpsError('invalid-argument', 'INVALID_SYNASTRY_PROFILE_COUNT');
    }
  } else if (input.profileIds.length !== 1) {
    throw new HttpsError('invalid-argument', 'PERSONAL_REQUIRES_ONE_PROFILE');
  }

  const profileSnaps = await Promise.all(
    input.profileIds.map((pid) =>
      db.collection('users').doc(uid).collection('profiles').doc(pid).get(),
    ),
  );
  const profiles = profileSnaps.map((s) => {
    const data = s.data();
    if (!s.exists || !data) {
      throw new HttpsError('not-found', 'PROFILE_NOT_FOUND');
    }
    return data;
  });

  if (!tierMeta.allowsEntityCharts && profiles.some((p) => p.entityType && p.entityType !== 'person')) {
    throw new HttpsError('permission-denied', 'ENTITY_CHART_REQUIRES_PRO');
  }

  const preset = await getServerPreset(tier, input.mode);
  const nowIso = now.toISOString();
  const sessionRef = db.collection('users').doc(uid).collection('sessions').doc();
  const names = profiles.map((p) => String(p.name)).join(' × ');
  const defaultTitle = input.mode === 'synastry' ? `合盘 · ${names}` : names;
  const sessionDoc = {
    mode: input.mode,
    profileIds: input.profileIds,
    profileId: input.profileIds[0],
    profileName: names,
    title: input.initialQuestion ? summarizeQuestionTitle(input.initialQuestion, defaultTitle) : defaultTitle,
    frozenPrompt: preset.systemPrompt,
    frozenModel: preset.modelName,
    frozenTools: preset.allowedTools,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await sessionRef.set(sessionDoc);
  await sessionRef.collection('private').doc('prompt').set({ bundle: { ...defaultBundle(tier), ...preset } });
  return { sessionId: sessionRef.id, session: { id: sessionRef.id, ...sessionDoc } };
}
