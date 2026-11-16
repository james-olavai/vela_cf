import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['apps/web/src/lib/apiClient.ts'],bundle:true,write:false,format:'esm',platform:'node',define:{'import.meta.env.DEV':'false'},plugins:[{name:'test-auth',setup(b){
  b.onResolve({filter:/^\.\/firebase$/},()=>({path:'firebase',namespace:'test'}));
  b.onResolve({filter:/^firebase\/app-check$/},()=>({path:'app-check',namespace:'test'}));
  b.onLoad({filter:/.*/,namespace:'test'},args=>({contents:args.path==='firebase'?'export const auth=globalThis.testAuth;export const appCheck=undefined;':'export const getToken=async()=>({token:"app"});'}));
}}]});
globalThis.__VELA_CONFIG__={projectId:'demo-vela-ci',apiKey:'fake',appId:'test',authDomain:'demo-vela-ci.firebaseapp.com',firestoreDatabaseId:'(default)'};
globalThis.testAuth={currentUser:{uid:'owner',getIdToken:async()=> 'id-token'}};
const api=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const stream=(chunks)=>new ReadableStream({start(c){for(const s of chunks)c.enqueue(new TextEncoder().encode(s));c.close();}});

test('SSE parser preserves fragmented UTF-8 and CRLF frames; rejects missing final result',async()=>{
  const bytes=new TextEncoder().encode('data: {"type":"text","text":"星盘"}\r\n\r\ndata: {"type":"done"}\n\n');
  const body=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
  const events=[];for await(const e of api.readSse(body,new AbortController().signal))events.push(e);
  assert.equal(events[0].text,'星盘');assert.equal(events[1].type,'done');
  const old=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response(stream(['data: {"type":"done"}\n\n']),{headers:{'content-type':'text/event-stream'}});
    await assert.rejects(async()=>{for await(const e of api.streamApi('owner','/v1/sessions/a/turns',{},new AbortController().signal))void e;},/生成中断/);
    globalThis.fetch=async()=>new Response(stream(['data: {"type":"done"}\n\ndata: {"type":"result","result":{"text":"answer"}}\n\n']),{headers:{'content-type':'text/event-stream'}});
    const result=[];for await(const e of api.streamApi('owner','/v1/sessions/a/turns',{},new AbortController().signal))result.push(e);
    assert.equal(result.at(-1).result.text,'answer');
    globalThis.fetch=async()=>new Response(stream(['data: {"type":"error","error":{"code":"MODEL_BUSY","message":"busy"}}\n\n']),{headers:{'content-type':'text/event-stream'}});
    await assert.rejects(async()=>{for await(const e of api.streamApi('owner','/v1/sessions/a/turns',{},new AbortController().signal))void e;},{code:'MODEL_BUSY'});
  }finally{globalThis.fetch=old;}
});
test('HTTP client binds identity, transmits token only in header and rejects late auth switch',async()=>{
  const old=globalThis.fetch;let calls=0;
  try{
    globalThis.fetch=async(url,options)=>{++calls;assert.equal(options.headers.Authorization,'Bearer id-token');assert(!String(url).includes('id-token'));return Response.json({items:[],nextCursor:null});};
    await assert.rejects(api.businessApi('other','/v1/me'));assert.equal(calls,0);
    await api.businessApi('owner','/v1/me');assert.equal(calls,1);
    const user=testAuth.currentUser;user.getIdToken=async()=>{testAuth.currentUser=null;return 'id-token';};
    await assert.rejects(api.businessApi('owner','/v1/me'));assert.equal(calls,1);
    user.getIdToken=async()=> 'id-token';testAuth.currentUser=user;
  }finally{globalThis.fetch=old;}
});
test('pagination follows all pages and rejects repeated cursor',async()=>{
  const old=globalThis.fetch;let calls=0;
  try{
    globalThis.fetch=async()=>Response.json(++calls===1?{items:[{id:'a'}],nextCursor:'a'}:{items:[{id:'b'}],nextCursor:null});
    assert.deepEqual((await api.apiList('owner','/v1/profiles',new AbortController().signal)).map(x=>x.id),['a','b']);
    globalThis.fetch=async()=>Response.json({items:[],nextCursor:'repeat'});
    await assert.rejects(api.apiList('owner','/v1/profiles',new AbortController().signal),/游标重复/);
  }finally{globalThis.fetch=old;}
});
test('poll subscriptions abort stale reads and unsubscribe prevents late state updates',async()=>{
  const old=globalThis.document;globalThis.document=Object.assign(new EventTarget(),{hidden:false});
  const pending=[],seen=[];
  const stop=api.subscribeApi(signal=>new Promise(resolve=>pending.push({signal,resolve})),v=>seen.push(v),e=>{throw e;});
  try{
    api.invalidateApi();assert.equal(pending[0].signal.aborted,true);
    pending[0].resolve('stale');pending[1].resolve('current');await new Promise(r=>setImmediate(r));assert.deepEqual(seen,['current']);
    api.invalidateApi();stop();assert(pending[2].signal.aborted);pending[2].resolve('after-unsubscribe');await new Promise(r=>setImmediate(r));assert.deepEqual(seen,['current']);
  }finally{stop();globalThis.document=old;}
});
test('poll subscription retries unchanged data when consumer deferred update during streaming',async()=>{
  const old=globalThis.document;globalThis.document=Object.assign(new EventTarget(),{hidden:false});
  let streaming=true,calls=0;const accepted=[];
  const stop=api.subscribeApi(async()=>({messages:['persisted']}),value=>{++calls;if(streaming)return false;accepted.push(value);},e=>{throw e;});
  try{
    await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(accepted.length,0);
    streaming=false;api.invalidateApi();await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(accepted.length,1);
    api.invalidateApi();await new Promise(r=>setImmediate(r));assert.equal(calls,2);
  }finally{stop();globalThis.document=old;}
});

