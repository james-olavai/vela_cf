import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpsError } from 'firebase-functions/v2/https';
import { commitSessionTurn } from './session.js';

const sessionPath='users/u/sessions/s',turnPath=`${sessionPath}/turns/t`,usagePath='usage/u';
const periodStart='2026-11-01T00:00:00Z';
function database(options: {onRead?:(path:string,attempt:number)=>void; retry?:()=>void; afterCommit?:()=>void; durable?:any}={}) {
  let ids=0,attempts=0,queued=0;
  const values=new Map<string,any>([
    [sessionPath,{activeTurnId:'t',title:'Existing title'}],
    [turnPath,options.durable||{status:'running'}],
    [usagePath,{periodStart,used:100,reservations:{r:{expiresAt:Date.now()+240000}}}],
  ]);
  const doc=(path:string):any=>({id:path.split('/').at(-1),path,collection:(name:string)=>collection(`${path}/${name}`)});
  const collection=(path:string):any=>({doc:(id=`m${++ids}`)=>doc(`${path}/${id}`)});
  const db:any={doc,collection,runTransaction:async(callback:any)=>{
    for(let attempt=0;attempt<2;attempt++) {
      attempts++;const writes:Array<()=>void>=[];
      const stage=(write:()=>void)=>{queued++;writes.push(write);};
      const result=await callback({
        get:async(ref:any)=>{options.onRead?.(ref.path,attempt);const data=values.get(ref.path);return {exists:!!data,data:()=>data};},
        update:(ref:any,data:any)=>stage(()=>values.set(ref.path,{...values.get(ref.path),...data})),
        set:(ref:any,data:any,opts:any)=>stage(()=>values.set(ref.path,opts?.merge?{...values.get(ref.path),...data}:data)),
        delete:(ref:any)=>stage(()=>values.delete(ref.path)),
      });
      if(attempt===0&&options.retry){options.retry();continue;} // Simulate a transaction conflict; discard queued writes.
      writes.forEach(write=>write());options.afterCommit?.();return result;
    }
    throw Error('Unexpected repeated conflict');
  }};
  return {db,values,attempts:()=>attempts,queued:()=>queued};
}
const input=(signal?:AbortSignal)=>({uid:'u',sessionId:'s',turnId:'t',signal,replacedMessageIds:[],durableResult:{text:'complete'},settlement:{periodStart,requestId:'r',costMicroUsd:50},userMessage:{text:'Question',createdAt:'2026-11-16T00:00:00Z'},assistantMessage:{parts:[{text:'Answer'}],createdAt:'2026-11-16T00:00:01Z'}});
function unchanged(state:ReturnType<typeof database>) {
  assert.equal(state.values.get(usagePath).used,100);assert(state.values.get(usagePath).reservations.r);
  assert.equal(state.values.get(turnPath).status,'running');assert.equal(state.values.get(sessionPath).activeTurnId,'t');
  assert.equal([...state.values.keys()].filter(path=>path.includes('/messages/')).length,0);
}

test('deadline or disconnect during transaction reads discards messages, durable result and queued settlement',async()=>{
  for(const reason of [new DOMException('Deadline','TimeoutError'),new HttpsError('aborted','TURN_DISCONNECTED')]){
    const controller=new AbortController();
    const state=database({onRead:path=>{if(path===usagePath)controller.abort(reason);}});
    await assert.rejects(commitSessionTurn(state.db,input(controller.signal)),error=>error===reason);
    assert(state.queued()>0,'Settlement helper had queued a write before abort was checked');unchanged(state);
  }
});

test('deadline between Firestore retry attempts is checked inside the retried transaction',async()=>{
  const controller=new AbortController(),reason=new DOMException('Deadline','TimeoutError');
  const state=database({retry:()=>controller.abort(reason)});
  await assert.rejects(commitSessionTurn(state.db,input(controller.signal)),error=>error===reason);
  assert.equal(state.attempts(),2);unchanged(state);
});

test('failed durable turns preserve safe failure reasons instead of reporting user cancellation',async()=>{
  for(const [status,error,expected] of [['failed','MODEL_TIMEOUT','MODEL_TIMEOUT'],['failed','TURN_INTERRUPTED','TURN_INTERRUPTED'],['failed','provider secret','TURN_INTERRUPTED'],['cancelled','TURN_CANCELLED','TURN_CANCELLED']]){
    const state=database({durable:{status,error}});
    await assert.rejects(commitSessionTurn(state.db,input()),(e:any)=>e.message===expected&&(expected!=='MODEL_TIMEOUT'||e.code==='deadline-exceeded'));
    assert.equal(state.values.get(usagePath).used,100);assert.equal(state.values.size,3);
  }
});

test('disconnect after atomic commit does not undo completed messages or usage',async()=>{
  const controller=new AbortController(),state=database({afterCommit:()=>controller.abort(new HttpsError('aborted','TURN_DISCONNECTED'))});
  await commitSessionTurn(state.db,input(controller.signal));
  assert.equal(state.values.get(usagePath).used,150);assert.equal(state.values.get(turnPath).status,'completed');
  assert.equal([...state.values.keys()].filter(path=>path.includes('/messages/')).length,2);assert(controller.signal.aborted);
});
