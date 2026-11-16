import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import type { Firestore } from 'firebase-admin/firestore';
import { handleStripeWebhook } from './stripe-payments.js';
const stripe=new Stripe('sk_test_fixture');
const secret='whsec_fixture';
const db={} as Firestore;
const auth={getUser:async()=>{throw new Error('unexpected Auth read');},setCustomUserClaims:async()=>{throw new Error('unexpected claims write');}};
async function environment(operation:()=>Promise<void>){
  const keys=['STRIPE_BILLING_ENABLED','STRIPE_MODE','STRIPE_WEBHOOK_SECRET'] as const;
  const previous=keys.map(key=>process.env[key]);
  process.env.STRIPE_BILLING_ENABLED='true';process.env.STRIPE_MODE='test';process.env.STRIPE_WEBHOOK_SECRET=secret;
  try{await operation();}finally{keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});}
}
const event=(live=false)=>JSON.stringify({id:'evt_fixture',type:'product.updated',livemode:live,data:{object:{id:'prod_fixture'}}});
test('Stripe webhook rejects forged and expired signatures before any persistence or Auth access',()=>environment(async()=>{
  const payload=event();
  await assert.rejects(()=>handleStripeWebhook(db,auth,Buffer.from(payload),'forged',stripe),/INVALID_STRIPE_SIGNATURE/);
  const stale=stripe.webhooks.generateTestHeaderString({payload,secret,timestamp:Math.floor(Date.now()/1000)-600});
  await assert.rejects(()=>handleStripeWebhook(db,auth,Buffer.from(payload),stale,stripe),/INVALID_STRIPE_SIGNATURE/);
}));
test('Stripe webhook rejects validly signed events from the wrong payment mode',()=>environment(async()=>{
  const payload=event(true),signature=stripe.webhooks.generateTestHeaderString({payload,secret});
  await assert.rejects(()=>handleStripeWebhook(db,auth,Buffer.from(payload),signature,stripe),/BILLING_MODE_MISMATCH/);
}));
test('Stripe webhook safely acknowledges signed events outside subscription synchronization',()=>environment(async()=>{
  const payload=event(),signature=stripe.webhooks.generateTestHeaderString({payload,secret});
  await handleStripeWebhook(db,auth,Buffer.from(payload),signature,stripe);
}));
test('Stripe webhook refuses traffic when billing is disabled or the signing secret is absent',()=>environment(async()=>{
  process.env.STRIPE_BILLING_ENABLED='false';
  await assert.rejects(()=>handleStripeWebhook(db,auth,Buffer.from(event()),'',stripe),/BILLING_NOT_CONFIGURED/);
  process.env.STRIPE_BILLING_ENABLED='true';delete process.env.STRIPE_WEBHOOK_SECRET;
  await assert.rejects(()=>handleStripeWebhook(db,auth,Buffer.from(event()),'',stripe),/BILLING_NOT_CONFIGURED/);
}));
