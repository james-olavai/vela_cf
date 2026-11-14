import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onCallGenkit } from 'firebase-functions/https';
import { genkit, z } from 'genkit';
import { vertexAI } from '@genkit-ai/google-genai';
import Stripe from 'stripe';
import {
  ChatRequestSchema,
  computeEffectiveBudget,
  computeTokenCostMicroUsd,
  CreateSessionRequestSchema,
  MAX_OUTPUT_TOKENS_BY_TIER,
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
const DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID || 'ai-studio-velacf-811abd0a-45c7-449f-a973-2e2998b2ac79';
const db = getFirestore(DATABASE_ID);
const auth = getAuth();

const REGION = 'asia-southeast1';
const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === 'true';

const ai = genkit({
  plugins: [vertexAI({ location: 'global' })],
});

const astrologyTools = createAstrologyTools(ai);

const TOOL_LABELS: Record<string, string> = {
  natalWheel: '已排盘：西洋本命盘',
  transitEvents: '已排盘：行运时间线',
  baziPillars: '已排盘：八字四柱',
  ziweiPalaces: '已排盘：紫微斗数',
  synastryAspects: '已排盘：合盘相位',
};

const FALLBACK_CITIES = [
  { displayName: '多伦多，安大略省，加拿大', latitude: 43.6532, longitude: -79.3832, timezone: 'America/Toronto', keys: ['toronto', '多伦多'] },
  { displayName: '台北，台湾', latitude: 25.033, longitude: 121.5654, timezone: 'Asia/Taipei', keys: ['taipei', '台北', '臺北'] },
  { displayName: '上海，中国', latitude: 31.2304, longitude: 121.4737, timezone: 'Asia/Shanghai', keys: ['shanghai', '上海'] },
  { displayName: '北京，中国', latitude: 39.9042, longitude: 116.4074, timezone: 'Asia/Shanghai', keys: ['beijing', '北京'] },
  { displayName: '香港', latitude: 22.3193, longitude: 114.1694, timezone: 'Asia/Hong_Kong', keys: ['hong kong', '香港'] },
  { displayName: '新加坡', latitude: 1.3521, longitude: 103.8198, timezone: 'Asia/Singapore', keys: ['singapore', '新加坡'] },
  { displayName: '东京，日本', latitude: 35.6762, longitude: 139.6503, timezone: 'Asia/Tokyo', keys: ['tokyo', '东京', '東京'] },
  { displayName: '纽约，纽约州，美国', latitude: 40.7128, longitude: -74.006, timezone: 'America/New_York', keys: ['new york', '纽约'] },
  { displayName: '旧金山，加利福尼亚州，美国', latitude: 37.7749, longitude: -122.4194, timezone: 'America/Los_Angeles', keys: ['san francisco', '旧金山'] },
  { displayName: '洛杉矶，加利福尼亚州，美国', latitude: 34.0522, longitude: -118.2437, timezone: 'America/Los_Angeles', keys: ['los angeles', '洛杉矶'] },
  { displayName: '温哥华，不列颠哥伦比亚省，加拿大', latitude: 49.2827, longitude: -123.1207, timezone: 'America/Vancouver', keys: ['vancouver', '温哥华'] },
  { displayName: '伦敦，英国', latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London', keys: ['london', '伦敦'] },
  { displayName: '悉尼，澳大利亚', latitude: -33.8688, longitude: 151.2093, timezone: 'Australia/Sydney', keys: ['sydney', '悉尼'] },
];

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

type HttpsErrorCode = ConstructorParameters<typeof HttpsError>[0];

const GENKIT_STATUS_TO_HTTPS: Record<string, HttpsErrorCode> = {
  INVALID_ARGUMENT: 'invalid-argument',
  FAILED_PRECONDITION: 'failed-precondition',
  OUT_OF_RANGE: 'out-of-range',
  UNAUTHENTICATED: 'unauthenticated',
  PERMISSION_DENIED: 'permission-denied',
  NOT_FOUND: 'not-found',
  ALREADY_EXISTS: 'already-exists',
  ABORTED: 'aborted',
  RESOURCE_EXHAUSTED: 'resource-exhausted',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
  DEADLINE_EXCEEDED: 'deadline-exceeded',
  UNIMPLEMENTED: 'unimplemented',
};

function toHttpsError(err: unknown): HttpsError {
  if (err instanceof HttpsError) return err;
  if (err instanceof z.ZodError) {
    return new HttpsError('invalid-argument', err.issues[0]?.message || 'INVALID_REQUEST');
  }
  const maybe = err as { status?: string; code?: string; message?: string };
  const mappedCode = maybe?.status ? GENKIT_STATUS_TO_HTTPS[maybe.status] : undefined;
  if (mappedCode) {
    return new HttpsError(mappedCode, (maybe.message || maybe.status || 'REQUEST_FAILED').slice(0, 400));
  }
  if (typeof maybe?.code === 'string' && maybe.code.startsWith('auth/')) {
    return new HttpsError('failed-precondition', (maybe.message || maybe.code).slice(0, 300));
  }
  console.error('[vela-api] unhandled error:', err);
  const msg = err instanceof Error ? err.message : String(err);
  return new HttpsError('internal', msg.slice(0, 400) || 'INTERNAL_ERROR');
}

const chatFlow = ai.defineFlow(
  {
    name: 'velaChatFlow',
    inputSchema: z.object({
      sessionId: z.string().min(1).max(128),
      message: z.string().trim().min(1).max(2000),
    }),
    outputSchema: z.object({
      text: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
    streamSchema: z.object({
      type: z.enum(['text', 'tool', 'chart', 'done']),
      text: z.string().optional(),
      toolName: z.string().optional(),
      label: z.string().optional(),
      chart: z.any().optional(),
      suggestions: z.array(z.string()).optional(),
    }),
  },
  async (rawInput, { sendChunk, context }) => {
    try {
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
      const preBonus = isNewPeriod ? 0 : Number(preData?.bonusMicroUsd ?? 0);
      if (preUsed >= computeEffectiveBudget(tier, preBonus)) {
        throw new HttpsError('resource-exhausted', 'QUOTA_EXCEEDED');
      }

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
          return txt ? `${msg.role === 'user' ? '用户' : '顾问'}: ${txt}` : '';
        })
        .filter(Boolean)
        .join('\n');

      const userCreatedAt = new Date().toISOString();
      const allowedToolNames: AstrologyToolName[] = Array.isArray(session.frozenTools)
        ? (session.frozenTools as AstrologyToolName[])
        : ['natalWheel'];
      const tools = allowedToolNames.map((name) => astrologyTools[name]).filter(Boolean);

      let fullText = '';
      const toolParts: Array<{ type: 'tool-call'; toolName: string; label: string }> = [];
      const seenTools = new Set<string>();
      const chartSnapshot: Record<string, unknown> = {};

      const entityLabel = (et?: string) =>
        et === 'company' ? '公司' : et === 'country' ? '国家' : '个人';
      const profileContext = profiles
        .map(
          (p, idx) =>
            `档案${profiles.length > 1 ? idx + 1 : ''}：类型=${entityLabel(p.entityType)}，称呼=${p.name}，出生/成立时间=${p.birthDateTime}，地点=${p.locationName}（纬度 ${p.latitude}，经度 ${p.longitude}，时区 ${p.timezone}），性别=${p.gender ?? 'unset'}。`,
        )
        .join('\n');

      const modelName = String(session.frozenModel || 'vertexai/gemini-4-hydrogen');
      const isGemini4 = modelName.includes('gemini-4-');
      const { stream, response } = ai.generateStream({
        model: modelName,
        system:
          `${session.frozenPrompt}\n` +
          '在回复正文最后，请另起一行输出 `SUGGESTIONS:` 后跟 2 个简短追问（用 `|` 分隔），例如 `SUGGESTIONS:天顶在水瓶意味着什么？|土星六宫该如何减负？`。\n\n' +
          profileContext,
        prompt: `${historyContext ? `${historyContext}\n` : ''}用户最新消息: ${input.message}`,
        tools,
        maxTurns: 3,
        config: {
          ...(isGemini4 ? {} : { temperature: 0.6 }),
          maxOutputTokens: MAX_OUTPUT_TOKENS_BY_TIER[tier],
        },
      });

    for await (const chunk of stream) {
      if (chunk.toolRequests.length > 0) {
        for (const req of chunk.toolRequests) {
          const toolName = req.toolRequest.name;
          if (!seenTools.has(toolName)) {
            seenTools.add(toolName);
            const label = TOOL_LABELS[toolName] ?? `已排盘：${toolName}`;
            toolParts.push({ type: 'tool-call', toolName, label });
            sendChunk({ type: 'tool', toolName, label });
          }
        }
      }

      for (const part of chunk.content) {
        const tr = (part as { toolResponse?: { name?: string; output?: unknown } }).toolResponse;
        if (tr?.name && tr.output !== undefined) {
          if (tr.name === 'natalWheel' && !chartSnapshot.natal) {
            chartSnapshot.natal = tr.output;
          } else if (tr.name === 'transitEvents') {
            chartSnapshot.transits = tr.output;
          } else if (tr.name === 'baziPillars') {
            chartSnapshot.bazi = tr.output;
          } else if (tr.name === 'ziweiPalaces') {
            chartSnapshot.ziwei = tr.output;
          }
          if (chartSnapshot.natal) {
            sendChunk({ type: 'chart', chart: { ...chartSnapshot } });
          }
        }
      }

      if (chunk.role === 'model' && chunk.text) {
        fullText += chunk.text;
        sendChunk({ type: 'text', text: chunk.text });
      }
    }

    const finalResp = await response;
    if (!fullText && finalResp.text) {
      fullText = finalResp.text;
    }

    if (!chartSnapshot.natal) {
      try {
        const primary = profiles[0];
        chartSnapshot.natal = natalWheel({
          birthDateTime: String(primary.birthDateTime),
          latitude: Number(primary.latitude),
          longitude: Number(primary.longitude),
          timezone: String(primary.timezone),
        });
        sendChunk({ type: 'chart', chart: { ...chartSnapshot } });
      } catch {
        // ignore chart preview fallback errors
      }
    }

    const sugMatch = fullText.match(/\n?SUGGESTIONS:\s*(.+)$/s);
    const suggestions = sugMatch
      ? sugMatch[1]
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];
    const cleanText = fullText.replace(/\n?SUGGESTIONS:\s*.+$/s, '').trim();

    const usageMeta = finalResp.usage;
    const inTokens = Number(usageMeta?.inputTokens ?? 0);
    const outTokens = Number(usageMeta?.outputTokens ?? 0) + Number(usageMeta?.thoughtsTokens ?? 0);
    const costMicroUsd =
      inTokens > 0 || outTokens > 0 ? computeTokenCostMicroUsd(inTokens, outTokens) : 30_000;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      const data = snap.data();
      const reset = !data || String(data.periodStart) < periodStart;
      const baseUsed = reset ? 0 : Number(data?.used ?? 0);
      const nextPayload: Record<string, unknown> = {
        periodStart,
        used: baseUsed + costMicroUsd,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (reset) {
        nextPayload.bonusMicroUsd = 0;
        nextPayload.shareCount = 0;
        nextPayload.lastShareDate = '';
      }
      tx.set(usageRef, nextPayload, { merge: true });
    });

    const assistantParts = [
      ...toolParts,
      ...(cleanText ? [{ type: 'text', text: cleanText }] : []),
    ];
    await sessionRef.collection('messages').add({
      role: 'user',
      parts: [{ type: 'text', text: input.message }],
      createdAt: userCreatedAt,
    });
    await sessionRef.collection('messages').add({
      role: 'assistant',
      parts: assistantParts,
      suggestions,
      createdAt: new Date().toISOString(),
    });
    await sessionRef.update({ updatedAt: new Date().toISOString() });

    sendChunk({ type: 'done', suggestions });
    return { text: cleanText, suggestions };
    } catch (err) {
      throw toHttpsError(err);
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
    try {
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
      const sessionDoc = {
        mode: input.mode,
        profileIds: input.profileIds,
        profileId: input.profileIds[0],
        profileName: names,
        title: input.mode === 'synastry' ? `合盘 · ${names}` : names,
        frozenPrompt: preset.systemPrompt,
        frozenModel: preset.modelName,
        frozenTools: preset.allowedTools,
        createdAt: now,
        updatedAt: now,
      };

      await sessionRef.set(sessionDoc);

      return { sessionId: sessionRef.id, session: { id: sessionRef.id, ...sessionDoc } };
    } catch (err) {
      throw toHttpsError(err);
    }
  },
);

export const previewNatalWheel = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (req) => {
    try {
      const input = NatalWheelInputSchema.parse(req.data);
      return { natal: natalWheel(input) };
    } catch (err) {
      throw toHttpsError(err);
    }
  },
);

