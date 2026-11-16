import { computePortraitSummary } from './portrait.js';
import { z } from 'zod';
import type { Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { HttpsError } from 'firebase-functions/v2/https';
import { createStripeCheckout, createStripePortal } from './stripe-payments.js';
import { PRODUCTION_WEB_ORIGIN, PRODUCTION_FIREBASE_PROJECT, TIER_META, TierSchema, SubjectSchema, PortraitSummarySchema } from '@vela-cf/shared';
import { NatalWheelInputSchema, TransitSnapshotInputSchema, natalWheel, transitSnapshot } from '@vela-cf/astrology';
import { claimShareBonus, resolveUserPeriodAndTier } from './quota.js';
import { exportAccountData, deleteAccountWithRetry } from './account.js';
import { resolveSubjects, validateBirthTime } from './subjects.js';
import type { BusinessRequest } from './business-api.js';

import { locationRoutes, listLocationCatalog, searchLocations } from './locations.js';
export { searchLocations } from './locations.js';

const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const Json = z.record(z.string(), z.unknown());
const Plan = z.object({ id:TierSchema,label:z.string(),priceLabel:z.string(),monthlyBudgetMicroUsd:z.number().int().nonnegative(),maxProfiles:z.number().int().nonnegative(),maxSynastryProfiles:z.number().int().nonnegative(),allowsEntityCharts:z.boolean(),highlights:z.array(z.string()),analysisDepths:z.array(z.enum(['quick','balanced','deep'])) });
const Empty = z.object({}).strict();
const Checkout = z.object({ id:Id,status:z.enum(['pending','completed','failed']),url:z.string().url().optional(),error:z.string().optional() });
const ReturnUrl = z.string().url();
const SubjectChart = z.object({subjects:z.array(SubjectSchema).length(1)}).strict();
const NatalInput = z.union([NatalWheelInputSchema.strict(),SubjectChart]);
const TransitInput = z.union([TransitSnapshotInputSchema.strict(),SubjectChart.extend({atDateTime:TransitSnapshotInputSchema.shape.atDateTime,atTimezone:TransitSnapshotInputSchema.shape.atTimezone})]);
export const actionRoutes = [
  ...locationRoutes,
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
export function webOrigins(project=process.env.GCLOUD_PROJECT||PRODUCTION_FIREBASE_PROJECT) {
  return [`https://${project}.web.app`,`https://${project}.firebaseapp.com`,...(project===PRODUCTION_FIREBASE_PROJECT && process.env.VELA_ENVIRONMENT!=='staging' ? [PRODUCTION_WEB_ORIGIN] : [])];
}
export function validateReturnUrl(raw:string) {
  const url=new URL(raw), allowed=webOrigins();
  const local=process.env.FUNCTIONS_EMULATOR==='true'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname);
  if(url.username||url.password||(!allowed.includes(url.origin)&&!local)) throw new HttpsError('invalid-argument','INVALID_RETURN_URL');
  return url.href;
}
export async function dispatchActionApi(db:Firestore,auth:Pick<Auth,'deleteUser'>,request:BusinessRequest,billing={checkout:createStripeCheckout,portal:createStripePortal}) {
  const segments=request.path.split('/');
  const route=actionRoutes.find(r=>r.method===request.method&&r.path.split('/').length===segments.length&&r.path.split('/').every((s,i)=>s==='{id}'||s===segments[i]));
  if(!route) throw new HttpsError('not-found','ROUTE_NOT_FOUND');
  const uid=request.auth?.uid;
  if(!route.public&&!uid) throw new HttpsError('unauthenticated','AUTH_REQUIRED');
  const input:any='body' in route && route.body?route.body.parse(request.body):Empty.parse(request.body??{});
  const query='query' in route && route.query?route.query.parse(request.query||{}):Empty.parse(request.query||{});
  let result:unknown;
  switch(route.operationId) {
    case 'searchLocations': result=await searchLocations(db,query); break;
    case 'listLocationCatalog': result=listLocationCatalog(request.query??{}); break;
    case 'previewNatal': case 'previewTransits': {
      if(input.subjects?.some((s:any)=>s.profile_id)&&!uid) throw new HttpsError('unauthenticated','AUTH_REQUIRED');
      const profile=input.subjects?(await resolveSubjects(db,uid||'',input.subjects))[0].profile:input;
      validateBirthTime(profile.birthDateTime,profile.timezone);
      if(profile.entityType && profile.entityType!=='person') {
        if(!uid)throw new HttpsError('unauthenticated','AUTH_REQUIRED');
        const {tier}=await resolveUserPeriodAndTier(db,uid,request.auth?.token.stripeRole);
        if(!TIER_META[tier].allowsEntityCharts)throw new HttpsError('permission-denied','ENTITY_CHART_REQUIRES_PRO');
      }
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
      validateReturnUrl(input.successUrl);validateReturnUrl(input.cancelUrl);
      result=await billing.checkout(db,uid!,input); break;
    }
    case 'getCheckout': {
      const id=Id.parse(segments[4]),doc=await db.collection('customers').doc(uid!).collection('checkout_sessions').doc(id).get();
      if(!doc.exists) throw new HttpsError('not-found','RESOURCE_NOT_FOUND');
      const d=doc.data()!; result=d.error?{id,status:'failed',error:'CHECKOUT_FAILED'}:d.url?{id,status:'completed',url:String(d.url)}:{id,status:'pending'}; break;
    }
    case 'createPortal': {
      result=await billing.portal(db,uid!,validateReturnUrl(input.returnUrl)); break;
    }
  }
  const parsed=route.response.safeParse(result);
  if(!parsed.success)throw new HttpsError('internal','INVALID_RESPONSE');
  return {status:route.status,body:parsed.data};
}
