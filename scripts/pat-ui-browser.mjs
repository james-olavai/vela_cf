// Settings/Modal regression with real PAT components, auth helper and API request
// adapter; Firebase SDK popup/credential methods are controlled test adapters. This is not evidence of a successful online Google OAuth flow.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||resolve('.ci-tools/browser/node_modules/playwright-core'));
const entry=`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{SettingsModal}from'./src/components/SettingsModal';
window.__pat={uid:'user-a',listeners:new Set(),authMode:'success',authCalls:0,refreshes:0};
window.__pat.user={uid:'user-a',email:'user-a@example.invalid',providerData:[{providerId:'google.com'}],getIdToken:async(force)=>{if(force)window.__pat.refreshes++;return 'synthetic-firebase-user-a'}};
function Harness(){const[uid,setUid]=useState('user-a'),[open,setOpen]=useState(true);
window.__switchUid=(next)=>{window.__pat.uid=next;window.__pat.user=next?{uid:next,providerData:[{providerId:'google.com'}],getIdToken:async()=> 'synthetic-firebase-'+next}:null;window.__pat.listeners.forEach(fn=>fn(next));setUid(next);};
return <><button onClick={()=>setOpen(v=>!v)}>设置测试开关</button><SettingsModal open={open} uid={uid} email={uid+'@example.invalid'} authBusy={false} authError={null} authNotice={null} onConfirmGoogleLogin={()=>{}} onEmailAuth={()=>{}} onResetPassword={()=>{}} onClose={()=>setOpen(false)} onSignOut={()=>window.__switchUid(null)}/></>;}
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);`;
const authAdapter=`
export const EmailAuthProvider={credential:(email,password)=>({email,password})};
export function onAuthStateChanged(auth,fn){const listener=()=>fn(auth.currentUser);window.__pat.listeners.add(listener);listener();return()=>window.__pat.listeners.delete(listener);}
async function reauth(method){window.__pat.authCalls++;window.__pat.authMethod=method;if(window.__pat.authMode==='cancel')throw Object.assign(new Error('验证已取消'),{code:'auth/popup-closed-by-user'});if(window.__pat.authMode==='held')await new Promise(resolve=>{window.__pat.releaseAuth=resolve;});}
export const reauthenticateWithPopup=()=>reauth('google');
export const reauthenticateWithCredential=(user,credential)=>{if(credential.email!==user.email||!credential.password)throw Error('Missing credential');return reauth('password');};
`;
const bundled=await build({stdin:{contents:entry,resolveDir:resolve('apps/web'),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'import.meta.env.DEV':'false','import.meta.env.VITE_API_BASE_URL':'undefined','process.env.NODE_ENV':'"test"'},plugins:[{name:'controlled-auth',setup(b){
 b.onResolve({filter:/^firebase\/auth$/},args=>args.importer.endsWith('/apiTokens.ts')?{path:'auth-adapter',namespace:'fixture'}:undefined);
 b.onResolve({filter:/^(\.\/firebase|\.\.\/lib\/firebase)$/},args=>(args.importer.endsWith('/apiClient.ts')||args.importer.endsWith('/SettingsModal.tsx')||args.importer.endsWith('/apiTokens.ts'))?{path:'firebase-adapter',namespace:'fixture'}:undefined);
 b.onResolve({filter:/^\.\/runtimeConfig$/},args=>args.importer.endsWith('/apiClient.ts')?{path:'config-adapter',namespace:'fixture'}:undefined);
 b.onResolve({filter:/^\.\.\/lib\/store$/},args=>args.importer.endsWith('/SettingsModal.tsx')?{path:'store-adapter',namespace:'fixture'}:undefined);
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='auth-adapter'?authAdapter:args.path==='store-adapter'?`export const deleteUserAccount=async()=>{throw Error('Unexpected deletion')};export const exportUserDataJson=async()=>{throw Error('Unexpected export')};export const formatAppError=()=> 'Failure';`:args.path==='firebase-adapter'?`export const googleProvider={};export const updateAnalyticsConsent=()=>{};export const auth={get currentUser(){return window.__pat.user}};export const appCheck=undefined;`:`export const firebaseConfig={projectId:'demo-vela-ui'};`,loader:'js'}));
}}]});
const assets=resolve('apps/web/dist/assets'),styles=(await readdir(assets)).filter(name=>name.endsWith('.css'));
assert(styles.length,'Build the frontend before running the PAT component regression');
const css=(await Promise.all(styles.map(name=>readFile(resolve(assets,name),'utf8')))).join('\n');
const server=createServer((req,res)=>{
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','application/javascript');res.end(bundled.outputFiles[0].text);}
 else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(css);}
 else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><main id="root" style="max-width:640px;margin:auto;padding:16px"></main><script src="/fixture.js"></script></body></html>');}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||undefined,headless:true,args:['--no-sandbox','--disable-gpu']});
const origin=`http://127.0.0.1:${server.address().port}`,secret='vela_pat_emulator_0123456789abcdef01234567_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const token={id:'token-one',name:'Automation',prefix:'redacted',scopes:['profiles:read'],createdAt:'2026-11-16T00:00:00Z',expiresAt:'2026-12-16T00:00:00Z',revokedAt:null,lastUsedAt:null};
async function fixture(options={}){
 const context=await browser.newContext({viewport:options.viewport||{width:900,height:900}}),page=await context.newPage();
 const requests=[],errors=[],logs=[];let held,heldCapability,heldList,capabilityCalls=0;
 const state={capability:{canCreate:true,canManage:true},tokens:[],createError:null,holdCreate:false,...options};
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>logs.push(message.text()));
 await page.addInitScript(({ignoreAbort})=>{if(ignoreAbort){const originalFetch=window.fetch.bind(window);window.fetch=(input,options)=>originalFetch(input,{...options,signal:undefined});}window.__storageWrites=[];const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){window.__storageWrites.push(String(value));return original.call(this,key,value);};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{if(window.__clipboardHold)await new Promise(resolve=>{window.__releaseCopy=resolve;});throw new Error('Clipboard blocked');}}});},{ignoreAbort:!!options.ignoreAbort});
 await page.route('**/businessApi/v1/**',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method(),path=url.pathname.split('/businessApi')[1];
  requests.push({method,path,body:request.postDataJSON(),auth:request.headers().authorization});
  const json=(body,status=200)=>route.fulfill({status,json:body,headers:{'Access-Control-Allow-Origin':'*'}});
  if(method==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,DELETE'}});
  if(path==='/v1/me/api-token-capabilities'){if(state.holdFirstCapability&&++capabilityCalls===1){await new Promise(resolve=>{heldCapability=resolve;});return json({canCreate:false,canManage:false});}return state.capabilityError?json({error:{code:'UNAVAILABLE'}},503):json(state.capability);}
  if(path==='/v1/profiles')return state.profilesError?json({error:{code:'PROFILES_UNAVAILABLE',message:'档案加载失败'}},503):json({items:[{id:'profile-a',name:'Test profile'}],nextCursor:null});
  if(method==='GET'&&path==='/v1/me/api-tokens'){if(state.holdList)await new Promise(resolve=>{heldList=resolve;});return state.paginate?json(url.searchParams.has('cursor')?{items:[{...token,id:'token-two',name:'Second token'}],nextCursor:null}:{items:[token],nextCursor:'next-page'}):json({items:state.tokens,nextCursor:null});}
  if(method==='POST'&&path==='/v1/me/api-tokens'){
   if(state.holdCreate)await new Promise(resolve=>{held=resolve;});
   if(state.createError)return json({error:{code:state.createError,message:state.createError}},403);
   state.tokens=[token];return json({...token,secret},201);
  }
  if(method==='DELETE'){state.tokens=state.tokens.map(item=>({...item,revokedAt:'2026-11-17T00:00:00Z'}));return json({revoked:true});}
  throw new Error('Unexpected fixture API route');
 });
 await page.goto(origin);
 return {context,page,state,requests,errors,logs,release:()=>held?.(),held:()=>!!held,releaseCapability:()=>heldCapability?.(),releaseList:()=>heldList?.(),listHeld:()=>!!heldList};
}
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const posts=fixture=>fixture.requests.filter(request=>request.method==='POST');
async function open(page){await page.getByText('开发者接入',{exact:true}).click();await page.getByLabel('Token 名称（必填）',{exact:true}).waitFor();}
async function create(page){await page.getByLabel('Token 名称（必填）',{exact:true}).fill('Automation');await button(page,'创建 Token').click();}
async function clean(f){assert.deepEqual(f.errors,[]);assert(!f.logs.some(line=>line.includes(secret)),'Secret leaked to console');await f.context.close();}
try{
 const strict=await fixture({holdFirstCapability:true,ignoreAbort:true});
 await strict.page.getByText('开发者接入',{exact:true}).waitFor();strict.releaseCapability();await strict.page.waitForTimeout(150);
 assert.equal(await strict.page.getByText('开发者接入',{exact:true}).count(),1,'Stale first StrictMode effect must not overwrite current capabilities');await clean(strict);
 const hidden=await fixture({capability:{canCreate:false,canManage:false}});
 await hidden.page.waitForFunction(()=>window.__pat);
 await hidden.page.waitForTimeout(150);
 assert.equal(await hidden.page.getByText('开发者接入',{exact:true}).count(),0);await clean(hidden);
 const loading=await fixture({holdList:true});await open(loading.page);
 await loading.page.getByLabel('Token 名称（必填）',{exact:true}).fill('Automation');
 await loading.page.waitForTimeout(100);assert(loading.listHeld());
 assert.equal(await button(loading.page,'创建 Token').isDisabled(),true);
 // A direct form submit also exercises the runtime guard, beyond disabled-button UX.
 await loading.page.getByRole('form',{name:'创建 API Token'}).evaluate(form=>form.requestSubmit());
 assert.equal(posts(loading).length,0,'Initial list loading must block creation');
 loading.releaseList();await button(loading.page,'创建 Token').waitFor();
 await loading.page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='创建 Token'&&!button.disabled));
 await create(loading.page);await loading.page.getByLabel('Token 密钥（仅显示这一次）',{exact:true}).waitFor();assert.equal(posts(loading).length,1);await clean(loading);
 const f=await fixture();await open(f.page);await create(f.page);
 await f.page.waitForFunction(value=>[...document.querySelectorAll('input,textarea')].some(el=>el.value===value),secret);
 assert.deepEqual(posts(f)[0].body.scopes,['profiles:read']);
 assert.equal(posts(f).length,1);
 assert.equal(await f.page.evaluate(value=>JSON.stringify(localStorage).includes(value)||JSON.stringify(sessionStorage).includes(value)||location.href.includes(value)||window.__storageWrites.some(item=>item.includes(value)),secret),false);
 await button(f.page,'复制 Token').click();await f.page.getByText(/复制失败/).waitFor();
 assert(await f.page.evaluate(value=>[...document.querySelectorAll('input,textarea')].some(el=>el.value===value&&el.readOnly),secret));
 await button(f.page,'关闭弹窗').click();await f.page.getByRole('dialog').waitFor({state:'hidden'});await button(f.page,'设置测试开关').click();
 await f.page.getByText('开发者接入',{exact:true}).waitFor();
 assert.equal(await f.page.evaluate(value=>document.body.textContent.includes(value)||[...document.querySelectorAll('input,textarea')].some(el=>el.value===value),secret),false);
 await clean(f);
 const cancelled=await fixture({createError:'RECENT_AUTH_REQUIRED'});await open(cancelled.page);await create(cancelled.page);
 await button(cancelled.page,'验证身份').waitFor();const attempts=posts(cancelled).length;
 await cancelled.page.evaluate(()=>{window.__pat.authMode='cancel';});await button(cancelled.page,'验证身份').click();
 await cancelled.page.waitForFunction(()=>window.__pat.authCalls===1);assert.equal(posts(cancelled).length,attempts,'Cancelled reauthentication must not issue a PAT');
 await cancelled.page.getByText('已取消身份验证，未创建 Token',{exact:true}).waitFor();
 await cancelled.page.evaluate(()=>{window.__pat.authMode='success';});await button(cancelled.page,'验证身份').click();
 await cancelled.page.getByText('身份已验证，请点击创建 Token',{exact:true}).waitFor();assert.equal(await cancelled.page.evaluate(()=>window.__pat.refreshes),1,'Real auth helper must force-refresh after popup');assert.equal(posts(cancelled).length,attempts,'Successful verification also requires a separate create click');
 cancelled.state.createError=null;await button(cancelled.page,'创建 Token').click();
 await cancelled.page.getByLabel('Token 密钥（仅显示这一次）',{exact:true}).waitFor();assert.equal(posts(cancelled).length,attempts+1);
 await clean(cancelled);
 const password=await fixture({createError:'RECENT_AUTH_REQUIRED'});await password.page.evaluate(()=>{window.__pat.user.providerData=[{providerId:'password'}];});
 await open(password.page);await create(password.page);await password.page.getByLabel('当前密码',{exact:true}).fill('synthetic-password');
 await button(password.page,'验证身份').click();await password.page.getByText('身份已验证，请点击创建 Token',{exact:true}).waitFor();
 assert.equal(await password.page.evaluate(()=>window.__pat.authMethod),'password');assert.equal(await password.page.evaluate(()=>window.__pat.refreshes),1);assert.equal(posts(password).length,1);await clean(password);
 const changing=await fixture({createError:'RECENT_AUTH_REQUIRED'});await open(changing.page);await create(changing.page);
 await changing.page.evaluate(()=>{window.__pat.authMode='held';});await button(changing.page,'验证身份').click();
 await changing.page.waitForFunction(()=>typeof window.__pat.releaseAuth==='function');await changing.page.evaluate(()=>{window.__switchUid('user-b');window.__pat.releaseAuth();});
 await changing.page.getByText('user-b@example.invalid',{exact:true}).waitFor();assert.equal(posts(changing).length,1);assert.equal(await changing.page.evaluate(()=>window.__pat.refreshes),0,'Changed identity must not refresh the previous Firebase user');await clean(changing);
 const late=await fixture({holdCreate:true});await open(late.page);await create(late.page);
 await late.page.waitForTimeout(100);assert(late.held());assert.equal(await button(late.page,'正在处理…').isDisabled(),true);
 await late.page.evaluate(()=>window.__switchUid('user-b'));late.release();await late.page.waitForTimeout(150);
 assert.equal(await late.page.evaluate(value=>document.body.textContent.includes(value)||[...document.querySelectorAll('input,textarea')].some(el=>el.value===value),secret),false);
 assert.equal(posts(late).length,1);await clean(late);
 const copying=await fixture();await open(copying.page);await create(copying.page);
 await copying.page.getByLabel('Token 密钥（仅显示这一次）',{exact:true}).waitFor();
 await copying.page.evaluate(()=>{window.__clipboardHold=true;});await button(copying.page,'复制 Token').click();
 await copying.page.waitForFunction(()=>typeof window.__releaseCopy==='function');await button(copying.page,'已保存，关闭').click();
 await copying.page.evaluate(()=>window.__releaseCopy());await open(copying.page);
 assert.equal(await copying.page.getByText(/复制失败/).count(),0,'Late clipboard rejection must not update reopened panel');await clean(copying);
 const collapsed=await fixture({holdCreate:true});await open(collapsed.page);await create(collapsed.page);
 await collapsed.page.waitForTimeout(100);assert(collapsed.held());
 await collapsed.page.getByText('开发者接入',{exact:true}).click();collapsed.release();await collapsed.page.waitForTimeout(150);
 await open(collapsed.page);
 assert.equal(await collapsed.page.getByLabel('Token 密钥（仅显示这一次）',{exact:true}).count(),0);
 assert.equal(posts(collapsed).length,1);await clean(collapsed);
 const failedProfiles=await fixture({profilesError:true});await open(failedProfiles.page);
 await failedProfiles.page.getByText(/档案加载失败，指定档案/).waitFor();await failedProfiles.page.getByLabel('指定档案',{exact:true}).check();
 await create(failedProfiles.page);await failedProfiles.page.getByText('请先加载档案并选择至少一个指定档案',{exact:true}).waitFor();
 assert.equal(posts(failedProfiles).length,0);assert.equal(await failedProfiles.page.getByLabel('指定档案',{exact:true}).isChecked(),true);await clean(failedProfiles);
 const pagination=await fixture({paginate:true});await open(pagination.page);await pagination.page.getByText('Second token',{exact:true}).waitFor();
 assert.equal(pagination.requests.filter(r=>r.method==='GET'&&r.path==='/v1/me/api-tokens').length,2);await clean(pagination);
 const unavailable=await fixture({capabilityError:true});await unavailable.page.waitForTimeout(150);
 assert.equal(await unavailable.page.getByText('开发者接入',{exact:true}).count(),0);assert.equal(posts(unavailable).length,0);await clean(unavailable);
 const manage=await fixture({capability:{canCreate:false,canManage:true},tokens:[token],viewport:{width:360,height:780}});
 await manage.page.getByText('开发者接入',{exact:true}).click();await button(manage.page,'撤销 Automation').click();
 assert.equal(manage.requests.filter(r=>r.method==='DELETE').length,0);
 await button(manage.page,'取消撤销').click();assert.equal(manage.requests.filter(r=>r.method==='DELETE').length,0);
 await button(manage.page,'撤销 Automation').click();await button(manage.page,'确认撤销 Automation').click();
 await manage.page.getByText('Token 已撤销',{exact:true}).waitFor();assert.equal(manage.requests.filter(r=>r.method==='DELETE').length,1);
 assert.equal(await button(manage.page,'创建 Token').count(),0);
 assert(await manage.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Narrow viewport must not overflow');
 const dialog=manage.page.getByRole('dialog',{name:'账号与合规设置'});const bounds=await dialog.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=360,'Settings dialog must fit narrow viewport');
 const overflow=await dialog.evaluate(node=>[node,...node.querySelectorAll('div,section,form,fieldset')].filter(element=>element.scrollWidth>element.clientWidth+1).map(element=>({tag:element.tagName,classes:element.className,width:element.clientWidth,scroll:element.scrollWidth})));assert.deepEqual(overflow,[],'Settings contents must not overflow horizontally');
 await button(manage.page,'关闭弹窗').click();await dialog.waitFor({state:'hidden'});await button(manage.page,'设置测试开关').click();await dialog.waitFor();
 // Native dialog may yield focus to browser chrome (activeElement=body); page background controls remain inert.
 for(let i=0;i<12;i++){await manage.page.keyboard.press('Tab');const focus=await manage.page.evaluate(()=>({tag:document.activeElement?.tagName,inDialog:!!document.activeElement?.closest('dialog'),body:document.activeElement===document.body,modal:!!document.querySelector('dialog:modal')}));assert(focus.modal&&(focus.inDialog||focus.body),`Tab must not reach background controls: ${JSON.stringify(focus)}`);}
 await manage.page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await manage.page.evaluate(()=>document.activeElement?.textContent),'设置测试开关');await clean(manage);
 const narrow=await fixture({viewport:{width:320,height:740}});await open(narrow.page);
 await narrow.page.getByLabel('Token 名称（必填）',{exact:true}).fill('Narrow viewport');
 await narrow.page.getByLabel('指定档案',{exact:true}).check();await narrow.page.getByLabel('Test profile',{exact:true}).check();
 const narrowDialog=narrow.page.getByRole('dialog',{name:'账号与合规设置'}),narrowBounds=await narrowDialog.boundingBox();
 assert(narrowBounds.x>=0&&narrowBounds.x+narrowBounds.width<=320);
 const narrowOverflow=await narrowDialog.evaluate(node=>[node,...node.querySelectorAll('div,section,form,fieldset')].filter(element=>element.scrollWidth>element.clientWidth+1).map(element=>({tag:element.tagName,classes:element.className,width:element.clientWidth,scroll:element.scrollWidth})));
 assert.deepEqual(narrowOverflow,[],'Settings create form must fit 320px');
 await button(narrow.page,'创建 Token').click();await narrow.page.getByLabel('Token 密钥（仅显示这一次）',{exact:true}).waitFor();
 assert.deepEqual(posts(narrow)[0].body.profileIds,['profile-a']);await clean(narrow);
 console.log('PASS PAT Settings/Modal integration: capabilities, list-load guard, read-only defaults, secret lifetime, clipboard failures, Google/password reauthentication, stale effect/UID responses, revoke confirmation, narrow viewport and keyboard focus');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
