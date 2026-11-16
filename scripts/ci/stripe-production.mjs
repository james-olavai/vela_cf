// Live readiness checks never create charges, subscriptions or payment methods.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadEnvironment} from './environments.mjs';
const require=createRequire(import.meta.url),Stripe=require('stripe');
export function assertLivePrice(price,tier,amount){
  assert(price.livemode&&price.active&&price.unit_amount===amount&&price.currency==='usd'&&price.recurring?.interval==='month'&&price.recurring.interval_count===1,'Live monthly price mismatch');
  assert(typeof price.product!=='string'&&!price.product.deleted&&price.product.active&&price.product.metadata.firebaseRole===tier,'Live product role mismatch');
}
export async function productionBillingPreflight({applyPortal=false,probe=false}={}){
  assert.equal(process.env.VELA_ENVIRONMENT,'production','Explicit production environment required');
  const target=loadEnvironment('production');assert(target.billing?.enabled&&target.billing.mode==='live','Live billing must be configured');
  const {google,deleteTree,documentRoot}=await import('./google.mjs');const project=target.firebase.projectId,origin='https://velaastro.com';
  const secret=async name=>{const result=await google(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access`);return Buffer.from(result.payload.data,'base64').toString('utf8').trim();};
  const key=await secret('STRIPE_SECRET_KEY'),signing=await secret('STRIPE_WEBHOOK_SECRET');
  assert(key.startsWith('sk_live_')&&signing.startsWith('whsec_'),'Live secrets missing or wrong mode');
  const stripe=new Stripe(key,{timeout:20000,maxNetworkRetries:1});const account=await stripe.accounts.retrieve();
  assert(account.charges_enabled&&account.payouts_enabled&&account.details_submitted,'Stripe account is not ready for live payments');
  const products=[];
  for(const [tier,id,amount] of [['go',target.billing.goPriceId,990],['pro',target.billing.proPriceId,2490]]){
    const p=await stripe.prices.retrieve(id,{expand:['product']});
    assertLivePrice(p,tier,amount);
    products.push({product:p.product.id,prices:[p.id],adjustable_quantity:{enabled:false}});
  }
  for(const path of ['/terms','/privacy']){const response=await fetch(origin+path,{redirect:'error',signal:AbortSignal.timeout(15000)});assert(response.ok,'Production policy page unavailable');}
  const url=`${target.apiBase}/v1/billing/stripe-webhook`;
  const endpoints=(await stripe.webhookEndpoints.list({limit:100})).data.filter(e=>e.url===url&&e.status==='enabled');
  assert.equal(endpoints.length,1,'Exactly one enabled production webhook required');const endpoint=endpoints[0];
  const required=['checkout.session.completed','checkout.session.async_payment_succeeded','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','invoice.payment_action_required'];
  assert(endpoint.enabled_events.includes('*')||required.every(e=>endpoint.enabled_events.includes(e)),'Production webhook event coverage incomplete');
  const configs=(await stripe.billingPortal.configurations.list({is_default:true,limit:100})).data;
  assert.equal(configs.length,1,'Exactly one default live Portal required');
  if(applyPortal)await stripe.billingPortal.configurations.update(configs[0].id,{active:true,default_return_url:origin,business_profile:{terms_of_service_url:origin+'/terms',privacy_policy_url:origin+'/privacy'},features:{invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_cancel:{enabled:true,mode:'at_period_end',proration_behavior:'none'},subscription_update:{enabled:true,default_allowed_updates:['price'],products,proration_behavior:'always_invoice'}}});
  const portal=await stripe.billingPortal.configurations.retrieve(configs[0].id,{expand:['features.subscription_update.products']});
  assert(portal.livemode&&portal.active&&portal.default_return_url===origin,'Live Portal return address mismatch');
  assert(portal.business_profile.terms_of_service_url===origin+'/terms'&&portal.business_profile.privacy_policy_url===origin+'/privacy','Live Portal policy links missing');
  assert(portal.features.subscription_cancel.enabled&&portal.features.subscription_cancel.mode==='at_period_end'&&portal.features.subscription_update.enabled&&portal.features.invoice_history.enabled&&portal.features.payment_method_update.enabled,'Live Portal features incomplete');
  assert.deepEqual(portal.features.subscription_update.products.map(p=>({product:p.product,prices:p.prices,adjustable_quantity:{enabled:p.adjustable_quantity.enabled}})),products,'Portal must offer exactly the server Go/Pro prices');
  const report={environment:'production',mode:'live',accountReady:true,pricesVerified:true,webhookConfigured:true,portalVerified:true,chargeCreated:false,subscriptionCreated:false};
  if(probe){
    const fn=await google(`https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/asia-southeast1/functions/businessApi`);
    assert.equal(fn.serviceConfig.environmentVariables.STRIPE_BILLING_ENABLED,'true');assert.equal(fn.serviceConfig.environmentVariables.STRIPE_MODE,'live');
    const names=fn.serviceConfig.secretEnvironmentVariables?.map(s=>s.key)||[];assert(names.includes('STRIPE_SECRET_KEY')&&names.includes('STRIPE_WEBHOOK_SECRET'),'Deployed function secret binding incomplete');
    let customer,checkout,user,changedEvents=false;
    const userApi=async(method,path,body)=>{const r=await fetch(target.apiBase+path,{method,headers:{Authorization:`Bearer ${user.idToken}`,'Content-Type':'application/json',Origin:origin},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});const data=await r.json();assert(r.ok,`Production billing API failed HTTP ${r.status} ${data.error?.code||''}`);return data;};
    try{
      // A non-financial customer event proves real Stripe transport and deployed signing.
      if(!endpoint.enabled_events.includes('*')&&!endpoint.enabled_events.includes('customer.created')){await stripe.webhookEndpoints.update(endpoint.id,{enabled_events:[...endpoint.enabled_events,'customer.created']});changedEvents=true;}
      const started=Math.floor(Date.now()/1000),run=randomUUID();
      const signup=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${target.firebase.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:`vela-live-probe-${run}@vela.local`,password:randomUUID()+randomUUID(),returnSecureToken:true}),signal:AbortSignal.timeout(30000)});
      assert(signup.ok,'Production fixture authentication failed');user=await signup.json();
      await userApi('PATCH','/v1/me',{acceptedTerms:true,confirmedAdult:true});
      const result=await userApi('POST','/v1/billing/checkout-sessions',{tier:'go',successUrl:origin+'/?checkout=success',cancelUrl:origin+'/?checkout=cancel'});
      assert(result.status==='completed'&&new URL(result.url).hostname==='checkout.stripe.com','Production Checkout API response invalid');
      const record=await google(`${documentRoot}/customers/${user.localId}`);customer=await stripe.customers.retrieve(record.fields.stripeId.stringValue);assert(customer.livemode&&!customer.deleted);
      checkout=(await stripe.checkout.sessions.list({customer:customer.id,limit:10})).data.find(s=>s.url===result.url);
      assert(checkout?.livemode&&checkout.status==='open'&&checkout.payment_status==='unpaid','Unexpected Checkout state');
      assert(new URL(checkout.success_url).origin===origin&&new URL(checkout.cancel_url).origin===origin,'Production return origin mismatch');
      await stripe.checkout.sessions.expire(checkout.id);checkout=undefined;
      const session=await userApi('POST','/v1/billing/portal-sessions',{returnUrl:origin});assert(new URL(session.url).hostname==='billing.stripe.com');
      const deadline=Date.now()+120000;let delivered=false;
      while(Date.now()<deadline){const events=await stripe.events.list({type:'customer.created',created:{gte:started},limit:100});const event=events.data.find(e=>e.data.object.id===customer.id);if(event&&event.pending_webhooks===0){delivered=true;break;}await new Promise(r=>setTimeout(r,2000));}
      const wire=await stripe.webhookEndpoints.retrieve(endpoint.id);assert(wire.status==='enabled'&&wire.url===url&&(wire.enabled_events.includes('*')||wire.enabled_events.includes('customer.created')),'Production webhook changed during readiness probe');
      assert(delivered,'Real production webhook delivery was not confirmed');Object.assign(report,{liveCheckoutCreatedAndExpired:true,livePortalCreated:true,realWebhookDeliveryConfirmed:true});
    }finally{
      let failures=0;
      if(user&&!customer){try{const doc=await google(`${documentRoot}/customers/${user.localId}`);if(doc.fields?.stripeId?.stringValue)customer=await stripe.customers.retrieve(doc.fields.stripeId.stringValue);}catch{}}

      try{if(checkout)await stripe.checkout.sessions.expire(checkout.id);}catch{failures++;}
      try{if(customer)await stripe.customers.del(customer.id);}catch{failures++;}
      try{if(changedEvents){const current=await stripe.webhookEndpoints.retrieve(endpoint.id);await stripe.webhookEndpoints.update(endpoint.id,{enabled_events:current.enabled_events.filter(e=>e!=='customer.created')});}}catch{failures++;}
      if(user){
        try{await google(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:delete`,{method:'POST',body:{localId:user.localId}});}catch{failures++;}
        for(const path of [`users/${user.localId}`,`usage/${user.localId}`,`customers/${user.localId}`,`billingLocks/${user.localId}`])try{await deleteTree(path);}catch{failures++;}
      }
      report.cleanup=failures===0;assert.equal(failures,0,'Production readiness fixture cleanup failed');
    }
  }
  console.log(JSON.stringify(report));return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);assert(args.every(a=>['--apply-portal','--probe'].includes(a)),'Unsupported argument');
  await productionBillingPreflight({applyPortal:args.includes('--apply-portal'),probe:args.includes('--probe')}).catch(error=>{console.error(JSON.stringify({result:'failed',type:error.type||error.name,code:error.code,status:error.statusCode,assertion:error.name==='AssertionError'?error.message:undefined}));process.exitCode=1;});
}
