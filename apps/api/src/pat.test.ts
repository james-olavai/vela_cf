import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { readPatConfig, dispatchPatApi, verifyPat, authorizePatRequest, deleteUserPats, assertPatTransaction, type PatConfig } from './pat.js';

function database() {
  const store = new Map<string, any>();
  let tail = Promise.resolve();
  const snap = (path: string) => ({id:path.split('/').at(-1)!, ref:doc(path), exists:store.has(path), data:()=>structuredClone(store.get(path))});
  const doc = (path: string): any => ({
    id:path.split('/').at(-1), path, collection:(name:string)=>collection(`${path}/${name}`),
    get:async()=>snap(path), set:async(data:any,options?:any)=>store.set(path,options?.merge?{...store.get(path),...data}:data),
    update:async(data:any)=>store.set(path,{...store.get(path),...data}), delete:async()=>store.delete(path),
  });
  const collection = (path: string): any => {
    let maximum=Infinity, cursor='', filter:((v:any)=>boolean)=()=>true;
    const query:any={
      doc:(id:string)=>doc(`${path}/${id}`),
      where:(key:string,op:string,value:unknown)=>{assert.equal(op,'==');filter=v=>v[key]===value;return query;},
      orderBy:()=>query, startAfter:(id:string)=>{cursor=id;return query;}, limit:(n:number)=>{maximum=n;return query;},
      get:async()=>({docs:[...store.keys()].filter(k=>k.startsWith(path+'/')&&k.split('/').length===path.split('/').length+1).sort().filter(k=>k.split('/').at(-1)!>cursor&&filter(store.get(k))).slice(0,maximum).map(snap)}),
    };
    return query;
  };
  const db={doc,collection,getAll:async(...refs:any[])=>Promise.all(refs.map(r=>r.get())),
    runTransaction:async(fn:any)=>{
      const previous=tail;let unlock!:()=>void;tail=new Promise<void>(r=>{unlock=r;});await previous;
      const writes:Array<()=>unknown>=[];
      try{const result=await fn({get:(ref:any)=>ref.get(),getAll:(...refs:any[])=>Promise.all(refs.map(r=>r.get())),
        create:(ref:any,data:any)=>{writes.push(()=>{assert(!store.has(ref.path));store.set(ref.path,data);});},
        set:(ref:any,data:any,options?:any)=>{writes.push(()=>store.set(ref.path,options?.merge?{...store.get(ref.path),...data}:data));},
        update:(ref:any,data:any)=>{writes.push(()=>store.set(ref.path,{...store.get(ref.path),...data}));},
        delete:(ref:any)=>{writes.push(()=>store.delete(ref.path));}});for(const write of writes)write();return result;
      }finally{unlock();}
    },
    batch:()=>{const refs:any[]=[];return {delete:(ref:any)=>refs.push(ref),commit:async()=>{for(const ref of refs)store.delete(ref.path);}};},
  } as unknown as Firestore;
  store.set('users/alice',{});store.set('users/bob',{});
  for(const id of ['one','two'])store.set(`users/alice/profiles/${id}`,{name:id});
  store.set('users/bob/profiles/other',{name:'other'});
  return {db,store};
}
const config:PatConfig={mode:'internal',environment:'staging',audience:'https://staging.example/businessApi',allowedUids:['alice'],requestsPerMinute:60};
const identity=(uid='alice')=>({uid,credentialKind:'firebase',token:{uid,auth_time:Math.floor(Date.now()/1000),stripeRole:'pro'}});
function users(){
  const records:any={alice:{uid:'alice',disabled:false,customClaims:{stripeRole:'pro'},tokensValidAfterTime:new Date(0).toISOString()},bob:{uid:'bob',disabled:false,customClaims:{}}};
  const auth={getUser:async(uid:string)=>{if(!records[uid])throw Error('not found');return structuredClone(records[uid]);}} as unknown as Auth;
  return {records,auth};
}
const create=(db:Firestore,auth:Auth,body:any={},who:any=identity(),cfg=config)=>dispatchPatApi(db,auth,who,{method:'POST',path:'/v1/me/api-tokens',body:{name:'Synthetic API client',scopes:['profiles:read'],...body}},cfg);
const request=(method:string,path:string,body?:unknown)=>({method,path,body});

