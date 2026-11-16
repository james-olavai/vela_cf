import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {loadEnvironment} from './environments.mjs';
export function verifyReleaseIdentity(credentials,target,options={}) {
  const expected=options.serviceAccount ?? process.env.VELA_RELEASE_SERVICE_ACCOUNT;
  const useGcloud=options.useGcloud ?? (process.env.VELA_USE_GCLOUD==='1');
  const project=target.firebase.projectId;
  const scoped=email=>typeof email==='string' && new RegExp(`^[a-z][a-z0-9-]{4,28}[a-z0-9]@${project.replaceAll('.','\\.')}\\.iam\\.gserviceaccount\\.com$`).test(email);
  let email;
  if(credentials?.type==='service_account') {
    assert.equal(credentials.project_id,project,'Release identity belongs to a different environment project');
    email=credentials.client_email;
  } else {
    assert(['impersonated_service_account','external_account'].includes(credentials?.type),'Dedicated release service account credentials are required');
    assert(scoped(expected),'Explicit VELA_RELEASE_SERVICE_ACCOUNT scoped to the selected project is required');
    assert(credentials.project_id===undefined || credentials.project_id===project,'Release identity belongs to a different environment project');
    const url=new URL(credentials.service_account_impersonation_url);
    const match=/^\/v1\/projects\/-\/serviceAccounts\/([^/]+):generateAccessToken$/.exec(url.pathname);
    assert(url.origin==='https://iamcredentials.googleapis.com' && !url.username && !url.password && !url.search && !url.hash && match,'Invalid service_account_impersonation_url');
    email=decodeURIComponent(match[1]);
    if(credentials.type==='external_account') {
      assert.equal(credentials.token_url,'https://sts.googleapis.com/v1/token','Invalid workload identity token URL');
      assert(/^\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/.test(credentials.audience),'Invalid workload identity audience');
      assert(credentials.credential_source && typeof credentials.credential_source==='object','Missing workload identity credential source');
    } else assert(credentials.source_credentials && ['authorized_user','service_account','external_account'].includes(credentials.source_credentials.type),'Missing impersonation source credentials');
  }
  assert(scoped(email),'Release identity is not scoped to the selected project');
  if(expected!==undefined)assert.equal(email,expected,'Release identity does not match VELA_RELEASE_SERVICE_ACCOUNT');
  if(useGcloud)assert.equal(expected,email,'gcloud release requires explicit VELA_RELEASE_SERVICE_ACCOUNT');
  return email;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const target=loadEnvironment(process.env.VELA_ENVIRONMENT);
  assert(process.env.GOOGLE_APPLICATION_CREDENTIALS,'Missing release credentials');
  verifyReleaseIdentity(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS,'utf8')),target);
  assert(process.env.VELA_BOOTSTRAP_STAGING!=='true' || target.environment==='staging','Production bootstrap is forbidden');
  console.log(`Release identity verified for ${target.environment}`);
}
