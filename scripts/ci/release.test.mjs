import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {codeIdentity,assertCleanSource} from './artifact.mjs';
import { parseChat, parseHttpChat } from './live-smoke.mjs';
import { rollback, validateArtifact, configureGateway, verifyRollbackCapabilities, verifyReleaseOrigin } from './release.mjs';
const sse=data=>`data: ${JSON.stringify(data)}\n\n`;
test('HTTP 200 is insufficient: smoke requires text, done, final, and rejects stream errors',()=>{
  const text=sse({message:{type:'text',text:'reply'}}), done=sse({message:{type:'done'}}), final=sse({result:{text:'verified response '.repeat(4)}});
  assert.deepEqual(parseChat(text+done+final).eventTypes,['text','done']);
  for(const bad of [text,text+final,done+final,text+done,sse({error:{status:'RESOURCE_EXHAUSTED',message:'provider unavailable'}})]) assert.throws(()=>parseChat(bad));
});
const saved={functions:[{name:'projects/test/locations/asia-southeast1/functions/chat',buildConfig:{source:{storageSource:{bucket:'old',object:'source.zip',generation:'1'}},runtime:'nodejs22',entryPoint:'chat'}}],hosting:'sites/test/versions/old',rules:[{name:'projects/test/releases/cloud.firestore/test',rulesetName:'projects/test/rulesets/old'}]};
test('Rollback restores frozen Functions source, Hosting version, and Rules and waits for completion',async()=>{
  const calls=[];
  await rollback(saved,{sleep:async()=>{},request:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/functions/chat'))return {name:'projects/test/locations/asia-southeast1/operations/restore'};
    if(url.includes('/operations/'))return {done:true};
    if(url.endsWith('/releases?pageSize=1'))return {releases:[{version:{name:'sites/test/versions/new'}}]};
    return {};
  }});
  assert.deepEqual(calls[0].options.body.buildConfig.source,saved.functions[0].buildConfig.source);
  assert(calls.some(c=>c.url.includes('versionName=sites%2Ftest%2Fversions%2Fold')));
  assert(calls.some(c=>c.options?.body?.release?.rulesetName==='projects/test/rulesets/old'));
  assert(calls.some(c=>c.url.includes('/operations/')));
});
test('Partial rollback failure still attempts other services and fails the release',async()=>{
  const called=[];
  await assert.rejects(rollback(saved,{request:async(url)=>{
    called.push(url);
    if(url.includes('/functions/chat'))throw new Error('restore denied');
    if(url.endsWith('/releases?pageSize=1'))return {releases:[{version:{name:saved.hosting}}]};
    return {};
  }}),/Rollback incomplete/);
  assert(called.some(x=>x.includes('firebaserules.googleapis.com')));
  assert(called.some(x=>x.includes('firebasehosting.googleapis.com')));
});

test('Release refuses a wrong SHA, modified file, or untracked artifact file',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vela-artifact-'));
  try {
    writeFileSync(join(dir,'asset.js'),'tested');
    writeFileSync(join(dir,'manifest.json'),JSON.stringify({sha:'abc',hashes:{'asset.js':createHash('sha256').update('tested').digest('hex')},...codeIdentity({'asset.js':createHash('sha256').update('tested').digest('hex')})}));
    assert.equal(validateArtifact(dir,'abc').sha,'abc');
    assert.throws(()=>validateArtifact(dir,'wrong'),/commit/);
    writeFileSync(join(dir,'asset.js'),'changed');assert.throws(()=>validateArtifact(dir,'abc'),/modified/);
    writeFileSync(join(dir,'asset.js'),'tested');writeFileSync(join(dir,'extra.js'),'extra');
    assert.throws(()=>validateArtifact(dir,'abc'),/inventory/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Rollback deletes only explicitly introduced functions absent before deployment',async()=>{
  const name='projects/test/locations/asia-southeast1/functions/businessApi', calls=[];
  await rollback({...saved,createdFunctions:[name]}, {request:async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/functions'))return {functions:[{name},{name:'projects/test/locations/asia-southeast1/functions/unrelated'}]};
    if(options?.method==='DELETE')return {name:'projects/test/locations/asia-southeast1/operations/delete'};
    if(url.includes('/functions/chat'))return {name:'projects/test/locations/asia-southeast1/operations/restore'};
    if(url.includes('/operations/'))return {done:true};
    if(url.endsWith('/releases?pageSize=1'))return {releases:[{version:{name:'sites/test/versions/new'}}]};
    return {};
  }});
  assert.deepEqual(calls.filter(c=>c.options?.method==='DELETE').map(c=>c.url),[`https://cloudfunctions.googleapis.com/v2/${name}`]);
});

