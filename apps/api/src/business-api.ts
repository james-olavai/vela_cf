import { z } from 'zod';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { ProfileInputSchema, CreateSessionRequestSchema, TierSchema, TIER_META, computeEffectiveBudget } from '@vela-cf/shared';
import { createFrozenSession } from './session.js';
import { CountrySnapshotSchema } from './country-charts.js';
import { resolveUserPeriodAndTier } from './quota.js';
import { resolveProfileLocation } from './locations.js';

const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const DateText = z.string();
const Profile = ProfileInputSchema.strict();
const ProfileRecord = Profile.extend({ id: Id, createdAt: DateText, updatedAt: DateText, countryCode:z.string().regex(/^[A-Z]{2}$/).optional(),locationSource:z.enum(['builtin','external']).optional() });
const ProfilePatch = Profile.partial().extend({ entityType: Profile.shape.entityType.unwrap().optional(), gender: Profile.shape.gender.unwrap().optional() }).strict().refine(v => Object.keys(v).length > 0, 'EMPTY_PATCH');
const MePatch = z.object({ displayName: z.string().trim().max(64).optional(), acceptedTerms: z.literal(true).optional(), confirmedAdult: z.literal(true).optional() }).strict();
const Me = z.object({ uid: Id, email: z.string(), displayName: z.string(), acceptedTermsAt: DateText, confirmedAdultAt: DateText, createdAt: DateText });
const Session = z.object({ subjects: z.array(z.object({ref:Id,profileId:Id.optional(),profile:ProfileInputSchema.extend({countryCode:ProfileRecord.shape.countryCode,locationSource:ProfileRecord.shape.locationSource}),countryChart:CountrySnapshotSchema.optional()})).optional(), id: Id, mode: z.enum(['personal', 'synastry']), profileIds: z.array(Id), profileId: Id, profileName: z.string(), title: z.string(), createdAt: DateText, updatedAt: DateText });
const Message = z.object({ id: Id, role: z.enum(['user','assistant','tool']), parts: z.array(z.record(z.string(), z.unknown())), suggestions: z.array(z.string()).optional(), createdAt: DateText });
const PageQuery = z.object({ limit: z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/).transform(Number).optional(), cursor: Id.optional() }).strict();
const page = (item: z.ZodType) => z.object({ items: z.array(item), nextCursor: Id.nullable() });
const Usage = z.object({ tier: TierSchema, periodStart: DateText, unlimited: z.boolean(), used: z.number(), bonusMicroUsd: z.number(), shareCount: z.number(), lastShareDate: z.string(), budgetMicroUsd: z.number() });
const CreateSession = CreateSessionRequestSchema;
export const businessRoutes = [
  { method: 'GET', path: '/v1/me', operationId: 'getMe', response: Me, status: 200 },
  { method: 'PATCH', path: '/v1/me', operationId: 'updateMe', body: MePatch, response: Me, status: 200 },
  { method: 'GET', path: '/v1/profiles', operationId: 'listProfiles', query: PageQuery, response: page(ProfileRecord), status: 200 },
  { method: 'POST', path: '/v1/profiles', operationId: 'createProfile', body: Profile, response: ProfileRecord, status: 201 },
  { method: 'GET', path: '/v1/profiles/{id}', params: z.object({ id: Id }), operationId: 'getProfile', response: ProfileRecord, status: 200 },
  { method: 'PATCH', path: '/v1/profiles/{id}', params: z.object({ id: Id }), operationId: 'updateProfile', body: ProfilePatch, response: ProfileRecord, status: 200 },
  { method: 'DELETE', path: '/v1/profiles/{id}', params: z.object({ id: Id }), operationId: 'deleteProfile', response: z.object({ deleted: z.literal(true) }), status: 200 },
  { method: 'GET', path: '/v1/sessions', operationId: 'listSessions', query: PageQuery, response: page(Session), status: 200 },
  { method: 'POST', path: '/v1/sessions', operationId: 'createSession', body: CreateSession, response: Session, status: 201 },
  { method: 'GET', path: '/v1/sessions/{id}', params: z.object({ id: Id }), operationId: 'getSession', response: Session, status: 200 },
  { method: 'GET', path: '/v1/sessions/{id}/messages', params: z.object({ id: Id }), operationId: 'listMessages', query: PageQuery, response: page(Message), status: 200 },
  { method: 'GET', path: '/v1/me/usage', operationId: 'getUsage', response: Usage, status: 200 },
];
export interface BusinessRequest {
  method: string; path: string; query?: unknown; body?: unknown;
  // Only the HTTP adapter may populate this after verifying a Firebase ID token.
  auth?: { uid: string; token: Record<string, unknown> };
}
export async function dispatchBusinessApi(db: Firestore, request: BusinessRequest): Promise<{ status: number; body: unknown }> {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  const uid = Id.parse(request.auth.uid), token = request.auth.token;
  const segments = request.path.split('/');
  const route = businessRoutes.find(r => r.method === request.method && r.path.split('/').length === segments.length && r.path.split('/').every((s,i) => s === '{id}' || s === segments[i]));
  if (!route) throw new HttpsError('not-found', 'ROUTE_NOT_FOUND');
  const id = route.path.includes('{id}') ? Id.parse(segments[3]) : undefined;
  const input: any = route.body ? route.body.parse(request.body) : undefined;
  if (!route.body && request.body !== undefined && request.body !== null && Object.keys(request.body as object).length) throw new HttpsError('invalid-argument', 'UNEXPECTED_BODY');
  const query = route.query ? route.query.parse(request.query ?? {}) : z.object({}).strict().parse(request.query ?? {});
  const root = db.collection('users').doc(uid), now = new Date().toISOString();
  const get = async (ref: FirebaseFirestore.DocumentReference) => {
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'RESOURCE_NOT_FOUND');
    return { ...snap.data(), id: snap.id };
  };
  const list = async (collection: FirebaseFirestore.CollectionReference, chronological = false) => {
    // Stable document-ID order avoids missing records when update timestamps change.
    let q = (chronological ? collection.orderBy('createdAt').orderBy(FieldPath.documentId()) : collection.orderBy(FieldPath.documentId())).limit((query.limit ?? 20) + 1);
    if (query.cursor) {
      if (chronological) {
        const cursor = await collection.doc(query.cursor).get();
        if (!cursor.exists) throw new HttpsError('invalid-argument', 'INVALID_CURSOR');
        q = q.startAfter(cursor);
      } else q = q.startAfter(query.cursor);
    }
    const docs = (await q.get()).docs, hasMore = docs.length > (query.limit ?? 20);
    if (hasMore) docs.pop();
    return { items: docs.map(d => ({ ...d.data(), id: d.id })), nextCursor: hasMore ? docs.at(-1)!.id : null };
  };
  let result: unknown;
  switch (route.operationId) {
    case 'getMe': {
      const data = await get(root); result = { ...data, uid }; break;
    }
    case 'updateMe': {
      result = await db.runTransaction(async tx => {
        const snap = await tx.get(root), previous = snap.data();
        if (!snap.exists && (!input.acceptedTerms || !input.confirmedAdult)) throw new HttpsError('failed-precondition', 'CONSENT_REQUIRED');
        const data = { email: String(token.email ?? ''), displayName: input.displayName ?? previous?.displayName ?? String(token.name ?? ''), acceptedTermsAt: previous?.acceptedTermsAt || (input.acceptedTerms ? now : ''), confirmedAdultAt: previous?.confirmedAdultAt || (input.confirmedAdult ? now : ''), createdAt: previous?.createdAt || now };
        tx.set(root, data, { merge: true }); return { ...data, uid };
      }); break;
    }
    case 'listProfiles': result = await list(root.collection('profiles')); break;
    case 'createProfile': {
      const ref = root.collection('profiles').doc();
      const data = { ...await resolveProfileLocation(db,input), consentedOther: Boolean(input.consentedOther), createdAt: now, updatedAt: now };
      const guard = root.collection('private').doc('profile-limit');
      await db.runTransaction(async tx => {
        const lock = await tx.get(guard), usage = await tx.get(db.collection('usage').doc(uid));
        const override = TierSchema.safeParse(usage.data()?.overrideTier), claimed = TierSchema.safeParse(token.stripeRole);
        const tier = override.success ? override.data : claimed.success ? claimed.data : 'free';
        const limit = TIER_META[tier].maxProfiles;
        const existing = await tx.get(root.collection('profiles').limit(limit));
        if (existing.docs.length >= limit) throw new HttpsError('resource-exhausted', 'PROFILE_LIMIT_REACHED');
        tx.set(guard, { revision: Number(lock.data()?.revision ?? 0) + 1 });
        tx.create(ref, data);
      });
      result = { ...data, id: ref.id }; break;
    }
    case 'getProfile': result = await get(root.collection('profiles').doc(id!)); break;
    case 'updateProfile': {
      const ref = root.collection('profiles').doc(id!);
      result = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError('not-found', 'RESOURCE_NOT_FOUND');
        const data = ProfileRecord.parse({ ...await resolveProfileLocation(db,input,snap.data()), updatedAt: now, id });
        const { id: _, ...stored } = data; tx.set(ref, stored); return data;
      }); break;
    }
    case 'deleteProfile': {
      const guard = root.collection('private').doc('profile-limit');
      await db.runTransaction(async tx => {
        const lock = await tx.get(guard);
        tx.set(guard, { revision: Number(lock.data()?.revision ?? 0) + 1 });
        tx.delete(root.collection('profiles').doc(id!));
      });
      result = { deleted: true }; break;
    }
    case 'listSessions': result = await list(root.collection('sessions')); break;
    case 'createSession': {
      const { tier } = await resolveUserPeriodAndTier(db, uid, token.stripeRole);
      result = (await createFrozenSession(db, { uid, tier, rawData: input })).session; break;
    }
    case 'getSession': result = await get(root.collection('sessions').doc(id!)); break;
    case 'listMessages': {
      const ref = root.collection('sessions').doc(id!); await get(ref);
      result = await list(ref.collection('messages'), true); break;
    }
    case 'getUsage': {
      const effective = await resolveUserPeriodAndTier(db, uid, token.stripeRole);
      const data = (await db.collection('usage').doc(uid).get()).data() ?? {};
      const current = String(data.periodStart ?? '') >= effective.periodStart;
      const bonus = current ? Number(data.bonusMicroUsd ?? 0) : 0;
      result = { ...effective, used: current ? Number(data.used ?? 0) : 0, bonusMicroUsd: bonus, shareCount: current ? Number(data.shareCount ?? 0) : 0, lastShareDate: current ? String(data.lastShareDate ?? '') : '', budgetMicroUsd: computeEffectiveBudget(effective.tier, bonus) }; break;
    }
  }
  const publicSession = (session: any) => ({ ...session, ...(session.frozenSubjects ? {subjects:session.frozenSubjects} : {}) });
  if (route.operationId === 'listSessions') result = {...result as any, items:(result as any).items.map(publicSession)};
  if (route.operationId === 'getSession' || route.operationId === 'createSession') result = publicSession(result);
  // Strip internal fields (frozenPrompt, reservations, locks) at the public boundary.
  const response = route.response.safeParse(result);
  if (!response.success) throw new HttpsError('internal', 'INVALID_RESPONSE');
  return { status: route.status, body: response.data };
}
