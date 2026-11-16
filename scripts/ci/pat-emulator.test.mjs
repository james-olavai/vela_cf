import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHttpApi,verifyApiIdentity} from '../../apps/api/src/http-api.ts';
import {verifyPat,authorizePatRequest,dispatchPatApi,deleteUserPats,assertPatTransaction} from '../../apps/api/src/pat.ts';
import {dispatchBusinessApi} from '../../apps/api/src/business-api.ts';
import {createChatRunner} from '../../apps/api/src/chat-service.ts';
import {deleteAccountWithRetry} from '../../apps/api/src/account.ts';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const {initializeApp,deleteApp}=require('firebase-admin/app'),{getAuth}=require('firebase-admin/auth'),{getFirestore}=require('firebase-admin/firestore');
const authHost=process.env.FIREBASE_AUTH_EMULATOR_HOST;
if(!/^127\.0\.0\.1:\d+$/.test(authHost||'')||!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw new Error('PAT integration requires local emulators');

test('PAT HTTP lifecycle uses real Auth and Firestore authorization, including commit revocation',async(t)=>{
  const app=initializeApp({projectId:'demo-vela-ci'},'pat-http-test'),auth=getAuth(app),db=getFirestore(app);
  const config={mode:'internal',environment:'emulator',audience:'http://127.0.0.1:5001/demo-vela-ci/asia-southeast1/businessApi',allowedUids:[],requestsPerMinute:60};
  const users=[];let requireAppCheck=false,hold=false,entered,release,revokeOnCommit,revokePending,commitAttempts=0;
  const runner=createChatRunner(db,async()=>{
    if(hold){entered();await new Promise(resolve=>{release=resolve;});}
    return {text:'Synthetic deterministic reading.',uiBlocks:[],suggestions:[],toolParts:[],chart:{},usage:{inputTokens:10,outputTokens:10}};
  },async(context,sessionId)=>{
    if(context.auth.credentialKind==='pat')context.auth.token=(await authorizePatRequest(db,auth,context.auth,{method:'POST',path:`/v1/sessions/${sessionId}/turns`},config,false)).token;
  },async(tx,context)=>{
    if(context.auth.credentialKind!=='pat')return;
    if(revokeOnCommit){
      commitAttempts++;
      if(commitAttempts===1){
        await assertPatTransaction(db,tx,context.auth,config);
        revokePending=revokeOnCommit();
        // A genuine SDK retry releases pessimistic locks before the HTTP revocation
        // completes. The second attempt must re-read authorization, not trust attempt one.
        throw Object.assign(new Error('Synthetic transaction contention'),{code:10});
      }
      await revokePending;
    }
    await assertPatTransaction(db,tx,context.auth,config);
  });
  const dependencies={verifyToken:raw=>verifyApiIdentity(auth,raw),verifyPat:raw=>verifyPat(db,auth,raw,config),authorizePat:(identity,input)=>authorizePatRequest(db,auth,identity,input,config),
    dispatch:input=>(input.path.startsWith('/v1/me/api-tokens')||input.path==='/v1/me/api-token-capabilities')?dispatchPatApi(db,auth,input.auth,input,config):input.path==='/v1/me'&&input.method==='DELETE'?deleteAccountWithRetry({db,auth,uid:input.auth.uid}).then(body=>({status:200,body})):dispatchBusinessApi(db,input),
    stream:(body,identity,emit,signal)=>runner(body,{auth:identity,turnId:identity.turnId},emit,signal)};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let body='';for await(const chunk of req)body+=chunk;
    req.path=url.pathname;req.query=Object.fromEntries(url.searchParams);req.body=body?JSON.parse(body):undefined;
    req.get=name=>req.headers[name.toLowerCase()];req.is=mime=>req.headers['content-type']?.startsWith(mime);
    res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    // There is no App Check emulator: reject every supplied attestation. This tests the
    // machine-route bypass only; Firebase verification and PAT authorization stay real.
    await createHttpApi({...dependencies,...(requireAppCheck?{verifyAppCheck:async()=>{throw new Error('No App Check emulator');}}:{})})(req,res);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(token,method,path,body,headers={})=>{
    const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    const text=await response.text();return {status:response.status,body:response.headers.get('content-type')?.includes('text/event-stream')?text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))):JSON.parse(text)};
  };
  try{
    const signup=await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(signup.status,200);const user=await signup.json(),uid=user.localId,idToken=user.idToken;users.push(uid);config.allowedUids=[uid];
    await db.doc(`users/${uid}`).set({name:'Synthetic PAT test'});
    const profile=(await call(idToken,'POST','/v1/profiles',{name:'PAT fixture',birthDateTime:'1994-06-03T08:20',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',locationName:'Shanghai',gender:'female'})).body;
    const scopes=['profiles:read','charts:compute','sessions:read','sessions:create','turns:write','usage:read'];
    const create=async(extra={})=>call(idToken,'POST','/v1/me/api-tokens',{name:'Synthetic test',scopes,...extra});
    const capability=()=>call(idToken,'GET','/v1/me/api-token-capabilities');
    assert.deepEqual((await capability()).body,{canCreate:true,canManage:true});
    config.allowedUids=[];assert.deepEqual((await capability()).body,{canCreate:false,canManage:false});config.allowedUids=[uid];
    config.mode='disabled';assert.deepEqual((await capability()).body,{canCreate:false,canManage:false});
    assert.equal((await create()).body.error.code,'PAT_DISABLED');config.mode='internal';
    const now=Date.now(),clock=t.mock.method(Date,'now',()=>now+301000);
    try{assert.equal((await create()).body.error.code,'RECENT_AUTH_REQUIRED');}finally{clock.mock.restore();}
    const issued=await create();assert.equal(issued.status,201);const pat=issued.body.secret,patId=issued.body.id;
    assert.match(pat,/^vela_pat_emulator_/);
    config.mode='disabled';assert.deepEqual((await capability()).body,{canCreate:false,canManage:true});
    assert.equal((await call(idToken,'GET','/v1/me/api-tokens')).body.items.length,1);
    assert.equal((await create()).body.error.code,'PAT_DISABLED');config.mode='internal';
    config.allowedUids=[];assert.deepEqual((await capability()).body,{canCreate:false,canManage:true});config.allowedUids=[uid];
    await db.doc(`users/${uid}`).update({deletionState:{status:'in_progress'}});
    assert.deepEqual((await capability()).body,{canCreate:false,canManage:true});
    await db.doc(`users/${uid}`).set({name:'Synthetic PAT test'});
    assert.equal((await call(pat,'GET','/v1/me/api-token-capabilities')).body.error.code,'PAT_SCOPE_DENIED');

    const persisted=(await db.doc(`apiTokens/${patId}`).get()).data();assert(!JSON.stringify(persisted).includes(pat));assert.equal(persisted.secretHash.length,64);
    const listing=await call(idToken,'GET','/v1/me/api-tokens');assert.equal(listing.body.items.length,1);assert(!JSON.stringify(listing).includes(pat));assert(!JSON.stringify(listing).includes('secretHash'));
    assert.equal((await call(pat,'GET',`/v1/profiles/${profile.id}`)).status,200);
    assert.equal((await call(pat,'GET','/v1/me/usage')).status,200);
    for(const [method,path,body] of [['POST','/v1/me/api-tokens',{name:'Escalate',scopes}],['DELETE','/v1/me'],['POST','/v1/profiles',{}],['GET','/v1/tuning/packs'],['POST','/v1/billing/checkout',{}]]){
      assert.equal((await call(pat,method,path,body)).body.error.code,'PAT_SCOPE_DENIED',path);
    }
    requireAppCheck=true;
    assert.equal((await call(idToken,'GET','/v1/me/usage')).body.error.code,'APP_CHECK_REQUIRED');
    assert.equal((await call(idToken,'GET','/v1/me/usage',undefined,{'X-Firebase-AppCheck':'invalid'})).body.error.code,'INVALID_APP_CHECK');
    assert.equal((await call(pat,'GET','/v1/me/usage')).status,200);
    requireAppCheck=false;
    config.environment='staging';assert.equal((await call(pat,'GET','/v1/me/usage')).body.error.code,'INVALID_PAT');config.environment='emulator';
    config.audience+='-other';assert.equal((await call(pat,'GET','/v1/me/usage')).body.error.code,'INVALID_PAT');config.audience=config.audience.slice(0,-6);
    config.allowedUids=[];assert.equal((await call(pat,'GET','/v1/me/usage')).body.error.code,'PAT_DISABLED');config.allowedUids=[uid];
    const restricted=await create({scopes:['profiles:read'],profileIds:[profile.id]});assert.equal(restricted.status,201);
    assert.equal((await call(restricted.body.secret,'GET',`/v1/profiles/${profile.id}`)).status,200);
    assert.equal((await call(restricted.body.secret,'GET','/v1/profiles')).body.error.code,'PAT_PROFILE_SCOPE_DENIED');
    assert.equal((await call(restricted.body.secret,'GET','/v1/profiles/another-profile')).body.error.code,'PAT_PROFILE_SCOPE_DENIED');
    assert.equal((await call(restricted.body.secret,'GET','/v1/me/usage')).body.error.code,'PAT_SCOPE_DENIED');
    const disabledToken=await create();assert.equal(disabledToken.status,201);
    config.mode='disabled';
    assert.equal((await call(idToken,'DELETE',`/v1/me/api-tokens/${disabledToken.body.id}`)).status,200);
    assert((await call(idToken,'GET','/v1/me/api-tokens')).body.items.find(item=>item.id===disabledToken.body.id).revokedAt);
    config.mode='internal';
    const session=await call(pat,'POST','/v1/sessions',{mode:'personal',subjects:[{ref:'self',profile_id:profile.id}]});assert.equal(session.status,201);
    const sessionId=session.body.id;
    const success=await call(pat,'POST',`/v1/sessions/${sessionId}/turns`,{message:'Synthetic question'},{'Idempotency-Key':'successful'});assert.equal(success.body.at(-1).type,'result');
    const before=(await db.doc(`usage/${uid}`).get()).data().used;
    const retryToken=await create();assert.equal(retryToken.status,201);
    revokeOnCommit=()=>call(idToken,'DELETE',`/v1/me/api-tokens/${retryToken.body.id}`);
    const retried=await call(retryToken.body.secret,'POST',`/v1/sessions/${sessionId}/turns`,{message:'Must fail on retried transaction'},{'Idempotency-Key':'revoked-retry'});
    revokeOnCommit=undefined;
    assert.equal(retried.body.at(-1).error.code,'INVALID_PAT');assert.equal(commitAttempts,2);
    assert.equal((await revokePending).status,200);
    assert.equal((await db.doc(`usage/${uid}`).get()).data().used,before);
    assert.equal((await db.collection(`users/${uid}/sessions/${sessionId}/messages`).get()).size,2);
    assert.equal((await db.doc(`users/${uid}/sessions/${sessionId}/turns/revoked-retry`).get()).data().status,'failed');
    hold=true;const ready=new Promise(resolve=>{entered=resolve;});
    const pending=call(pat,'POST',`/v1/sessions/${sessionId}/turns`,{message:'Must not commit after revoke'},{'Idempotency-Key':'revoked-inflight'});
    await Promise.race([ready,pending.then(()=>{throw new Error('Model did not reach hold');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Model hold timeout')),15000);timer.unref();})]);
    assert.equal((await call(idToken,'DELETE',`/v1/me/api-tokens/${patId}`)).status,200);release();
    const revoked=await pending;assert.equal(revoked.body.at(-1).error.code,'INVALID_PAT');
    assert.equal((await db.doc(`usage/${uid}`).get()).data().used,before);
    assert.equal((await db.collection(`users/${uid}/sessions/${sessionId}/messages`).get()).size,2);
    assert.equal((await db.doc(`users/${uid}/sessions/${sessionId}/turns/revoked-inflight`).get()).data().status,'failed');
    assert(!(await db.doc(`users/${uid}/sessions/${sessionId}`).get()).data().activeTurnId);
    assert.equal(Object.keys((await db.doc(`usage/${uid}`).get()).data().reservations||{}).length,0);
    assert.equal((await call(pat,'GET','/v1/me/usage')).body.error.code,'INVALID_PAT');
    const deletionToken=await create();assert.equal(deletionToken.status,201);
    const deletingReady=new Promise(resolve=>{entered=resolve;});
    const deletingTurn=call(deletionToken.body.secret,'POST',`/v1/sessions/${sessionId}/turns`,{message:'Must not survive account deletion'},{'Idempotency-Key':'account-deleting'});
    await Promise.race([deletingReady,deletingTurn.then(()=>{throw new Error('Deleting turn did not reach model');})]);
    assert.equal((await call(idToken,'DELETE','/v1/me')).status,200);release();
    assert.equal((await deletingTurn).body.at(-1).error.code,'INVALID_PAT');
    assert(!(await db.doc(`users/${uid}`).get()).exists);
    assert(!(await db.doc(`usage/${uid}`).get()).exists);
    assert.equal((await db.collection(`users/${uid}/sessions/${sessionId}/messages`).get()).size,0);

    assert.equal((await db.collection('apiTokens').where('uid','==',uid).get()).size,0);
    await assert.rejects(auth.getUser(uid),error=>error.code==='auth/user-not-found');
    assert.equal((await call(restricted.body.secret,'GET',`/v1/profiles/${profile.id}`)).body.error.code,'INVALID_PAT');
  }finally{
    release?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    for(const uid of users){await deleteUserPats(db,uid);await db.recursiveDelete(db.doc(`users/${uid}`));await db.doc(`usage/${uid}`).delete();await db.recursiveDelete(db.doc(`customers/${uid}`));await auth.deleteUser(uid).catch(error=>{if(error.code!=='auth/user-not-found')throw error;});}
    await deleteApp(app);
  }
});