test('HTTP chat smoke requires useful final result and streamed completion',()=>{
  const good=sse({type:'text',text:'text'})+sse({type:'done'})+sse({type:'result',result:{text:'Useful final answer '.repeat(3)}});
  assert(parseHttpChat(good).characters>30);
  assert.throws(()=>parseHttpChat(sse({type:'done'})));
  assert.throws(()=>parseHttpChat(good+sse({type:'error',error:{code:'FAILED'}})));
});

test('Rollback skips Hosting creation when the saved version is already active',async()=>{
  const calls=[];
  await rollback(saved,{request:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/functions/chat'))return {name:'projects/test/locations/asia-southeast1/operations/restore'};
    if(url.includes('/operations/'))return {done:true};
    if(url.endsWith('/releases?pageSize=1'))return {releases:[{version:{name:saved.hosting}}]};
    if(options?.method==='POST')throw new Error('Cannot release current active version');
    return {};
  }});
  assert(calls.some(c=>c.url.endsWith('/releases?pageSize=1')));
  assert(!calls.some(c=>c.options?.method==='POST'));
  assert(calls.some(c=>c.options?.body?.release?.rulesetName===saved.rules[0].rulesetName));
  assert(calls.some(c=>c.url.includes('/operations/')));
});

test('Hosting lookup and restore failures remain fatal while Function operations finish',async()=>{
  for(const failure of ['lookup','missing-version','publish']) {
    const calls=[];
    await assert.rejects(rollback(saved,{request:async(url,options)=>{
      calls.push({url,options});
      if(url.includes('/functions/chat'))return {name:'projects/test/locations/asia-southeast1/operations/restore'};
      if(url.includes('/operations/'))return {done:true};
      if(url.endsWith('/releases?pageSize=1')) {
        if(failure==='lookup')throw new Error('lookup denied');
        return failure==='missing-version'?{}:{releases:[{version:{name:'sites/test/versions/new'}}]};
      }
      if(options?.method==='POST')throw new Error('publish denied');
      return {};
    }}),/Rollback incomplete/);
    assert(calls.some(c=>c.url.includes('/operations/')));
    assert.equal(calls.some(c=>c.options?.method==='POST'),failure==='publish');
  }
});


test('Gateway readiness tolerates IAM propagation but never accepts missing application auth', async () => {
  const { waitForApiGateway } = await import('./api-smoke.mjs');
  const ready = () => Response.json({error:{message:'AUTH_REQUIRED'}}, {status:401});
  let calls = 0;
  await waitForApiGateway('https://example.test', {fetchImpl:async()=>++calls === 1 ? new Response('<html>IAM denied</html>', {status:401}) : ready(), sleep:async()=>{}});
  assert.equal(calls,2);
  await assert.rejects(waitForApiGateway('https://example.test', {fetchImpl:async()=>new Response('denied',{status:403}),sleep:async()=>{},attempts:2}), /not ready after 2/);
  for (const response of [Response.json({items:[]}),Response.json({error:{message:'INVALID_TOKEN'}},{status:401})]) {
    await assert.rejects(waitForApiGateway('https://example.test', {fetchImpl:async()=>response,sleep:async()=>{}}), /did not enforce/);
  }
});


test('Gateway configuration changes only invoker checking, waits, and verifies the effective value',async()=>{
  let applied=false;const calls=[];
  const request=async(url,options)=>{calls.push({url,options});if(options?.method==='PATCH'){assert.deepEqual(Object.keys(options.body).sort(),['etag','invokerIamDisabled','name','template']);assert.equal(options.body.invokerIamDisabled,true);assert.deepEqual(options.body.template,{revision:''});return {name:'projects/test/locations/test/operations/update'};}if(url.includes('/operations/')){applied=true;return {done:true};}return {etag:'etag',invokerIamDisabled:applied};};
  await configureGateway(true,{request,sleep:async()=>{}});
  assert(calls.some(c=>c.url.endsWith('?updateMask=invokerIamDisabled,template.revision')));
  const before=calls.length;await configureGateway(true,{request});assert.equal(calls.length,before+1);
  await assert.rejects(configureGateway(true,{request:async(url,options)=>options?{done:true,error:{message:'denied'}}:{},sleep:async()=>{}}),/failed/);
});

