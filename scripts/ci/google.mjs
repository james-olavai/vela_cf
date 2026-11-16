import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { loadEnvironment } from './environments.mjs';
const require = createRequire(import.meta.url);
export const environment = process.env.VELA_ENVIRONMENT || 'production';
export const environmentConfig = loadEnvironment(environment);
export const config = environmentConfig.firebase;
export const project = config.projectId;
export function gcloudAccessTokenArgs(serviceAccount=process.env.VELA_RELEASE_SERVICE_ACCOUNT,targetProject=project) {
  if(serviceAccount!==undefined && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(serviceAccount))throw new Error('Invalid VELA_RELEASE_SERVICE_ACCOUNT');
  if(serviceAccount && !serviceAccount.endsWith(`@${targetProject}.iam.gserviceaccount.com`))throw new Error('gcloud identity belongs to a different environment project');
  return ['auth','print-access-token',...(serviceAccount?[`--impersonate-service-account=${serviceAccount}`]:[])];
}
let cached;
export async function accessToken() {
  const identity=[process.env.VELA_USE_GCLOUD,process.env.VELA_RELEASE_SERVICE_ACCOUNT,process.env.GOOGLE_APPLICATION_CREDENTIALS].join('|');
  if (!cached || cached.identity!==identity || cached.expires < Date.now()) {
    const token = process.env.VELA_USE_GCLOUD === '1'
      ? execFileSync('gcloud', gcloudAccessTokenArgs(), {encoding:'utf8'}).trim()
      : await new (require('google-auth-library').GoogleAuth)({scopes:['https://www.googleapis.com/auth/cloud-platform']}).getAccessToken();
    if (!token) throw new Error('Google deployment credentials are required');
    cached = {token,identity,expires:Date.now()+45*60_000};
  }
  return cached.token;
}
export async function google(url, {method='GET', body, headers={}}={}) {
  const response=await fetch(url,{method,headers:{Authorization:`Bearer ${await accessToken()}`,'x-goog-user-project':project,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60_000)});
  const data=await response.json();
  if(!response.ok) throw new Error(`Google API ${response.status}: ${data.error?.message || response.statusText}`);
  return data;
}
export const documentRoot=`https://firestore.googleapis.com/v1/projects/${project}/databases/${config.firestoreDatabaseId}/documents`;
export function value(v) {
  if(v===null) return {nullValue:null};
  if(typeof v==='string') return {stringValue:v};
  if(typeof v==='boolean') return {booleanValue:v};
  if(typeof v==='number') return Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v};
  if(Array.isArray(v)) return {arrayValue:{values:v.map(value)}};
  return {mapValue:{fields:fields(v)}};
}
export const fields=data=>Object.fromEntries(Object.entries(data).map(([k,v])=>[k,value(v)]));
export const writeDocument=(path,data)=>google(`${documentRoot}/${path}`,{method:'PATCH',body:{fields:fields(data)}});
export async function deleteTree(path) {
  let pageToken;
  do {
    const ids=await google(`${documentRoot}/${path}:listCollectionIds`,{method:'POST',body:{pageSize:100,...(pageToken?{pageToken}:{})}});
    for(const id of ids.collectionIds||[]) {
      let token;
      do {
        const docs=await google(`${documentRoot}/${path}/${id}?pageSize=100${token?`&pageToken=${encodeURIComponent(token)}`:''}`);
        for(const doc of docs.documents||[]) await deleteTree(doc.name.split('/documents/')[1]);
        token=docs.nextPageToken;
      } while(token);
    }
    pageToken=ids.nextPageToken;
  } while(pageToken);
  await google(`${documentRoot}/${path}`,{method:'DELETE'});
}
