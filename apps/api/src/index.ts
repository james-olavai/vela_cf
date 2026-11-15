import { generateReading } from './generate-reading.js';
import { defaultBundle } from './prompt-bundle.js';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onCallGenkit } from 'firebase-functions/https';
import { genkit, z } from 'genkit';
import { enableFirebaseTelemetry } from '@genkit-ai/firebase';
import { vertexAI } from '@genkit-ai/google-genai';
import {
  ChatRequestSchema,
  computeTokenCostMicroUsd,
  extractVelaUiBlocks,
  MAX_OUTPUT_TOKENS_BY_TIER,
  ResolveLocationRequestSchema,
  type AstrologyToolName,
} from '@vela-cf/shared';
import { NatalWheelInputSchema, natalWheel, type NatalWheelResult } from '@vela-cf/astrology';
import { deleteAccountWithRetry, exportAccountData } from './account.js';
import { buildNatalFactSummary, filterHallucinatedUiBlocks, verifyKeySignClaims } from './guard.js';
import {
  claimShareBonus,
  releaseQuota,
  reserveQuota,
  resolveUserPeriodAndTier,
  settleQuota,
  type ShareMethod,
} from './quota.js';
import {
  acquireSessionTurn,
  commitSessionTurn,
  createFrozenSession,
  releaseSessionTurn,
} from './session.js';
import { routeTurnCapabilities } from './skills.js';
import { createAstrologyTools } from './tools.js';

initializeApp();
enableFirebaseTelemetry();
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
  loadSkillReference: '已加载技法 Reference',
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
    console.error('[vela-api] upstream failure', { status: maybe.status, message: (maybe.message || '').slice(0, 400) });
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
      editLastTurn: z.boolean().optional(),
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
    const turnId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    let uid: string | undefined;
    let sessionId: string | undefined;
    let sessionLockAcquired = false;
    let quotaReserved = false;

    try {
      const input = ChatRequestSchema.parse(rawInput);
      uid = context?.auth?.uid;
      sessionId = input.sessionId;
      if (!uid) {
        throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
      }

      const { session, historyContext, replacedMessageIds } = await acquireSessionTurn(db, {
        uid,
        sessionId: input.sessionId,
        turnId,
        editLastTurn: input.editLastTurn,
      });
      sessionLockAcquired = true;

      const profileIds: string[] =
        Array.isArray(session.profileIds) && session.profileIds.length > 0
          ? (session.profileIds as string[])
          : [String(session.profileId)];

      const profileSnaps = await Promise.all(
        profileIds.map((pid) =>
          db.collection('users').doc(uid!).collection('profiles').doc(pid).get(),
        ),
      );
      const profiles = profileSnaps
        .filter((s) => s.exists && s.data())
        .map((s) => s.data()!);
      if (profiles.length === 0) {
        throw new HttpsError('not-found', 'PROFILE_NOT_FOUND');
      }

      const { tier, periodStart, unlimited } = await resolveUserPeriodAndTier(
        db,
        uid,
        context?.auth?.token?.stripeRole,
      );
      await reserveQuota(db, {
        uid,
        tier,
        periodStart,
        unlimited,
        requestId: turnId,
      });
      quotaReserved = true;

      const userCreatedAt = new Date().toISOString();
      const frozen = await db.collection('users').doc(uid).collection('sessions').doc(input.sessionId).collection('private').doc('prompt').get();
      const bundle = { ...defaultBundle(tier), ...(frozen.data()?.bundle as object || {}),
        systemPrompt: String(session.frozenPrompt || defaultBundle(tier).systemPrompt),
        modelName: String(session.frozenModel || defaultBundle(tier).modelName),
        allowedTools: Array.isArray(session.frozenTools) ? session.frozenTools : ['natalWheel'],
      };
      const generated = await generateReading(ai, { bundle, tier, profiles, message: input.message,
        historyContext, mode: String(session.mode), depth: input.depth }, sendChunk);
      const { text: cleanText, uiBlocks, suggestions, toolParts } = generated;
      sendChunk({type:'chart',chart:generated.chart});
      const usageMeta = generated.usage;
      const inTokens = Number(usageMeta?.inputTokens ?? 0);
      const outTokens = Number(usageMeta?.outputTokens ?? 0) + Number(usageMeta?.thoughtsTokens ?? 0);
      const costMicroUsd =
        inTokens > 0 || outTokens > 0 ? computeTokenCostMicroUsd(inTokens, outTokens) : 30_000;

      const assistantParts = [
        ...toolParts,
        ...(cleanText ? [{ type: 'text', text: cleanText }] : []),
        ...uiBlocks,
      ];

      await commitSessionTurn(db, {
        uid,
        sessionId: input.sessionId,
        turnId,
        replacedMessageIds,
        userMessage: {
          text: input.message,
          createdAt: userCreatedAt,
        },
        assistantMessage: {
          parts: assistantParts,
          suggestions,
          createdAt: new Date().toISOString(),
        },
      });
      sessionLockAcquired = false;

      await settleQuota(db, {
        uid,
        periodStart,
        requestId: turnId,
        costMicroUsd,
      });
      quotaReserved = false;

      sendChunk({ type: 'done', suggestions });
      return { text: cleanText, suggestions, uiBlocks };
    } catch (err) {
      if (uid && quotaReserved) {
        await releaseQuota(db, { uid, requestId: turnId }).catch(() => undefined);
      }
      if (uid && sessionId && sessionLockAcquired) {
        await releaseSessionTurn(db, { uid, sessionId, turnId }).catch(() => undefined);
      }
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
      const { tier } = await resolveUserPeriodAndTier(db, uid, req.auth?.token?.stripeRole);
      return await createFrozenSession(db, { uid, tier, rawData: req.data });
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

      const payload = req.data as { action?: string; shareMethod?: ShareMethod; clientDate?: string } | undefined;
      if (payload?.action === 'claimShareBonus') {
        const usage = await claimShareBonus(db, {
          uid,
          shareMethod: payload.shareMethod,
          clientDate: payload.clientDate,
        });
        return { usage };
      }

      return await exportAccountData(db, uid);
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
      return await deleteAccountWithRetry({ db, auth, uid });
    } catch (err) {
      throw toHttpsError(err);
    }
  },
);
