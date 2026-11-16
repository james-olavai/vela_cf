// Real browser -> frontend stores/components -> Functions/Auth/Firestore; isolated plan-fixture and error injections are explicit.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
const authHost=process.env.FIREBASE_AUTH_EMULATOR_HOST, firestoreHost=process.env.FIRESTORE_EMULATOR_HOST;
assert.match(authHost??'',/^127\.0\.0\.1:\d+$/);assert.match(firestoreHost??'',/^127\.0\.0\.1:\d+$/);
const project='demo-vela-ci', database=process.env.FIRESTORE_DATABASE_ID || 'ai-studio-velacf-811abd0a-45c7-449f-a973-2e2998b2ac79';
const apiBase=process.env.VELA_API_EMULATOR_URL || `http://127.0.0.1:5001/${project}/asia-southeast1/businessApi`;
assert.match(apiBase,/^http:\/\/127\.0\.0\.1:\d+\/demo-vela-ci\/asia-southeast1\/businessApi$/);
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE_PATH||resolve('.ci-tools/browser/node_modules/playwright-core'));
const app=initializeApp({projectId:project},'api-browser-test'), db=getFirestore(app,database);
const server=await createServer({root:resolve('apps/web'),configFile:false,esbuild:{jsx:'automatic'},appType:'custom',server:{host:'127.0.0.1',port:3138,strictPort:true},define:{'import.meta.env.VITE_API_BASE_URL':JSON.stringify(apiBase)},plugins:[{
  name:'emulator-config-only',enforce:'pre',load(id){if(id.endsWith('/firebase-applet-config.json'))return JSON.stringify({projectId:project,apiKey:'fake',appId:'test',authDomain:'localhost',firestoreDatabaseId:database,recaptchaSiteKey:''});}
}]});
server.middlewares.use('/__api-browser',async(req,res,next)=>{
  if(req.url!=='/'&&req.url!=='')return next();
  const html=`<!doctype html><html><body><div id="subscription"></div><div id="plan-probe"></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {usePlan} from '/src/lib/planStore.ts';
    const planRoot=createRoot(document.getElementById('plan-probe'));
    function PlanProbe({uid,tier}){const current=usePlan(uid,tier);window.planProbe={uid,tier,plan:current.plan,error:current.error};window.retryPlan=current.retry;return React.createElement('output',{'data-testid':'plan-probe'},current.error||current.plan?.label||'套餐加载中');}
    import {SubscriptionSubpage} from '/src/components/SubscriptionSubpage.tsx';
    const subscriptionRoot=createRoot(document.getElementById('subscription'));
    import {auth} from '/src/lib/firebase.ts';
    import {connectAuthEmulator,createUserWithEmailAndPassword,deleteUser} from 'firebase/auth';
    import {saveProfile,removeProfile,subscribeProfiles,fetchNatalChart} from '/src/lib/profileStore.ts';
    import {businessApi} from '/src/lib/apiClient.ts';
    import {ensureUserRecord} from '/src/lib/accountStore.ts';
    import {claimDailyShareBonus,subscribeUsage} from '/src/lib/usageStore.ts';
    import {createConsultationSession,subscribeSessions,subscribeMessages} from '/src/lib/sessionStore.ts';
    connectAuthEmulator(auth,${JSON.stringify(`http://${authHost}`)},{disableWarnings:true});
    window.state={profiles:[],usage:null,sessions:[],messages:[],errors:[]};window.stops=[];
    const fail=error=>window.state.errors.push(String(error));
    window.harness={renderPlan:(uid,tier)=>flushSync(()=>planRoot.render(React.createElement(PlanProbe,{uid,tier}))),renderSubscription:uid=>subscriptionRoot.render(React.createElement(SubscriptionSubpage,{uid,tier:'free',usage:{used:0,periodStart:'2026-11-01'},profileCount:0,onRequestAuth:()=>{},onOpenShare:()=>{}})),saveProfile,removeProfile,businessApi,ensureUserRecord,claimDailyShareBonus,createConsultationSession,fetchNatalChart,
      watch:uid=>{window.stops.push(subscribeProfiles(uid,v=>window.state.profiles=v,fail),subscribeUsage(uid,v=>window.state.usage=v,fail),subscribeSessions(uid,v=>window.state.sessions=v,fail));},
      watchMessages:(uid,id)=>window.stops.push(subscribeMessages(uid,id,v=>window.state.messages=v,fail)),
      stop:()=>window.stops.forEach(fn=>fn()),login:async(email,password)=>(await createUserWithEmailAndPassword(auth,email,password)).user.uid,cleanup:async()=>{if(auth.currentUser)await deleteUser(auth.currentUser);}};
  </script></body></html>`;
  try{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__api-browser',html));}catch(error){next(error);}
});
let browser,uid;
try{
  await server.listen();
  browser=await chromium.launch({executablePath:process.env.CHROME_BIN||undefined,headless:true,args:['--no-sandbox','--disable-gpu']});
  const page=await browser.newPage(),writes=[];
  page.on('response',response=>{if(response.url().startsWith(apiBase)&&['POST','PATCH','DELETE'].includes(response.request().method()))writes.push({body:response.request().postDataJSON(),url:response.url(),method:response.request().method(),status:response.status(),origin:response.headers()['access-control-allow-origin']});});
  await page.goto('http://127.0.0.1:3138/__api-browser');await page.waitForFunction(()=>Boolean(window.harness));
  const guest=await page.evaluate(()=>window.harness.fetchNatalChart(null,{id:'guest',name:'Guest',birthDateTime:'1994-06-03T08:20',locationName:'Shanghai',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',gender:'female'}));
  assert(guest.natal.planets.length>0);assert(guest.portrait?.sunSign,'Guest natal API must provide server portrait');assert(guest.portrait.elements,'Portrait element summary missing');
  uid=await page.evaluate(async({email,password})=>window.harness.login(email,password),{email:`browser-${randomUUID()}@vela.test`,password:randomUUID()});
  assert.notEqual(uid,'e2e_test_user');
  await page.evaluate(async uid=>{await window.harness.ensureUserRecord(uid,'ignored-client-email','Browser API');window.harness.watch(uid);},uid);
  const profile={name:'Browser API',birthDateTime:'1994-06-03T08:20',locationName:'Shanghai',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',gender:'female'};
  const id=await page.evaluate(({uid,profile})=>window.harness.saveProfile(uid,null,profile),{uid,profile});
  const ref=db.doc(`users/${uid}/profiles/${id}`);
  assert.equal((await ref.get()).data()?.name,'Browser API');
  await page.waitForFunction(id=>window.state.profiles.some(p=>p.id===id),id);
  await page.evaluate(({uid,id,profile})=>window.harness.saveProfile(uid,id,{...profile,name:'Browser updated'}),{uid,id,profile});
  assert.equal((await ref.get()).data()?.name,'Browser updated');
  await page.waitForFunction(id=>window.state.profiles.some(p=>p.id===id&&p.name==='Browser updated'),id);
  const session=await page.evaluate(({id,profile})=>window.harness.createConsultationSession('personal',[{...profile,id}],'Browser session'),{id,profile});
  await page.waitForFunction(id=>window.state.sessions.some(s=>s.id===id),session.id);
  const sessionWrite=writes.find(x=>x.url.endsWith('/v1/sessions'));assert.deepEqual(sessionWrite.body.subjects,[{ref:'subject_1',profile_id:id}]);assert(!('profileIds' in sessionWrite.body));
  await page.evaluate(({uid,id})=>window.harness.watchMessages(uid,id),{uid,id:session.id});
  await db.doc(`users/${uid}/sessions/${session.id}/messages/browser-fixture`).set({role:'assistant',parts:[{type:'text',text:'Persisted synthetic message'}],createdAt:new Date().toISOString()});
  await page.waitForFunction(()=>window.state.messages.some(m=>m.parts.some(p=>p.text==='Persisted synthetic message')),{},{timeout:12000});
  await page.evaluate(uid=>window.harness.claimDailyShareBonus(uid,'copy'),uid);
  await page.waitForFunction(()=>window.state.usage?.shareCount===1);

  const read=await page.evaluate(({uid,id})=>window.harness.businessApi(uid,`/v1/profiles/${id}`),{uid,id});assert.equal(read.name,'Browser updated');
  await page.evaluate(({uid,id})=>window.harness.removeProfile(uid,id),{uid,id});assert.equal((await ref.get()).exists,false);
  await page.waitForFunction(id=>!window.state.profiles.some(p=>p.id===id),id);
  assert.deepEqual(writes.filter(x=>x.url.includes('/v1/profiles')).map(x=>[x.method,x.status]),[['POST',201],['PATCH',200],['DELETE',200]]);
  assert.deepEqual(await page.evaluate(()=>window.state.errors),[]);
  await page.evaluate(()=>window.harness.stop());
  assert(writes.every(x=>x.origin==='http://127.0.0.1:3138'),'CORS must explicitly allow browser origin');
  await db.doc(`customers/${uid}/subscriptions/browser-sub`).set({status:'past_due',role:'go',current_period_end:1796000000});
  await page.evaluate(uid=>window.harness.renderSubscription(uid),uid);
  await page.getByTestId('subscription-status').getByText(/Go：付款逾期/).waitFor();
  assert(await page.getByRole('button',{name:'升级到 Go'}).isVisible());
  await page.evaluate(()=>window.harness.renderSubscription(null));
  await page.getByText('当前方案：免费档').waitFor();
  assert.equal(await page.getByTestId('subscription-status').count(),0,'Account change must hide prior billing state');
  await page.route('**/v1/me/subscription',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'订阅服务暂时不可用'}})}));
  await page.evaluate(uid=>window.harness.renderSubscription(uid),uid);
  await page.getByRole('alert').getByText('订阅服务暂时不可用').waitFor();
  assert.equal(await page.getByRole('button',{name:'升级到 Go'}).count(),0,'Failed loading must not show stale actionable plans');
  await page.unroute('**/v1/me/subscription');await page.getByRole('button',{name:'重新加载订阅信息'}).click();
  await page.getByTestId('subscription-status').getByText(/Go：付款逾期/).waitFor();
  // Explicit fixture only for dynamic entitlement regression; real API tests above remain untouched.
  const fixturePlans=['free','go','pro'].map((id,index)=>({id,label:`Fixture ${id}`,priceLabel:'fixture',maxProfiles:23+index,maxSynastryProfiles:7+index,monthlyBudgetMicroUsd:1000,allowsEntityCharts:false,analysisDepths:[],highlights:[]}));
  let releasePlans,planGate=new Promise(resolve=>{releasePlans=resolve;}),plansUnavailable=false;
  await page.route('**/v1/plans',async route=>{
    await planGate;
    await route.fulfill({status:plansUnavailable?503:200,contentType:'application/json',body:JSON.stringify(plansUnavailable?{error:{code:'UNAVAILABLE',message:'Fixture plan outage'}}:{items:fixturePlans})});
  });
  await page.evaluate(uid=>window.harness.renderPlan(uid,'free'),uid);
  assert.equal(await page.evaluate(()=>window.planProbe.plan),undefined,'First render must not invent default entitlement');
  releasePlans();
  await page.waitForFunction(()=>window.planProbe.plan?.maxProfiles===23);
  assert.deepEqual(await page.evaluate(()=>window.planProbe.plan.analysisDepths),[]);
  await page.evaluate(uid=>window.harness.renderPlan(uid,'pro'),uid);
  assert.equal(await page.evaluate(()=>window.planProbe.plan?.maxProfiles),25,'Tier change must select new plan, never keep free limits');
  plansUnavailable=true;await page.evaluate(()=>window.retryPlan());
  await page.waitForFunction(()=>Boolean(window.planProbe.error));
  assert.equal(await page.evaluate(()=>window.planProbe.plan),undefined,'Read failure must discard old entitlement');
  plansUnavailable=false;await page.evaluate(()=>window.retryPlan());
  await page.waitForFunction(()=>window.planProbe.plan?.maxProfiles===25&&!window.planProbe.error);
  planGate=new Promise(resolve=>{releasePlans=resolve;});
  await page.evaluate(()=>window.harness.renderPlan(null,'pro'));
  assert.equal(await page.evaluate(()=>window.planProbe.plan),undefined,'UID switch must synchronously hide previous account plan');
  releasePlans();await page.waitForFunction(()=>window.planProbe.uid===null&&window.planProbe.plan?.maxProfiles===25);
  await page.evaluate(()=>window.harness.renderPlan(null,'go'));
  assert.equal(await page.evaluate(()=>window.planProbe.plan?.maxSynastryProfiles),8);
  await page.unroute('**/v1/plans');
  await page.evaluate(()=>window.harness.cleanup());
  console.log('PASS browser API integration: guest natal, real Firebase login/account, profile CRUD, session creation and polling profiles/messages/usage via API, share reward, subjects request, real plans/subscription UI, account switching, failed-load retry, usePlan first-load/tier/UID isolation/outage/same-response retry, CORS and Firestore persistence');
}finally{
  if(uid){await db.recursiveDelete(db.doc(`users/${uid}`));await db.doc(`usage/${uid}`).delete();await db.recursiveDelete(db.doc(`customers/${uid}`));const {getAuth}=await import('firebase-admin/auth');await getAuth(app).deleteUser(uid).catch(e=>{if(e.code!=='auth/user-not-found')throw e;});}
  await browser?.close();await server.close();await deleteApp(app);
}
