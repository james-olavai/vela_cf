import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onCallGenkit } from 'firebase-functions/https';
import { genkit, z } from 'genkit';
import { vertexAI } from '@genkit-ai/vertexai';
import Stripe from 'stripe';
import {
  ChatRequestSchema,
  computeTokenCostMicroUsd,
  CreateSessionRequestSchema,
  MAX_OUTPUT_TOKENS_BY_TIER,
  QUOTA_BUDGET_MICRO_USD,
  ResolveLocationRequestSchema,
  TIER_META,
  TierSchema,
  utcMonthPeriodStart,
  type AstrologyToolName,
  type Tier,
} from '@vela-cf/shared';
import { NatalWheelInputSchema, natalWheel } from '@vela-cf/astrology';
import { createAstrologyTools } from './tools.js';
import { getServerPreset } from './presets.js';

initializeApp();
const db = getFirestore();
const auth = getAuth();

const REGION = 'asia-southeast1';
const ENFORCE_APP_CHECK = process.env.FUNCTIONS_EMULATOR !== 'true';

const ai = genkit({
  plugins: [vertexAI({ location: REGION })],
});

const astrologyTools = createAstrologyTools(ai);

async function resolveUserPeriodAndTier(uid: string, tokenRole?: unknown): Promise<{
  tier: Tier;
  periodStart: string;
}> {
  const parsed = TierSchema.safeParse(tokenRole);
  let tier: Tier = parsed.success ? parsed.data : 'free';
  let periodStart = utcMonthPeriodStart();

  if (tier !== 'free') {
    const subs = await db
      .collection('customers')
      .doc(uid)
      .collection('subscriptions')
      .where('status', 'in', ['active', 'trialing'])
      .limit(1)
      .get();
    const doc = subs.docs[0]?.data();
    if (doc?.current_period_start) {
      periodStart =
        typeof doc.current_period_start === 'string'
          ? doc.current_period_start
          : new Date(doc.current_period_start.seconds * 1000).toISOString();
    }
  }
  return { tier, periodStart };
}

const chatFlow = ai.defineFlow(
  {
    name: 'velaChatFlow',
    inputSchema: z.object({
      sessionId: z.string().min(1).max(128),
      message: z.string().trim().min(1).max(2000),
    }),
    outputSchema: z.object({ text: z.string() }),
    streamSchema: z.object({
      type: z.enum(['text', 'tool']),
      text: z.string().optional(),
      toolName: z.string().optional(),
    }),
  },
  async (rawInput, { sendChunk, context }) => {
    const input = ChatRequestSchema.parse(rawInput);
    const uid = context?.auth?.uid;
    if (!uid) {
      throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    }

    const sessionRef = db.collection('users').doc(uid).collection('sessions').doc(input.sessionId);
    const sessionSnap = await sessionRef.get();
    const session = sessionSnap.data();
    if (!sessionSnap.exists || !session) {
      throw new HttpsError('not-found', 'SESSION_NOT_FOUND');
    }

    const profileIds: string[] =
      Array.isArray(session.profileIds) && session.profileIds.length > 0
        ? session.profileIds
        : [session.profileId];

    const profileSnaps = await Promise.all(
      profileIds.map((pid) =>
        db.collection('users').doc(uid).collection('profiles').doc(pid).get(),
      ),
    );
    const profiles = profileSnaps
      .filter((s) => s.exists && s.data())
      .map((s) => s.data()!);
    if (profiles.length === 0) {
      throw new HttpsError('not-found', 'PROFILE_NOT_FOUND');
    }

    const { tier, periodStart } = await resolveUserPeriodAndTier(uid, context.auth?.token?.stripeRole);
    const usageRef = db.collection('usage').doc(uid);

    const preSnap = await usageRef.get();
    const preData = preSnap.data();
    const isNewPeriod = !preData || String(preData.periodStart) < periodStart;
    const preUsed = isNewPeriod ? 0 : Number(preData?.used ?? 0);
    if (preUsed >= QUOTA_BUDGET_MICRO_USD[tier]) {
      throw new HttpsError('resource-exhausted', 'QUOTA_EXCEEDED');
    }

    await sessionRef.collection('messages').add({
      role: 'user',
      parts: [{ type: 'text', text: input.message }],
      createdAt: new Date().toISOString(),
    });

    const historySnap = await sessionRef
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limit(20)
      .get();

    const historyContext = historySnap.docs
      .map((d) => {
        const msg = d.data();
        const txt = Array.isArray(msg.parts)
          ? msg.parts
              .filter((p: { type?: string }) => p.type === 'text')
              .map((p: { text?: string }) => p.text ?? '')
              .join('\n')
          : '';
        return `${msg.role === 'user' ? '用户' : '顾问'}: ${txt}`;
      })
      .join('\n');

    const allowedToolNames: AstrologyToolName[] = Array.isArray(session.frozenTools)
      ? (session.frozenTools as AstrologyToolName[])
      : ['natalWheel'];
    const tools = allowedToolNames.map((name) => astrologyTools[name]).filter(Boolean);

    let fullText = '';

    try {
      const entityLabel = (et?: string) =>
        et === 'company' ? '公司' : et === 'country' ? '国家' : '个人';
      const profileContext = profiles
        .map(
          (p, idx) =>
            `档案${profiles.length > 1 ? idx + 1 : ''}：类型=${entityLabel(p.entityType)}，称呼=${p.name}，出生/成立时间=${p.birthDateTime}，地点=${p.locationName}（纬度 ${p.latitude}，经度 ${p.longitude}，时区 ${p.timezone}），性别=${p.gender ?? 'unset'}。`,
        )
        .join('\n');
      const { stream, response } = ai.generateStream({
        model: session.frozenModel || 'vertexai/gemini-4-hydrogen',
        system: `${session.frozenPrompt}\n\n${profileContext}`,
        prompt: `${historyContext}\n用户最新消息: ${input.message}`,
        tools,
        maxTurns: 3,
        config: {
          temperature: 0.6,
          maxOutputTokens: MAX_OUTPUT_TOKENS_BY_TIER[tier],
        },
      });

      for await (const chunk of stream) {
        if (chunk.text) {
          fullText += chunk.text;
          sendChunk({ type: 'text', text: chunk.text });
        }
      }

      const finalResp = await response;
      if (!fullText && finalResp.text) {
        fullText = finalResp.text;
      }

      const usageMeta = finalResp.usage;
      const inTokens = Number(usageMeta?.inputTokens ?? 0);
      const outTokens = Number(usageMeta?.outputTokens ?? 0) + Number(usageMeta?.thoughtsTokens ?? 0);
      const costMicroUsd =
        inTokens > 0 || outTokens > 0
          ? computeTokenCostMicroUsd(inTokens, outTokens)
          : 30_000;

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(usageRef);
        const data = snap.data();
        const reset = !data || String(data.periodStart) < periodStart;
        const baseUsed = reset ? 0 : Number(data?.used ?? 0);
        tx.set(usageRef, {
          periodStart,
          used: baseUsed + costMicroUsd,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      await sessionRef.collection('messages').add({
        role: 'assistant',
        parts: [{ type: 'text', text: fullText }],
        createdAt: new Date().toISOString(),
      });
      await sessionRef.update({ updatedAt: new Date().toISOString() });

      return { text: fullText };
    } catch (err) {
      throw err;
    }
  },
);

export const chat = onCallGenkit(
  {
    region: REGION,
    enforceAppCheck: ENFORCE_APP_CHECK,
    authPolicy: (authData) => Boolean(authData?.uid),
  },
  chatFlow,
);

export const createSession = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

    const input = CreateSessionRequestSchema.parse(req.data);
    const { tier } = await resolveUserPeriodAndTier(uid, req.auth?.token?.stripeRole);
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
    const now = new Date().toISOString();
    const sessionRef = db.collection('users').doc(uid).collection('sessions').doc();
    const names = profiles.map((p) => String(p.name)).join(' × ');
    const modeLabel = input.mode === 'synastry' ? '多人合盘' : '个人星盘';

    await sessionRef.set({
      mode: input.mode,
      profileIds: input.profileIds,
      profileId: input.profileIds[0],
      profileName: names,
      title: `${modeLabel} · ${names}`,
      frozenPrompt: preset.systemPrompt,
      frozenModel: preset.modelName,
      frozenTools: preset.allowedTools,
      createdAt: now,
      updatedAt: now,
    });

    return { sessionId: sessionRef.id };
  },
);

