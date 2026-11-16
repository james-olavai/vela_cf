import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { google, project, config } from './google.mjs';
import { liveSmoke, liveApiSmoke } from './live-smoke.mjs';
import { waitForApiGateway } from './api-smoke.mjs';
const tools=JSON.parse(readFileSync(new URL('./tools.json',import.meta.url),'utf8'));
const functionsRoot=`https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/asia-southeast1`;
const hosting=`https://firebasehosting.googleapis.com/v1beta1/sites/${project}/releases`;
const rules=`https://firebaserules.googleapis.com/v1/projects/${project}/releases`;
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
  const saved={functions:(functions.functions||[]).filter(f=>expected.includes(f.name.split('/').at(-1))).map(f=>({name:f.name,buildConfig:{source:f.buildConfig.source,runtime:f.buildConfig.runtime,entryPoint:f.buildConfig.entryPoint}})),hosting:site.releases[0].version.name,rules:(releases.releases||[]).filter(r=>r.name.endsWith(`/cloud.firestore/${config.firestoreDatabaseId}`)).map(r=>({name:r.name,rulesetName:r.rulesetName}))};
  const present=new Set(saved.functions.map(f=>f.name.split('/').at(-1)));
  assert(inventory.existing.every(n=>present.has(n))&&saved.functions.every(f=>f.buildConfig.source?.storageSource),'Missing Functions rollback sources');
  saved.createdFunctions=inventory.introduced.filter(n=>!present.has(n)).map(n=>`projects/${project}/locations/asia-southeast1/functions/${n}`);
  assert(saved.rules.length>0,'Missing Firestore rollback rulesets');return saved;
}
export async function rollback(saved, { request=google, sleep=ms=>new Promise(r=>setTimeout(r,ms)), timeoutMs=20*60_000 }={}) {
  const pending=[], errors=[];
  for(const f of saved.functions) try {
    const op=await request(`https://cloudfunctions.googleapis.com/v2/${f.name}?updateMask=buildConfig.source,buildConfig.runtime,buildConfig.entryPoint`,{method:'PATCH',body:{name:f.name,buildConfig:{source:f.buildConfig.source,runtime:f.buildConfig.runtime,entryPoint:f.buildConfig.entryPoint}}});
    pending.push(op.name);
  } catch(e) { errors.push(e); }
  for(const name of saved.createdFunctions || []) try {
    // Only names absent from the pre-release snapshot and explicitly owned by this release.
    const all=await listFunctions(request);
    if((all.functions||[]).some(f=>f.name===name)) {const op=await request(`https://cloudfunctions.googleapis.com/v2/${name}`,{method:'DELETE'});pending.push(op.name);}
  } catch(e) {errors.push(e);}
  for(const r of saved.rules) try { await request(`https://firebaserules.googleapis.com/v1/${r.name}`,{method:'PATCH',body:{release:r,updateMask:'rulesetName'}}); } catch(e) { errors.push(e); }
  try {
    const site=await request(`${hosting}?pageSize=1`);
    const active=site.releases?.[0]?.version?.name;
    assert(active,'No active Hosting version available during rollback');
    if(active!==saved.hosting) await request(`${hosting}?versionName=${encodeURIComponent(saved.hosting)}`,{method:'POST',body:{message:'Automatic rollback after failed release validation'}});
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
  if(errors.length) throw new AggregateError(errors,'Rollback incomplete; see saved release snapshot');
}
export async function verifyHosting(manifest) {
  const base=`https://${project}.web.app`;
  const version=await (await fetch(`${base}/version.json?t=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(30_000)})).json();
  assert.equal(version.sha,manifest.sha,'Hosting release SHA does not match tested artifact');
  const html=await(await fetch(base,{cache:'no-store',signal:AbortSignal.timeout(30_000)})).text();
  assert.equal(createHash('sha256').update(html).digest('hex'),manifest.hashes['web/index.html']);
  for(const match of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css|webp))"/g)) assert((await fetch(base+match[1],{signal:AbortSignal.timeout(30_000)})).ok,`Missing live asset ${match[1]}`);
}
export function validateArtifact(directory, sha) {
  const root=resolve(directory), manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
  assert.equal(manifest.sha,sha,'Artifact commit does not match CI commit');
  const actual=[];
  function scan(dir='') {
    for(const entry of readdirSync(resolve(root,dir),{withFileTypes:true})) {
      const path=dir?`${dir}/${entry.name}`:entry.name;
      if(entry.isDirectory()) scan(path); else { assert(entry.isFile(),'Release symlinks are forbidden');if(path!=='manifest.json') actual.push(path); }
    }
  }
  scan();assert.deepEqual(actual.sort(),Object.keys(manifest.hashes).sort(),'Artifact inventory changed');
  for(const [path,hash] of Object.entries(manifest.hashes)) {
    assert(resolve(root,path).startsWith(root+sep),'Invalid release path');
    assert.equal(createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex'),hash,`Artifact was modified: ${path}`);
  }
  return manifest;
}
async function release() {
  assert(process.env.CI==='true','Production release must run in CI');
  assert(process.env.CI_COMMIT_SHA,'CI_COMMIT_SHA is required');
  assert(process.env.GOOGLE_APPLICATION_CREDENTIALS,'Release credentials are required');
  const manifest=validateArtifact('.release',process.env.CI_COMMIT_SHA);
  // CLI loads the compiled function locally before upload; install the exact artifact lock for discovery.
  const install=spawn('npm',['ci','--omit=dev','--ignore-scripts','--prefix',resolve('.release/api')],{stdio:'inherit'});
  const [installed]=await once(install,'exit');assert.equal(installed,0,'Release dependency installation failed');
  mkdirSync('artifacts',{recursive:true});
  const saved=await snapshot(manifest.functionInventory);writeFileSync('artifacts/rollback.json',JSON.stringify(saved,null,2),{mode:0o600});
  try {
    const deploy=async only=>{
      const child=spawn('npx',['--yes',`firebase-tools@${tools.firebase}`,'deploy','--config',resolve('.release/firebase.json'),'--project',project,'--only',only,'--non-interactive'],{stdio:'inherit'});
      const [code]=await once(child,'exit');assert.equal(code,0,`Firebase deployment failed: ${only}`);
    };
    await deploy('functions');
    await waitForApiGateway(`https://asia-southeast1-${project}.cloudfunctions.net/businessApi`);
    await liveApiSmoke(); // Backend must serve new clients before publishing their assets.
    await deploy('hosting');
    await verifyHosting(manifest);
    await deploy('firestore:rules'); // Retire legacy direct writes only after API clients are published.
    await liveSmoke();await liveApiSmoke();
    writeFileSync('artifacts/release-result.json',JSON.stringify({sha:manifest.sha,status:'verified',at:new Date().toISOString()}));
  } catch(error) {
    console.error('Release failed; restoring previous Functions sources, Hosting version, and Rules releases');
    try {await rollback(saved);console.error('Previous release restored');}
    catch(restoreError){throw new AggregateError([error,restoreError],'Release and automatic rollback failed');}
    throw error;
  }
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href) await release();
