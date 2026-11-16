// Browser checks the deployed application with actual Firebase Auth and API calls.
// Only a same-origin blank login harness is intercepted; business responses are never mocked.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {config,project,environment,google,documentRoot,writeDocument,deleteTree} from './google.mjs';
import {apiClient} from './api-smoke.mjs';
const require=createRequire(import.meta.url);
export async function stagingBrowser() {
  assert.equal(environment,'staging','Deployed browser fixture is staging-only');
  assert(process.env.PLAYWRIGHT_CORE_PATH,'Isolated Playwright path is required');
  const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_CORE_PATH,'index.mjs')).href);
  const {build}=require('esbuild'),base=`https://${project}.web.app`,email=`vela-browser-${randomUUID()}@vela.local`,password=randomUUID()+randomUUID();
  const authCall=async(action,body)=>{
    const response=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${config.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
    assert(response.ok,`Synthetic browser authentication failed (${response.status})`);return response.json();
  };
  let user,browser;
  const evidence={environment,projectId:project,status:'failed',checks:[]};mkdirSync('artifacts',{recursive:true});
  try {
    user=await authCall('signUp',{email,password,returnSecureToken:true});
    const api=apiClient(`https://asia-southeast1-${project}.cloudfunctions.net/businessApi`,user.idToken);
    assert.equal((await api('PATCH','/v1/me',{acceptedTerms:true,confirmedAdult:true})).status,200);
    await writeDocument(`usage/${user.localId}`,{overrideTier:'pro',unlimited:true,used:0,periodStart:new Date().toISOString().slice(0,7)+'-01T00:00:00Z'});
    const source=`import {initializeApp} from 'firebase/app';import {getAuth,setPersistence,indexedDBLocalPersistence,signInWithEmailAndPassword} from 'firebase/auth';globalThis.loginFixture=async(config,email,password)=>{const auth=getAuth(initializeApp(config));await setPersistence(auth,indexedDBLocalPersistence);return (await signInWithEmailAndPassword(auth,email,password)).user.uid;};`;
    const bundle=await build({stdin:{contents:source,resolveDir:resolve('apps/web')},bundle:true,write:false,format:'iife',platform:'browser'});
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[];
    page.on('pageerror',()=>errors.push('browser-exception'));
    await page.route(`${base}/__ci_auth`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>CI Auth</title>'}));
    await page.goto(`${base}/__ci_auth`);await page.addScriptTag({content:bundle.outputFiles[0].text});
    const signedUid=await page.evaluate(async input=>globalThis.loginFixture(input.config,input.email,input.password),{config,email,password});assert.equal(signedUid,user.localId);
    await page.unroute(`${base}/__ci_auth`);await page.goto(base,{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'添加出生信息，查看星盘',exact:true}).click();
    await page.locator('#profile-name').fill('CI Browser Synthetic');await page.locator('#profile-birth').fill('1994-06-03T08:20');
    const city=page.locator('#profile-city');await city.fill('beijing');
    await page.getByRole('listbox',{name:'匹配地点'}).getByRole('option').first().waitFor({timeout:30_000});
    await city.press('ArrowDown');await city.press('Enter');await page.getByText('地点已选，可继续填写',{exact:true}).waitFor();
    const savedPromise=page.waitForResponse(r=>r.url().endsWith('/v1/profiles') && r.request().method()==='POST');
    await page.getByRole('button',{name:'保存',exact:true}).click();const saved=await savedPromise;assert.equal(saved.status(),201);
    const profile=await saved.json();assert.equal(profile.countryCode,'CN');assert(profile.locationRef?.id);
    const read=await api('GET',`/v1/profiles/${profile.id}`);assert.equal(read.status,200);assert.equal(read.body.name,'CI Browser Synthetic');
    const expand=page.getByRole('button',{name:'展开侧栏',exact:true});if(await expand.isVisible())await expand.click();
    const panel=page.getByRole('region',{name:'关联国家盘'});await panel.getByText(/已关联：/).waitFor();
    await panel.getByRole('checkbox',{name:'加入本次分析'}).check();assert(await panel.getByRole('checkbox',{name:'加入本次分析'}).isChecked());
    assert.equal(errors.length,0,'Deployed app raised a browser exception');
    Object.assign(evidence,{status:'passed',checks:['firebase-sdk-login','deployed-app','builtin-location-keyboard','profile-api-persistence','country-recommendation-selection']});
    console.log('PASS staging browser: deployed UI, real Firebase SDK login, location selection, profile API persistence and country selection');
    return evidence;
  } catch(error) {evidence.error=error.name||'Error';throw error;}
  finally {
    const browserClosed=browser?await browser.close().then(()=>true,()=>false):true;
    if(user){const cleanup=await Promise.allSettled([deleteTree(`users/${user.localId}`),google(`${documentRoot}/usage/${user.localId}`,{method:'DELETE'}),authCall('delete',{idToken:user.idToken})]);evidence.cleanup=browserClosed && cleanup.every(r=>r.status==='fulfilled');writeFileSync('artifacts/staging-browser.json',JSON.stringify(evidence,null,2));assert(evidence.cleanup,'Staging browser fixture cleanup failed');}
    else writeFileSync('artifacts/staging-browser.json',JSON.stringify(evidence,null,2));
  }
}