export const previewNatalWheel = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (req) => {
    const input = NatalWheelInputSchema.parse(req.data);
    return { natal: natalWheel(input) };
  },
);

export const resolveLocation = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (req) => {
    const { query } = ResolveLocationRequestSchema.parse(req.data);
    const cacheKey = query.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '_').slice(0, 100);
    const cacheRef = db.collection('locations_cache').doc(cacheKey);
    const cached = await cacheRef.get();
    if (cached.exists && Array.isArray(cached.data()?.results)) {
      return { results: cached.data()!.results };
    }

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=zh&format=json`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new HttpsError('unavailable', 'LOCATION_SERVICE_UNAVAILABLE');
    }
    const json = (await resp.json()) as {
      results?: Array<{
        name: string;
        admin1?: string;
        country?: string;
        latitude: number;
        longitude: number;
        timezone?: string;
      }>;
    };

    const results = (json.results ?? []).map((item) => ({
      displayName: [item.name, item.admin1, item.country].filter(Boolean).join('，'),
      latitude: Number(item.latitude.toFixed(4)),
      longitude: Number(item.longitude.toFixed(4)),
      timezone: item.timezone || 'UTC',
    }));

    await cacheRef.set({ results, createdAt: new Date().toISOString() });
    return { results };
  },
);

export const exportUserData = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

    const userDoc = await db.collection('users').doc(uid).get();
    const profilesSnap = await db.collection('users').doc(uid).collection('profiles').get();
    const sessionsSnap = await db.collection('users').doc(uid).collection('sessions').get();

    const sessions = await Promise.all(
      sessionsSnap.docs.map(async (s) => {
        const msgsSnap = await s.ref.collection('messages').orderBy('createdAt', 'asc').get();
        return {
          id: s.id,
          ...s.data(),
          messages: msgsSnap.docs.map((m) => ({ id: m.id, ...m.data() })),
        };
      }),
    );

    return {
      exportedAt: new Date().toISOString(),
      user: userDoc.data() ?? null,
      profiles: profilesSnap.docs.map((p) => ({ id: p.id, ...p.data() })),
      sessions,
    };
  },
);

export const deleteAccount = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      const stripe = new Stripe(stripeKey);
      const subsSnap = await db
        .collection('customers')
        .doc(uid)
        .collection('subscriptions')
        .where('status', 'in', ['active', 'trialing'])
        .get();
      for (const s of subsSnap.docs) {
        await stripe.subscriptions.cancel(s.id).catch(() => undefined);
      }
    }

    await db.recursiveDelete(db.collection('users').doc(uid));
    await db.collection('usage').doc(uid).delete().catch(() => undefined);
    await auth.deleteUser(uid);

    return { deleted: true };
  },
);
