import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createChatRunner } from '../../apps/api/src/chat-service.ts';
import { createHttpApi, verifyApiIdentity } from '../../apps/api/src/http-api.ts';
import { dispatchTurnApi } from '../../apps/api/src/turns.ts';
import { dispatchBusinessApi } from '../../apps/api/src/business-api.ts';
import { apiClient } from './api-smoke.mjs';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const {initializeApp,deleteApp}=require('firebase-admin/app'),{getAuth}=require('firebase-admin/auth'),{getFirestore}=require('firebase-admin/firestore'),{HttpsError}=require('firebase-functions/v2/https');
const authHost=process.env.FIREBASE_AUTH_EMULATOR_HOST;
if(!/^127\.0\.0\.1:\d+$/.test(authHost||'')||!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw new Error('Chat integration requires local emulators');

test('real HTTP chat runner persists messages and usage, uses frozen subject and cleans failed turns',async()=>{
  const app=initializeApp({projectId:'demo-vela-ci'},'api-chat-test'),db=getFirestore(app),auth=getAuth(app);
  let uid,fail=false,observed,sessionId,hold=false,empty=false,invalid=false,generations=0,waiting,unblock,dropCompletedResponse=false,modelFailure,expectedSessionId;
  const runner=createChatRunner(db,async(input,emit)=>{
    try {
    observed=input;++generations;
    const current=(await db.doc(`users/${uid}/sessions/${expectedSessionId || sessionId}`).get()).data();
    const quota=(await db.doc(`usage/${uid}`).get()).data();
    assert(current.activeTurnExpiresAt-Date.now()>180000,'Lock must outlive function runtime');
    assert(Object.values(quota.reservations).every(r=>r.expiresAt-Date.now()>180000),'Reservation must outlive function runtime');
    assert(input.signal instanceof AbortSignal);

    if(hold){waiting?.();await new Promise((resolve,reject)=>{unblock=resolve;input.signal.addEventListener('abort',()=>reject(new HttpsError('aborted','TURN_CANCELLED')),{once:true});});}
    emit({type:'text',text:fail?'Partial synthetic text':'A useful synthetic reading for the API integration test.'});
    if(fail)throw new HttpsError('unavailable','MODEL_BUSY');
    return {text:empty?'   ':'A useful synthetic reading for the API integration test.',uiBlocks:[],suggestions:[],toolParts:invalid?[undefined]:[],chart:{},usage:{inputTokens:10,outputTokens:10}};
    } catch(error) { modelFailure=error; throw error; }
  });
  const handler=createHttpApi({verifyToken:t=>verifyApiIdentity(auth,t),dispatch:i=>i.path.includes('/turns/')?dispatchTurnApi(db,i):dispatchBusinessApi(db,i),stream:(body,identity,emit,signal)=>runner(body,{auth:identity,turnId:identity.turnId},emit,signal)});
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let body='';for await(const chunk of req)body+=chunk;
    req.path=url.pathname;req.query=Object.fromEntries(url.searchParams);req.body=body?JSON.parse(body):undefined;
    req.get=name=>req.headers[name.toLowerCase()];req.is=mime=>req.headers['content-type']?.startsWith(mime);
    res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    const write=res.write.bind(res);
    res.write=(chunk,...args)=>{
      if(dropCompletedResponse && String(chunk).includes('"type":"done"')) {res.destroy();return false;}
      return write(chunk,...args);
    };
    await handler(req,res);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const signup=await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(signup.status,200);const user=await signup.json();uid=user.localId;const call=apiClient(base,user.idToken);
    const profile=await call('POST','/v1/profiles',{name:'Frozen name',birthDateTime:'1994-06-03T08:20',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',locationName:'Shanghai',gender:'female'});
    assert.equal(profile.status,201);
    const session=await call('POST','/v1/sessions',{mode:'personal',subjects:[{ref:'subject1',profile_id:profile.body.id}]});assert.equal(session.status,201);sessionId=session.body.id;
    await call('PATCH',`/v1/profiles/${profile.body.id}`,{name:'Edited later'});
    const send=async(key,question='Synthetic question',target=session.body.id)=>{
      expectedSessionId=target;
      const response=await fetch(`${base}/v1/sessions/${target}/turns`,{method:'POST',headers:{Authorization:`Bearer ${user.idToken}`,'Content-Type':'application/json',Accept:'text/event-stream',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify({message:question}),signal:AbortSignal.timeout(30000)});
      if(response.status!==200)return {status:response.status,...await response.json()};
      assert.match(response.headers.get('content-type'),/text\/event-stream/);
      return (await response.text()).split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
    };
    const startHeld=async(label,key,target=sessionId)=>{
      let timer;modelFailure=undefined;expectedSessionId=target;
      const ready=new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error(`${label}: model did not enter hold; generations=${generations}`,{cause:modelFailure})),15000);
        waiting=()=>resolve();
      });
      const pending=send(key,'Synthetic question',target);
      try { await Promise.race([ready,pending.then(result=>{throw new Error(`${label}: request ended before model hold: ${JSON.stringify(result)}`,{cause:modelFailure});})]); }
      finally {clearTimeout(timer);}
      assert.equal(typeof unblock,'function',`${label}: missing model release`);
      return {pending,release:unblock};
    };
    const events=await send('first-turn');assert.deepEqual(events.map(e=>e.type),['started','text','chart','done','result']);assert.match(events.at(-1).result.text,/synthetic reading/);
    assert.equal(observed.profiles[0].name,'Frozen name');
    const messages=await call('GET',`/v1/sessions/${session.body.id}/messages`);assert.equal(messages.body.items.length,2);
    const usage=await call('GET','/v1/me/usage');assert(usage.body.used>0);const before=usage.body.used;
    fail=true;const failure=await send();assert.deepEqual(failure.map(e=>e.type),['started','text','error']);assert.equal(failure.at(-1).error.retryable,true);
    assert.equal((await call('GET',`/v1/sessions/${session.body.id}/messages`)).body.items.length,2,'Failed turn cannot replace persisted messages');
    assert.equal((await call('GET','/v1/me/usage')).body.used,before);
    fail=false;
    const beforeReplay=generations;
    const replay=await send('first-turn');assert.deepEqual(replay.map(e=>e.type),['done','result']);assert.equal(generations,beforeReplay);
    assert.equal((await call('GET','/v1/me/usage')).body.used,before);
    assert.equal((await send('first-turn','Changed question')).error.code,'IDEMPOTENCY_CONFLICT');
    const completed=await call('GET',`/v1/sessions/${sessionId}/turns/first-turn`);assert.equal(completed.body.status,'completed');
    assert.equal((await call('POST',`/v1/sessions/${sessionId}/turns/first-turn/cancel`,{})).body.status,'completed');
    // Cancellation while the model is in flight prevents both message and quota commit.
    hold=true;const {pending:cancelled}=await startHeld('explicit cancellation','cancel-me');
    assert.equal((await send('cancel-me')).error.code,'TURN_RUNNING');
    assert.equal((await call('POST',`/v1/sessions/${sessionId}/turns/cancel-me/cancel`,{})).body.status,'cancelled');
    assert.equal((await cancelled).at(-1).type,'error');hold=false;
    assert.equal((await call('GET',`/v1/sessions/${sessionId}/messages`)).body.items.length,2);
    assert.equal((await call('GET','/v1/me/usage')).body.used,before);
    // A serialization failure at commit cannot leave messages saved but quota unsettled.
    invalid=true;assert.equal((await send('invalid-commit')).at(-1).type,'error');invalid=false;
    assert.equal((await call('GET',`/v1/sessions/${sessionId}/messages`)).body.items.length,2);
    assert.equal((await call('GET','/v1/me/usage')).body.used,before);
    assert.equal((await call('GET',`/v1/sessions/${sessionId}/turns/invalid-commit`)).body.status,'failed');
    empty=true;assert.equal((await send('empty-model')).at(-1).type,'error');empty=false;
    assert.equal((await call('GET',`/v1/sessions/${sessionId}/messages`)).body.items.length,2);
    assert.equal((await call('GET','/v1/me/usage')).body.used,before);
    assert.equal((await call('GET',`/v1/sessions/${sessionId}/turns/empty-model`)).body.status,'failed');
    // Terminal keys never generate again; a new key is required for explicit retry.
    const beforeFailedReplay=generations;assert.equal((await send('invalid-commit')).error.code,'TURN_FAILED');assert.equal(generations,beforeFailedReplay);
    // Same key across two sessions must reserve distinct quota entries.
    const second=await call('POST','/v1/sessions',{mode:'personal',subjects:[{ref:'subject1',profile_id:profile.body.id}]});
    await db.doc(`usage/${uid}`).update({overrideTier:'free',unlimited:false});
    hold=true;const {pending:firstParallel,release:releaseFirst}=await startHeld('parallel first session','shared-key');
    const {pending:secondParallel,release:releaseSecond}=await startHeld('parallel second session','shared-key',second.body.id);
    assert.equal(Object.keys((await db.doc(`usage/${uid}`).get()).data().reservations).length,2);
    releaseFirst();releaseSecond();assert.equal((await firstParallel).at(-1).type,'result');assert.equal((await secondParallel).at(-1).type,'result');hold=false;
    const parallelQuota=(await db.doc(`usage/${uid}`).get()).data();
    assert.equal(Object.keys(parallelQuota.reservations).length,0,'Concurrent settlement must remove both reservations');
    assert.equal(parallelQuota.overrideTier,'free');assert.equal(parallelQuota.unlimited,false);
    // Losing the final response after commit must recover the same result without generating or charging twice.
    const beforeLostUsage=(await call('GET','/v1/me/usage')).body.used;
    const beforeLostMessages=(await call('GET',`/v1/sessions/${sessionId}/messages`)).body.items.length;
    const beforeLostGeneration=generations;
    dropCompletedResponse=true;
    try {await assert.rejects(()=>send('lost-response'));}finally{dropCompletedResponse=false;}
    const recovered=await call('GET',`/v1/sessions/${sessionId}/turns/lost-response`);
    assert.equal(recovered.body.status,'completed');assert.match(recovered.body.result.text,/synthetic reading/);
    const afterLostUsage=(await call('GET','/v1/me/usage')).body.used;assert(afterLostUsage>beforeLostUsage);
    assert.equal((await call('GET',`/v1/sessions/${sessionId}/messages`)).body.items.length,beforeLostMessages+2);
    const recoveredReplay=await send('lost-response');assert.deepEqual(recoveredReplay.map(e=>e.type),['done','result']);
    assert.deepEqual(recoveredReplay.at(-1).result,recovered.body.result);assert.equal(generations,beforeLostGeneration+1);
    assert.equal((await call('GET','/v1/me/usage')).body.used,afterLostUsage);
    // Cancellation racing with commit has exactly one terminal outcome and matching side effects.
    const raceUsage=afterLostUsage,raceMessages=(await call('GET',`/v1/sessions/${sessionId}/messages`)).body.items.length;
    hold=true;const {pending:racingTurn,release:raceRelease}=await startHeld('cancel versus commit','cancel-commit-race');
    const racingCancel=call('POST',`/v1/sessions/${sessionId}/turns/cancel-commit-race/cancel`,{});raceRelease();
    const [raceEvents,cancelResult]=await Promise.all([racingTurn,racingCancel]);hold=false;
    const raceState=(await call('GET',`/v1/sessions/${sessionId}/turns/cancel-commit-race`)).body.status;
    assert(['completed','cancelled'].includes(raceState));assert.equal(cancelResult.body.status,raceState);
    assert.equal(raceEvents.at(-1).type,raceState==='completed'?'result':'error');
    assert.equal((await call('GET',`/v1/sessions/${sessionId}/messages`)).body.items.length,raceMessages+(raceState==='completed'?2:0));
    const afterRaceUsage=(await call('GET','/v1/me/usage')).body.used;
    assert(raceState==='completed'?afterRaceUsage>raceUsage:afterRaceUsage===raceUsage);
    // Cancelling one of two sessions using the same key must not release the other's reservation.
    hold=true;const {pending:cancelOne}=await startHeld('cancel isolation first session','shared-cancel');
    const {pending:continueOther,release:finishOther}=await startHeld('cancel isolation second session','shared-cancel',second.body.id);
    assert.equal((await call('POST',`/v1/sessions/${sessionId}/turns/shared-cancel/cancel`,{})).body.status,'cancelled');
    assert.equal((await cancelOne).at(-1).type,'error');
    assert.equal(Object.keys((await db.doc(`usage/${uid}`).get()).data().reservations).length,1);
    finishOther();assert.equal((await continueOther).at(-1).type,'result');hold=false;
    // Another user cannot query or cancel a turn using its known identifiers.
    const outsider=await auth.createUser({});const outsiderCall=i=>dispatchTurnApi(db,{...i,auth:{uid:outsider.uid}});
    try {for(const method of ['GET','POST'])await assert.rejects(outsiderCall({method,path:`/v1/sessions/${sessionId}/turns/first-turn${method==='POST'?'/cancel':''}`,body:{}}),/TURN_NOT_FOUND/);}finally{await auth.deleteUser(outsider.uid);}
    // Expired leases become terminal on read; retries cannot regenerate them.
    await db.doc(`users/${uid}/sessions/${sessionId}/turns/stale`).set({id:'stale',status:'running',createdAt:new Date().toISOString(),expiresAt:Date.now()-1});
    assert.equal((await call('GET',`/v1/sessions/${sessionId}/turns/stale`)).body.error,'TURN_INTERRUPTED');
    // Expired running keys become failed on replay even if no preceding GET was made.
    const staleInput={sessionId,message:'Synthetic question'};
    await db.doc(`users/${uid}/sessions/${sessionId}/turns/stale-replay`).set({id:'stale-replay',hash:createHash('sha256').update(JSON.stringify(staleInput)).digest('hex'),status:'running',createdAt:new Date().toISOString(),expiresAt:Date.now()-1});
    const beforeStaleReplay=generations;assert.equal((await send('stale-replay')).error.code,'TURN_FAILED');assert.equal(generations,beforeStaleReplay);
    assert.equal((await call('GET',`/v1/sessions/${sessionId}/turns/stale-replay`)).body.error,'TURN_INTERRUPTED');
    const state=(await db.doc(`users/${uid}/sessions/${session.body.id}`).get()).data(),quota=(await db.doc(`usage/${uid}`).get()).data();
    assert(!state.activeTurnId);assert.equal(Object.keys(quota.reservations||{}).length,0);
  }finally{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    if(uid){await db.recursiveDelete(db.doc(`users/${uid}`));await db.doc(`usage/${uid}`).delete();await auth.deleteUser(uid);}
    await deleteApp(app);
  }
});