test('production frontend business access uses HTTP rather than Firestore or Callable SDKs',async()=>{
  const {readdirSync,readFileSync}=await import('node:fs');
  function inspect(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=`${dir}/${entry.name}`;if(entry.isDirectory())inspect(file);else if(/\.[jt]sx?$/.test(file))assert(!/from\s+['"]firebase\/(?:firestore|functions)['"]/.test(readFileSync(file,'utf8')),`Direct business SDK access returned: ${file}`);}}
  inspect('apps/web/src');
});

test('SSE transport sends caller idempotency key only as a request header',async()=>{
  const old=globalThis.fetch;
  try {
    globalThis.fetch=async(url,options)=>{
      assert.equal(options.headers['Idempotency-Key'],'test-turn-key');
      assert(!String(url).includes('test-turn-key'));
      assert.deepEqual(JSON.parse(options.body),{message:'question'});
      return new Response(stream(['data: {"type":"done"}\n\ndata: {"type":"result","result":{"text":"answer"}}\n\n']),{headers:{'content-type':'text/event-stream'}});
    };
    for await(const event of api.streamApi('owner','/v1/sessions/a/turns',{message:'question'},new AbortController().signal,'test-turn-key'))void event;
  }finally{globalThis.fetch=old;}
});

test('poll retry publishes unchanged data after an intervening read failure',async()=>{
  const old=globalThis.document;globalThis.document=Object.assign(new EventTarget(),{hidden:false});
  let fail=false;const seen=[];
  const stop=api.subscribeApi(async()=>{if(fail)throw new Error('offline');return {capacity:23};},value=>seen.push(value),()=>seen.push('error'));
  try{
    await new Promise(r=>setImmediate(r));fail=true;api.invalidateApi();await new Promise(r=>setImmediate(r));
    fail=false;api.invalidateApi();await new Promise(r=>setImmediate(r));
    assert.deepEqual(seen,[{capacity:23},'error',{capacity:23}]);
  }finally{stop();globalThis.document=old;}
});
