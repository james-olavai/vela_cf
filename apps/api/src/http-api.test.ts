import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApi, verifyApiIdentity } from './http-api.js';

async function request(options: {authorization?:string; appToken?:string; rejectToken?:boolean; appCheck?:boolean; rejectApp?:boolean; method?:string; json?:boolean}={}) {
  let dispatched = false;
  const result: any = {headers:{}};
  const handler = createHttpApi({
    verifyToken: async token => { assert.equal(token,'valid'); if(options.rejectToken)throw Error('secret failure');return {uid:'verified-user'} as any; },
    ...(options.appCheck ? {verifyAppCheck:async token=>{if(options.rejectApp)throw Error('bad');assert.equal(token,'app');}} : {}),
    dispatch:async input=>{dispatched=true;assert.equal(input.auth.uid,'verified-user');return {status:200,body:{ok:true}};},
  });
  const req:any={headers:{authorization:options.authorization},method:options.method||'GET',path:'/v1/me',query:{},body:{uid:'attacker'},get:()=>options.appToken,is:()=>options.json!==false};
  const res:any={setHeader:(key:string,v:string)=>{result.headers[key]=v;},status:(s:number)=>{result.status=s;return res;},json:(body:unknown)=>{result.body=body;},end:()=>{}};
  await handler(req,res);return {...result,dispatched};
}
test('HTTP adapter requires verified identity; request UID cannot establish identity',async()=>{
  for(const authorization of [undefined,'user-uid','Bearer uid extra']) {const r=await request({authorization});assert.equal(r.status,401);assert.equal(r.dispatched,false);}
  const denied=await request({authorization:'Bearer valid',rejectToken:true});assert.equal(denied.status,401);assert(!JSON.stringify(denied).includes('secret failure'));
  const ok=await request({authorization:'Bearer valid'});assert.equal(ok.status,200);assert.equal(ok.headers['Cache-Control'],'no-store');assert(ok.headers['X-Request-Id']);
});
test('App Check and JSON content checks precede business execution',async()=>{
  for(const opts of [{appCheck:true},{appCheck:true,appToken:'app',rejectApp:true}]) {const r=await request({authorization:'Bearer valid',...opts});assert.equal(r.status,401);assert.equal(r.dispatched,false);}
  assert.equal((await request({authorization:'Bearer valid',appCheck:true,appToken:'app'})).status,200);
  const bad=await request({authorization:'Bearer valid',method:'POST',json:false});assert.equal(bad.status,400);assert.equal(bad.dispatched,false);
});

test('Fresh server claims override stale token privileges and check revocation',async()=>{
  const identity=await verifyApiIdentity({verifyIdToken:async (_:string,revoked:boolean)=>{assert.equal(revoked,true);return {uid:'owner',stripeRole:'pro',tuningEditor:true,tuningPublisher:true};},getUser:async()=>({customClaims:{}})} as any,'old-token');
  assert.equal(identity.tuningEditor,false);assert.equal(identity.tuningPublisher,false);assert.equal(identity.stripeRole,'free');
  const upgraded=await verifyApiIdentity({verifyIdToken:async()=>({uid:'owner',stripeRole:'free'}),getUser:async()=>({customClaims:{stripeRole:'go'}})} as any,'old-free-token');assert.equal(upgraded.stripeRole,'go');
});

test('HTTP SSE requires final result and reports midstream errors as events',async()=>{
  const {EventEmitter}=await import('node:events');
  const {HttpsError}=await import('firebase-functions/v2/https');
  for(const fail of [false,true]) {
    const frames:string[]=[];const res:any=new EventEmitter();res.headersSent=false;res.destroyed=false;
    res.setHeader=()=>{};res.write=(frame:string)=>{res.headersSent=true;frames.push(frame);};res.end=(frame?:string)=>{if(frame)frames.push(frame);res.writableEnded=true;};res.status=()=>res;res.json=()=>{throw Error('Expected streaming error');};
    const req:any={headers:{authorization:'Bearer test'},method:'POST',path:'/v1/sessions/session/turns',query:{},body:{message:'question'},get:()=>undefined,is:()=>true};
    const api=createHttpApi({verifyToken:async()=>({uid:'test'} as any),dispatch:async()=>{throw Error('wrong dispatcher');},stream:async(body:any,auth,emit)=>{assert.equal(body.sessionId,'session');assert.equal(auth.uid,'test');emit({type:'text',text:'partial'});if(fail)throw new HttpsError('unavailable','provider secret');emit({type:'done'});return {text:'complete'};}});
    await api(req,res);
    const events=frames.map(frame=>JSON.parse(frame.slice(6).trim()));
    if(fail){assert.equal(events.at(-1).type,'error');assert(!frames.join('').includes('provider secret'));assert(!events.some(e=>e.type==='result'));}
    else {assert.equal(events.at(-1).type,'result');assert.equal(events.at(-1).result.text,'complete');}
    assert.equal(res.listenerCount('close'),0);
  }
});

