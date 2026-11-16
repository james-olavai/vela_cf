import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {handleStripeWebhook,withBillingLock} from '../../apps/api/src/stripe-payments.ts';
import {resolveUserPeriodAndTier} from '../../apps/api/src/quota.ts';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const {initializeApp,deleteApp}=require('firebase-admin/app'),{getAuth}=require('firebase-admin/auth'),{getFirestore}=require('firebase-admin/firestore');
const Stripe=require('stripe');
if(!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST||'')||!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw new Error('Stripe integration requires local Auth and Firestore emulators');

test('signed payment events sync real Firestore and Auth with replay, stale events and retry safety',async(t)=>{
  const app=initializeApp({projectId:'demo-vela-ci'},`stripe-${randomUUID()}`),db=getFirestore(app),auth=getAuth(app);
  const saved={...process.env};
  process.env.STRIPE_BILLING_ENABLED='true';process.env.STRIPE_MODE='test';
  process.env.STRIPE_SECRET_KEY='sk_test_emulator_only';process.env.STRIPE_WEBHOOK_SECRET='whsec_emulator_only';
  process.env.STRIPE_PRICE_GO='price_go';process.env.STRIPE_PRICE_PRO='price_pro';
  const uid=`stripe-qa-${randomUUID()}`,customer=`cus_${randomUUID()}`,events=[];
  const stripe=new Stripe('sk_test_emulator_only');
  let status='active',tier='go',calls=0;
  const start=Math.floor(Date.now()/1000)-100,end=start+2_592_000;
  const product=role=>({id:`prod_${role}`,object:'product',active:true,metadata:{firebaseRole:role}});
  const price=role=>({id:`price_${role}`,object:'price',type:'recurring',livemode:false,active:true,product:product(role),recurring:{interval:'month',interval_count:1},currency:'usd'});
  stripe.subscriptions.list=()=>({async *[Symbol.asyncIterator](){calls++;yield {id:'sub_qa',customer,livemode:false,status,cancel_at_period_end:status==='active',items:{data:[{id:'si_qa',price:price(tier),current_period_start:start,current_period_end:end}]},current_period_start:start,current_period_end:end};}});
  stripe.prices.retrieve=async id=>price(id==='price_go'?'go':'pro');
  const event=(type='customer.subscription.updated',created=start)=>({id:`evt_${randomUUID()}`,object:'event',type,created,livemode:false,data:{object:{id:'sub_qa',object:'subscription',customer,metadata:{firebaseUID:'forged-other-user'}}}});
  async function deliver(e,authClient=auth){events.push(e.id);const raw=Buffer.from(JSON.stringify(e)),signature=Stripe.webhooks.generateTestHeaderString({payload:raw.toString(),secret:process.env.STRIPE_WEBHOOK_SECRET});return handleStripeWebhook(db,authClient,raw,signature,stripe);}
  try {
    await auth.createUser({uid});await auth.setCustomUserClaims(uid,{admin:true,unrelated:'keep'});
    await db.collection('customers').doc(uid).set({stripeId:customer});
    await t.test('signature rejection performs no subscription read or claim write',async()=>{
      await assert.rejects(()=>handleStripeWebhook(db,auth,Buffer.from('{}'),'invalid',stripe));assert.equal(calls,0);assert.equal((await auth.getUser(uid)).customClaims.stripeRole,undefined);
    });
    await t.test('customer billing lock excludes concurrent webhook and account operations',async()=>{
      let entered,release;const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
      const operation=withBillingLock(db,uid,async()=>{entered();await held;});
      await started;
      try{await assert.rejects(()=>deliver(event()),/BILLING_BUSY/);}finally{release();await operation;}
    });
    const first=event();
    await t.test('Go grants real claims, subscription period and quota tier',async()=>{
      await deliver(first);const claims=(await auth.getUser(uid)).customClaims;
      assert.deepEqual(claims,{admin:true,unrelated:'keep',stripeRole:'go'});
      const quota=await resolveUserPeriodAndTier(db,uid,claims.stripeRole);assert.equal(quota.tier,'go');assert.equal(quota.periodStart,new Date(start*1000).toISOString());
    });
    await t.test('completed event replay does not resynchronize',async()=>{const before=calls;await deliver(first);assert.equal(calls,before);});
    await t.test('old event reflects current provider Pro instead of downgrading to old payload',async()=>{tier='pro';await deliver(event('customer.subscription.updated',start-500));assert.equal((await auth.getUser(uid)).customClaims.stripeRole,'pro');});
    await t.test('Auth failure does not complete event and retry succeeds',async()=>{
      tier='go';const e=event();await assert.rejects(()=>deliver(e,{getUser:id=>auth.getUser(id),setCustomUserClaims:async()=>{throw new Error('Synthetic Auth failure');}}));
      const before=calls;await deliver(e);assert(calls>before);assert.equal((await auth.getUser(uid)).customClaims.stripeRole,'go');
    });
    await t.test('past_due removes paid entitlement but preserves unrelated claims',async()=>{status='past_due';await deliver(event());const claims=(await auth.getUser(uid)).customClaims;assert(!claims.stripeRole||claims.stripeRole==='free');assert.equal(claims.admin,true);assert.equal(claims.unrelated,'keep');});
    await t.test('active until period end retains role; actual cancellation removes it',async()=>{status='active';await deliver(event());assert.equal((await auth.getUser(uid)).customClaims.stripeRole,'go');status='canceled';await deliver(event('customer.subscription.deleted'));assert(!(await auth.getUser(uid)).customClaims.stripeRole||(await auth.getUser(uid)).customClaims.stripeRole==='free');});
    await t.test('unregistered customer metadata cannot confer access',async()=>{
      const e=event();e.data.object.customer='cus_unregistered';await deliver(e);assert(!(await auth.getUser(uid)).customClaims.stripeRole||(await auth.getUser(uid)).customClaims.stripeRole==='free');
    });
  } finally {
    await db.collection('billingLocks').doc(uid).delete();await auth.deleteUser(uid);await db.recursiveDelete(db.collection('customers').doc(uid));
    for(const id of new Set(events))await db.collection('stripeEvents').doc(id).delete();
    for(const key of ['STRIPE_BILLING_ENABLED','STRIPE_MODE','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_GO','STRIPE_PRICE_PRO'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
    await deleteApp(app);
  }
});
