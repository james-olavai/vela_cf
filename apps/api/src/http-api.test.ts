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