test('application storage and monthly quota limits remain distinct from retryable provider limits',async()=>{
  const {HttpsError}=await import('firebase-functions/v2/https');
  for(const message of ['PROFILE_LIMIT_REACHED','QUOTA_EXCEEDED','MONTHLY_SHARE_LIMIT_REACHED','provider exhausted']){
    let status:number|undefined,output:any;
    const handler=createHttpApi({verifyToken:async()=>({uid:'owner'} as any),dispatch:async()=>{throw new HttpsError('resource-exhausted',message);}});
    const res:any={setHeader:()=>{},status:(value:number)=>{status=value;return res;},json:(body:any)=>{output=body;}};
    await handler({headers:{authorization:'Bearer token'},method:'GET',path:'/v1/me',query:{}} as any,res);
    assert.equal(status,429);
    assert.equal(output.error.code,message==='provider exhausted'?'MODEL_BUSY':message);
    assert.equal(output.error.retryable,message==='provider exhausted');
  }
});

test('Only public catalogs support ETag; private recommendations and errors never become shared cache entries',async()=>{
  const {HttpsError}=await import('firebase-functions/v2/https');
  const call=async(path:string,tag?:string,fail=false)=>{
    const out:any={headers:{}};
    const handler=createHttpApi({verifyToken:async()=>({uid:'owner'} as any),publicRoute:()=>true,dispatch:async()=>{if(fail)throw new HttpsError('unavailable','LOCATION_PROVIDER_UNAVAILABLE');return {status:200,body:{catalogVersion:'v1',items:[]}};}});
    const res:any={setHeader:(k:string,v:string)=>out.headers[k]=v,status:(v:number)=>{out.status=v;return res;},json:(v:unknown)=>out.body=v,end:()=>{out.ended=true;}};
    await handler({method:'GET',path,headers:{},query:{},get:(key:string)=>key==='If-None-Match'?tag:undefined} as any,res);return out;
  };
  const catalog=await call('/v1/locations/catalog');assert.equal(catalog.status,200);assert(catalog.headers.ETag);
  const cached=await call('/v1/locations/catalog',`W/${catalog.headers.ETag}`);assert.equal(cached.status,304);assert.equal(cached.body,undefined);
  assert.equal((await call('/v1/locations/catalog','"different"')).status,200);
  const privateResult=await call('/v1/profiles/owner/country-chart');assert.equal(privateResult.headers['Cache-Control'],'no-store');assert(!privateResult.headers.ETag);
  const failure=await call('/v1/locations/catalog',undefined,true);assert.equal(failure.status,503);assert.equal(failure.body.error.code,'LOCATION_PROVIDER_UNAVAILABLE');assert.equal(failure.headers['Cache-Control'],'no-store');
});

test('safe generation timeout and observer failures retain distinct codes before and during SSE', async () => {
  const { EventEmitter } = await import('node:events');
  const { HttpsError } = await import('firebase-functions/v2/https');
  for (const streamed of [false, true]) for (const [kind, code, status] of [['deadline-exceeded', 'MODEL_TIMEOUT', 504], ['unavailable', 'TURN_OBSERVER_FAILED', 503]] as const) {
    const out: any = { frames: [] }, res: any = new EventEmitter();
    res.setHeader = () => {};
    res.status = (value: number) => { out.status = value; return res; };
    res.json = (value: unknown) => { out.body = value; };
    res.write = (value: string) => { res.headersSent = true; out.frames.push(value); };
    res.end = (value?: string) => { if (value) out.frames.push(value); res.writableEnded = true; };
    const handler = createHttpApi({ verifyToken: async () => ({ uid: 'owner' } as any), dispatch: async () => { throw Error('Unexpected dispatch'); }, stream: async (_body, _auth, emit) => { if (streamed) emit({ type: 'started', turnId: 'turn' }); throw new HttpsError(kind, code); } });
    await handler({ headers: { authorization: 'Bearer token' }, method: 'POST', path: '/v1/sessions/session/turns', body: { message: 'Test' }, query: {}, get: () => undefined, is: () => true } as any, res);
    const error = streamed ? JSON.parse(out.frames.at(-1).slice(6)).error : out.body.error;
    assert.equal(error.code, code);
    assert.equal(error.retryable, true);
    if (!streamed) assert.equal(out.status, status);
    assert(!out.frames.some((frame: string) => frame.includes('"type":"result"')));
  }
});

