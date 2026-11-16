import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { FieldPath, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { HttpsError } from 'firebase-functions/v2/https';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Scope = z.enum(['profiles:read','charts:compute','sessions:read','sessions:create','turns:write','usage:read']);
const Scopes = z.array(Scope).min(1).max(6).refine(values => new Set(values).size === values.length);
const ProfileIds = z.array(Id).min(1).max(100).refine(values => new Set(values).size === values.length);
const Create = z.object({name:z.string().trim().min(1).max(80),scopes:Scopes,expiresInDays:z.number().int().min(1).max(90).default(30),profileIds:ProfileIds.optional()}).strict();
const Metadata = z.object({id:Id,name:z.string(),prefix:z.string(),scopes:Scopes,profileIds:ProfileIds.optional(),createdAt:z.string(),expiresAt:z.string(),revokedAt:z.string().nullable(),lastUsedAt:z.string().nullable()});
const Page = z.object({limit:z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/).transform(Number).optional(),cursor:Id.optional()}).strict();
export const patRoutes = [
  {method:'GET',path:'/v1/me/api-token-capabilities',operationId:'getApiTokenCapabilities',response:z.object({canCreate:z.boolean(),canManage:z.boolean()}),status:200},
  {method:'POST',path:'/v1/me/api-tokens',operationId:'createApiToken',body:Create,response:Metadata.extend({secret:z.string()}),status:201},
  {method:'GET',path:'/v1/me/api-tokens',operationId:'listApiTokens',query:Page,response:z.object({items:z.array(Metadata),nextCursor:Id.nullable()}),status:200},
  {method:'DELETE',path:'/v1/me/api-tokens/{id}',operationId:'revokeApiToken',params:z.object({id:Id}),response:z.object({revoked:z.literal(true)}),status:200},
];
export const PAT_ROUTE_SCOPES: Record<string,string[]> = {
  'GET /v1/profiles':['profiles:read'],
  'GET /v1/profiles/{id}':['profiles:read'],
  'GET /v1/profiles/{id}/country-chart':['profiles:read'],
  'GET /v1/sessions':['sessions:read'],
  'POST /v1/sessions':['sessions:create','profiles:read'],
  'GET /v1/sessions/{id}':['sessions:read'],
  'GET /v1/sessions/{id}/messages':['sessions:read'],
  'GET /v1/sessions/{id}/turns/{turnId}':['sessions:read'],
  'POST /v1/sessions/{id}/turns':['turns:write','sessions:read'],
  'POST /v1/sessions/{id}/turns/{turnId}/cancel':['turns:write','sessions:read'],
  'POST /v1/charts/natal':['charts:compute','profiles:read'],
  'POST /v1/charts/transits':['charts:compute','profiles:read'],
  'GET /v1/me/usage':['usage:read'],
  'GET /v1/locations/catalog':[],
  'GET /v1/country-charts':[],
  'GET /v1/country-charts/{id}':[],
  'GET /v1/plans':[],
};
export interface PatConfig {
  mode:'disabled'|'internal'|'public'; environment:string; audience:string; allowedUids:string[]; requestsPerMinute:number;
}
export interface PatIdentity {
  uid:string; token:Record<string,unknown>; credentialKind:'pat'; credentialId:string;
  scopes:string[]; profileIds?:string[]; environment:string;
}
type Identity = {uid:string;token:Record<string,unknown>;credentialKind?:string};
type Request = {method:string;path:string;query?:unknown;body?:unknown};
type RecordData = z.infer<typeof Metadata> & {uid:string;environment:string;audience:string;secretHash:string;authValidAfter:string};
export function readPatConfig(env:Record<string,string|undefined> = process.env): PatConfig {
  const mode = env.PAT_MODE || 'disabled';
  if (!['disabled','internal','public'].includes(mode)) throw new Error('Invalid PAT_MODE');
  const environment = env.VELA_ENVIRONMENT || '', project = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || '';
  const audience = env.PAT_AUDIENCE || '', allowedUids = (env.PAT_ALLOWED_UIDS || '').split(',').map(v=>v.trim()).filter(Boolean);
  if (mode !== 'disabled') {
    const local = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/([a-z][a-z0-9-]{4,62})\/asia-southeast1\/businessApi$/.exec(audience);
    const emulator = environment === 'emulator' && env.FUNCTIONS_EMULATOR === 'true' && local?.[1] === project && !!project;
    const deployed = ['staging','production'].includes(environment) && /^[a-z][a-z0-9-]{4,62}$/.test(project) && audience === `https://asia-southeast1-${project}.cloudfunctions.net/businessApi`;
    if (!(emulator || deployed) || allowedUids.some(uid=>!Id.safeParse(uid).success) || (mode === 'internal' && !allowedUids.length)) throw new Error('Invalid PAT configuration');
  }
  return {mode:mode as PatConfig['mode'],environment,audience,allowedUids,requestsPerMinute:60};
}
function gate(config:PatConfig,uid:string) {
  if (config.mode === 'disabled' || (config.mode === 'internal' && !config.allowedUids.includes(uid))) throw new HttpsError('permission-denied','PAT_DISABLED');
}
const invalid = () => new HttpsError('unauthenticated','INVALID_PAT');
const digest = (raw:string) => createHash('sha256').update(raw).digest('hex');
function active(row:RecordData,config:PatConfig) {
  if (!row || row.revokedAt || !(Date.parse(row.expiresAt) > Date.now()) || row.environment !== config.environment || row.audience !== config.audience) throw invalid();
  gate(config,row.uid);
}
async function current(db:Firestore,auth:Auth,id:string,config:PatConfig): Promise<PatIdentity> {
  const row = (await db.doc(`apiTokens/${id}`).get()).data() as RecordData;
  active(row,config);
  const [user,account] = await Promise.all([auth.getUser(row.uid).catch(()=>{throw invalid();}),db.doc(`users/${row.uid}`).get()]);
  if (user.disabled || Date.parse(user.tokensValidAfterTime || '') > Date.parse(row.authValidAfter) || !account.exists) throw invalid();
  if (account.data()?.deletionState) throw new HttpsError('permission-denied','ACCOUNT_DELETING');
  return {uid:row.uid,credentialKind:'pat',credentialId:id,scopes:Scopes.parse(row.scopes),...(row.profileIds?{profileIds:ProfileIds.parse(row.profileIds)}:{}),environment:row.environment,token:{...user.customClaims,uid:row.uid,stripeRole:['go','pro'].includes(user.customClaims?.stripeRole)?user.customClaims!.stripeRole:'free'}};
}
export async function verifyPat(db:Firestore,auth:Auth,raw:string,config:PatConfig): Promise<PatIdentity> {
  const match = /^vela_pat_(staging|production|emulator)_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!match || match[1] !== config.environment) throw invalid();
  const row = (await db.doc(`apiTokens/${match[2]}`).get()).data();
  const expected = Buffer.from(typeof row?.secretHash === 'string' && /^[a-f0-9]{64}$/.test(row.secretHash)?row.secretHash:'0'.repeat(64),'hex');
  if (!timingSafeEqual(expected,Buffer.from(digest(raw),'hex')) || !row) throw invalid();
  return current(db,auth,match[2],config);
}
function metadata(row:RecordData) { return Metadata.parse(row); }
export async function dispatchPatApi(db:Firestore,auth:Auth,identity:Identity,input:Request,config:PatConfig): Promise<{status:number;body:any}> {
  if (identity.credentialKind !== 'firebase') throw new HttpsError('permission-denied','FIREBASE_AUTH_REQUIRED');
  if (!identity.uid) throw new HttpsError('unauthenticated','AUTH_REQUIRED');
  if (input.method === 'GET' && input.path === '/v1/me/api-token-capabilities') {
    const user = await auth.getUser(identity.uid).catch(()=>{throw new HttpsError('unauthenticated','INVALID_TOKEN');});
    if (user.disabled) throw new HttpsError('unauthenticated','INVALID_TOKEN');
    const account = await db.doc(`users/${identity.uid}`).get();
    const enabled = config.mode === 'public' || (config.mode === 'internal' && config.allowedUids.includes(identity.uid));
    const canCreate = enabled && account.exists && !account.data()?.deletionState;
    const existing = canCreate ? false : (await db.collection('apiTokens').where('uid','==',identity.uid).limit(1).get()).docs.length > 0;
    return {status:200,body:{canCreate,canManage:canCreate || existing}};
  }
  const match = /^\/v1\/me\/api-tokens(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(input.path);
  if (!match) throw new HttpsError('not-found','ROUTE_NOT_FOUND');
  const uid = identity.uid;
  if (input.method === 'GET' && !match[1]) {
    const page = Page.parse(input.query || {}),limit = page.limit || 20;
    let query = db.collection('apiTokens').where('uid','==',uid).orderBy(FieldPath.documentId()).limit(limit+1);
    if (page.cursor) query = query.startAfter(page.cursor);
    const docs = (await query.get()).docs;
    return {status:200,body:{items:docs.slice(0,limit).map(doc=>metadata(doc.data() as RecordData)),nextCursor:docs.length>limit?docs[limit-1].id:null}};
  }
  if (input.method === 'DELETE' && match[1]) {
    const ref = db.doc(`apiTokens/${match[1]}`);
    await db.runTransaction(async tx=>{
      const row = (await tx.get(ref)).data();
      if (!row || row.uid !== uid) throw new HttpsError('not-found','TOKEN_NOT_FOUND');
      if (!row.revokedAt) tx.update(ref,{revokedAt:new Date().toISOString()});
    });
    return {status:200,body:{revoked:true}};
  }
  if (input.method !== 'POST' || match[1]) throw new HttpsError('not-found','ROUTE_NOT_FOUND');
  gate(config,uid);
  const age = Date.now()/1000-Number(identity.token.auth_time);
  if (!Number.isFinite(age) || age<0 || age>300) throw new HttpsError('permission-denied','RECENT_AUTH_REQUIRED');
  const body = Create.parse(input.body),user = await auth.getUser(uid);
  if (user.disabled) throw new HttpsError('unauthenticated','INVALID_TOKEN');
  const id = randomBytes(12).toString('hex'),secret = `vela_pat_${config.environment}_${id}_${randomBytes(32).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  const row:RecordData = {id,uid,name:body.name,prefix:`vela_pat_${config.environment}_${id}`,scopes:body.scopes,...(body.profileIds?{profileIds:body.profileIds}:{}),createdAt,expiresAt:new Date(Date.now()+body.expiresInDays*86400000).toISOString(),revokedAt:null,lastUsedAt:null,environment:config.environment,audience:config.audience,secretHash:digest(secret),authValidAfter:user.tokensValidAfterTime || new Date(0).toISOString()};
  const guard = db.doc(`users/${uid}/private/api-token-limit`);
  await db.runTransaction(async tx=>{
    const account = await tx.get(db.doc(`users/${uid}`)),guardData = (await tx.get(guard)).data();
    if (!account.exists || account.data()?.deletionState) throw new HttpsError('permission-denied','ACCOUNT_DELETING');
    const ids:string[] = guardData?.ids || [];
    const snapshots = await Promise.all(ids.map(tokenId=>tx.get(db.doc(`apiTokens/${tokenId}`))));
    const valid = snapshots.filter(s=>s.exists && !s.data()!.revokedAt && Date.parse(s.data()!.expiresAt)>Date.now()).map(s=>s.id);
    if (valid.length>=5) throw new HttpsError('resource-exhausted','PAT_LIMIT_REACHED');
    for (const profileId of body.profileIds || []) if (!(await tx.get(db.doc(`users/${uid}/profiles/${profileId}`))).exists) throw new HttpsError('permission-denied','PAT_PROFILE_SCOPE_DENIED');
    tx.create(db.doc(`apiTokens/${id}`),row);
    tx.set(guard,{ids:[...valid,id]});
  });
  return {status:201,body:{...metadata(row),secret}};
}
function subjectsAllowed(subjects:any[],allowed:string[],frozen:boolean) {
  if (!Array.isArray(subjects) || !subjects.length) return false;
  const valid = (subject:any) => typeof subject?.[frozen?'profileId':'profile_id'] === 'string' && allowed.includes(subject[frozen?'profileId':'profile_id']);
  return subjects.every(subject=>{
    if (valid(subject)) return true;
    const country = subject?.[frozen?'countryChart':'country_chart'];
    const source = country?.[frozen?'sourceRef':'source_ref'];
    return typeof source === 'string' && subjects.some(other=>other.ref === source && valid(other));
  });
}
async function checkProfiles(db:Firestore,identity:PatIdentity,input:Request) {
  const allowed = identity.profileIds;
  if (!allowed) return;
  const denied = () => new HttpsError('permission-denied','PAT_PROFILE_SCOPE_DENIED');
  const pieces = input.path.split('/');
  if (input.path === '/v1/profiles' || (input.path === '/v1/sessions' && input.method === 'GET')) throw denied();
  if (pieces[2] === 'profiles' && !allowed.includes(pieces[3])) throw denied();
  if (pieces[2] === 'sessions' && pieces[3]) {
    const session = (await db.doc(`users/${identity.uid}/sessions/${pieces[3]}`).get()).data();
    if (!session) throw new HttpsError('not-found','SESSION_NOT_FOUND');
    const subjects = session.frozenSubjects;
    const ids = session.profileIds || (session.profileId?[session.profileId]:[]);
    if (subjects !== undefined ? !subjectsAllowed(subjects,allowed,true) : !ids.length || ids.some((id:string)=>!allowed.includes(id))) throw denied();
  }
  if (input.method === 'POST' && (input.path === '/v1/sessions' || pieces[2] === 'charts')) {
    const body = input.body as any;
    const subjects = body?.subjects || body?.profileIds?.map((id:string)=>({profile_id:id}));
    if (!subjectsAllowed(subjects,allowed,false)) throw denied();
  }
}
export async function authorizePatRequest(db:Firestore,auth:Auth,principal:PatIdentity,input:Request,config:PatConfig,consumeRate=true): Promise<PatIdentity> {
  const identity = await current(db,auth,principal.credentialId,config);
  if (identity.uid !== principal.uid) throw invalid();
  const key = Object.keys(PAT_ROUTE_SCOPES).find(template=>{
    const [method,path] = template.split(' '),parts = path.split('/'),actual = input.path.split('/');
    return method === input.method && parts.length === actual.length && parts.every((p,i)=>p.startsWith('{')?Id.safeParse(actual[i]).success:p===actual[i]);
  });
  if (!key || PAT_ROUTE_SCOPES[key].some(scope=>!identity.scopes.includes(scope))) throw new HttpsError('permission-denied','PAT_SCOPE_DENIED');
  await checkProfiles(db,identity,input);
  if (consumeRate) {
    const ref = db.doc(`apiTokens/${identity.credentialId}`),minute = Math.floor(Date.now()/60000);
    const generation = input.method === 'POST' && /^\/v1\/sessions\/[^/]+\/turns$/.test(input.path);
    await db.runTransaction(async tx=>{
      const row = (await tx.get(ref)).data() as RecordData & {rateMinute?:number;requests?:number;generations?:number};
      active(row,config);
      const requests = row.rateMinute === minute ? row.requests || 0 : 0;
      const generations = row.rateMinute === minute ? row.generations || 0 : 0;
      if (requests>=config.requestsPerMinute || (generation && generations>=6)) throw new HttpsError('resource-exhausted','PAT_RATE_LIMITED');
      tx.update(ref,{rateMinute:minute,requests:requests+1,generations:generations+Number(generation),lastUsedAt:new Date().toISOString()});
    });
  }
  return identity;
}
// These reads join the message/quota transaction, so revocation conflicts retry and fail closed.
export async function assertPatTransaction(db:Firestore,tx:Transaction,identity:PatIdentity,config:PatConfig): Promise<void> {
  const [token,account] = await Promise.all([tx.get(db.doc(`apiTokens/${identity.credentialId}`)),tx.get(db.doc(`users/${identity.uid}`))]);
  const row = token.data() as RecordData;
  active(row,config);
  if (row.uid !== identity.uid || !account.exists) throw invalid();
  if (account.data()?.deletionState) throw new HttpsError('permission-denied','ACCOUNT_DELETING');
  if (identity.scopes.some(scope=>!Scopes.parse(row.scopes).includes(scope as z.infer<typeof Scope>))) throw new HttpsError('permission-denied','PAT_SCOPE_DENIED');
  if (JSON.stringify(row.profileIds || null) !== JSON.stringify(identity.profileIds || null)) throw new HttpsError('permission-denied','PAT_PROFILE_SCOPE_DENIED');
}
export async function deleteUserPats(db:Firestore,uid:string) {
  for (;;) {
    const docs = (await db.collection('apiTokens').where('uid','==',uid).limit(100).get()).docs;
    if (!docs.length) break;
    const batch = db.batch();docs.forEach(doc=>batch.delete(doc.ref));await batch.commit();
  }
  await db.doc(`users/${uid}/private/api-token-limit`).delete();
}
