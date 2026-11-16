/*
 * Adapted from invertase/stripe-firebase-extensions firestore-stripe-payments
 * (checkout-session-creation.ts and webhook-events.ts), Copyright 2020 Stripe, Inc.
 * Licensed under the Apache License, Version 2.0:
 * https://www.apache.org/licenses/LICENSE-2.0
 * Modified for Firebase Functions v2 HTTP API, named Firestore and current Stripe SDK.
 * Distributed on an AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
 */
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { HttpsError } from 'firebase-functions/v2/https';

type BillingAuth = Pick<Auth,'getUser'|'setCustomUserClaims'>;
function configured(client?:Stripe) {
  if(process.env.STRIPE_BILLING_ENABLED!=='true')throw new HttpsError('failed-precondition','BILLING_NOT_CONFIGURED');
  const key=process.env.STRIPE_SECRET_KEY;
  const live=process.env.STRIPE_MODE==='live';
  if(!['test','live'].includes(process.env.STRIPE_MODE||'test')||(!client&&(!key||!key.startsWith(live?'sk_live_':'sk_test_'))))throw new HttpsError('failed-precondition','BILLING_MODE_MISMATCH');
  return client||new Stripe(key!,{timeout:20_000,maxNetworkRetries:0});
}
function sameMode(livemode:boolean) {
  if(livemode!==(process.env.STRIPE_MODE==='live'))throw new HttpsError('failed-precondition','BILLING_MODE_MISMATCH');
}
export async function withBillingLock<T>(db:Firestore,uid:string,operation:(assertOwner:()=>Promise<void>)=>Promise<T>) {
  const ref=db.collection('billingLocks').doc(uid),owner=randomUUID();
  // HTTP timeout is at most 180s; lease outlives any in-flight Stripe/Auth request.
  await db.runTransaction(async tx=>{
    const data=(await tx.get(ref)).data();
    if(data?.untilMs>Date.now())throw new HttpsError('aborted','BILLING_BUSY');
    tx.set(ref,{owner,untilMs:Date.now()+900_000});
  });
  const assertOwner=async()=>{const data=(await ref.get()).data();if(data?.owner!==owner||data.untilMs<=Date.now())throw new HttpsError('aborted','BILLING_LOCK_EXPIRED');};
  try{return await operation(assertOwner);}finally{
    await db.runTransaction(async tx=>{if((await tx.get(ref)).data()?.owner===owner)tx.delete(ref);});
  }
}
async function currentSubscriptions(stripe:Stripe,customer:string) {
  const result:Stripe.Subscription[]=[];
  for await(const subscription of stripe.subscriptions.list({customer,status:'all',limit:100,expand:['data.items.data.price.product']}))result.push(subscription);
  return result;
}
function priceFor(tier:'go'|'pro') {
  const price=process.env[tier==='go'?'STRIPE_PRICE_GO':'STRIPE_PRICE_PRO'];
  if(!price)throw new HttpsError('failed-precondition','BILLING_NOT_CONFIGURED');
  return price;
}
async function verifyPrice(stripe:Stripe,id:string,tier:'go'|'pro',selling=true) {
  const price=await stripe.prices.retrieve(id,{expand:['product']});sameMode(price.livemode);
  const product=price.product;
  if((selling&&!price.active)||price.type!=='recurring'||price.recurring?.interval!=='month'||price.recurring.interval_count!==1||typeof product==='string'||product.deleted||(selling&&!product.active)||product.metadata.firebaseRole!==tier)throw new HttpsError('failed-precondition','BILLING_PRICE_INVALID');
  return price;
}
export async function createStripeCheckout(db:Firestore,uid:string,input:{tier:'go'|'pro';successUrl:string;cancelUrl:string},client?:Stripe) {
  const stripe=configured(client),price=priceFor(input.tier);await verifyPrice(stripe,price,input.tier);
  return withBillingLock(db,uid,async assertOwner=>{
    const user=(await db.collection('users').doc(uid).get()).data();
    if(user?.deletionState)throw new HttpsError('failed-precondition','ACCOUNT_DELETING');
    const ref=db.collection('customers').doc(uid);let customer=(await ref.get()).data()?.stripeId;
    if(!customer){
      const created=await stripe.customers.create({metadata:{firebaseUID:uid}},{idempotencyKey:`vela-customer-${process.env.GCLOUD_PROJECT}-${uid}`});
      sameMode(created.livemode);customer=created.id;await ref.set({stripeId:customer},{merge:true});
    }
    if((await currentSubscriptions(stripe,customer)).some(s=>['active','trialing','past_due','unpaid','incomplete','paused'].includes(s.status)))throw new HttpsError('failed-precondition','SUBSCRIPTION_ALREADY_EXISTS');
    const checkout=ref.collection('checkout_sessions').doc('current'),previous=(await checkout.get()).data();
    if(previous?.stripeSessionId){
      const session=await stripe.checkout.sessions.retrieve(previous.stripeSessionId);sameMode(session.livemode);
      if(session.status==='open'){
        if(previous.price===price&&previous.successUrl===input.successUrl&&previous.cancelUrl===input.cancelUrl&&session.url)return {id:'current',status:'completed' as const,url:session.url};
        await stripe.checkout.sessions.expire(session.id);
      }
    }
    const attempt=previous?.status==='creating'&&previous.price===price&&previous.successUrl===input.successUrl&&previous.cancelUrl===input.cancelUrl?previous.attempt:randomUUID();
    await checkout.set({status:'creating',attempt,price,successUrl:input.successUrl,cancelUrl:input.cancelUrl});
    const session=await stripe.checkout.sessions.create({customer,mode:'subscription',line_items:[{price,quantity:1}],success_url:input.successUrl,cancel_url:input.cancelUrl,client_reference_id:uid,customer_update:{address:'auto'},automatic_tax:{enabled:true},consent_collection:{terms_of_service:'required'}},{idempotencyKey:`vela-checkout-${attempt}`});
    sameMode(session.livemode);if(!session.url)throw new HttpsError('internal','CHECKOUT_URL_MISSING');
    await assertOwner();
    if((await db.collection('users').doc(uid).get()).data()?.deletionState){await stripe.checkout.sessions.expire(session.id);throw new HttpsError('failed-precondition','ACCOUNT_DELETING');}
    await checkout.set({status:'ready',stripeSessionId:session.id,url:session.url},{merge:true});
    return {id:'current',status:'completed' as const,url:session.url};
  });
}
export async function createStripePortal(db:Firestore,uid:string,returnUrl:string,client?:Stripe) {
  const stripe=configured(client);
  if((await db.collection('users').doc(uid).get()).data()?.deletionState)throw new HttpsError('failed-precondition','ACCOUNT_DELETING');
  const customer=(await db.collection('customers').doc(uid).get()).data()?.stripeId;
  if(typeof customer!=='string'||!customer)throw new HttpsError('failed-precondition','BILLING_CUSTOMER_NOT_FOUND');
  return {url:(await stripe.billingPortal.sessions.create({customer,return_url:returnUrl})).url};
}
export async function handleStripeWebhook(db:Firestore,auth:BillingAuth,rawBody:Buffer,signature:string,client?:Stripe) {
  const stripe=configured(client),secret=process.env.STRIPE_WEBHOOK_SECRET;
  if(!secret)throw new HttpsError('failed-precondition','BILLING_NOT_CONFIGURED');
  let event:Stripe.Event;
  try{event=stripe.webhooks.constructEvent(rawBody,signature,secret);}catch{throw new HttpsError('invalid-argument','INVALID_STRIPE_SIGNATURE');}
  sameMode(event.livemode);
  if(!/^customer\.subscription\.(created|updated|deleted)$|^checkout\.session\.(completed|async_payment_succeeded)$|^invoice\.(paid|payment_failed|payment_action_required)$/.test(event.type))return;
  const object=event.data.object as unknown as {customer?:string|{id:string}};
  const customer=typeof object.customer==='string'?object.customer:object.customer?.id;
  if(!customer)throw new HttpsError('invalid-argument','BILLING_CUSTOMER_MISSING');
  const matches=await db.collection('customers').where('stripeId','==',customer).limit(2).get();
  // Unrelated Stripe customers can share this account, but must never grant Vela access.
  if(matches.empty)return;
  if(matches.size!==1)throw new HttpsError('failed-precondition','BILLING_CUSTOMER_AMBIGUOUS');
  const uid=matches.docs[0].id;
  await withBillingLock(db,uid,async assertOwner=>{
    const receipt=db.collection('stripeEvents').doc(event.id);
    if((await receipt.get()).data()?.status==='done')return;
    if((await db.collection('users').doc(uid).get()).data()?.deletionState)return;
    const subscriptions=await currentSubscriptions(stripe,customer),records:Record<string,unknown>[]=[];
    let role='free';
    for(const sub of subscriptions){
      sameMode(sub.livemode);let subRole='free';
      for(const item of sub.items.data){
        const tier=item.price.id===priceFor('pro')?'pro':item.price.id===priceFor('go')?'go':undefined;
        if(!tier)continue;
        await verifyPrice(stripe,item.price.id,tier,false);
        if(tier==='pro'||subRole==='free')subRole=tier;
      }
      // past_due/unpaid/incomplete revoke paid access; period-end cancellation stays active.
      if(['active','trialing'].includes(sub.status)&&(subRole==='pro'||role==='free'))role=subRole;
      const item=sub.items.data[0];
      records.push({id:sub.id,status:sub.status,role:subRole,current_period_start:Timestamp.fromMillis(item.current_period_start*1000),current_period_end:Timestamp.fromMillis(item.current_period_end*1000),cancel_at_period_end:sub.cancel_at_period_end});
    }
    await assertOwner();
    let user;
    try{user=await auth.getUser(uid);}catch(error){if((error as {code?:string}).code==='auth/user-not-found')return;throw error;}
    if((await db.collection('users').doc(uid).get()).data()?.deletionState)return;
    if(records.length>400)throw new HttpsError('resource-exhausted','BILLING_SUBSCRIPTIONS_LIMIT');
    const batch=db.batch(),collection=db.collection('customers').doc(uid).collection('subscriptions');
    const previous=await collection.get();
    for(const doc of previous.docs)if(!records.some(record=>record.id===doc.id))batch.set(doc.ref,{status:'canceled'},{merge:true});
    for(const {id,...record} of records)batch.set(collection.doc(String(id)),record);
    await batch.commit();
    await assertOwner();
    if((await db.collection('users').doc(uid).get()).data()?.deletionState)return;
    try{await auth.setCustomUserClaims(uid,{...user.customClaims,stripeRole:role});}catch(error){if((error as {code?:string}).code==='auth/user-not-found')return;throw error;}
    await receipt.set({status:'done',uid,type:event.type,processedAt:Timestamp.now()});
  });
}
