// Deployed UI -> real Firebase Auth/API -> real Vertex, with two isolated submissions.
// Only the same-origin authentication bootstrap page is intercepted.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {environment,project,config,google,documentRoot,writeDocument,deleteTree} from './google.mjs';
import {apiClient} from './api-smoke.mjs';
import {parseHttpChat} from './live-smoke.mjs';
const require=createRequire(import.meta.url);
export async function companySynastryBrowser(){
  assert.equal(environment,'staging');assert.equal(project,'velaastro-staging');
  const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||'playwright-core'),{build}=require('esbuild');
  const origin=`https://${project}.web.app`,apiBase=`https://asia-southeast1-${project}.cloudfunctions.net/businessApi`;
  const email=`vela-company-browser-${randomUUID()}@vela.local`,password=randomUUID()+randomUUID();
  const report={environment,projectId:project,status:'failed',scope:'deployed-ui-real-auth-api-vertex',maxGenerations:2,cases:[],cleanup:false};
  let user,browser,page,phase='signup',generationCount=0;
  const persist=()=>{mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/company-synastry-browser.json',JSON.stringify(report,null,2)+'\n');};
  async function authCall(action,body){const response=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${config.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});assert(response.ok,`Auth ${action} HTTP ${response.status}`);return response.json();}
  try{
    user=await authCall('signUp',{email,password,returnSecureToken:true});report.uid=user.localId;console.log(`TEST_UID ${user.localId}`);
    const api=apiClient(apiBase,user.idToken);assert.equal((await api('PATCH','/v1/me',{acceptedTerms:true,confirmedAdult:true})).status,200);
    await writeDocument(`usage/${user.localId}`,{overrideTier:'pro',unlimited:false,used:0,periodStart:new Date().toISOString().slice(0,7)+'-01T00:00:00Z'});
    const profiles=[];
    for(const [index,name,entityType] of [[0,'Browser Person','person'],[1,'Browser Company Alpha','company'],[2,'Browser Company Beta','company']]){
      const created=await api('POST','/v1/profiles',{name,entityType,birthDateTime:`199${index+1}-06-03T08:20`,latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',locationName:'上海',gender:'unset',consentedOther:true});assert.equal(created.status,201);profiles.push(created.body);
    }
    phase='browser-auth';const source=`import{initializeApp}from'firebase/app';import{getAuth,setPersistence,indexedDBLocalPersistence,signInWithEmailAndPassword}from'firebase/auth';globalThis.loginFixture=async(config,email,password)=>{const auth=getAuth(initializeApp(config));await setPersistence(auth,indexedDBLocalPersistence);return(await signInWithEmailAndPassword(auth,email,password)).user.uid;};`;
    const bundle=await build({stdin:{contents:source,resolveDir:resolve('apps/web')},bundle:true,write:false,format:'iife',platform:'browser'});
    browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);
    const exceptions=[];page.on('pageerror',()=>exceptions.push('browser-exception'));
    page.on('request',request=>{if(request.url().startsWith(apiBase)&&request.method()==='POST'&&/\/v1\/sessions\/[^/]+\/turns$/.test(new URL(request.url()).pathname))generationCount++;});
    await page.route(`${origin}/__ci_auth`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic Auth</title>'}));
    await page.goto(`${origin}/__ci_auth`);await page.addScriptTag({content:bundle.outputFiles[0].text});assert.equal(await page.evaluate(input=>globalThis.loginFixture(input.config,input.email,input.password),{config,email,password}),user.localId);await page.unroute(`${origin}/__ci_auth`);
    phase='app-hydration';await page.goto(origin,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'新咨询',exact:true}).waitFor();
    const expand=page.getByRole('button',{name:'展开侧栏',exact:true});if(await expand.isVisible().catch(()=>false))await expand.click();
    const quick=page.getByTestId('sidebar-quick-profiles');await quick.waitFor();
    for(const [name,pair] of [['person-company',[profiles[0],profiles[1]]],['company-company',[profiles[1],profiles[2]]]]){
      phase=`${name}-selection`;await page.getByRole('button',{name:'新咨询',exact:true}).click();
      while(await quick.getByRole('button',{name:/^取消合盘 /}).count())await quick.getByRole('button',{name:/^取消合盘 /}).first().click();
      const primary=quick.getByRole('button',{name:`将 ${pair[0].name} 设为主档案`,exact:true});if(await primary.count())await primary.click();
      await quick.getByRole('button',{name:`勾选合盘 ${pair[1].name}`,exact:true}).click();
      assert.equal(await quick.getByRole('button',{name:`取消合盘 ${pair[1].name}`,exact:true}).getAttribute('aria-pressed'),'true');
      assert(generationCount<2,'Generation budget exceeded');
      const sessionResponse=page.waitForResponse(r=>r.url()===`${apiBase}/v1/sessions`&&r.request().method()==='POST',{timeout:60000});
      const turnResponse=page.waitForResponse(r=>r.url().startsWith(apiBase)&&/\/v1\/sessions\/[^/]+\/turns$/.test(new URL(r.url()).pathname)&&r.request().method()==='POST',{timeout:180000});
      const question=`请必须调用 synastryAspects 合盘工具分析 ${pair.map(p=>p.name).join(' 与 ')} 的合作倾向。请逐一使用上述完整名称，每个对象给一条具体分工建议；公司是组织而非自然人，不要虚构关系，回答简短。`;
      await page.locator('#consult-question').fill(question);phase=`${name}-generation`;await page.getByRole('button',{name:'发送',exact:true}).click();
      const created=await sessionResponse;assert.equal(created.status(),201);const session=await created.json(),input=created.request().postDataJSON();
      assert.equal(input.mode,'synastry');assert.deepEqual(new Set(input.subjects.map(s=>s.profile_id)),new Set(pair.map(p=>p.id)));assert.equal(session.subjects.length,2);assert.deepEqual(session.subjects.map(s=>s.profile.entityType),pair.map(p=>p.entityType));
      const response=await turnResponse;assert.equal(response.status(),200);const text=await Promise.race([response.text(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('SSE_TIMEOUT')),180000);timer.unref();})]);
      const parsed=parseHttpChat(text,pair.map(p=>p.name));assert(parsed.tools.includes('synastryAspects'),'Missing actual synastry tool');
      phase=`${name}-persistence`;const messages=await api('GET',`/v1/sessions/${session.id}/messages`);assert.equal(messages.status,200);const assistant=messages.body.items.filter(m=>m.role==='assistant');assert(assistant.length>0);const persisted=JSON.stringify(assistant);for(const profile of pair)assert(persisted.includes(profile.name),'Persisted answer omitted an object');assert(persisted.includes('synastryAspects'),'Persisted tool trace missing');
      report.cases.push({name,status:'passed',sessionId:session.id,entityTypes:pair.map(p=>p.entityType),characters:parsed.characters,tools:parsed.tools,selectionSubmitted:true,answerNamesVerified:true,persisted:true});persist();console.log(`PASS ${name}: real UI selection, API subjects, live synastry tool, names and persistence`);
      await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden',timeout:30000});
    }
    assert.equal(generationCount,2);assert.equal(exceptions.length,0);const usage=await api('GET','/v1/me/usage');assert.equal(usage.status,200);assert(usage.body.used>0);report.settledMicroUsd=usage.body.used;report.generations=generationCount;report.status='passed';return report;
  }catch(error){if(page)await page.screenshot({path:'artifacts/company-synastry-browser-failure.png',fullPage:true}).catch(()=>{});report.failure={phase,type:error.name||'Error',assertion:error.name==='AssertionError'?error.message:undefined};throw error;}
  finally{
    const closed=browser?await browser.close().then(()=>true,()=>false):true;
    if(user){const clean=await Promise.allSettled([deleteTree(`users/${user.localId}`),google(`${documentRoot}/usage/${user.localId}`,{method:'DELETE'}),authCall('delete',{idToken:user.idToken})]);report.cleanup=closed&&clean.every(r=>r.status==='fulfilled');}
    else report.cleanup=closed;
    report.generations=generationCount;persist();console.log(JSON.stringify(report));assert(report.cleanup,'Fixture cleanup failed');
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await companySynastryBrowser().catch(()=>{process.exitCode=1;});
