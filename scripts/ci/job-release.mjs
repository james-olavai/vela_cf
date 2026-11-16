// Credentials exist only in a private temporary directory outside uploaded evidence.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const phase=process.argv[2];
assert(['deploy','verify','production'].includes(phase),'Unknown CI release job');
assert.equal(process.env.CI,'true','This wrapper is CI-only');
assert.equal(process.env.VELA_ENVIRONMENT,phase==='production'?'production':'staging','Wrong CI environment');
assert(process.env.FIREBASE_SERVICE_ACCOUNT_B64,'Missing mandatory environment release credentials');
const dir=mkdtempSync(join(tmpdir(),'vela-ci-identity-')),file=join(dir,'adc.json');
const env={...process.env,GOOGLE_APPLICATION_CREDENTIALS:file,VELA_RELEASE_PHASE:phase==='production'?'all':phase};
if(phase==='production')env.VELA_BOOTSTRAP_STAGING='false';
delete env.FIREBASE_SERVICE_ACCOUNT_B64;delete env.FIREBASE_TOKEN;
if(!env.VELA_RELEASE_SERVICE_ACCOUNT)delete env.VELA_RELEASE_SERVICE_ACCOUNT;
const clean=()=>rmSync(dir,{recursive:true,force:true});
for(const [signal,code] of [['SIGTERM',143],['SIGINT',130]])process.once(signal,()=>{clean();process.exit(code);});
async function run(args){const child=spawn(process.execPath,args,{stdio:'inherit',env});const [code,signal]=await once(child,'exit');assert(code===0&&!signal,'CI release command failed');}
try{
  writeFileSync(file,Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64,'base64'),{mode:0o600});
  await run(['scripts/ci/release-preflight.mjs']);
  if(phase==='production'){
    const {loadEnvironment}=await import('./environments.mjs');
    if(loadEnvironment('production').billing?.enabled)await run(['scripts/ci/stripe-production.mjs']);
  }
  if(phase!=='verify')await run(['--import','./scripts/register-ts.mjs','scripts/ci/vertex-live.mjs']);
  await run(['scripts/ci/release.mjs']);
}finally{clean();}
