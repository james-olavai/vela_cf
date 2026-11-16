import { computePortraitSummary } from './portrait.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { HttpsError } from 'firebase-functions/v2/https';
import Stripe from 'stripe';
import { ResolveLocationRequestSchema, TIER_META, TierSchema, SubjectSchema, PortraitSummarySchema } from '@vela-cf/shared';
import { NatalWheelInputSchema, TransitSnapshotInputSchema, natalWheel, transitSnapshot } from '@vela-cf/astrology';
import { claimShareBonus } from './quota.js';
import { exportAccountData, deleteAccountWithRetry } from './account.js';
import { resolveSubjects, validateBirthTime } from './subjects.js';
import type { BusinessRequest } from './business-api.js';

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
const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const Json = z.record(z.string(), z.unknown());
const Plan = z.object({ id:TierSchema,label:z.string(),priceLabel:z.string(),monthlyBudgetMicroUsd:z.number().int().nonnegative(),maxProfiles:z.number().int().nonnegative(),maxSynastryProfiles:z.number().int().nonnegative(),allowsEntityCharts:z.boolean(),highlights:z.array(z.string()),analysisDepths:z.array(z.enum(['quick','balanced','deep'])) });
const Empty = z.object({}).strict();
const Location = z.object({ displayName:z.string(),latitude:z.number(),longitude:z.number(),timezone:z.string() });
const Checkout = z.object({ id:Id,status:z.enum(['pending','completed','failed']),url:z.string().url().optional(),error:z.string().optional() });
const ReturnUrl = z.string().url();
const SubjectChart = z.object({subjects:z.array(SubjectSchema).length(1)}).strict();
const NatalInput = z.union([NatalWheelInputSchema.strict(),SubjectChart]);
const TransitInput = z.union([TransitSnapshotInputSchema.strict(),SubjectChart.extend({atDateTime:TransitSnapshotInputSchema.shape.atDateTime,atTimezone:TransitSnapshotInputSchema.shape.atTimezone})]);
export const actionRoutes = [
  { method:'GET',path:'/v1/locations',operationId:'searchLocations',query:ResolveLocationRequestSchema.strict(),response:z.object({results:z.array(Location)}),status:200,public:true },
  { method:'POST',path:'/v1/charts/natal',operationId:'previewNatal',body:NatalInput,response:z.object({natal:Json,portrait:PortraitSummarySchema}),status:200,public:true },
  { method:'POST',path:'/v1/charts/transits',operationId:'previewTransits',body:TransitInput,response:z.object({transit:Json}),status:200,public:true },
  { method:'POST',path:'/v1/me/share-claims',operationId:'claimShare',body:z.object({shareMethod:z.enum(['native','poster','copy'])}).strict(),response:z.object({usage:Json}),status:200 },
  { method:'POST',path:'/v1/me/exports',operationId:'exportAccount',body:Empty,response:z.object({exportedAt:z.string(),user:Json.nullable(),profiles:z.array(Json),sessions:z.array(Json)}),status:200 },
  { method:'DELETE',path:'/v1/me',operationId:'deleteAccount',response:z.object({deleted:z.literal(true),canceledSubscriptionIds:z.array(z.string())}),status:200 },
  { method:'GET',path:'/v1/plans',operationId:'listPlans',response:z.object({items:z.array(Plan)}),status:200,public:true },
  { method:'GET',path:'/v1/me/subscription',operationId:'getSubscription',response:z.object({items:z.array(z.object({id:z.string(),status:z.string(),role:z.string().optional(),currentPeriodEnd:z.number().optional()}))}),status:200 },
  { method:'POST',path:'/v1/billing/checkout-sessions',operationId:'createCheckout',body:z.object({tier:z.enum(['go','pro']),successUrl:ReturnUrl,cancelUrl:ReturnUrl}).strict(),response:Checkout,status:201 },
  { method:'GET',path:'/v1/billing/checkout-sessions/{id}',operationId:'getCheckout',params:z.object({id:Id}),response:Checkout,status:200 },
  { method:'POST',path:'/v1/billing/portal-sessions',operationId:'createPortal',body:z.object({returnUrl:ReturnUrl}).strict(),response:z.object({url:ReturnUrl}),status:200 },
];
export async function searchLocations(db:Firestore, raw:unknown, request:typeof fetch=fetch) {
  const {query}=ResolveLocationRequestSchema.parse(raw), key=createHash('sha256').update(query.toLowerCase()).digest('hex');
  const ref=db.collection('locations_cache').doc(key);
  try { const cached=(await ref.get()).data(); if(cached?.results) return {results:z.array(Location).parse(cached.results)}; } catch { /* Cache is optional. */ }
  let results:z.infer<typeof Location>[]=[];
  try {
    const response=await request(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=zh&format=json`,{signal:AbortSignal.timeout(4000)});
    if(response.ok) {
      const data=await response.json() as {results?:Array<{name:string;admin1?:string;country?:string;latitude:number;longitude:number;timezone?:string}>};
      results=(data.results||[]).map(v=>({displayName:[v.name,v.admin1,v.country].filter(Boolean).join('，'),latitude:Number(v.latitude.toFixed(4)),longitude:Number(v.longitude.toFixed(4)),timezone:v.timezone||'UTC'}));
      results=z.array(Location).parse(results);
    }
  } catch { /* Known cities remain available when geocoding is unavailable. */ }
  if(!results.length) { const q=query.toLowerCase(); results=FALLBACK_CITIES.filter(c=>c.displayName.toLowerCase().includes(q)||c.keys.some(k=>k.includes(q)||q.includes(k))).map(({keys,...city})=>city); }
  if(results.length) await ref.set({results,createdAt:new Date().toISOString()}).catch(()=>undefined);
  return {results};
}
export function validateReturnUrl(raw:string) {
  const url=new URL(raw), project=process.env.GCLOUD_PROJECT||'yhvhchen-387212';
  const allowed=[`https://${project}.web.app`,`https://${project}.firebaseapp.com`];
  const local=process.env.FUNCTIONS_EMULATOR==='true'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname);
  if(url.username||url.password||(!allowed.includes(url.origin)&&!local)) throw new HttpsError('invalid-argument','INVALID_RETURN_URL');
  return url.href;
}
export async function dispatchActionApi(db:Firestore,auth:Pick<Auth,'deleteUser'>,request:BusinessRequest) {
  const segments=request.path.split('/');
  const route=actionRoutes.find(r=>r.method===request.method&&r.path.split('/').length===segments.length&&r.path.split('/').every((s,i)=>s==='{id}'||s===segments[i]));
  if(!route) throw new HttpsError('not-found','ROUTE_NOT_FOUND');
  const uid=request.auth?.uid;
  if(!route.public&&!uid) throw new HttpsError('unauthenticated','AUTH_REQUIRED');
  const input:any=route.body?route.body.parse(request.body):Empty.parse(request.body??{});
  const query=route.query?route.query.parse(request.query||{}):Empty.parse(request.query||{});
  let result:unknown;
  switch(route.operationId) {
    case 'searchLocations': result=await searchLocations(db,query); break;
    case 'previewNatal': case 'previewTransits': {
      if(input.subjects?.some((s:any)=>s.profile_id)&&!uid) throw new HttpsError('unauthenticated','AUTH_REQUIRED');
      const profile=input.subjects?(await resolveSubjects(db,uid||'',input.subjects))[0].profile:input;
      validateBirthTime(profile.birthDateTime,profile.timezone);
      if(route.operationId==='previewTransits')validateBirthTime(input.atDateTime,input.atTimezone);
      validateBirthTime(profile.birthDateTime,profile.timezone);
      if(route.operationId==='previewTransits')validateBirthTime(input.atDateTime,input.atTimezone || profile.timezone);
      if(route.operationId==='previewNatal'){const natal=natalWheel(profile);result={natal,portrait:computePortraitSummary(natal)};}
      else result={transit:transitSnapshot({...profile,atDateTime:input.atDateTime,atTimezone:input.atTimezone})}; break;
    }
    case 'claimShare': result={usage:await claimShareBonus(db,{uid:uid!,shareMethod:input.shareMethod})}; break;
    case 'exportAccount': {
      const exported=await exportAccountData(db,uid!);
      // Frozen system prompts and private session internals are not personal export data.
      const sessions=(exported.sessions as Array<Record<string,unknown>>).map(({frozenPrompt,frozenTools,frozenModel,activeTurnId,activeTurnExpiresAt,...session})=>session);
      result={...exported,sessions}; break;
    }
    case 'deleteAccount': result=await deleteAccountWithRetry({db,auth,uid:uid!}); break;
    case 'listPlans': result={items:Object.entries(TIER_META).map(([id,meta])=>({id,...meta,analysisDepths:id==='pro'?['quick','balanced','deep']:[]}))}; break;
    case 'getSubscription': {
      const snap=await db.collection('customers').doc(uid!).collection('subscriptions').limit(20).get();
      result={items:snap.docs.map(doc=>{const d=doc.data();return {id:doc.id,status:String(d.status||'unknown'),...(typeof d.role==='string'?{role:d.role}:{}),...(typeof d.current_period_end==='number'?{currentPeriodEnd:d.current_period_end}:d.current_period_end?.seconds?{currentPeriodEnd:d.current_period_end.seconds}:{})};})}; break;
    }
    case 'createCheckout': {
      const price=process.env[input.tier==='go'?'STRIPE_PRICE_GO':'STRIPE_PRICE_PRO'];
      if(!price) throw new HttpsError('failed-precondition','BILLING_NOT_CONFIGURED');
      const data={price,success_url:validateReturnUrl(input.successUrl),cancel_url:validateReturnUrl(input.cancelUrl)};
      const ref=await db.collection('customers').doc(uid!).collection('checkout_sessions').add(data);
      result={id:ref.id,status:'pending'}; break;
    }
    case 'getCheckout': {
      const id=Id.parse(segments[4]),doc=await db.collection('customers').doc(uid!).collection('checkout_sessions').doc(id).get();
      if(!doc.exists) throw new HttpsError('not-found','RESOURCE_NOT_FOUND');
      const d=doc.data()!; result=d.error?{id,status:'failed',error:'CHECKOUT_FAILED'}:d.url?{id,status:'completed',url:String(d.url)}:{id,status:'pending'}; break;
    }
    case 'createPortal': {
      const return_url=validateReturnUrl(input.returnUrl),key=process.env.STRIPE_SECRET_KEY;
      if(!key) throw new HttpsError('failed-precondition','BILLING_NOT_CONFIGURED');
      const customer=(await db.collection('customers').doc(uid!).get()).data()?.stripeId;
      if(typeof customer!=='string'||!customer) throw new HttpsError('failed-precondition','BILLING_CUSTOMER_NOT_FOUND');
      result={url:(await new Stripe(key).billingPortal.sessions.create({customer,return_url})).url}; break;
    }
  }
  const parsed=route.response.safeParse(result);
  if(!parsed.success)throw new HttpsError('internal','INVALID_RESPONSE');
  return {status:route.status,body:parsed.data};
}
