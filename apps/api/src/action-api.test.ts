import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import { TIER_META } from '@vela-cf/shared';
import { actionRoutes, dispatchActionApi, searchLocations, validateReturnUrl, webOrigins } from './action-api.js';
function database() {
  const store=new Map<string,any>(); let count=0;
  const doc=(path:string):any=>({id:path.split('/').at(-1),get:async()=>({exists:store.has(path),data:()=>store.get(path)}),set:async(v:any)=>store.set(path,v),collection:(name:string)=>collection(`${path}/${name}`)});
  const collection=(path:string):any=>({doc:(id:string)=>doc(`${path}/${id}`),add:async(v:any)=>{const id=`c${++count}`;store.set(`${path}/${id}`,v);return {id};},limit:()=>collection(path),get:async()=>({docs:[...store].filter(([k])=>k.startsWith(path+'/')&&k.split('/').length===path.split('/').length+1).map(([k,v])=>({id:k.split('/').at(-1),data:()=>v}))})});
  return {store,db:{collection} as unknown as Firestore};
}
const deleter={deleteUser:async()=>{throw new Error('Unexpected auth deletion');}};
const identity={uid:'alice',token:{}};
const birth={birthDateTime:'1994-06-03T08:20',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai'};

test('public chart APIs accept raw subjects without persisting profiles; stored subjects require identity and ownership',async()=>{
  const {db,store}=database();
  const result=await dispatchActionApi(db,deleter,{method:'POST',path:'/v1/charts/natal',body:{subjects:[{ref:'p1',birth:{datetime:birth.birthDateTime,timezone:birth.timezone,latitude:birth.latitude,longitude:birth.longitude}}]}});
  assert.equal(result.status,200); assert((result.body as any).natal.planets.length>0); assert.equal(store.size,0);
  await assert.rejects(()=>dispatchActionApi(db,deleter,{method:'POST',path:'/v1/charts/natal',body:{subjects:[{ref:'p1',profile_id:'secret'}]}}),/AUTH_REQUIRED/);
  store.set('users/bob/profiles/secret',{...birth,name:'Bob',locationName:'Shanghai',gender:'unset'});
  await assert.rejects(()=>dispatchActionApi(db,deleter,{auth:identity,method:'POST',path:'/v1/charts/natal',body:{subjects:[{ref:'p1',profile_id:'secret'}]}}),/PROFILE_NOT_FOUND/);
  await assert.rejects(()=>dispatchActionApi(db,deleter,{method:'POST',path:'/v1/charts/natal',body:{...birth,birthDateTime:'2026-02-30T12:00'}}),/INVALID_BIRTH_DATETIME/);
  await assert.rejects(()=>dispatchActionApi(db,deleter,{method:'POST',path:'/v1/charts/natal',body:{...birth,timezone:'not-a-timezone'}}),/INVALID_TIMEZONE/);
  const transit=await dispatchActionApi(db,deleter,{method:'POST',path:'/v1/charts/transits',body:{...birth,atDateTime:'2026-11-16T12:00',atTimezone:'UTC'}});
  assert.equal((transit.body as any).transit.chartType,'transit_snapshot');
});

test('action input rejects privilege injection and untrusted redirect targets',async()=>{
  const {db}=database();
  await assert.rejects(()=>dispatchActionApi(db,deleter,{method:'POST',path:'/v1/me/share-claims',body:{shareMethod:'copy'}}),/AUTH_REQUIRED/);
  await assert.rejects(()=>dispatchActionApi(db,deleter,{auth:identity,method:'POST',path:'/v1/me/share-claims',body:{shareMethod:'copy',uid:'bob'}}));
  await assert.rejects(()=>dispatchActionApi(db,deleter,{auth:identity,method:'DELETE',path:'/v1/me',body:{uid:'bob'}}));
  assert.throws(()=>validateReturnUrl('https://evil.example/account'),/INVALID_RETURN_URL/);
  assert.throws(()=>validateReturnUrl('https://evil.example@yhvhchen-387212.web.app/account'),/INVALID_RETURN_URL/);
  assert.equal(validateReturnUrl(`https://${process.env.GCLOUD_PROJECT||'yhvhchen-387212'}.web.app/account`),`https://${process.env.GCLOUD_PROJECT||'yhvhchen-387212'}.web.app/account`);
});

test('checkout delegates only authenticated tier and validated URLs; status strips provider internals',async()=>{
  const {db,store}=database();let called=0;
  const origin=webOrigins()[0];
  const billing={checkout:async(database:Firestore,uid:string,input:any)=>{
    assert.equal(database,db);assert.equal(uid,'alice');assert.deepEqual(input,{tier:'go',successUrl:origin+'/success',cancelUrl:origin+'/cancel'});called++;
    return {id:'c1',status:'completed' as const,url:'https://checkout.stripe.com/test'};
  },portal:async()=>{throw new Error('Unexpected portal');}};
  const created=await dispatchActionApi(db,deleter,{auth:identity,method:'POST',path:'/v1/billing/checkout-sessions',body:{tier:'go',successUrl:origin+'/success',cancelUrl:origin+'/cancel'}},billing);
  assert.equal(created.status,201);assert.equal(called,1);
  assert.deepEqual(created.body,{id:'c1',status:'completed',url:'https://checkout.stripe.com/test'});
  store.set('customers/alice/checkout_sessions/c1',{url:'https://checkout.stripe.com/test',internalSecret:'hidden'});
  await assert.rejects(()=>dispatchActionApi(db,deleter,{auth:{uid:'bob',token:{}},method:'GET',path:'/v1/billing/checkout-sessions/c1'}),/RESOURCE_NOT_FOUND/);
  const status=await dispatchActionApi(db,deleter,{auth:identity,method:'GET',path:'/v1/billing/checkout-sessions/c1'});
  assert.deepEqual(status.body,{id:'c1',status:'completed',url:'https://checkout.stripe.com/test'});
});

test('location lookup matches builtin data without geocoding or database writes',async()=>{
  const {db,store}=database();let requests=0;
  const failed=(async()=>{requests++;throw new Error('offline');}) as typeof fetch;
  const first=await searchLocations(db,{query:'上海'},failed);assert.equal(first.results[0].timezone,'Asia/Shanghai');assert.equal(store.size,0);
  assert.deepEqual(await searchLocations(db,{query:'上海'},failed),first);assert.equal(requests,0);
});

test('public plans preserve tier entitlements and expose depth choices only for Pro with a concrete contract',async()=>{
  const {db,store}=database();
  const result=await dispatchActionApi(db,deleter,{method:'GET',path:'/v1/plans'});
  assert.equal(result.status,200); assert.equal(store.size,0);
  assert.deepEqual(result.body,{items:Object.entries(TIER_META).map(([id,meta])=>({id,...meta,analysisDepths:id==='pro'?['quick','balanced','deep']:[]}))});
  const response=actionRoutes.find(route=>route.operationId==='listPlans')!.response;
  assert.equal(response.safeParse({items:[{id:'pro'}]}).success,false);
  const items=(result.body as any).items;
  assert.equal(response.safeParse({items:[{...items[2],analysisDepths:['unsupported']}]}).success,false);
  assert.equal(response.safeParse({items:[{...items[0],monthlyBudgetMicroUsd:'100000'}]}).success,false);
});


test('production custom domain is exact-origin allowed for CORS and billing, without granting staging access',()=>{
  const saved={project:process.env.GCLOUD_PROJECT,environment:process.env.VELA_ENVIRONMENT};
  try {
    process.env.GCLOUD_PROJECT='yhvhchen-387212';process.env.VELA_ENVIRONMENT='production';
    assert(webOrigins().includes('https://velaastro.com'));
    assert.equal(validateReturnUrl('https://velaastro.com:443/account?checkout=success'),'https://velaastro.com/account?checkout=success');
    for(const url of ['http://velaastro.com/account','https://velaastro.com.evil.test/account','https://velaastro.com@evil.test/account','https://user@velaastro.com/account','https://velaastro.com:8443/account','https://www.velaastro.com/account'])assert.throws(()=>validateReturnUrl(url),/INVALID_RETURN_URL/);
    process.env.GCLOUD_PROJECT='vela-staging-test';process.env.VELA_ENVIRONMENT='staging';
    assert(!webOrigins().includes('https://velaastro.com'));assert.throws(()=>validateReturnUrl('https://velaastro.com/account'),/INVALID_RETURN_URL/);
    assert.equal(validateReturnUrl('https://vela-staging-test.web.app/account'),'https://vela-staging-test.web.app/account');
  } finally {
    if(saved.project===undefined)delete process.env.GCLOUD_PROJECT;else process.env.GCLOUD_PROJECT=saved.project;
    if(saved.environment===undefined)delete process.env.VELA_ENVIRONMENT;else process.env.VELA_ENVIRONMENT=saved.environment;
  }
});

test('billing endpoints require identity; reject client-selected prices, owners and roles before writing',async()=>{
  const {db,store}=database();
  const origin=webOrigins()[0];
  const body={tier:'go',successUrl:origin,cancelUrl:origin};
  for(const [method,path,input] of [
    ['POST','/v1/billing/checkout-sessions',body],
    ['GET','/v1/billing/checkout-sessions/c1',undefined],
    ['POST','/v1/billing/portal-sessions',{returnUrl:origin}],
    ['GET','/v1/me/subscription',undefined],
  ] as const) await assert.rejects(()=>dispatchActionApi(db,deleter,{method,path,body:input}),/AUTH_REQUIRED/);
  for(const injection of [{price:'price_attacker'},{uid:'bob'},{stripeRole:'pro'},{tier:'free'}]) {
    await assert.rejects(()=>dispatchActionApi(db,deleter,{auth:identity,method:'POST',path:'/v1/billing/checkout-sessions',body:{...body,...injection}}));
  }
  assert.equal(store.size,0);
});

test('both paid tiers reach billing with fixed input shape; redirects fail before provider invocation',async()=>{
  const {db,store}=database(),calls:any[]=[];
  const billing={checkout:async(database:Firestore,uid:string,input:any)=>{calls.push({database,uid,input});return {id:'c1',status:'completed' as const,url:'https://checkout.stripe.com/test'};},portal:async()=>{throw new Error('Unexpected portal');}};
  const origin=webOrigins()[0];
  for(const tier of ['go','pro']) await dispatchActionApi(db,deleter,{auth:identity,method:'POST',path:'/v1/billing/checkout-sessions',body:{tier,successUrl:origin+'/success',cancelUrl:origin+'/cancel'}},billing);
  assert.deepEqual(calls.map(({uid,input})=>({uid,input})),['go','pro'].map(tier=>({uid:'alice',input:{tier,successUrl:origin+'/success',cancelUrl:origin+'/cancel'}})));
  for(const field of ['successUrl','cancelUrl']) await assert.rejects(()=>dispatchActionApi(db,deleter,{auth:identity,method:'POST',path:'/v1/billing/checkout-sessions',body:{tier:'pro',successUrl:origin,cancelUrl:origin,[field]:'https://attacker.example/'}},billing),/INVALID_RETURN_URL/);
  assert.equal(calls.length,2);assert.equal(store.size,0);
});

test('checkout polling preserves pending and redacts provider failure even if a URL exists',async()=>{
  const {db,store}=database(),path='customers/alice/checkout_sessions/c1';
  store.set(path,{price:'price_test'});
  const request={auth:identity,method:'GET',path:'/v1/billing/checkout-sessions/c1'};
  assert.deepEqual((await dispatchActionApi(db,deleter,request)).body,{id:'c1',status:'pending'});
  store.set(path,{url:'https://checkout.stripe.com/stale',error:{message:'private provider detail',secret:'sensitive'}});
  assert.deepEqual((await dispatchActionApi(db,deleter,request)).body,{id:'c1',status:'failed',error:'CHECKOUT_FAILED'});
});

test('subscription API normalizes timestamps and returns only the authenticated customer data',async()=>{
  const {db,store}=database();
  store.set('customers/alice/subscriptions/sub_a',{status:'active',role:'go',current_period_end:{seconds:1800000000},privateMetadata:'hidden'});
  store.set('customers/alice/subscriptions/sub_b',{status:'canceled',role:'pro',current_period_end:1800000001});
  store.set('customers/bob/subscriptions/sub_secret',{status:'active',role:'pro'});
  const response=await dispatchActionApi(db,deleter,{auth:identity,method:'GET',path:'/v1/me/subscription'});
  assert.deepEqual(response.body,{items:[{id:'sub_a',status:'active',role:'go',currentPeriodEnd:1800000000},{id:'sub_b',status:'canceled',role:'pro',currentPeriodEnd:1800000001}]});
});

test('portal refuses missing configuration or missing own customer and rejects customer injection',async()=>{
  const {db,store}=database(),previous=process.env.STRIPE_SECRET_KEY,enabled=process.env.STRIPE_BILLING_ENABLED,mode=process.env.STRIPE_MODE;
  process.env.STRIPE_BILLING_ENABLED='true';process.env.STRIPE_MODE='test';
  const request={auth:identity,method:'POST',path:'/v1/billing/portal-sessions',body:{returnUrl:webOrigins()[0]}};
  try {
    delete process.env.STRIPE_SECRET_KEY;
    await assert.rejects(()=>dispatchActionApi(db,deleter,request),/BILLING_MODE_MISMATCH/);
    process.env.STRIPE_SECRET_KEY='sk_test_not_a_real_key';
    store.set('customers/bob',{stripeId:'cus_other'});
    await assert.rejects(()=>dispatchActionApi(db,deleter,request),/BILLING_CUSTOMER_NOT_FOUND/);
    await assert.rejects(()=>dispatchActionApi(db,deleter,{...request,body:{...request.body,customer:'cus_other'}}));
    await assert.rejects(()=>dispatchActionApi(db,deleter,{...request,body:{returnUrl:'https://attacker.example'}}),/INVALID_RETURN_URL/);
  } finally {if(previous===undefined)delete process.env.STRIPE_SECRET_KEY;else process.env.STRIPE_SECRET_KEY=previous;
    for(const [key,value] of [['STRIPE_BILLING_ENABLED',enabled],['STRIPE_MODE',mode]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}
  }
});