// Schema, storage, identity and lifecycle are observed through public module boundaries.
test('PAT is disabled by default and internal rollout is a server-side UID gate',async()=>{
  assert.equal(readPatConfig({}).mode,'disabled');
  const {db}=database(),{auth}=users();
  await assert.rejects(create(db,auth,{},identity(),{...config,mode:'disabled'}),/PAT_DISABLED/);
  await assert.rejects(create(db,auth,{},identity('bob')),/PAT_DISABLED/);
  await assert.rejects(create(db,auth,{}, {...identity(),token:{uid:'alice',auth_time:1}}),/RECENT_AUTH_REQUIRED/);
});

test('PAT secret appears once, stored hash verifies, listing is owner-scoped and revocation is immediate',async()=>{
  const {db,store}=database(),{auth}=users();
  const created=await create(db,auth);assert.equal(created.status,201);
  const raw=created.body.secret;assert.match(raw,/^vela_pat_staging_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
  const signed=await verifyPat(db,auth,raw,config);assert.equal(signed.uid,'alice');assert.equal(signed.credentialKind,'pat');
  assert(!JSON.stringify([...store.values()]).includes(raw));
  const list=await dispatchPatApi(db,auth,identity(),request('GET','/v1/me/api-tokens'),config);
  assert.equal(list.body.items.length,1);assert(!JSON.stringify(list.body).includes('secretHash'));assert(!JSON.stringify(list.body).includes(raw));
  const other=await dispatchPatApi(db,auth,identity('bob'),request('GET','/v1/me/api-tokens'),config);assert.equal(other.body.items.length,0);
  await assert.rejects(verifyPat(db,auth,raw.slice(0,-1)+(raw.endsWith('a')?'b':'a'),config));
  const revoke=await dispatchPatApi(db,auth,identity(),request('DELETE',`/v1/me/api-tokens/${signed.credentialId}`),{...config,mode:'disabled'});assert.equal(revoke.status,200);
  await assert.rejects(verifyPat(db,auth,raw,config));
});

test('PAT rejects expired, wrong-environment/audience, disabled, revoked-account and deleted-account credentials',async()=>{
  const {db,store}=database(),{auth,records}=users(),created=await create(db,auth),raw=created.body.secret;
  const signed=await verifyPat(db,auth,raw,config);
  for(const cfg of [{...config,environment:'production'},{...config,audience:'https://other.example/businessApi'},{...config,allowedUids:[]}])await assert.rejects(verifyPat(db,auth,raw,cfg));
  records.alice.disabled=true;await assert.rejects(verifyPat(db,auth,raw,config));records.alice.disabled=false;
  records.alice.tokensValidAfterTime=new Date(Date.now()+10000).toISOString();await assert.rejects(verifyPat(db,auth,raw,config));records.alice.tokensValidAfterTime=new Date(0).toISOString();
  const row=store.get(`apiTokens/${signed.credentialId}`);row.expiresAt=new Date(0).toISOString();await assert.rejects(verifyPat(db,auth,raw,config));
  delete records.alice;await assert.rejects(verifyPat(db,auth,raw,config));
});

test('PAT caps creation transactionally, validates scopes/ranges, and cannot create other credentials',async()=>{
  const {db}=database(),{auth}=users();
  for(const body of [{scopes:[]},{scopes:['profiles:read','profiles:read']},{scopes:['admin']},{expiresInDays:0},{expiresInDays:91},{profileIds:['other']},{profileIds:[]}])await assert.rejects(create(db,auth,body));
  const outputs=await Promise.allSettled(Array.from({length:8},()=>create(db,auth)));assert.equal(outputs.filter(r=>r.status==='fulfilled').length,5);
  const result:any=outputs.find(r=>r.status==='fulfilled');const pat=await verifyPat(db,auth,result.value.body.secret,config);
  await assert.rejects(create(db,auth,{},pat),/FIREBASE_AUTH_REQUIRED/);
});

test('PAT scopes fail closed and restricted profiles cannot escape through session history or birth objects',async()=>{
  const {db,store}=database(),{auth}=users();
  const created=await create(db,auth,{scopes:['profiles:read','charts:compute','sessions:read','sessions:create','turns:write'],profileIds:['one']}),pat=await verifyPat(db,auth,created.body.secret,config);
  const check=(method:string,path:string,body?:unknown)=>authorizePatRequest(db,auth,pat,request(method,path,body),config);
  await check('GET','/v1/profiles/one');
  for(const path of ['/v1/profiles/two','/v1/profiles','/v1/sessions','/v1/me/usage','/v1/tuning/prompts','/v1/me/api-tokens'])await assert.rejects(check('GET',path));
  await assert.rejects(check('DELETE','/v1/me'));await assert.rejects(check('POST','/v1/me/share-claims',{}));
  await check('POST','/v1/sessions',{profileIds:['one'],mode:'personal'});
  await check('POST','/v1/charts/natal',{subjects:[{ref:'self',profile_id:'one'}]});
  for(const subjects of [[{ref:'other',profile_id:'two'}],[{ref:'raw',birth:{datetime:'1990-01-01T00:00'}}],[{ref:'country',country_chart:{id:'cn',version:'1'}}]])await assert.rejects(check('POST','/v1/sessions',{subjects}));
  store.set('users/alice/sessions/allowed',{frozenSubjects:[{ref:'self',profileId:'one',profile:{name:'one'}}]});
  store.set('users/alice/sessions/mixed',{frozenSubjects:[{ref:'self',profileId:'one',profile:{}},{ref:'other',profileId:'two',profile:{}}]});
  store.set('users/alice/sessions/raw',{frozenSubjects:[{ref:'raw',profile:{}}]});
  await check('GET','/v1/sessions/allowed/messages');await check('POST','/v1/sessions/allowed/turns',{message:'Synthetic'});
  for(const path of ['/v1/sessions/mixed/messages','/v1/sessions/raw','/v1/sessions/mixed/turns/turn'])await assert.rejects(check('GET',path));
});

test('PAT rate limits are separate from user quota and commit recheck sees revocation without charging twice',async()=>{
  const {db,store}=database(),{auth,records}=users(),created=await create(db,auth),pat=await verifyPat(db,auth,created.body.secret,config),cfg={...config,requestsPerMinute:2};
  const check=(consume=true)=>authorizePatRequest(db,auth,pat,request('GET','/v1/profiles/one'),cfg,consume);
  await check();await check();await check(false);await assert.rejects(check(),/PAT_RATE_LIMITED/);
  assert(!store.has('usage/alice'));
  records.alice.customClaims.stripeRole='free';assert.equal((await check(false)).token.stripeRole,'free');
  await dispatchPatApi(db,auth,identity(),request('DELETE',`/v1/me/api-tokens/${pat.credentialId}`),config);await assert.rejects(check(false));
});

test('PAT deletion blocks new credentials, clears owner records and preserves another user',async()=>{
  const {db,store}=database(),{auth}=users();await create(db,auth);await create(db,auth,{},identity('bob'),{...config,mode:'public'});
  store.set('users/alice',{deletionState:{status:'subscriptions_canceled'}});await assert.rejects(create(db,auth));
  await deleteUserPats(db,'alice');assert([...store.values()].some(v=>v.uid==='bob'));assert(![...store.values()].some(v=>v.uid==='alice'));
});


test('real Firestore serializes PAT creation cap and commit recheck observes immediate revocation', {skip:process.env.VELA_PAT_EMULATOR_TEST!=='1'}, async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:\d+$/);
  assert.match(process.env.FIREBASE_AUTH_EMULATOR_HOST||'',/^127\.0\.0\.1:\d+$/);
  const {initializeApp,deleteApp}=await import('firebase-admin/app');
  const {getAuth}=await import('firebase-admin/auth');
  const {getFirestore}=await import('firebase-admin/firestore');
  const app=initializeApp({projectId:'demo-vela-ci'},'pat-real-tests'),db=getFirestore(app),auth=getAuth(app);
  const user=await auth.createUser({}),uid=user.uid,root=db.doc(`users/${uid}`);
  const who={...identity(uid)},cfg={...config,allowedUids:[uid]};
  try{
    await root.set({displayName:'Synthetic PAT owner'});await root.collection('profiles').doc('one').set({name:'Synthetic'});
    const attempts=await Promise.allSettled(Array.from({length:9},()=>create(db,auth,{},who,cfg)));
    const succeeded=attempts.filter((r:any)=>r.status==='fulfilled');assert.equal(succeeded.length,5);
    const first:any=succeeded[0],pat=await verifyPat(db,auth,first.value.body.secret,cfg);
    await authorizePatRequest(db,auth,pat,request('GET','/v1/profiles/one'),cfg);
    await dispatchPatApi(db,auth,who,request('DELETE',`/v1/me/api-tokens/${pat.credentialId}`),cfg);
    await assert.rejects(authorizePatRequest(db,auth,pat,request('GET','/v1/profiles/one'),cfg,false));
    assert.equal((await create(db,auth,{},who,cfg)).status,201,'Revoked slot can be replaced');
    await root.set({deletionState:{status:'subscriptions_canceled'}},{merge:true});
    await assert.rejects(create(db,auth,{},who,cfg));
  }finally{
    await deleteUserPats(db,uid);await db.recursiveDelete(root);await auth.deleteUser(uid);await deleteApp(app);
  }
});

