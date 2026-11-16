// Explicit provider integration test. Does not assert Vela webhook/Auth synchronization.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { loadEnvironment } from './environments.mjs';
const target = loadEnvironment('staging');
const testOrigin = `https://${target.firebase.projectId}.web.app`;
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const Stripe = require('stripe');
let local = {};
try { local = parseEnv(readFileSync(new URL('../../.env', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const key = process.env.STRIPE_SECRET_KEY || process.env.stripe_token || local.stripe_token || local.STRIPE_SECRET_KEY;
if (!key?.startsWith('sk_test_')) {
  console.error('STRIPE_TEST_KEY_REQUIRED: refusing missing, live or unrecognized credentials');
  process.exit(1);
}
const stripe = new Stripe(key, { timeout: 20_000, maxNetworkRetries: 1 });
const lifecycleOnly=process.argv.includes('--lifecycle-only');
assert(process.argv.slice(2).every(arg=>arg==='--lifecycle-only'),'Unsupported Stripe test argument');
const run = `vela-billing-test-${randomUUID()}`;
const metadata = { vela_test_run: run };
let clock, checkout;
if(lifecycleOnly)console.log('PROVIDER LIFECYCLE ONLY: excludes Checkout, Vela webhook delivery and Firebase entitlement synchronization');
const report = { run, mode: 'test', scope: 'stripe-provider-only', environment: target.environment, origin: testOrigin, checkout: lifecycleOnly?'not-run':'pending', checks: [], cleanup: false };
function check(name, condition) { assert(condition, name); report.checks.push(name); console.log(`PASS ${name}`); }
async function advance(frozen_time) {
  await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await stripe.testHelpers.testClocks.retrieve(clock.id);
    if (state.status === 'ready') return;
    assert.equal(state.status, 'advancing', 'clock failed');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('CLOCK_TIMEOUT');
}
try {
  const products = [];
  for await (const product of stripe.products.list({ active: true, limit: 100 })) products.push(product);
  const prices = {};
  for (const [tier, amount] of [['go', 990], ['pro', 2490]]) {
    const matches = products.filter(p => p.metadata.firebaseRole === tier);
    check(`${tier} unique firebaseRole product`, matches.length === 1);
    const price = await stripe.prices.retrieve(matches[0].default_price);
    check(`${tier} active USD monthly price`, !price.livemode && price.active && price.currency === 'usd' && price.unit_amount === amount && price.recurring?.interval === 'month' && price.recurring.interval_count === 1);
    prices[tier] = price.id;
  }
  clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now()/1000), name: run });
  console.log(`TEST_CLOCK ${clock.id}`); // Recovery identifier, never a credential.
  const customer = await stripe.customers.create({ name: run, test_clock: clock.id, metadata, payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' } });
  if(!lifecycleOnly){
  checkout = await stripe.checkout.sessions.create({ customer: customer.id, mode: 'subscription', automatic_tax: {enabled:true}, customer_update: {address:'auto'}, consent_collection: {terms_of_service:'required'}, line_items: [{ price: prices.go, quantity: 1 }], success_url: `${testOrigin}/?test=success`, cancel_url: `${testOrigin}/?test=cancel`, metadata });
  check('checkout session created in test mode', checkout.livemode === false && checkout.status === 'open' && Boolean(checkout.url));
  await stripe.checkout.sessions.expire(checkout.id); checkout = undefined;
    report.checkout='creation-passed';
  }
  let subscription = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: prices.go }], metadata, payment_behavior: 'error_if_incomplete', expand: ['latest_invoice'] });
  check('Go initial invoice paid', subscription.status === 'active' && subscription.latest_invoice.status === 'paid');
  subscription = await stripe.subscriptions.update(subscription.id, { items: [{ id: subscription.items.data[0].id, price: prices.pro }], proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete', expand: ['latest_invoice'] });
  check('Pro upgrade invoice paid', subscription.items.data[0].price.id === prices.pro && subscription.status === 'active' && subscription.latest_invoice.status === 'paid');
  const oldInvoice = subscription.latest_invoice.id;
  const periodEnd = subscription.items.data[0].current_period_end;
  assert(Number.isInteger(periodEnd), 'missing subscription period');
  await advance(periodEnd + 7200);
  subscription = await stripe.subscriptions.retrieve(subscription.id, { expand: ['latest_invoice'] });
  check('renewal paid with new invoice', subscription.latest_invoice.id !== oldInvoice && subscription.latest_invoice.status === 'paid' && subscription.status === 'active');
  subscription = await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
  check('scheduled cancellation preserves active period', subscription.cancel_at_period_end && subscription.status === 'active');
  await advance(subscription.items.data[0].current_period_end + 1);
  subscription = await stripe.subscriptions.retrieve(subscription.id);
  check('canceled at period end', subscription.status === 'canceled');
  // Independent failed-renewal scenario, using an attachable official decline fixture.
  let failed = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: prices.go }], metadata, payment_behavior: 'error_if_incomplete' });
  const decline = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: customer.id });
  failed = await stripe.subscriptions.update(failed.id, { default_payment_method: decline.id });
  await advance(failed.items.data[0].current_period_end + 7200);
  failed = await stripe.subscriptions.retrieve(failed.id, { expand: ['latest_invoice'] });
  console.log(JSON.stringify({scenario:'failed-renewal',subscriptionStatus:failed.status,invoiceStatus:failed.latest_invoice.status,attempts:failed.latest_invoice.attempt_count}));
  check('failed renewal leaves unpaid invoice and past_due subscription', failed.status === 'past_due' && failed.latest_invoice.status === 'open' && failed.latest_invoice.attempt_count > 0);
  failed = await stripe.subscriptions.cancel(failed.id);
  check('past_due subscription can be canceled', failed.status === 'canceled');
} catch (error) {
  // Never serialize Stripe errors: they can carry request payloads and authentication headers.
  const message=String(error.message||'');
  const configurationHint=/terms.of.service/i.test(message)?'Configure Stripe public business terms-of-service URL':/customer_update.*address|customer.*address/i.test(message)?'Automatic Tax requires a customer billing address or customer_update.address=auto':/tax/i.test(message)?'Verify Stripe Tax configuration and tax registrations':undefined;
  console.error(JSON.stringify({ configurationHint, result: 'failed', type: error.type || error.name, code: error.code, status: error.statusCode, assertion: error.name === 'AssertionError' ? error.message : undefined }));
  process.exitCode = 1;
} finally {
  try {
    if (checkout) await stripe.checkout.sessions.expire(checkout.id);
    if (clock) await stripe.testHelpers.testClocks.del(clock.id);
    report.cleanup = true;
  } catch { console.error('TEST_FIXTURE_CLEANUP_FAILED: remove only the TEST_CLOCK printed above'); process.exitCode = 1; }
  console.log(JSON.stringify(report));
}
