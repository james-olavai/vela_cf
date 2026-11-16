import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
export const rulesRelease=(project,database)=>`projects/${project}/releases/cloud.firestore${database==='(default)'?'':`/${database}`}`;
export async function emptyStagingSnapshot(target,productionProject,inventory,{request}={}) {
  assert.equal(target.environment,'staging','Bootstrap is staging-only');
  const project=target.firebase.projectId,database=target.firebase.firestoreDatabaseId;
  assert.notEqual(project,productionProject,'Production bootstrap is forbidden');
  assert(inventory?.existing?.length && Array.isArray(inventory.introduced),'Missing owned function inventory');
  const names=[...inventory.existing,...inventory.introduced];assert(new Set(names).size===names.length && names.every(n=>/^[A-Za-z][A-Za-z0-9_]*$/.test(n)),'Invalid function inventory');
  // A failed read is never interpreted as an empty target.
  const [functions,site,accounts,collections,releases]=await Promise.all([
    request(`https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/asia-southeast1/functions?pageSize=1`),
    request(`https://firebasehosting.googleapis.com/v1beta1/sites/${project}/releases?pageSize=100`),
    request(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:batchGet?maxResults=1`),
    request(`https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents:listCollectionIds`,{method:'POST',body:{pageSize:1}}),
    request(`https://firebaserules.googleapis.com/v1/projects/${project}/releases`),
  ]);
  for(const [value,key] of [[functions,'functions'],[accounts,'users'],[collections,'collectionIds']]){
    assert(value && typeof value==='object' && !Array.isArray(value),'Malformed bootstrap inspection');
    assert(value[key]===undefined || Array.isArray(value[key]),'Malformed bootstrap resource list');
    assert(!(value[key]?.length) && !value.nextPageToken,'Staging bootstrap target is not empty');
  }
  assert(site && typeof site==='object' && !Array.isArray(site) && (site.releases===undefined || Array.isArray(site.releases)) && !site.nextPageToken,'Incomplete Hosting bootstrap inspection');
  assert((site.releases||[]).every(r=>r && typeof r==='object' && !Array.isArray(r) && r.type==='SITE_DISABLE' && r.version===undefined),'Staging bootstrap target has a real or unrecognized Hosting release');
  assert(releases && (releases.releases===undefined || Array.isArray(releases.releases)) && !releases.nextPageToken,'Incomplete rules inspection');
  const name=rulesRelease(project,database),savedRules=(releases.releases||[]).filter(r=>r.name===name).map(r=>({name:r.name,rulesetName:r.rulesetName}));
  assert(savedRules.every(r=>typeof r.rulesetName==='string'),'Malformed existing rules release');
  return {firstDeployment:true,environment:'staging',projectId:project,functions:[],hosting:null,rules:savedRules,createdRuleReleases:savedRules.length?[]:[name],createdFunctions:names.map(n=>`projects/${project}/locations/asia-southeast1/functions/${n}`)};
}
export async function disableStagingHosting(saved,productionProject,version) {
  assert(saved.firstDeployment && saved.environment==='staging' && saved.projectId!==productionProject,'Refusing to disable a non-bootstrap or production site');
  const child=spawn('npx',['--yes',`firebase-tools@${version}`,'hosting:disable','--project',saved.projectId,'--site',saved.projectId,'--force','--non-interactive'],{stdio:'inherit'});
  const [code]=await once(child,'exit');assert.equal(code,0,'Failed to disable staging Hosting after bootstrap failure');
}