export const resolveLocation = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (req) => {
    try {
      const { query } = ResolveLocationRequestSchema.parse(req.data);
    const cacheKey = query.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '_').slice(0, 100);
    const cacheRef = db.collection('locations_cache').doc(cacheKey);
    try {
      const cached = await cacheRef.get();
      if (cached.exists && Array.isArray(cached.data()?.results)) {
        return { results: cached.data()!.results };
      }
    } catch {
      // ignore cache read failures
    }

    let results: Array<{
      displayName: string;
      latitude: number;
      longitude: number;
      timezone: string;
    }> = [];

    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=zh&format=json`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (resp.ok) {
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
        results = (json.results ?? []).map((item) => ({
          displayName: [item.name, item.admin1, item.country].filter(Boolean).join('，'),
          latitude: Number(item.latitude.toFixed(4)),
          longitude: Number(item.longitude.toFixed(4)),
          timezone: item.timezone || 'UTC',
        }));
      }
    } catch {
      // fallback below
    }

    if (results.length === 0) {
      const lower = query.toLowerCase();
      results = FALLBACK_CITIES.filter(
        (c) =>
          c.displayName.toLowerCase().includes(lower) ||
          c.keys.some((k) => k.includes(lower) || lower.includes(k)),
      ).map(({ displayName, latitude, longitude, timezone }) => ({
        displayName,
        latitude,
        longitude,
        timezone,
      }));
    }

    if (results.length > 0) {
      await cacheRef.set({ results, createdAt: new Date().toISOString() }).catch(() => undefined);
    }
      return { results };
    } catch (err) {
      throw toHttpsError(err);
    }
  },
);

export const exportUserData = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (req) => {
    try {
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
    } catch (err) {
      throw toHttpsError(err);
    }
  },
);

export const deleteAccount = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK },
  async (req) => {
    try {
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
    } catch (err) {
      throw toHttpsError(err);
    }
  },
);
