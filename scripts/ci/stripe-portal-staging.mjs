// Configure Stripe test-mode Portal only. Default is read-only; --apply performs update.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createRequire} from 'node:module';
import {loadEnvironment} from './environments.mjs';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const Stripe=require('stripe');
const target=loadEnvironment('staging'),origin=`https://${target.firebase.projectId}.web.app`;
assert.equal(origin,'https://velaastro-staging.web.app');
assert.equal(target.billing?.mode,'test');
const args=process.argv.slice(2);assert(args.every(arg=>arg==='--apply'),'Only --apply is supported');
let local={};try{local=parseEnv(readFileSync(new URL('../../.env',import.meta.url),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const key=process.env.STRIPE_SECRET_KEY||process.env.stripe_token||local.stripe_token||local.STRIPE_SECRET_KEY;
if(!key?.startsWith('sk_test_')){console.error('STRIPE_TEST_KEY_REQUIRED');process.exit(1);}
const stripe=new Stripe(key,{timeout:20_000,maxNetworkRetries:1});
try{
  const products=[];
  for(const [tier,id,amount] of [['go',target.billing.goPriceId,990],['pro',target.billing.proPriceId,2490]]){
    const price=await stripe.prices.retrieve(id,{expand:['product']});
    assert(!price.livemode&&price.active&&price.currency==='usd'&&price.unit_amount===amount&&price.recurring?.interval==='month'&&price.recurring.interval_count===1,`${tier} price mismatch`);
    const product=price.product;
    assert(typeof product!=='string'&&!product.deleted&&product.active&&!product.livemode&&product.metadata.firebaseRole===tier,`${tier} product metadata mismatch`);
    products.push({product:product.id,prices:[id],adjustable_quantity:{enabled:false}});
  }
  const defaults=[];for await(const config of stripe.billingPortal.configurations.list({limit:100,is_default:true}))defaults.push(config);
  assert.equal(defaults.length,1,'Expected exactly one existing default test Portal');
  assert(!defaults[0].livemode,'Refusing live Portal');
  const desired={active:true,default_return_url:origin,business_profile:{privacy_policy_url:origin+'/privacy',terms_of_service_url:origin+'/terms'},features:{invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_cancel:{enabled:true,mode:'at_period_end',proration_behavior:'none'},subscription_update:{enabled:true,default_allowed_updates:['price'],products,proration_behavior:'always_invoice'}}};
  const config=args.includes('--apply')?await stripe.billingPortal.configurations.update(defaults[0].id,desired):defaults[0];
  const verified=await stripe.billingPortal.configurations.retrieve(config.id,{expand:['features.subscription_update.products']});
  assert(!verified.livemode&&verified.is_default);
  if(args.includes('--apply')){
    assert.equal(verified.default_return_url,origin);assert.equal(verified.business_profile.terms_of_service_url,origin+'/terms');assert.equal(verified.business_profile.privacy_policy_url,origin+'/privacy');
    assert(verified.active&&verified.features.invoice_history.enabled&&verified.features.payment_method_update.enabled&&verified.features.subscription_cancel.enabled&&verified.features.subscription_update.enabled);
    assert.equal(verified.features.subscription_cancel.mode,'at_period_end');assert.equal(verified.features.subscription_update.proration_behavior,'always_invoice');
    assert.deepEqual(verified.features.subscription_update.default_allowed_updates,['price']);
    assert.deepEqual(verified.features.subscription_update.products.map(p=>({product:p.product,prices:p.prices,adjustable_quantity:{enabled:p.adjustable_quantity.enabled}})),products);
  }
  console.log(JSON.stringify({environment:'staging',mode:'test',applied:args.includes('--apply'),configurationId:verified.id,isDefault:verified.is_default,origin:verified.default_return_url,terms:verified.business_profile.terms_of_service_url,privacy:verified.business_profile.privacy_policy_url,features:{invoice:verified.features.invoice_history.enabled,paymentMethod:verified.features.payment_method_update.enabled,cancel:verified.features.subscription_cancel.enabled,cancelMode:verified.features.subscription_cancel.mode,subscriptionUpdate:verified.features.subscription_update.enabled,proration:verified.features.subscription_update.proration_behavior},products}));
}catch(error){console.error(JSON.stringify({result:'failed',type:error.type||error.name,code:error.code,status:error.statusCode,assertion:error.name==='AssertionError'?error.message:undefined}));process.exitCode=1;}