test('enabled PAT configuration is bound to trusted project and never falls back across environments',()=>{
  const env={PAT_MODE:'internal',PAT_ALLOWED_UIDS:'alice',VELA_ENVIRONMENT:'staging',GCLOUD_PROJECT:'vela-stage',PAT_AUDIENCE:'https://asia-southeast1-vela-stage.cloudfunctions.net/businessApi'};
  assert.equal(readPatConfig(env).audience,env.PAT_AUDIENCE);
  for(const patch of [{PAT_MODE:'unknown'},{PAT_ALLOWED_UIDS:''},{PAT_AUDIENCE:'https://evil.test/businessApi'},{GCLOUD_PROJECT:'vela-prod'},{VELA_ENVIRONMENT:'unknown'},{PAT_ALLOWED_UIDS:'alice,invalid/uid'}])assert.throws(()=>readPatConfig({...env,...patch}));
  assert.equal(readPatConfig({...env,PAT_MODE:'public',PAT_ALLOWED_UIDS:''}).mode,'public');
  const emulator={PAT_MODE:'internal',PAT_ALLOWED_UIDS:'alice',VELA_ENVIRONMENT:'emulator',GCLOUD_PROJECT:'demo-vela-ci',FUNCTIONS_EMULATOR:'true',PAT_AUDIENCE:'http://127.0.0.1:5001/demo-vela-ci/asia-southeast1/businessApi'};
  assert.equal(readPatConfig(emulator).environment,'emulator');
  assert.throws(()=>readPatConfig({...emulator,FUNCTIONS_EMULATOR:'false'}));
  assert.throws(()=>readPatConfig({...emulator,PAT_AUDIENCE:'http://evil.test:5001/demo-vela-ci/asia-southeast1/businessApi'}));
});

