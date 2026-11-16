import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadEnvironment,validateEnvironment,hash} from './environments.mjs';
import {artifactHashes,codeIdentity,validateArtifact} from './artifact.mjs';
import {bindArtifact,verifyPromotion} from './bind-artifact.mjs';
const configuration=projectId=>({projectId,appId:'1:123:web:test',apiKey:'AIza-test',authDomain:`${projectId}.firebaseapp.com`,firestoreDatabaseId:'(default)'});
const staging=validateEnvironment({environment:'staging',firebase:configuration('vela-test-stage')},'staging','vela-test-prod');
const production=validateEnvironment({environment:'production',firebase:configuration('vela-test-prod')},'production');
test('Environment selection rejects missing staging, unknown keys, wrong audience and production reuse',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vela-env-'));
  try{
    writeFileSync(join(dir,'production.json'),JSON.stringify({environment:'production',firebase:configuration('vela-test-prod')}));
    assert.throws(()=>loadEnvironment('staging',dir),/Missing staging/);
    assert.throws(()=>loadEnvironment('prod',dir),/VELA_ENVIRONMENT/);
    assert.throws(()=>validateEnvironment({environment:'staging',firebase:configuration('vela-test-prod')},'staging','vela-test-prod'),/separate/);
    assert.throws(()=>validateEnvironment({...staging,apiBase:'https://evil.test'},'staging','vela-test-prod'),/Unknown/);
    assert.throws(()=>validateEnvironment({environment:'staging',firebase:{...configuration('vela-test-stage'),authDomain:'evil.test'}},'staging','vela-test-prod'),/Auth domain/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'vela-promote-'));
  for(const path of ['api/dist','web/assets'])mkdirSync(join(dir,path),{recursive:true});
  for(const [file,value] of Object.entries({'api/dist/index.cjs':'tested server','web/assets/app.js':'tested browser','web/index.html':'<script src="/runtime-config.js"></script>','web/runtime-config.js':'// unbound','web/version.json':'{}','firebase.template.json':JSON.stringify({functions:[{source:'api'}],hosting:{public:'web'},firestore:{rules:'firestore.rules'}})}))writeFileSync(join(dir,file),value);
  const hashes=artifactHashes(dir),manifest={sha:'a'.repeat(40),rollbackCapabilities:['profile-location-metadata'],hashes,...codeIdentity(hashes)};
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));return {dir,manifest};
}
test('Environment binding preserves identical executable files and refuses modified/rebound artifacts',()=>{
  const first=fixture(),second=fixture();
  try{
    const a=bindArtifact(first.dir,staging,first.manifest.sha),b=bindArtifact(second.dir,production,second.manifest.sha);
    assert.equal(a.codeHash,b.codeHash);assert.equal(a.hashes['web/assets/app.js'],b.hashes['web/assets/app.js']);assert.equal(a.hashes['api/dist/index.cjs'],b.hashes['api/dist/index.cjs']);
    assert.notEqual(a.hashes['web/runtime-config.js'],b.hashes['web/runtime-config.js']);
    assert.equal(JSON.parse(readFileSync(join(first.dir,'firebase.json'))).firestore.database,'(default)');
    assert(readFileSync(join(first.dir,'api/.env.vela-test-stage'),'utf8').includes('PAT_MODE=disabled'));
    assert.equal(validateArtifact(first.dir,a.sha).binding.environment,'staging');
    assert.throws(()=>bindArtifact(first.dir,production,a.sha),/fresh immutable/);
    writeFileSync(join(first.dir,'web/assets/app.js'),'changed');assert.throws(()=>validateArtifact(first.dir,a.sha),/modified/);
  }finally{for(const x of [first,second])rmSync(x.dir,{recursive:true,force:true});}
});
test('Production promotion requires complete same-code staging evidence and unchanged staging configuration',()=>{
  const {dir,manifest}=fixture();
  try{
    const bound=bindArtifact(dir,production,manifest.sha);
    const evidence={environment:'staging',status:'verified',sha:bound.sha,codeHash:bound.codeHash,configHash:staging.configHash,projectId:staging.firebase.projectId,checks:['candidate-vertex','deployed-browser','live-matrix','api-ready'],cases:['current-free','frozen-unlimited','exhausted-free','country-chart-pro','single-pro','pair-pro','four-person-pro','company-pro'].map(name=>({case:name,status:'passed'}))};
    verifyPromotion(bound,evidence,staging);
    for(const patch of [{status:'failed'},{sha:'b'.repeat(40)},{codeHash:hash('different')},{configHash:hash('changed')},{environment:'production'},{projectId:'vela-test-prod'},{checks:['candidate-vertex']},{cases:evidence.cases.slice(1)}])assert.throws(()=>verifyPromotion(bound,{...evidence,...patch},staging));
    assert.throws(()=>verifyPromotion(bound,{...evidence,cases:evidence.cases.map((c,i)=>i?c:{...c,status:'failed'})},staging));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Bootstrap requires a genuinely empty staging target and treats read failures as fatal',async()=>{
  const {emptyStagingSnapshot,rulesRelease}=await import('./bootstrap-staging.mjs');
  const inventory={existing:['chat'],introduced:['businessApi']},requests=[];
  const empty=async(url,options)=>{requests.push({url,options});return {};};
  const snapshot=await emptyStagingSnapshot(staging,production.firebase.projectId,inventory,{request:empty});
  assert(snapshot.firstDeployment);assert.equal(snapshot.hosting,null);assert.equal(snapshot.createdFunctions.length,2);
  assert.deepEqual(snapshot.createdRuleReleases,['projects/vela-test-stage/releases/cloud.firestore']);
  assert.equal(rulesRelease('p','named-db'),'projects/p/releases/cloud.firestore/named-db');
  await assert.rejects(emptyStagingSnapshot(production,production.firebase.projectId,inventory,{request:empty}),/staging-only/);
  await assert.rejects(emptyStagingSnapshot({...staging,firebase:production.firebase},production.firebase.projectId,inventory,{request:empty}),/Production/);
  for(const response of [{functions:[{}]},{users:[{}]},{collectionIds:['users']},{releases:[{}]},{nextPageToken:'more'},null]){
    await assert.rejects(emptyStagingSnapshot(staging,production.firebase.projectId,inventory,{request:async()=>response}));
  }
  await assert.rejects(emptyStagingSnapshot(staging,production.firebase.projectId,inventory,{request:async()=>{throw new Error('read denied');}}),/read denied/);
  assert(requests.some(r=>r.url.includes('accounts:batchGet')));assert(requests.some(r=>r.options?.body?.pageSize===1));
});

test('Deployment identity must belong to the selected project; no production credential fallback',async()=>{
  const {verifyReleaseIdentity}=await import('./release-preflight.mjs');
  const identity={type:'service_account',project_id:staging.firebase.projectId,client_email:`release@${staging.firebase.projectId}.iam.gserviceaccount.com`};
  verifyReleaseIdentity(identity,staging);
  assert.throws(()=>verifyReleaseIdentity(identity,production),/different environment/);
  assert.throws(()=>verifyReleaseIdentity({...identity,client_email:'human@example.test'},staging),/scoped/);
  assert.throws(()=>verifyReleaseIdentity({...identity,type:'authorized_user'},staging),/Dedicated/);
});

test('Bound artifacts reject executable edits even when outer hashes are refreshed',()=>{
  for(const extra of [false,true]){
    const {dir,manifest}=fixture();
    try{
      const bound=bindArtifact(dir,staging,manifest.sha);
      writeFileSync(join(dir,extra?'web/assets/extra.js':'web/assets/app.js'),'untested code');
      bound.hashes=artifactHashes(dir);writeFileSync(join(dir,'manifest.json'),JSON.stringify(bound));
      assert.throws(()=>validateArtifact(dir,manifest.sha),/Immutable code/);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});
test('Candidate evidence requires exact artifact/environment and successful real legacy tool execution',async()=>{
  const {verifyCandidateEvidence}=await import('./vertex-evidence.mjs');
  const manifest={sha:'abc',codeHash:'code',binding:{environment:'staging',projectId:'vela-stage',configHash:'config'}};
  const evidence={...manifest,...manifest.binding,status:'verified',cases:['current','frozen-legacy'].map(name=>({case:name,model:'vertexai/gemini-4-hydrogen',characters:35,usage:{inputTokens:12},tools:['transitEvents']}))};
  verifyCandidateEvidence(evidence,manifest);
  for(const patch of [{sha:'old'},{codeHash:'old'},{environment:'production'},{projectId:'wrong'},{configHash:'old'},{status:'running'},{cases:[]},{cases:[evidence.cases[0],evidence.cases[0]]},{cases:[evidence.cases[0],{...evidence.cases[1],tools:[]}]}])assert.throws(()=>verifyCandidateEvidence({...evidence,...patch},manifest));
  assert.throws(()=>verifyCandidateEvidence(undefined,manifest));
});

test('Trusted target detects rewritten runtime/deploy configuration even with refreshed hashes',async()=>{
  const {verifyBinding}=await import('./bind-artifact.mjs');
  for(const file of ['web/runtime-config.js','web/version.json','api/.env.vela-test-stage','environment.json','firebase.json']){
    const {dir,manifest}=fixture();
    try{
      const bound=bindArtifact(dir,staging,manifest.sha);verifyBinding(dir,bound,staging);
      writeFileSync(join(dir,file),'wrong environment');bound.hashes=artifactHashes(dir);writeFileSync(join(dir,'manifest.json'),JSON.stringify(bound));
      validateArtifact(dir,manifest.sha);
      assert.throws(()=>verifyBinding(dir,bound,staging),/Bound configuration changed/);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});

test('Billing binding is disabled by default, uses environment prices and refuses staging live mode or embedded secrets',()=>{
  const base={environment:'staging',firebase:configuration('vela-test-stage')};
  for(const billing of [{enabled:true,mode:'live',goPriceId:'price_go',proPriceId:'price_pro'},{enabled:true,mode:'test',goPriceId:'price_same',proPriceId:'price_same'},{enabled:true,mode:'test',goPriceId:'price_go',proPriceId:'price_pro',secretKey:'sk_test_private'}]) assert.throws(()=>validateEnvironment({...base,billing},'staging','vela-test-prod'));
  const target=validateEnvironment({...base,billing:{enabled:true,mode:'test',goPriceId:'price_go',proPriceId:'price_pro'}},'staging','vela-test-prod');
  const {dir,manifest}=fixture();
  try {
    bindArtifact(dir,target,manifest.sha);
    const env=readFileSync(join(dir,'api/.env.vela-test-stage'),'utf8');
    assert(env.includes('STRIPE_BILLING_ENABLED=true\n'));assert(env.includes('STRIPE_MODE=test\n'));assert(env.includes('STRIPE_PRICE_GO=price_go\n'));assert(!env.includes('STRIPE_SECRET_KEY'));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Short-lived release ADC requires explicit same-project target and official impersonation endpoint',async()=>{
  const {verifyReleaseIdentity}=await import('./release-preflight.mjs');
  const serviceAccount=`release@${staging.firebase.projectId}.iam.gserviceaccount.com`;
  const endpoint=`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`;
  const impersonated={type:'impersonated_service_account',service_account_impersonation_url:endpoint,source_credentials:{type:'authorized_user'}};
  const federated={type:'external_account',service_account_impersonation_url:endpoint,token_url:'https://sts.googleapis.com/v1/token',audience:'//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/ci-pool/providers/ci-provider',credential_source:{file:'/tmp/oidc-token'}};
  const options={serviceAccount,useGcloud:false};
  for(const identity of [impersonated,federated]) {
    assert.equal(verifyReleaseIdentity(identity,staging,options),serviceAccount);
    assert.equal(verifyReleaseIdentity({...identity,service_account_impersonation_url:endpoint.replace(serviceAccount,encodeURIComponent(serviceAccount))},staging,options),serviceAccount);
    assert.throws(()=>verifyReleaseIdentity(identity,production,options),/scoped/);
    assert.throws(()=>verifyReleaseIdentity({...identity,project_id:'other-project'},staging,options),/different environment/);
    assert.throws(()=>verifyReleaseIdentity(identity,staging,{serviceAccount:'other-release@vela-test-stage.iam.gserviceaccount.com'}),/does not match/);
    for(const url of [endpoint.replace('https:','http:'),endpoint.replace('iamcredentials.googleapis.com','evil.test'),endpoint+'?key=evil',endpoint+'#fragment',endpoint.replace('/projects/-/','/projects/other/'),endpoint.replace('https://','https://user@'),endpoint.replace('release@','release%2F@')])assert.throws(()=>verifyReleaseIdentity({...identity,service_account_impersonation_url:url},staging,options));
  }
  assert.throws(()=>verifyReleaseIdentity(impersonated,staging,{serviceAccount:'',useGcloud:false}),/Explicit/);
  assert.throws(()=>verifyReleaseIdentity({...impersonated,source_credentials:undefined},staging,options),/source/);
  assert.throws(()=>verifyReleaseIdentity({...federated,token_url:'https://evil.test'},staging,options),/token URL/);
  assert.throws(()=>verifyReleaseIdentity({...federated,audience:'not-a-pool'},staging,options),/audience/);
  assert.throws(()=>verifyReleaseIdentity({type:'authorized_user'},staging,options),/Dedicated/);
  const legacy={type:'service_account',project_id:staging.firebase.projectId,client_email:serviceAccount};
  assert.equal(verifyReleaseIdentity(legacy,staging,{serviceAccount,useGcloud:true}),serviceAccount);
  assert.throws(()=>verifyReleaseIdentity(legacy,staging,{serviceAccount:'',useGcloud:true}),/does not match/);
});

test('gcloud access tokens explicitly impersonate chosen release account and reject cross-project identity',async()=>{
  const {gcloudAccessTokenArgs}=await import('./google.mjs');
  const email=`release@${staging.firebase.projectId}.iam.gserviceaccount.com`;
  assert.deepEqual(gcloudAccessTokenArgs(email,staging.firebase.projectId),['auth','print-access-token',`--impersonate-service-account=${email}`]);
  assert.throws(()=>gcloudAccessTokenArgs(email,production.firebase.projectId),/different environment/);
  for(const invalid of ['human@example.test','--account=human','release@project.iam.gserviceaccount.com\n'])assert.throws(()=>gcloudAccessTokenArgs(invalid,staging.firebase.projectId));
});


test('Bootstrap retry accepts only complete Hosting history of SITE_DISABLE entries without versions',async()=>{
  const {emptyStagingSnapshot}=await import('./bootstrap-staging.mjs');
  const inventory={existing:['chat'],introduced:['businessApi']};
  const inspect=site=>async(url)=>url.includes('firebasehosting.googleapis.com')?site:{};
  const disabled={type:'SITE_DISABLE',name:'sites/vela-test-stage/releases/disabled'};
  for(const releases of [[],[disabled],[disabled,{...disabled,name:'older-disable'}]]) {
    let hostingUrl;
    const request=async url=>{if(url.includes('firebasehosting.googleapis.com')){hostingUrl=url;return {releases};}return {};};
    const snapshot=await emptyStagingSnapshot(staging,production.firebase.projectId,inventory,{request});
    assert.equal(snapshot.firstDeployment,true);assert.equal(snapshot.hosting,null);assert(hostingUrl.endsWith('?pageSize=100'));
  }
  for(const site of [{releases:[disabled],nextPageToken:'older-page'},{releases:[disabled,{type:'DEPLOY',version:{name:'real'}}]},{releases:[{...disabled,version:{name:'real'}}]},{releases:[{...disabled,version:null}]},{releases:[{type:'ROLLBACK'}]},{releases:[null]},{releases:'invalid'}])await assert.rejects(emptyStagingSnapshot(staging,production.firebase.projectId,inventory,{request:inspect(site)}));
  // A disabled site never exempts existing application resources from inspection.
  for(const occupied of [{functions:[{}]},{users:[{}]},{collectionIds:['users']}])await assert.rejects(emptyStagingSnapshot(staging,production.firebase.projectId,inventory,{request:async url=>url.includes('firebasehosting.googleapis.com')?{releases:[disabled]}:occupied}));
});
