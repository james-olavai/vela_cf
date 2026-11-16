import test from 'node:test';
import { createServer } from 'node:http';
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


test('subscription synchronization uses SDK HTTP requests within Stripe expansion depth and customer scope',()=>environment(async()=>{
  // Exercise SDK serialization against a provider contract, rather than replacing list().
  const calls:URL[]=[];
  const server=createServer((request,response)=>{
    const url=new URL(request.url!,'http://stripe.test');calls.push(url);
    const expansions=[...url.searchParams.entries()].filter(([key])=>key.startsWith('expand')).map(([,value])=>value);
    if(expansions.some(value=>value.split('.').length>4)){
      response.writeHead(400,{'content-type':'application/json'});
      response.end(JSON.stringify({error:{type:'invalid_request_error',code:'property_expansion_max_depth',message:'Cannot expand more than 4 levels'}}));return;
    }
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({object:'list',data:[],has_more:false,url:'/v1/subscriptions'}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  const client=new Stripe('sk_test_fixture',{host:'127.0.0.1',port,protocol:'http',maxNetworkRetries:0});
  const store=new Map<string,unknown>();
  const ref=(path:string):any=>({id:path.split('/').at(-1),get:async()=>({data:()=>store.get(path)}),set:async(value:unknown)=>{store.set(path,value);},delete:async()=>{store.delete(path);}});
  const fakeDb={collection:(name:string)=>({doc:(id:string)=>ref(name+'/'+id),where:()=>({limit:()=>({get:async()=>({empty:false,size:1,docs:[{id:'alice'}]})})})}),runTransaction:async(operation:any)=>operation({get:(doc:any)=>doc.get(),set:(doc:any,value:unknown)=>doc.set(value),delete:(doc:any)=>doc.delete()})} as unknown as Firestore;
  const absentAuth={getUser:async()=>{throw Object.assign(new Error('deleted'),{code:'auth/user-not-found'});},setCustomUserClaims:auth.setCustomUserClaims};
  const payload=JSON.stringify({id:'evt_http_contract',type:'customer.subscription.updated',livemode:false,data:{object:{customer:'cus_owned'}}});
  try {
    await handleStripeWebhook(fakeDb,absentAuth,Buffer.from(payload),client.webhooks.generateTestHeaderString({payload,secret}),client);
    assert.equal(calls.length,1);assert.equal(calls[0].pathname,'/v1/subscriptions');
    assert.equal(calls[0].searchParams.get('customer'),'cus_owned');assert.equal(calls[0].searchParams.get('status'),'all');
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}));
