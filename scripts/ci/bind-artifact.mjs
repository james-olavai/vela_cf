import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadEnvironment,hash} from './environments.mjs';
import {validateArtifact,artifactHashes,codeIdentity} from './artifact.mjs';
export function bindingFiles(manifest,template,target) {
  const files={};
  const {environment,firebase,configHash,apiBase,billing}=target;

  const headers=[...(template.hosting.headers||[]),{source:'/runtime-config.js',headers:[{key:'Cache-Control',value:'no-store'}]},{source:'/version.json',headers:[{key:'Cache-Control',value:'no-store'}]}];
  files['firebase.json']= JSON.stringify({...template,hosting:{...template.hosting,headers},firestore:{...template.firestore,database:firebase.firestoreDatabaseId}},null,2);
  files['environment.json']= JSON.stringify({environment,firebase,...(billing?{billing}:{})},null,2);
  files[`api/.env.${firebase.projectId}`]= `FIRESTORE_DATABASE_ID=${firebase.firestoreDatabaseId}\nVELA_ENVIRONMENT=${environment}\nPAT_AUDIENCE=${apiBase}\nPAT_MODE=disabled\nPAT_ALLOWED_UIDS=\nSTRIPE_BILLING_ENABLED=${billing?.enabled===true}\nSTRIPE_MODE=${billing?.mode||'test'}\nSTRIPE_PRICE_GO=${billing?.enabled?billing.goPriceId:''}\nSTRIPE_PRICE_PRO=${billing?.enabled?billing.proPriceId:''}\n`;
  files['web/runtime-config.js']= `globalThis.__VELA_CONFIG__=Object.freeze(${JSON.stringify(firebase).replaceAll('<','\\u003c')});\n`;
  files['web/version.json']= JSON.stringify({sha:manifest.sha,rollbackCapabilities:manifest.rollbackCapabilities,environment,projectId:firebase.projectId,codeHash:manifest.codeHash,configHash});
  return files;
}
export function verifyBinding(directory,manifest,target) {
  assert.deepEqual(manifest.binding,{environment:target.environment,projectId:target.firebase.projectId,configHash:target.configHash},'Artifact environment binding mismatch');
  const template=JSON.parse(readFileSync(resolve(directory,'firebase.template.json'),'utf8'));
  for(const [file,value] of Object.entries(bindingFiles(manifest,template,target)))assert.equal(readFileSync(resolve(directory,file),'utf8'),value,`Bound configuration changed: ${file}`);
}
export function bindArtifact(directory,target,expectedSha) {
  const root=resolve(directory),manifest=validateArtifact(root,expectedSha);
  assert(!manifest.binding,'Only a fresh immutable artifact can be bound');
  const identity=codeIdentity(manifest.hashes);
  assert.equal(manifest.codeHash,identity.codeHash,'Code identity mismatch');
  assert.deepEqual(manifest.codeHashes,identity.codeHashes,'Code inventory mismatch');
  const {environment,firebase,configHash}=target;
  const template=JSON.parse(readFileSync(resolve(root,'firebase.template.json'),'utf8'));
  for(const [file,value] of Object.entries(bindingFiles(manifest,template,target)))writeFileSync(resolve(root,file),value);
  const bound={...manifest,binding:{environment,projectId:firebase.projectId,configHash},hashes:artifactHashes(root)};
  for(const [file,digest] of Object.entries(manifest.codeHashes))assert.equal(bound.hashes[file],digest,`Binding changed executable code: ${file}`);
  writeFileSync(resolve(root,'manifest.json'),JSON.stringify(bound,null,2));return bound;
}
export function verifyPromotion(manifest,evidence,staging) {
  assert.equal(manifest.binding?.environment,'production','Promotion target must be production');
  assert.equal(evidence?.environment,'staging','Verified staging evidence is required');
  assert.equal(evidence.status,'verified','Staging verification did not pass');
  assert.equal(evidence.sha,manifest.sha,'Staging tested a different commit');
  assert.equal(evidence.codeHash,manifest.codeHash,'Staging tested different code');
  assert.equal(evidence.configHash,staging.configHash,'Staging configuration changed after verification');
  assert.equal(evidence.projectId,staging.firebase.projectId,'Staging project evidence mismatch');
  assert.notEqual(evidence.projectId,manifest.binding.projectId,'Staging cannot be production');
  assert.deepEqual(evidence.checks,['candidate-vertex','deployed-browser','live-matrix','api-ready'],'Incomplete staging verification');
  const companies=evidence.companySynastry;
  assert(companies?.api?.length===2 && ['person-company-pro','company-company-pro'].every(name=>companies.api.some(c=>c.case===name && c.status==='passed' && c.cleanup==='passed')),'Missing company synastry API verification');
  assert(companies.browser?.status==='passed' && companies.browser.environment==='staging' && companies.browser.projectId===staging.firebase.projectId && companies.browser.cleanup===true && companies.browser.cases?.length===2 && ['person-company','company-company'].every(name=>companies.browser.cases.some(c=>c.name===name && c.status==='passed')),'Missing company synastry browser verification');
  if(staging.billing?.enabled){
    const billing=evidence.billingEvidence;
    assert(evidence.billingVerified===true && billing?.result==='passed' && billing.cleanup===true && billing.sha===manifest.sha && billing.codeHash===manifest.codeHash && billing.configHash===staging.configHash && billing.projectId===staging.firebase.projectId,'Missing matching staging payment verification');
  }
  const expected=['current-free','frozen-unlimited','exhausted-free','country-chart-pro','single-pro','pair-pro','four-person-pro','company-pro'];
  assert(Array.isArray(evidence.cases) && evidence.cases.length===expected.length && expected.every(name=>evidence.cases.some(c=>c.case===name && c.status==='passed')),'Incomplete staging model matrix');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const target=loadEnvironment(process.argv[2]);
  const bound=bindArtifact('.release',target,process.env.CI_COMMIT_SHA);
  if(target.environment==='production')verifyPromotion(bound,JSON.parse(readFileSync('staging-evidence/release-result.json','utf8')),loadEnvironment('staging'));
  console.log(JSON.stringify({sha:bound.sha,codeHash:bound.codeHash,...bound.binding}));
}
