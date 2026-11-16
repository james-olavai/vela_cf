import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('Stripe live gate import performs no network access or environment initialization',()=>{
  const moduleUrl=new URL('./stripe-live.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',`
    globalThis.fetch=()=>{throw new Error('Unexpected network request during import');};
    const module=await import(${JSON.stringify(moduleUrl)});
    if(typeof module.stripeLiveSmoke!=='function')process.exit(2);
    console.log('import-only');
  `],{encoding:'utf8',timeout:5000,env:{...process.env,VELA_ENVIRONMENT:'invalid-import-test',STRIPE_SECRET_KEY:'sk_live_import_must_not_use'}});
  assert.equal(child.status,0);assert.equal(child.stdout.trim(),'import-only');assert.equal(child.stderr,'');
});