test('Rollback restores the prior gateway setting for a pre-existing business API',async()=>{
  let restored=false;
  await rollback({...saved,gateway:{invokerIamDisabled:false}},{sleep:async()=>{},request:async(url,options)=>{
    if(url.includes('run.googleapis.com')){
      if(options?.method==='PATCH'){assert.equal(options.body.invokerIamDisabled,false);restored=true;return {done:true};}
      return {invokerIamDisabled:!restored};
    }
    if(url.includes('/functions/chat'))return {name:'projects/test/locations/test/operations/restore'};
    if(url.includes('/operations/'))return {done:true};
    if(url.endsWith('/releases?pageSize=1'))return {releases:[{version:{name:saved.hosting}}]};
    return {};
  }});
  assert(restored);
});


test('Release checks the active rollback capability before permitting new profile metadata writes',async()=>{
  const manifest={requiredRollbackCapabilities:['profile-location-metadata']};
  const active={sha:'a'.repeat(40),rollbackCapabilities:['profile-location-metadata']};
  const result=await verifyRollbackCapabilities(manifest,async(url,options)=>{
    assert(url.startsWith('https://'));assert(url.includes('/version.json?t='));
    assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert(options.signal);
    return Response.json(active);
  });
  assert.deepEqual(result,active);
  await assert.rejects(verifyRollbackCapabilities(manifest,async()=>Response.json({sha:'299c6404063039cced486781bc981a10fdfbf0b9'})),/preparation release first/);
  await assert.rejects(verifyRollbackCapabilities(manifest,async()=>Response.json({...active,rollbackCapabilities:['unrelated']})),/profile-location-metadata/);
});

test('Rollback capability gate fails closed on unavailable, malformed, or incomplete evidence',async()=>{
  const manifest={requiredRollbackCapabilities:['profile-location-metadata']};
  for(const response of [
    new Response('not found',{status:404}),new Response('<html>fallback</html>'),
    Response.json({sha:'not-a-commit',rollbackCapabilities:manifest.requiredRollbackCapabilities}),
    Response.json({sha:'b'.repeat(40),rollbackCapabilities:'profile-location-metadata'}),
    new Response('invalid JSON',{headers:{'content-type':'application/json'}}),
  ])await assert.rejects(verifyRollbackCapabilities(manifest,async()=>response));
  await assert.rejects(verifyRollbackCapabilities(manifest,async()=>{throw new Error('network unavailable');}),/network unavailable/);
  await assert.rejects(verifyRollbackCapabilities({},async()=>{assert.fail('Malformed manifest must fail before network');}),/Invalid required/);
  await verifyRollbackCapabilities({requiredRollbackCapabilities:[]},async()=>{assert.fail('Read-only preparation release has no new write capability requirement');});
});

test('Rollback restores owned environment variables and preserves unrelated live configuration',async()=>{
  let restored;
  await rollback({...saved,functions:saved.functions.map(f=>({...f,environmentVariables:{FIRESTORE_DATABASE_ID:'previous-db'}}))},{request:async(url,options)=>{
    if(url.includes('/functions/chat')){
      if(!options)return {serviceConfig:{environmentVariables:{FIRESTORE_DATABASE_ID:'new-db',PAT_MODE:'internal',UNRELATED:'preserved'}}};
      restored=options.body.serviceConfig.environmentVariables;return {done:true};
    }
    if(url.endsWith('/releases?pageSize=1'))return {releases:[{version:{name:saved.hosting}}]};
    return {done:true};
  }});
  assert.deepEqual(restored,{FIRESTORE_DATABASE_ID:'previous-db',UNRELATED:'preserved'});
});

