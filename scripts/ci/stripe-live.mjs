import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const repo=fileURLToPath(new URL('../../',import.meta.url));
async function executeStripeSmoke(browserCheckout,report){
assert.equal(process.env.VELA_ENVIRONMENT,'staging','Explicit staging required');
const {google,project,config,documentRoot,deleteTree,environmentConfig}=await import(`${repo}/scripts/ci/google.mjs`);
assert.equal(project,'velaastro-staging');assert.equal(environmentConfig.billing.mode,'test');assert.equal(environmentConfig.billing.enabled,true,'Staging billing must be enabled');
const require=createRequire(`${repo}/apps/api/package.json`),Stripe=require('stripe');
const configuredKey=process.env.STRIPE_SECRET_KEY;
const secret=configuredKey?null:await google(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/STRIPE_SECRET_KEY/versions/latest:access`);
const key=configuredKey||Buffer.from(secret.payload.data,'base64').toString('utf8');
assert(key?.startsWith('sk_test_'),'Test key required');
const stripe=new Stripe(key,{timeout:20000,maxNetworkRetries:1}),run=`vela-stage-payment-${randomUUID()}`;
const origin=`https://${project}.web.app`,base=environmentConfig.apiBase;
let user,customer,subscription,phase='preflight',checkoutId;
report.run=run;
const pass=name=>{report.checks.push(name);console.log(`PASS ${name}`);};
async function authCall(operation,body){const res=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${operation}?key=${config.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const data=await res.json();assert(res.ok,`Auth ${operation} failed HTTP ${res.status}`);return data;}
async function api(method,path,body){const res=await fetch(`${base}${path}`,{method,headers:{Authorization:`Bearer ${user.idToken}`,'Content-Type':'application/json',Origin:origin},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});const data=await res.json();assert(res.ok,`API ${method} ${path} failed HTTP ${res.status} ${data.error?.code||''}`);return data;}
async function claims(){const data=await google(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:lookup`,{method:'POST',body:{localId:[user.localId]}});assert.equal(data.users?.[0]?.localId,user.localId);return JSON.parse(data.users[0].customAttributes||'{}');}
async function observe(tier,status){phase=`observe-${tier}-${status}`;const deadline=Date.now()+150000;while(Date.now()<deadline){const [subs,usage,roles]=await Promise.all([api('GET','/v1/me/subscription'),api('GET','/v1/me/usage'),claims()]);if(subs.items.some(s=>s.id===subscription.id&&s.status===status)&&usage.tier===tier&&(roles.stripeRole||'free')===tier){assert.equal(usage.unlimited,false);pass(`Webhook subscription ${status}, Auth ${tier}, API quota ${tier}`);return;}await new Promise(r=>setTimeout(r,3000));}throw new Error('SYNC_TIMEOUT');}

async function completeCheckoutInBrowser(url,sessionId){
  phase='browser-checkout';report.browserCheckout='pending';
  const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||'playwright-core');
  const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
  try{
    const context=await browser.newContext({locale:'en-US',viewport:{width:1280,height:1000}}),page=await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    async function locate(selectors,required=true){
      const deadline=Date.now()+(required?30000:2000);
      while(Date.now()<deadline){for(const frame of page.frames())for(const selector of selectors){const locator=frame.locator(selector).first();if(await locator.isVisible().catch(()=>false))return locator;}await new Promise(r=>setTimeout(r,250));}
      if(required)throw new Error('CHECKOUT_FIELD_MISSING');return null;
    }
    async function fill(selectors,value,required=false){const field=await locate(selectors,required);if(field)await field.fill(value);}
    report.browserStep='email';await fill(['#email','input[type=email]'],`${run}@vela.local`);
    const cardButton=page.getByRole('button',{name:/^card$/i}).first();if(await cardButton.isVisible().catch(()=>false))await cardButton.click();
    report.browserStep='test-card';
    await fill(['#cardNumber','input[name=cardNumber]','input[autocomplete=cc-number]'],'4242424242424242',true);
    await fill(['#cardExpiry','input[name=cardExpiry]','input[autocomplete=cc-exp]'],'1234',true);
    await fill(['#cardCvc','input[name=cardCvc]','input[autocomplete=cc-csc]'],'123',true);
    report.browserStep='billing';await fill(['#billingName','input[name=billingName]','input[autocomplete=cc-name]'],'Vela Test Customer');
    const country=await locate(['select#billingCountry','select[name=billingCountry]','select[autocomplete=country]'],false);if(country)await country.selectOption('US');
    const manualAddress=page.getByText(/enter address manually/i).first();if(await manualAddress.isVisible().catch(()=>false))await manualAddress.click();
    await fill(['#billingAddressLine1','input[name=billingAddressLine1]','input[autocomplete=address-line1]'],'123 Test Street');
    await fill(['#billingAddressLine2','input[name=billingAddressLine2]'],'Test fixture');
    await fill(['#billingLocality','input[name=billingLocality]','input[autocomplete=address-level2]'],'San Francisco');
    const state=await locate(['#billingAdministrativeArea','[name=billingAdministrativeArea]','[autocomplete=address-level1]'],false);if(state){if(await state.evaluate(el=>el.tagName==='SELECT'))await state.selectOption('CA');else await state.fill('CA');}
    await fill(['#billingPostalCode','input[name=billingPostalCode]','input[autocomplete=postal-code]'],'94107');
    report.browserStep='terms';
    const terms=await locate(['input#termsOfServiceConsentCheckbox','input[name=termsOfServiceConsent]','input[type=checkbox][required]'],false);
    if(terms)await terms.check();else{const checkbox=page.getByRole('checkbox',{name:/terms/i}).first();await checkbox.check();}
    report.browserStep='submit';const submit=await locate(['button[type=submit]'],true);await submit.click();
    report.browserStep='provider-confirmation';const deadline=Date.now()+120000;
    while(Date.now()<deadline){
      const completed=await stripe.checkout.sessions.retrieve(sessionId,{expand:['subscription.latest_invoice']});
      if(completed.status==='complete'&&completed.payment_status==='paid'){
        assert(completed.subscription&&typeof completed.subscription!=='string');
        assert.equal(completed.subscription.status,'active');assert.equal(completed.subscription.latest_invoice.status,'paid');
        report.browserCheckout='passed';delete report.browserStep;pass('Browser submitted test card and required terms; Stripe Checkout complete and initial invoice paid');return completed.subscription;
      }
      await new Promise(r=>setTimeout(r,2000));
    }
    throw new Error('BROWSER_CHECKOUT_PAYMENT_TIMEOUT');
  }finally{await browser.close();}
}

try{
  for(const [tier,id,amount] of [['go',environmentConfig.billing.goPriceId,990],['pro',environmentConfig.billing.proPriceId,2490]]){const price=await stripe.prices.retrieve(id,{expand:['product']});assert(!price.livemode&&price.active&&price.unit_amount===amount&&price.product.metadata.firebaseRole===tier);}
  pass('test prices and product roles verified');
  phase='signup';user=await authCall('signUp',{email:`${run}@vela.local`,password:randomUUID()+randomUUID(),returnSecureToken:true});assert(user.idToken&&user.localId);report.uid=user.localId;console.log(`TEST_UID ${user.localId}`);
  await api('PATCH','/v1/me',{acceptedTerms:true,confirmedAdult:true});assert.equal((await api('GET','/v1/me/usage')).tier,'free');pass('synthetic Firebase account starts free');
  phase='checkout';const checkout=await api('POST','/v1/billing/checkout-sessions',{tier:'go',successUrl:origin+'/?checkout=success',cancelUrl:origin+'/?checkout=cancel'});assert.equal(checkout.status,'completed');const checkoutUrl=new URL(checkout.url);assert.equal(checkoutUrl.hostname,'checkout.stripe.com');
  let matches;const customerDeadline=Date.now()+120000;do{matches=await stripe.customers.search({query:`metadata['firebaseUID']:'${user.localId}'`,limit:10});if(matches.data.length)break;await new Promise(r=>setTimeout(r,3000));}while(Date.now()<customerDeadline);assert.equal(matches.data.length,1,'UID customer mapping must be unique');customer=matches.data[0];assert(!customer.livemode);assert.equal(customer.metadata.firebaseUID,user.localId);
  const pending=await stripe.checkout.sessions.list({customer:customer.id,limit:10});const session=pending.data.find(s=>s.url===checkout.url);assert(session&&!session.livemode&&session.status==='open');checkoutId=session.id;
  if(browserCheckout){
    subscription=await completeCheckoutInBrowser(checkout.url,session.id);checkoutId=undefined;
  }else{
    await stripe.checkout.sessions.expire(session.id);checkoutId=undefined;pass('API created real test Checkout and UID customer mapping; Checkout expired without browser payment');
    phase='go';subscription=await stripe.subscriptions.create({customer:customer.id,items:[{price:environmentConfig.billing.goPriceId}],default_payment_method:(await stripe.paymentMethods.attach('pm_card_visa',{customer:customer.id})).id,metadata:{vela_test_run:run},payment_behavior:'error_if_incomplete',expand:['latest_invoice']});assert.equal(subscription.latest_invoice.status,'paid');
  }
  await observe('go','active');
  phase='portal';const portal=await api('POST','/v1/billing/portal-sessions',{returnUrl:origin});assert.equal(new URL(portal.url).hostname,'billing.stripe.com');pass('Portal API created session using staging return URL');
  phase='pro';subscription=await stripe.subscriptions.update(subscription.id,{items:[{id:subscription.items.data[0].id,price:environmentConfig.billing.proPriceId}],proration_behavior:'always_invoice',payment_behavior:'error_if_incomplete',expand:['latest_invoice']});assert.equal(subscription.latest_invoice.status,'paid');await observe('pro','active');
  phase='cancel';subscription=await stripe.subscriptions.cancel(subscription.id);await observe('free','canceled');
}catch(error){if(report.browserCheckout==='pending')report.browserCheckout='failed';report.result='failed';report.failure={phase,type:error.type||error.name,code:typeof error.code==='string'&&/^[A-Za-z0-9_-]+$/.test(error.code)?error.code:undefined,status:error.statusCode};}
finally{
  phase='cleanup';const failures=[];
  if(user&&!customer){try{const matches=await stripe.customers.search({query:`metadata['firebaseUID']:'${user.localId}'`,limit:10});if(matches.data.length===1)customer=matches.data[0];else if(matches.data.length>1)failures.push('ambiguous-customer');}catch{failures.push('customer-recovery');}}
  if(customer){try{for await(const sub of stripe.subscriptions.list({customer:customer.id,status:'all',limit:100})){if(sub.status!=='canceled'&&sub.status!=='incomplete_expired')await stripe.subscriptions.cancel(sub.id);}if(checkoutId&&(await stripe.checkout.sessions.retrieve(checkoutId)).status==='open')await stripe.checkout.sessions.expire(checkoutId);await stripe.customers.del(customer.id);}catch{failures.push('stripe');}}
  if(user){
    // Remove Auth first: subsequent delayed real Webhooks cannot regrant claims.
    try{await google(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:delete`,{method:'POST',body:{localId:user.localId}});}catch{failures.push('auth');}
    for(const path of [`users/${user.localId}`,`usage/${user.localId}`,`customers/${user.localId}`,`billingLocks/${user.localId}`])try{await deleteTree(path);}catch{failures.push('firestore-tree');}
    try{const records=await google(`${documentRoot}:runQuery`,{method:'POST',body:{structuredQuery:{from:[{collectionId:'stripeEvents'}],where:{fieldFilter:{field:{fieldPath:'uid'},op:'EQUAL',value:{stringValue:user.localId}}}}}});for(const item of records)if(item.document)await google(`https://firestore.googleapis.com/v1/${item.document.name}`,{method:'DELETE'});}catch{failures.push('event-receipts');}
  }
  report.cleanup=failures.length===0;report.cleanupFailures=failures;if(failures.length)report.result='failed';
}

}

export async function stripeLiveSmoke({browserCheckout=false}={}){
  const report={environment:'staging',scope:browserCheckout?'browser-checkout-real-webhook-real-firebase':'sdk-subscription-real-webhook-real-firebase',checkoutMode:browserCheckout?'browser-test-card':'creation-only-sdk-subscription',checks:[],cleanup:false,result:'passed'};
  try{
    await executeStripeSmoke(browserCheckout,report);
  }catch(error){report.result='failed';report.failure={phase:'preflight',type:error.type||error.name};}
  finally{
    mkdirSync(resolve(repo,'artifacts'),{recursive:true});
    writeFileSync(resolve(repo,'artifacts/stripe-live.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
  }
  if(report.result!=='passed'||!report.cleanup)throw Object.assign(new Error('STRIPE_LIVE_FAILED'),{report});
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  if(!args.every(arg=>arg==='--browser-checkout')){console.error('Unsupported argument');process.exitCode=1;}
  else await stripeLiveSmoke({browserCheckout:args.includes('--browser-checkout')}).catch(()=>{process.exitCode=1;});
}
