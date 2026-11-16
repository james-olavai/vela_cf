import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const built=await build({entryPoints:['apps/web/src/lib/turnClient.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'turn-dependencies',setup(b){
  b.onResolve({filter:/^\.\/apiClient$/},()=>({path:'api',namespace:'test'}));
  b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`export const businessApi=(...args)=>globalThis.turnRequest(...args);export const streamApi=(...args)=>globalThis.turnStream(...args);export const invalidateApi=()=>{};export const apiError=value=>Object.assign(new Error(value.message),{code:value.code});`}));
}}]});
const {streamTurn,pendingTurn}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const values=new Map();globalThis.localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
const key=(uid,session)=>`vela:turn:${uid}:${session}`;
const fingerprint=body=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
const body={message:'private synthetic question'};
const seed=(uid,session,id='saved-key',payload=body)=>values.set(key(uid,session),JSON.stringify({id,fingerprint:fingerprint(payload)}));
const collect=async stream=>{const result=[];for await(const event of stream)result.push(event);return result;};
const signal=()=>new AbortController().signal;
const final={text:'Recovered answer',suggestions:['Next']};

test('turn stores a key and only a fingerprint before posting; successful completion removes pending state',async()=>{
  let posted;
  globalThis.turnRequest=async()=>{throw Error('No read expected');};
  globalThis.turnStream=async function*(uid,path,payload,abort,id){
    posted=id;const saved=JSON.parse(values.get(key(uid,'success')));
    assert.equal(saved.id,id);assert.match(id,/^[a-f0-9-]{36}$/);assert.equal(saved.fingerprint,fingerprint(body));
    assert(!JSON.stringify(saved).includes(body.message));assert.deepEqual(Object.keys(saved).sort(),['fingerprint','id']);
    yield {type:'done'};yield {type:'result',result:final};
  };
  const result=await collect(streamTurn('owner','success',body,signal()));
  assert(posted);assert.equal(result.at(-1).result.text,final.text);assert(!values.has(key('owner','success')));
});
test('uncertain stream transport reads completed result without repeating POST generation',async()=>{
  let posts=0,reads=0,id;
  globalThis.turnStream=async function*(_uid,_path,_body,_signal,turnId){posts++;id=turnId;yield {type:'text',text:'partial'};throw Error('network lost');};
  globalThis.turnRequest=async(uid,path,method)=>{reads++;assert.equal(uid,'owner');assert.equal(method,'GET');assert(path.endsWith(id));return {id,status:'completed',result:final};};
  const result=await collect(streamTurn('owner','disconnect',body,signal()));
  assert.equal(posts,1);assert(reads>=1);assert.equal(result.at(-1).result.text,final.text);assert(!values.has(key('owner','disconnect')));
});
test('running matching request resumes saved key; changed input cannot overwrite active pending turn',async()=>{
  seed('owner','running');let posts=0,reads=0;
  globalThis.turnStream=async function*(){posts++;throw Error('Must not regenerate');};
  globalThis.turnRequest=async(_uid,path)=>{assert(path.endsWith('saved-key'));return ++reads===1?{id:'saved-key',status:'running'}:{id:'saved-key',status:'completed',result:final};};
  assert.equal((await collect(streamTurn('owner','running',body,signal()))).at(-1).result.text,final.text);assert.equal(posts,0);
  seed('owner','conflict');globalThis.turnRequest=async()=>({id:'saved-key',status:'running'});
  await assert.rejects(collect(streamTurn('owner','conflict',{message:'different'},signal())),/上一条请求仍在处理中/);
  assert.equal(JSON.parse(values.get(key('owner','conflict'))).id,'saved-key');assert.equal(posts,0);
});
test('abort sends cancellation for its saved turn and failed cancellation preserves recovery reference',async()=>{
  for(const failed of [false,true]){
    const session=`abort-${failed}`,controller=new AbortController();let cancel=0;
    globalThis.turnStream=async function*(){controller.abort();throw controller.signal.reason;};
    globalThis.turnRequest=async(uid,path,method,payload,cancelSignal)=>{cancel++;assert.equal(uid,'owner');assert(path.endsWith('/cancel'));assert.equal(method,'POST');assert.deepEqual(payload,{});assert(!cancelSignal.aborted);if(failed)throw Error('offline');return {status:'cancelled'};};
    await assert.rejects(collect(streamTurn('owner',session,body,controller.signal)),{name:'AbortError'});
    assert.equal(cancel,1);assert.equal(values.has(key('owner',session)),failed);
  }
});
test('pending references are isolated by user and session; terminal recovery removes only matching reference',async()=>{
  seed('alice','shared','alice-turn');seed('bob','shared','bob-turn');const calls=[];
  globalThis.turnRequest=async(uid,path)=>{calls.push({uid,path});return {id:'alice-turn',status:'completed',result:final};};
  assert.equal(await pendingTurn('charlie','shared',signal()),null);assert.equal(await pendingTurn('alice','different',signal()),null);
  assert.equal((await pendingTurn('alice','shared',signal())).status,'completed');assert.deepEqual(calls,[{uid:'alice',path:'/v1/sessions/shared/turns/alice-turn'}]);
  assert(!values.has(key('alice','shared')));assert(values.has(key('bob','shared')));
});
test('a rejected request without a turn preserves original error; malformed completed result is not success',async()=>{
  const original=Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
  globalThis.turnStream=async function*(){throw original;};
  globalThis.turnRequest=async()=>{throw Object.assign(new Error('missing'),{code:'TURN_NOT_FOUND'});};
  await assert.rejects(collect(streamTurn('owner','rejected',body,signal())),error=>error===original);assert(!values.has(key('owner','rejected')));
  seed('owner','malformed');globalThis.turnRequest=async()=>({id:'saved-key',status:'completed',result:{text:''}});
  await assert.rejects(collect(streamTurn('owner','malformed',body,signal())),/结果不完整/);assert(values.has(key('owner','malformed')));
});
test('invalid stored pending shape cannot create an undefined turn lookup',async()=>{
  values.set(key('owner','corrupt'),JSON.stringify({message:'not a pending turn'}));
  globalThis.turnRequest=async()=>{throw Error('Must not query');};
  assert.equal(await pendingTurn('owner','corrupt',signal()),null);assert(!values.has(key('owner','corrupt')));
});