test('Empty staging bootstrap failure disables only its site and removes only owned created resources',async()=>{
  const calls=[],site=[];
  const initial={firstDeployment:true,environment:'staging',projectId:'vela-test-stage',functions:[],hosting:null,rules:[],createdFunctions:['projects/vela-test-stage/locations/asia-southeast1/functions/chat'],createdRuleReleases:['projects/vela-test-stage/releases/cloud.firestore']};
  await rollback(initial,{disableHosting:async saved=>site.push(saved.projectId),request:async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/functions'))return {functions:[{name:initial.createdFunctions[0]},{name:'unrelated'}]};
    if(url.includes('firebaserules')&&!options)return {releases:[{name:initial.createdRuleReleases[0]},{name:'unrelated'}]};
    if(options?.method==='DELETE')return {name:'projects/vela-test-stage/locations/asia-southeast1/operations/delete'};
    return {done:true};
  }});
  assert.deepEqual(site,['vela-test-stage']);
  assert.deepEqual(calls.filter(c=>c.options?.method==='DELETE').map(c=>c.url),[`https://cloudfunctions.googleapis.com/v2/${initial.createdFunctions[0]}`,`https://firebaserules.googleapis.com/v1/${initial.createdRuleReleases[0]}`]);
  assert(!calls.some(c=>c.url.includes('firebasehosting.googleapis.com')));
  await assert.rejects(rollback({...initial,environment:'production'},{request:async()=>assert.fail('No request allowed')}),/Invalid bootstrap/);
});

test('Rollback restores previous secret versions and removes newly introduced bindings without logging secret values',async()=>{
  const previous=[{key:'STRIPE_SECRET_KEY',projectId:'project',secret:'STRIPE_SECRET_KEY',version:'3'}];
  for(const secretEnvironmentVariables of [previous,[]]) {
    let patch,urlMask;
    await rollback({...saved,functions:saved.functions.map(f=>({...f,secretEnvironmentVariables}))},{request:async(url,options)=>{
      if(url.includes('/functions/chat')) {patch=options.body.serviceConfig;urlMask=url;return {done:true};}
      if(url.endsWith('/releases?pageSize=1'))return {releases:[{version:{name:saved.hosting}}]};
      return {done:true};
    }});
    assert.deepEqual(patch.secretEnvironmentVariables,secretEnvironmentVariables);
    assert(urlMask.includes('serviceConfig.secretEnvironmentVariables'));
  }
});


test('Release preparation rejects tracked, staged and untracked source while ignoring local secrets',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vela-clean-source-'));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git('init');git('config','user.email','ci@example.invalid');git('config','user.name','CI');
    writeFileSync(join(dir,'.gitignore'),'.env\n');writeFileSync(join(dir,'source.ts'),'reviewed');
    git('add','.');git('commit','-m','fixture');
    const sha=git('rev-parse','HEAD');assert.equal(assertCleanSource(dir),sha);
    writeFileSync(join(dir,'.env'),'local secret fixture');assert.equal(assertCleanSource(dir),sha);
    writeFileSync(join(dir,'source.ts'),'modified');assert.throws(()=>assertCleanSource(dir),/clean Git worktree/);
    git('add','source.ts');assert.throws(()=>assertCleanSource(dir),/clean Git worktree/);
    git('reset','--hard','HEAD');writeFileSync(join(dir,'new.ts'),'unreviewed');assert.throws(()=>assertCleanSource(dir),/clean Git worktree/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('Local release is allowed only for initial staging bootstrap with explicit impersonated identity',()=>{
  const target={environment:'staging',firebase:{projectId:'velaastro-staging'}};
  const serviceAccount='vela-release@velaastro-staging.iam.gserviceaccount.com';
  const credentials={type:'impersonated_service_account',source_credentials:{type:'authorized_user'},service_account_impersonation_url:`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`};
  const input={target,credentials,serviceAccount,bootstrap:true,useGcloud:true};
  assert.equal(verifyReleaseOrigin(input),'local-staging-bootstrap');
  assert.equal(verifyReleaseOrigin({...input,ci:'true'}),'ci');
  for(const patch of [{bootstrap:false},{target:{...target,environment:'production'}},{serviceAccount:undefined},{credentials:{type:'authorized_user'}},{credentials:{type:'service_account',project_id:target.firebase.projectId,client_email:serviceAccount}},{credentials:{...credentials,service_account_impersonation_url:credentials.service_account_impersonation_url.replace('vela-release@','other-release@')}}])assert.throws(()=>verifyReleaseOrigin({...input,...patch}));
  assert.throws(()=>verifyReleaseOrigin({...input,ci:'true',target:{...target,environment:'production'}}),/Production bootstrap/);
});
