import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import { TIER_META } from '@vela-cf/shared';
import { actionRoutes, dispatchActionApi, searchLocations, validateReturnUrl } from './action-api.js';
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

test('checkout creation uses server price and owner scope; status strips extension internals',async()=>{
  const {db,store}=database(),previous=process.env.STRIPE_PRICE_GO; process.env.STRIPE_PRICE_GO='price_test';
  try {
    const origin=`https://${process.env.GCLOUD_PROJECT||'yhvhchen-387212'}.web.app`;
    const created=await dispatchActionApi(db,deleter,{auth:identity,method:'POST',path:'/v1/billing/checkout-sessions',body:{tier:'go',successUrl:origin+'/success',cancelUrl:origin+'/cancel'}});
    assert.equal(created.status,201); const id=(created.body as any).id;
    assert.equal(store.get(`customers/alice/checkout_sessions/${id}`).price,'price_test');
    await assert.rejects(()=>dispatchActionApi(db,deleter,{auth:{uid:'bob',token:{}},method:'GET',path:`/v1/billing/checkout-sessions/${id}`}),/RESOURCE_NOT_FOUND/);
    store.set(`customers/alice/checkout_sessions/${id}`,{url:'https://checkout.stripe.com/test',internalSecret:'hidden'});
    const status=await dispatchActionApi(db,deleter,{auth:identity,method:'GET',path:`/v1/billing/checkout-sessions/${id}`});
    assert.deepEqual(status.body,{id,status:'completed',url:'https://checkout.stripe.com/test'});
    delete process.env.STRIPE_PRICE_GO;
    await assert.rejects(()=>dispatchActionApi(db,deleter,{auth:identity,method:'POST',path:'/v1/billing/checkout-sessions',body:{tier:'go',successUrl:origin,cancelUrl:origin}}),/BILLING_NOT_CONFIGURED/);
  } finally {if(previous===undefined)delete process.env.STRIPE_PRICE_GO;else process.env.STRIPE_PRICE_GO=previous;}
});

test('location lookup falls back without geocoding and reuses validated cache',async()=>{
  const {db,store}=database();let requests=0;
  const failed=(async()=>{requests++;throw new Error('offline');}) as typeof fetch;
  const first=await searchLocations(db,{query:'上海'},failed);assert.equal(first.results[0].timezone,'Asia/Shanghai');assert.equal(store.size,1);
  assert.deepEqual(await searchLocations(db,{query:'上海'},failed),first);assert.equal(requests,1);
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
