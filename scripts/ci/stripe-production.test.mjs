import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {assertLivePrice} from './stripe-production.mjs';
test('Production billing rejects test prices, wrong amount, interval, role and archived products',()=>{
  const price={livemode:true,active:true,unit_amount:990,currency:'usd',recurring:{interval:'month',interval_count:1},product:{active:true,metadata:{firebaseRole:'go'}}};
  assertLivePrice(price,'go',990);
  for(const patch of [{livemode:false},{active:false},{unit_amount:2490},{currency:'aud'},{recurring:{interval:'year',interval_count:1}},{recurring:{interval:'month',interval_count:2}},{product:'prod_unexpanded'},{product:{deleted:true}},{product:{active:true,metadata:{firebaseRole:'pro'}}}])assert.throws(()=>assertLivePrice({...price,...patch},'go',990));
});
test('Production billing module import never initializes credentials or contacts Stripe',()=>{
  const url=new URL('./stripe-production.mjs',import.meta.url).href;
  const r=spawnSync(process.execPath,['--input-type=module','-e',`globalThis.fetch=()=>{throw Error('Unexpected network')};const m=await import(${JSON.stringify(url)});if(typeof m.productionBillingPreflight!=='function')process.exit(1);`],{env:{...process.env,VELA_ENVIRONMENT:'invalid'},encoding:'utf8',timeout:5000});assert.equal(r.status,0);assert.equal(r.stderr,'');
});
