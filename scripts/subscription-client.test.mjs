import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['apps/web/src/lib/accountStore.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'subscription-dependencies',setup(b){
  b.onResolve({filter:/^\.\/(apiClient|firebase)$/},args=>({path:args.path,namespace:'test'}));
  b.onLoad({filter:/.*/,namespace:'test'},args=>({contents:args.path==='./apiClient'?'export const businessApi=(...args)=>globalThis.subscriptionRequest(...args);':'export const auth={currentUser:null};'}));
}}]});
const {loadSubscriptionPage}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const defaults={maxProfiles:7,maxSynastryProfiles:3,monthlyBudgetMicroUsd:123456,allowsEntityCharts:false,analysisDepths:[]};
const plans=[{...defaults,id:'free',label:'Server free'},{...defaults,id:'go',label:'Server Go',priceLabel:'$25'},{...defaults,id:'pro',label:'Server Pro'}];
test('subscription loader uses actual API plans and current user state, forwarding cancellation',async()=>{
  const calls=[],signal=new AbortController().signal;
  globalThis.subscriptionRequest=async(...args)=>{calls.push(args);return {items:args[1]==='/v1/plans'?plans:[{id:'sub',status:'past_due',role:'go'}]};};
  const result=await loadSubscriptionPage('owner',signal);
  assert.equal(result.plans[1].priceLabel,'$25');assert.equal(result.subscriptions[0].status,'past_due');
  assert.deepEqual(calls.map(c=>c.slice(0,3)),[['owner','/v1/plans','GET'],['owner','/v1/me/subscription','GET']]);
  assert(calls.every(c=>c[4]===signal));
});
test('guest plan loading never queries a private subscription and failure does not fall back to hardcoded plans',async()=>{
  const calls=[];
  globalThis.subscriptionRequest=async(...args)=>{calls.push(args);return {items:plans};};
  assert.deepEqual((await loadSubscriptionPage(null,new AbortController().signal)).subscriptions,[]);
  assert.deepEqual(calls.map(c=>c[1]),['/v1/plans']);
  globalThis.subscriptionRequest=async()=>{throw new Error('offline');};
  await assert.rejects(loadSubscriptionPage('owner',new AbortController().signal),/offline/);
  globalThis.subscriptionRequest=async()=>({items:[plans[0]]});
  await assert.rejects(loadSubscriptionPage(null,new AbortController().signal),/套餐信息不完整/);
});