test('restricted country subjects require a permitted profile source in both request and all frozen snapshots',async()=>{
  const {db,store}=database(),{auth}=users();
  const raw=(await create(db,auth,{profileIds:['one'],scopes:['profiles:read','sessions:read','sessions:create']})).body.secret;
  const pat=await verifyPat(db,auth,raw,config);
  const check=(method:string,path:string,body?:unknown)=>authorizePatRequest(db,auth,pat,request(method,path,body),config);
  const subjects=[{ref:'person',profile_id:'one'},{ref:'country',country_chart:{source_ref:'person'}}];
  await check('POST','/v1/sessions',{subjects});
  const frozenSubjects=[{ref:'person',profileId:'one',profile:{}},{ref:'country',profile:{},countryChart:{sourceRef:'person'}}];
  store.set('users/alice/sessions/country',{frozenSubjects});
  await check('GET','/v1/sessions/country/messages');
  for(const source_ref of ['missing','country'])await assert.rejects(check('POST','/v1/sessions',{subjects:[subjects[0],{ref:'country',country_chart:{source_ref}}]}),/PAT_PROFILE_SCOPE_DENIED/);
  store.set('users/alice/sessions/country',{frozenSubjects:[frozenSubjects[0],{...frozenSubjects[1],countryChart:{}}]});
  await assert.rejects(check('GET','/v1/sessions/country/messages'),/PAT_PROFILE_SCOPE_DENIED/);
  store.set('users/alice/sessions/legacy',{profileIds:['one','two']});
  await assert.rejects(check('GET','/v1/sessions/legacy'),/PAT_PROFILE_SCOPE_DENIED/);
});

test('six generation attempts per minute do not consume or replace user quota, and unrestricted list remains available',async()=>{
  const {db,store}=database(),{auth}=users();
  const pat=await verifyPat(db,auth,(await create(db,auth,{scopes:['sessions:read','turns:write','profiles:read']})).body.secret,config);
  const check=()=>authorizePatRequest(db,auth,pat,request('POST','/v1/sessions/session/turns',{message:'test'}),config);
  const results=await Promise.allSettled(Array.from({length:9},check));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,6);
  for(const result of results)if(result.status==='rejected')assert.equal(result.reason.message,'PAT_RATE_LIMITED');
  assert(!store.has('usage/alice'));
  await authorizePatRequest(db,auth,pat,request('GET','/v1/profiles'),config);
  await authorizePatRequest(db,auth,pat,request('GET','/v1/sessions'),config);
});

