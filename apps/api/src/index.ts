import { dispatchTurnApi } from './turns.js';
import { createChatRunner } from './chat-service.js';
import { dispatchActionApi, actionRoutes, searchLocations } from './action-api.js';
import { resolveSubjects } from './subjects.js';
import { getAppCheck } from 'firebase-admin/app-check';
import { createHttpApi, verifyApiIdentity } from './http-api.js';
import { dispatchBusinessApi } from './business-api.js';
import { dispatchTuningApi } from './tuning-api.js';
import { generateReading } from './generate-reading.js';
import { defaultBundle } from './prompt-bundle.js';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
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

const runChat = createChatRunner(db, (input,emit)=>generateReading(ai,input,emit));

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
  (rawInput, {sendChunk, context}) => runChat(rawInput, context, sendChunk).catch(error=>{throw toHttpsError(error);}),
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
  {region:REGION,enforceAppCheck:ENFORCE_APP_CHECK},
  async req => {try {return await searchLocations(db,req.data);}catch(error){throw toHttpsError(error);}},
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

// HTTP migration entry; legacy Callable clients remain supported.
export const businessApi = onRequest({
  region: REGION, timeoutSeconds: 180,
  cors: [`https://${process.env.GCLOUD_PROJECT || 'yhvhchen-387212'}.web.app`, `https://${process.env.GCLOUD_PROJECT || 'yhvhchen-387212'}.firebaseapp.com`, ...(process.env.FUNCTIONS_EMULATOR === 'true' ? [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] : [])],
}, createHttpApi({
  verifyToken: token => verifyApiIdentity(auth, token),
  publicRoute: (method,path) => (method==='GET' && ['/v1/locations','/v1/plans'].includes(path)) || (method==='POST' && ['/v1/charts/natal','/v1/charts/transits'].includes(path)),
  stream: (body,identity,emit,signal) => runChat(body,{auth:identity,turnId:identity.turnId},emit,signal).catch(error=>{throw toHttpsError(error);}),
  ...(ENFORCE_APP_CHECK ? {verifyAppCheck: (token: string) => getAppCheck().verifyToken(token)} : {}),
  dispatch: input => /\/turns\//.test(input.path) ? dispatchTurnApi(db,input) : input.path.startsWith('/v1/tuning/') ? dispatchTuningApi(input) : actionRoutes.some(r=>r.method===input.method && r.path.split('/').length===input.path.split('/').length && r.path.split('/').every((s,i)=>s==='{id}' || s===input.path.split('/')[i])) ? dispatchActionApi(db, auth, input) : dispatchBusinessApi(db, input),
}));
