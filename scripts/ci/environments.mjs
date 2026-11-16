import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export function validateEnvironment(value, expected, productionProject) {
  assert(['staging','production'].includes(expected),'VELA_ENVIRONMENT must be staging or production');
  assert(value?.environment===expected,'Environment configuration does not match requested target');
  const config=value.firebase;
  assert(config && typeof config==='object' && !Array.isArray(config),'Missing Firebase environment configuration');
  const allowed=['projectId','appId','apiKey','authDomain','firestoreDatabaseId','storageBucket','messagingSenderId','measurementId','oAuthClientId','recaptchaSiteKey'];
  assert(Object.keys(value).every(k=>['environment','firebase','billing'].includes(k)) && Object.keys(config).every(k=>allowed.includes(k)),'Unknown environment configuration field');
  assert(allowed.every(k=>config[k]===undefined || typeof config[k]==='string'),'Firebase configuration values must be strings');
  assert(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId),'Invalid project ID or staging placeholder');
  assert(config.appId?.startsWith('1:') && config.apiKey?.startsWith('AIza'),'Incomplete Firebase Web App configuration');
  assert(config.authDomain===`${config.projectId}.firebaseapp.com`,'Auth domain does not belong to selected project');
  assert(config.firestoreDatabaseId==='(default)' || /^[a-z][a-z0-9-]{2,62}$/.test(config.firestoreDatabaseId),'Invalid Firestore database ID');
  if(expected==='staging')assert(productionProject && config.projectId!==productionProject,'Staging and production must use separate Firebase projects');
  const billing=value.billing;
  if(billing!==undefined) {
    assert(billing && typeof billing==='object' && !Array.isArray(billing) && Object.keys(billing).every(k=>['enabled','mode','goPriceId','proPriceId'].includes(k)),'Invalid billing configuration; secrets must use Secret Manager');
    assert(typeof billing.enabled==='boolean' && ['test','live'].includes(billing.mode),'Invalid billing mode');
    assert(expected!=='staging' || billing.mode==='test','Staging must use Stripe test mode');
    if(billing.enabled)assert(/^price_[A-Za-z0-9]+$/.test(billing.goPriceId) && /^price_[A-Za-z0-9]+$/.test(billing.proPriceId) && billing.goPriceId!==billing.proPriceId,'Distinct server Go/Pro prices required');
  }
  return {environment:expected,firebase:config,...(billing?{billing}:{}),configHash:hash(value),apiBase:`https://asia-southeast1-${config.projectId}.cloudfunctions.net/businessApi`};
}
export function loadEnvironment(name, directory=resolve('config/environments')) {
  assert(['staging','production'].includes(name),'VELA_ENVIRONMENT must be staging or production');
  const file=resolve(directory,`${name}.json`);
  assert(existsSync(file),`Missing ${name} configuration: create ${file} from staging.example.json with an actual provisioned project; production fallback is forbidden`);
  const production=JSON.parse(readFileSync(resolve(directory,'production.json'),'utf8'));
  return validateEnvironment(JSON.parse(readFileSync(file,'utf8')),name,production.firebase?.projectId);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const value=loadEnvironment(process.argv[2]);console.log(JSON.stringify({environment:value.environment,projectId:value.firebase.projectId,database:value.firebase.firestoreDatabaseId,configHash:value.configHash}));
}