test('management pagination stays owner scoped and unrelated users cannot revoke known token ids',async()=>{
  const {db}=database(),{auth}=users();
  const one=await create(db,auth),two=await create(db,auth);
  await create(db,auth,{},identity('bob'),{...config,mode:'public'});
  const page=await dispatchPatApi(db,auth,identity(),{method:'GET',path:'/v1/me/api-tokens',query:{limit:'1'}},config);
  assert.equal(page.body.items.length,1);assert(page.body.nextCursor);
  const next=await dispatchPatApi(db,auth,identity(),{method:'GET',path:'/v1/me/api-tokens',query:{limit:'1',cursor:page.body.nextCursor}},config);
  assert.equal(next.body.items.length,1);assert.equal(next.body.nextCursor,null);
  assert.deepEqual(new Set([page.body.items[0].id,next.body.items[0].id]),new Set([one.body.id,two.body.id]));
  await assert.rejects(dispatchPatApi(db,auth,identity('bob'),request('DELETE',`/v1/me/api-tokens/${one.body.id}`),config),/TOKEN_NOT_FOUND/);
  await assert.rejects(create(db,auth,{}, {...identity(),credentialKind:'unknown'}),/FIREBASE_AUTH_REQUIRED/);
});

test('commit guard reads credentials and account in the transaction and rejects changed authority',async()=>{
  const {db,store}=database(),{auth}=users();
  const pat=await verifyPat(db,auth,(await create(db,auth,{scopes:['profiles:read','sessions:read']})).body.secret,config);
  const check=()=>db.runTransaction(tx=>assertPatTransaction(db,tx,pat,config));
  await check();
  const row=store.get(`apiTokens/${pat.credentialId}`);
  row.scopes=['profiles:read'];await assert.rejects(check(),/PAT_SCOPE_DENIED/);row.scopes=pat.scopes;
  row.profileIds=['one'];await assert.rejects(check(),/PAT_PROFILE_SCOPE_DENIED/);delete row.profileIds;
  store.set('users/alice',{deletionState:'in_progress'});await assert.rejects(check(),/ACCOUNT_DELETING/);store.set('users/alice',{});
  row.revokedAt=new Date().toISOString();await assert.rejects(check(),/INVALID_PAT/);
});

test('capability hides unopened users and preserves management after disable or removal from internal rollout',async()=>{
  const {db}=database(),{auth}=users();
  const capability=(who=identity(),cfg=config)=>dispatchPatApi(db,auth,who,request('GET','/v1/me/api-token-capabilities'),cfg);
  assert.deepEqual((await capability()).body,{canCreate:true,canManage:true});
  assert.deepEqual((await capability(identity('bob'))).body,{canCreate:false,canManage:false});
  assert.deepEqual((await capability(identity(),{...config,mode:'disabled'})).body,{canCreate:false,canManage:false});
  assert.deepEqual((await capability(identity('bob'),{...config,mode:'public'})).body,{canCreate:true,canManage:true});
  const created=await create(db,auth);
  for(const cfg of [{...config,mode:'disabled' as const},{...config,allowedUids:[]}])assert.deepEqual((await capability(identity(),cfg)).body,{canCreate:false,canManage:true});
  await dispatchPatApi(db,auth,identity(),request('DELETE',`/v1/me/api-tokens/${created.body.id}`),config);
  assert.deepEqual((await capability(identity(),{...config,mode:'disabled'})).body,{canCreate:false,canManage:true},'Historical records retain management access');
  assert.deepEqual((await capability(identity('bob'))).body,{canCreate:false,canManage:false},'Another user token must not reveal an entry');
});

test('capability requires current Firebase identity and never offers creation during deletion or before account initialization',async()=>{
  const {db,store}=database(),{auth,records}=users();
  const check=(who:any=identity())=>dispatchPatApi(db,auth,who,request('GET','/v1/me/api-token-capabilities'),config);
  const pat=await verifyPat(db,auth,(await create(db,auth)).body.secret,config);
  await assert.rejects(check(pat),/FIREBASE_AUTH_REQUIRED/);
  await assert.rejects(check({...identity(),credentialKind:'unknown'}),/FIREBASE_AUTH_REQUIRED/);
  await assert.rejects(check(identity('')),/AUTH_REQUIRED/);
  store.set('users/alice',{deletionState:'in_progress'});
  assert.deepEqual((await check()).body,{canCreate:false,canManage:true});
  await assert.rejects(create(db,auth),/ACCOUNT_DELETING/);
  records.alice.disabled=true;await assert.rejects(check(),/INVALID_TOKEN/);
  delete records.alice;await assert.rejects(check(),/INVALID_TOKEN/);
  store.delete('users/bob');
  assert.deepEqual((await dispatchPatApi(db,auth,identity('bob'),request('GET','/v1/me/api-token-capabilities'),{...config,mode:'public'})).body,{canCreate:false,canManage:false});
});
