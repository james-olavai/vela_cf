import {verifyBinding} from './bind-artifact.mjs';
import {verifyCandidateEvidence} from './vertex-evidence.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { google, project, config, environment, environmentConfig } from './google.mjs';
import { verifyReleaseIdentity } from './release-preflight.mjs';
import { loadEnvironment } from './environments.mjs';
import { validateArtifact } from './artifact.mjs';
import { verifyPromotion } from './bind-artifact.mjs';
import { emptyStagingSnapshot, disableStagingHosting, rulesRelease } from './bootstrap-staging.mjs';
import { stagingBrowser } from './staging-browser.mjs';
export { validateArtifact } from './artifact.mjs';
import { liveSmoke, liveApiSmoke } from './live-smoke.mjs';
import { waitForApiGateway } from './api-smoke.mjs';
const tools=JSON.parse(readFileSync(new URL('./tools.json',import.meta.url),'utf8'));
const functionsRoot=`https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/asia-southeast1`;
const hosting=`https://firebasehosting.googleapis.com/v1beta1/sites/${project}/releases`;
const rules=`https://firebaserules.googleapis.com/v1/projects/${project}/releases`;
const ownedEnvironmentKeys=['FIRESTORE_DATABASE_ID','VELA_ENVIRONMENT','PAT_AUDIENCE','PAT_MODE','PAT_ALLOWED_UIDS','STRIPE_BILLING_ENABLED','STRIPE_MODE','STRIPE_PRICE_GO','STRIPE_PRICE_PRO'];
const businessService=`projects/${project}/locations/asia-southeast1/services/businessapi`;
export async function configureGateway(disabled, {request=google, sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const url=`https://run.googleapis.com/v2/${businessService}`;
  const current=await request(url);
  if(Boolean(current.invokerIamDisabled)===disabled)return;
  let op=await request(`${url}?updateMask=invokerIamDisabled,template.revision`,{method:'PATCH',body:{name:businessService,etag:current.etag,invokerIamDisabled:disabled,template:{revision:''}}});
  for(let i=0;!op.done && i<24;i++) {await sleep(5000);op=await request(`https://run.googleapis.com/v2/${op.name}`);}
  assert(op.done&&!op.error,'Cloud Run gateway configuration failed or timed out');
  const updated=await request(url);
  assert.equal(Boolean(updated.invokerIamDisabled),disabled,'Cloud Run gateway configuration was not applied');
}
async function listFunctions(request=google) {
  const found=[];let pageToken;
  do {
    const page=await request(`${functionsRoot}/functions${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    found.push(...(page.functions||[]));pageToken=page.nextPageToken;
  } while(pageToken);
  return {functions:found};
}
export async function snapshot(inventory) {
  const [functions,site,releases]=await Promise.all([listFunctions(),google(`${hosting}?pageSize=1`),google(rules)]);
  assert(site.releases?.[0]?.version?.name,'No Hosting rollback version available');
  assert(inventory?.existing?.length && Array.isArray(inventory.introduced),'Missing owned function inventory');
  const expected=[...inventory.existing,...inventory.introduced];
  assert(new Set(expected).size===expected.length && expected.every(n=>/^[A-Za-z][A-Za-z0-9_]*$/.test(n)),'Invalid function inventory');
  const saved={functions:(functions.functions||[]).filter(f=>expected.includes(f.name.split('/').at(-1))).map(f=>({name:f.name,buildConfig:{source:f.buildConfig.source,runtime:f.buildConfig.runtime,entryPoint:f.buildConfig.entryPoint},secretEnvironmentVariables:f.serviceConfig?.secretEnvironmentVariables||[],environmentVariables:Object.fromEntries(ownedEnvironmentKeys.filter(key=>f.serviceConfig?.environmentVariables?.[key]!==undefined).map(key=>[key,f.serviceConfig.environmentVariables[key]]))})),hosting:site.releases[0].version.name,rules:(releases.releases||[]).filter(r=>r.name===rulesRelease(project,config.firestoreDatabaseId)).map(r=>({name:r.name,rulesetName:r.rulesetName}))};
  const present=new Set(saved.functions.map(f=>f.name.split('/').at(-1)));
  assert(inventory.existing.every(n=>present.has(n))&&saved.functions.every(f=>f.buildConfig.source?.storageSource),'Missing Functions rollback sources');
  saved.createdFunctions=inventory.introduced.filter(n=>!present.has(n)).map(n=>`projects/${project}/locations/asia-southeast1/functions/${n}`);
  if(present.has('businessApi')) saved.gateway={invokerIamDisabled:Boolean((await google(`https://run.googleapis.com/v2/${businessService}`)).invokerIamDisabled)};
  assert(saved.rules.length>0,'Missing Firestore rollback rulesets');return saved;
}
export async function rollback(saved, { request=google, sleep=ms=>new Promise(r=>setTimeout(r,ms)), timeoutMs=20*60_000, disableHosting=disableStagingHosting }={}) {
  const pending=[], errors=[];
  if(saved.firstDeployment)assert(saved.environment==='staging' && saved.projectId!==loadEnvironment('production').firebase.projectId,'Invalid bootstrap rollback target');
  for(const f of saved.functions) try {
    let serviceConfig;
    if(f.environmentVariables){const current=await request(`https://cloudfunctions.googleapis.com/v2/${f.name}`),variables={...current.serviceConfig?.environmentVariables};for(const key of ownedEnvironmentKeys){if(key in f.environmentVariables)variables[key]=f.environmentVariables[key];else delete variables[key];}serviceConfig={environmentVariables:variables};}
    if(f.secretEnvironmentVariables!==undefined)serviceConfig={...serviceConfig,secretEnvironmentVariables:f.secretEnvironmentVariables};
    const op=await request(`https://cloudfunctions.googleapis.com/v2/${f.name}?updateMask=buildConfig.source,buildConfig.runtime,buildConfig.entryPoint${f.environmentVariables?',serviceConfig.environmentVariables':''}${f.secretEnvironmentVariables!==undefined?',serviceConfig.secretEnvironmentVariables':''}`,{method:'PATCH',body:{name:f.name,buildConfig:{source:f.buildConfig.source,runtime:f.buildConfig.runtime,entryPoint:f.buildConfig.entryPoint},...(serviceConfig?{serviceConfig}:{})}});
    pending.push(op.name);
  } catch(e) { errors.push(e); }
  for(const name of saved.createdFunctions || []) try {
    // Only names absent from the pre-release snapshot and explicitly owned by this release.
    const all=await listFunctions(request);
    if((all.functions||[]).some(f=>f.name===name)) {const op=await request(`https://cloudfunctions.googleapis.com/v2/${name}`,{method:'DELETE'});pending.push(op.name);}
  } catch(e) {errors.push(e);}
  for(const r of saved.rules) try { await request(`https://firebaserules.googleapis.com/v1/${r.name}`,{method:'PATCH',body:{release:r,updateMask:'rulesetName'}}); } catch(e) { errors.push(e); }
  for(const name of saved.createdRuleReleases || [])try{const current=await request(`https://firebaserules.googleapis.com/v1/projects/${saved.projectId}/releases`);if((current.releases||[]).some(r=>r.name===name))await request(`https://firebaserules.googleapis.com/v1/${name}`,{method:'DELETE'});}catch(e){errors.push(e);}
  try {
    if(saved.firstDeployment)await disableHosting(saved,loadEnvironment('production').firebase.projectId,tools.firebase);
    else {
    const site=await request(`${hosting}?pageSize=1`);
    const active=site.releases?.[0]?.version?.name;
    assert(active,'No active Hosting version available during rollback');
    if(active!==saved.hosting) await request(`${hosting}?versionName=${encodeURIComponent(saved.hosting)}`,{method:'POST',body:{message:'Automatic rollback after failed release validation'}});
    }
  } catch(e){errors.push(e);}
  const deadline=Date.now()+timeoutMs;
  while(pending.length&&Date.now()<deadline) {
    for(let i=pending.length-1;i>=0;i--) {
      const op=await request(`https://cloudfunctions.googleapis.com/v2/${pending[i]}`);
      if(op.done) { if(op.error) errors.push(new Error(op.error.message));pending.splice(i,1); }
    }
    if(pending.length) await sleep(5000);
  }
  if(pending.length) errors.push(new Error('Rollback operations timed out'));
  if(saved.gateway)try {await configureGateway(saved.gateway.invokerIamDisabled,{request,sleep});}catch(e){errors.push(e);}
  if(errors.length) throw new AggregateError(errors,'Rollback incomplete; see saved release snapshot');
}
// Fail before any deployment: the saved server must be able to read data this release can create.
export async function verifyRollbackCapabilities(manifest, fetchImpl=fetch) {
  const required=manifest.requiredRollbackCapabilities;
  assert(Array.isArray(required) && required.every(value=>typeof value==='string' && /^[a-z0-9-]+$/.test(value)) && new Set(required).size===required.length,'Invalid required rollback capabilities');
  if(!required.length)return;
  const response=await fetchImpl(`https://${project}.web.app/version.json?t=${Date.now()}`,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30_000)});
  assert(response.ok && response.headers.get('content-type')?.includes('application/json'),'Cannot verify the active rollback release capabilities');
  const active=await response.json();
  assert(typeof active.sha==='string' && /^[a-f0-9]{40}$/.test(active.sha),'Active rollback release has no valid commit SHA');
  const capabilities=active.rollbackCapabilities;
  assert(Array.isArray(capabilities) && capabilities.every(value=>typeof value==='string'),'Active rollback release lacks capability evidence; deploy a tested read-compatible preparation release first');
  const missing=required.filter(value=>!capabilities.includes(value));
  assert(!missing.length,`Rollback target lacks ${missing.join(', ')}; deploy a tested read-compatible preparation release before enabling new data writes`);
  return {sha:active.sha,rollbackCapabilities:capabilities};
}
export async function verifyHosting(manifest) {
  const base=`https://${project}.web.app`;
  const version=await (await fetch(`${base}/version.json?t=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(30_000)})).json();
  assert.equal(version.sha,manifest.sha,'Hosting release SHA does not match tested artifact');
  assert.deepEqual(version.rollbackCapabilities,manifest.rollbackCapabilities,'Hosting rollback capability declaration does not match tested artifact');
  assert.equal(version.environment,environment);assert.equal(version.projectId,project);
  assert.equal(version.codeHash,manifest.codeHash);assert.equal(version.configHash,environmentConfig.configHash);
  const runtime=await(await fetch(`${base}/runtime-config.js?t=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(30_000)})).text();
  assert.equal(createHash('sha256').update(runtime).digest('hex'),manifest.hashes['web/runtime-config.js'],'Hosting environment configuration mismatch');
  const html=await(await fetch(base,{cache:'no-store',signal:AbortSignal.timeout(30_000)})).text();
  assert.equal(createHash('sha256').update(html).digest('hex'),manifest.hashes['web/index.html']);
  for(const match of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css|webp))"/g)) assert((await fetch(base+match[1],{signal:AbortSignal.timeout(30_000)})).ok,`Missing live asset ${match[1]}`);
}
export function verifyReleaseOrigin({ci,bootstrap,target,credentials,serviceAccount,useGcloud=false}) {
  assert(!bootstrap || target.environment==='staging','Production bootstrap is forbidden');
  verifyReleaseIdentity(credentials,target,{serviceAccount,useGcloud});
  if(ci==='true')return 'ci';
  assert(bootstrap && target.environment==='staging','Local release is restricted to first staging bootstrap');
  assert(['impersonated_service_account','external_account'].includes(credentials?.type),'Local staging bootstrap requires a dedicated impersonated release identity');
  assert(serviceAccount,'Local staging bootstrap requires explicit VELA_RELEASE_SERVICE_ACCOUNT');
  return 'local-staging-bootstrap';
}
async function release() {
  assert(['staging','production'].includes(process.env.VELA_ENVIRONMENT),'Release requires an explicit VELA_ENVIRONMENT');
  assert(process.env.CI_COMMIT_SHA,'CI_COMMIT_SHA is required');
  assert(process.env.GOOGLE_APPLICATION_CREDENTIALS,'Release credentials are required');
  const bootstrap=process.env.VELA_BOOTSTRAP_STAGING==='true';
  const releaseOrigin=verifyReleaseOrigin({ci:process.env.CI,bootstrap,target:environmentConfig,credentials:JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS,'utf8')),serviceAccount:process.env.VELA_RELEASE_SERVICE_ACCOUNT,useGcloud:process.env.VELA_USE_GCLOUD==='1'});
  const manifest=validateArtifact('.release',process.env.CI_COMMIT_SHA);
  verifyBinding('.release',manifest,environmentConfig);
  assert.deepEqual(manifest.binding,{environment,projectId:project,configHash:environmentConfig.configHash},'Artifact is not bound to this environment');
  if(environment==='production')verifyPromotion(manifest,JSON.parse(readFileSync('staging-evidence/release-result.json','utf8')),loadEnvironment('staging'));
  const candidate=JSON.parse(readFileSync('artifacts/vertex-live.json','utf8'));
  verifyCandidateEvidence(candidate,manifest);
  const initial=bootstrap?await emptyStagingSnapshot(environmentConfig,loadEnvironment('production').firebase.projectId,manifest.functionInventory,{request:google}):undefined;
  const rollbackVersion=bootstrap?undefined:await verifyRollbackCapabilities(manifest);
  // CLI loads the compiled function locally before upload; install the exact artifact lock for discovery.
  const install=spawn('npm',['ci','--omit=dev','--ignore-scripts','--prefix',resolve('.release/api')],{stdio:'inherit'});
  const [installed]=await once(install,'exit');assert.equal(installed,0,'Release dependency installation failed');
  mkdirSync('artifacts',{recursive:true});
  const saved={releaseOrigin,...(initial || await snapshot(manifest.functionInventory)),...(rollbackVersion?{rollbackVersion}:{})};writeFileSync('artifacts/rollback.json',JSON.stringify(saved,null,2),{mode:0o600});
  try {
    const deploy=async only=>{
      const child=spawn('npx',['--yes',`firebase-tools@${tools.firebase}`,'deploy','--config',resolve('.release/firebase.json'),'--project',project,'--only',only,'--non-interactive'],{stdio:'inherit'});
      const [code]=await once(child,'exit');assert.equal(code,0,`Firebase deployment failed: ${only}`);
    };
    await deploy('functions');
    await configureGateway(true); // Firebase ID Tokens belong to application auth, not Cloud Run IAM.
    await waitForApiGateway(`https://asia-southeast1-${project}.cloudfunctions.net/businessApi`);
    await liveApiSmoke(); // Backend must serve new clients before publishing their assets.
    await deploy('hosting');
    await verifyHosting(manifest);
    await deploy('firestore:rules'); // Retire legacy direct writes only after API clients are published.
    if(environment==='staging')await stagingBrowser();
    const cases=await liveSmoke({mode:environment});await liveApiSmoke();
    writeFileSync('artifacts/release-result.json',JSON.stringify({sha:manifest.sha,codeHash:manifest.codeHash,configHash:environmentConfig.configHash,environment,projectId:project,firstDeployment:bootstrap,releaseOrigin,status:'verified',checks:environment==='staging'?['candidate-vertex','deployed-browser','live-matrix','api-ready']:['candidate-vertex','live-matrix','api-ready'],cases,at:new Date().toISOString()}));
  } catch(error) {
    console.error('Release failed; restoring previous Functions sources, Hosting version, and Rules releases');
    try {await rollback(saved);writeFileSync('artifacts/rollback-result.json',JSON.stringify({sha:manifest.sha,environment,firstDeployment:bootstrap,releaseOrigin,status:'restored',at:new Date().toISOString()}));console.error(bootstrap?'Failed staging bootstrap disabled and owned resources cleaned':'Previous release restored');}
    catch(restoreError){writeFileSync('artifacts/rollback-result.json',JSON.stringify({sha:manifest.sha,environment,firstDeployment:bootstrap,releaseOrigin,status:'failed',at:new Date().toISOString()}));throw new AggregateError([error,restoreError],'Release and automatic rollback failed');}
    throw error;
  }
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href) await release();