test('abort during initial saved-turn recovery also cancels the original generation',async()=>{
  const controller=new AbortController();seed('owner','abort-recovery');let cancelled=0;
  globalThis.turnRequest=async(_uid,path,method)=>{
    if(method==='POST'){assert(path.endsWith('/saved-key/cancel'));cancelled++;return {status:'cancelled'};}
    controller.abort();throw controller.signal.reason;
  };
  await assert.rejects(collect(streamTurn('owner','abort-recovery',body,controller.signal)),{name:'AbortError'});
  assert.equal(cancelled,1);assert(!values.has(key('owner','abort-recovery')));
});

test('older completion, cancellation and status reads preserve another tab’s newer pending key',async()=>{
  for(const operation of ['stream','cancel','status','missing']){
    const session=`cross-tab-${operation}`,controller=new AbortController();
    const newer=()=>seed('owner',session,'newer-turn',{message:'another tab'});
    if(operation==='stream'||operation==='cancel'){
      globalThis.turnStream=async function*(){
        newer();
        if(operation==='cancel'){controller.abort();throw controller.signal.reason;}
        yield {type:'done'};yield {type:'result',result:final};
      };
      globalThis.turnRequest=async()=>({status:'cancelled'});
      if(operation==='cancel')await assert.rejects(collect(streamTurn('owner',session,body,controller.signal)),{name:'AbortError'});
      else await collect(streamTurn('owner',session,body,controller.signal));
    }else{
      seed('owner',session,'older-turn');
      globalThis.turnRequest=async(_uid,path)=>{
        assert(path.endsWith('/older-turn'));newer();
        if(operation==='missing')throw Object.assign(new Error('missing'),{code:'TURN_NOT_FOUND'});
        return {id:'older-turn',status:'completed',result:final};
      };
      await pendingTurn('owner',session,controller.signal);
    }
    assert.equal(JSON.parse(values.get(key('owner',session))).id,'newer-turn',operation);
    globalThis.turnRequest=async(_uid,path)=>{assert(path.endsWith('/newer-turn'));return {id:'newer-turn',status:'running'};};
    assert.equal((await pendingTurn('owner',session,signal())).id,'newer-turn');
  }
});