test('PAT type cannot fall back to Firebase, spoof principal fields, or bypass route authorization',async()=>{
  const {HttpsError}=await import('firebase-functions/v2/https');
  for (const scenario of ['disabled','invalid','denied','allowed','firebase-spoof']) {
    let firebaseCalls=0, appCalls=0, gated=0, dispatched=0;
    const out:any={};
    const pat:any={uid:'owner',token:{stripeRole:'free'},credentialKind:'pat',credentialId:'id',scopes:[],environment:'staging'};
    const handler=createHttpApi({
      verifyToken:async()=>{firebaseCalls++;return {uid:'owner',credentialKind:'pat'} as any;},
      ...(scenario==='disabled'?{}:{verifyPat:async()=>{if(scenario==='invalid')throw new HttpsError('unauthenticated','INVALID_PAT');return pat;},authorizePat:async identity=>{gated++;if(scenario==='denied')throw new HttpsError('permission-denied','PAT_SCOPE_DENIED');return identity;}}),
      verifyAppCheck:async()=>{appCalls++;},
      dispatch:async input=>{dispatched++;assert.equal(input.auth.credentialKind,'pat');assert.equal(input.auth.uid,'owner');return {status:200,body:{ok:true}};},
    });
    const res:any={setHeader:()=>{},status:(value:number)=>{out.status=value;return res;},json:(value:any)=>{out.body=value;}};
    await handler({headers:{authorization:`Bearer ${scenario==='firebase-spoof'?'firebase':'vela_pat_bad'}`},method:'GET',path:'/v1/profiles',body:{uid:'attacker',credentialKind:'pat'},query:{},get:()=>undefined} as any,res);
    assert.equal(out.status,scenario==='allowed'?200:['invalid','firebase-spoof'].includes(scenario)?401:403);
    assert.equal(firebaseCalls,scenario==='firebase-spoof'?1:0);assert.equal(appCalls,0);
    assert.equal(dispatched,scenario==='allowed'?1:0);assert.equal(gated,['denied','allowed'].includes(scenario)?1:0);
  }
});

test('PAT limits retain actionable codes and creation limits are not retried',async()=>{
  const {HttpsError}=await import('firebase-functions/v2/https');
  for(const code of ['PAT_LIMIT_REACHED','PAT_RATE_LIMITED']) {
    let output:any;
    const handler=createHttpApi({verifyToken:async()=>({uid:'owner'} as any),dispatch:async()=>{throw new HttpsError('resource-exhausted',code);}});
    const res:any={setHeader:()=>{},status:()=>res,json:(value:any)=>{output=value;}};
    await handler({headers:{authorization:'Bearer token'},method:'GET',path:'/v1/me',query:{}} as any,res);
    assert.equal(output.error.code,code);assert.equal(output.error.retryable,code==='PAT_RATE_LIMITED');
  }
});

test('Stripe webhook uses exact POST path and untouched bytes; every other path still authenticates',async()=>{
  const calls:any[]=[];
  const rawBody=Buffer.from('{ "id" : "evt_signed" }');
  const handler=createHttpApi({verifyToken:async()=>{throw Error('Unexpected identity');},verifyAppCheck:async()=>{throw Error('Unexpected AppCheck');},stripeWebhook:async(raw,signature)=>{calls.push({raw,signature});},dispatch:async()=>{throw Error('Unexpected dispatcher');}});
  async function call(method:string,path:string,raw:unknown=rawBody,signature:string|undefined='signed') {
    const out:any={};const res:any={setHeader:()=>{},status:(value:number)=>{out.status=value;return res;},json:(value:any)=>{out.body=value;}};
    await handler({method,path,headers:{},rawBody:raw,body:{id:'parsed-is-not-signed'},get:()=>signature} as any,res);return out;
  }
  assert.equal((await call('POST','/v1/billing/stripe-webhook')).status,200);
  assert.strictEqual(calls[0].raw,rawBody);assert.equal(calls[0].signature,'signed');
  for(const [method,path] of [['GET','/v1/billing/stripe-webhook'],['POST','/v1/billing/stripe-webhook/'],['POST','/v1/billing/stripe-webhook/extra'],['POST','/v1/billing/checkout-sessions']])assert.equal((await call(method,path)).status,401);
  assert.equal((await call('POST','/v1/billing/stripe-webhook',rawBody,'')).status,400);
  assert.equal((await call('POST','/v1/billing/stripe-webhook','parsed string')).status,400);
  assert.equal(calls.length,1);
});

test('Webhook synchronization errors are retryable HTTP failures with sanitized body',async()=>{
  const {HttpsError}=await import('firebase-functions/v2/https');
  for(const error of [new HttpsError('invalid-argument','INVALID_STRIPE_SIGNATURE'),Error('whsec_private')]) {
    const handler=createHttpApi({verifyToken:async()=>{throw Error('Unexpected auth');},stripeWebhook:async()=>{throw error;},dispatch:async()=>{throw Error('Unexpected dispatch');}});
    const out:any={},res:any={setHeader:()=>{},status:(value:number)=>{out.status=value;return res;},json:(value:any)=>{out.body=value;}};
    await handler({method:'POST',path:'/v1/billing/stripe-webhook',headers:{},rawBody:Buffer.from('{}'),get:()=> 'signed'} as any,res);
    assert.equal(out.status,error instanceof HttpsError?400:500);
    assert(!JSON.stringify(out).includes('whsec_private'));
  }
});
