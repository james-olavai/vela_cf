import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpsError } from 'firebase-functions/v2/https';
import { createChatRunner } from './chat-service.js';

function turnDatabase(observe?: (next: (snapshot: any) => void, error: () => void) => void) {
  const turn: any = {};
  const ref: any = { parent: {parent: {kind:'session'}}, onSnapshot(next: any, error: any) { observe?.(next,error);return ()=>{}; } };
  const db: any = {doc:()=>ref, runTransaction:async(fn:any)=>fn({
    get:async(target:any)=>target.kind==='session'?{exists:true}:{exists:Boolean(turn.status),data:()=>turn},
    create:(_:any,data:any)=>Object.assign(turn,data), update:(_:any,data:any)=>Object.assign(turn,data),
  })};
  return {db,turn};
}

test('server deadline persists failed MODEL_TIMEOUT, never cancelled, and retains the 150 second budget',async(t)=>{
  const {db,turn}=turnDatabase();
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{assert.equal(ms,150000);return AbortSignal.abort(new DOMException('Deadline reached','TimeoutError'));});
  const run=createChatRunner(db,async()=>{throw Error('Model must not execute');});
  await assert.rejects(run({sessionId:'s',message:'test'},{auth:{uid:'u'},turnId:'deadline'},()=>{}),(e:any)=>e.code==='deadline-exceeded'&&e.message==='MODEL_TIMEOUT');
  assert.equal(turn.status,'failed');assert.equal(turn.error,'MODEL_TIMEOUT');
});

test('disconnect and observer interruption remain failed while explicit cancellation remains cancelled',async()=>{
  for(const [reason,status,error] of [
    [new HttpsError('aborted','TURN_DISCONNECTED'),'failed','TURN_DISCONNECTED'],
    [new HttpsError('aborted','TURN_INTERRUPTED'),'failed','TURN_INTERRUPTED'],
    [new HttpsError('aborted','TURN_CANCELLED'),'cancelled','TURN_CANCELLED'],
  ] as const){
    const {db,turn}=turnDatabase();
    await assert.rejects(createChatRunner(db,async()=>{throw Error('Unexpected model');})({sessionId:'s',message:'test'},{auth:{uid:'u'},turnId:'t'},()=>{},AbortSignal.abort(reason)),(e:any)=>e.message===error);
    assert.equal(turn.status,status);assert.equal(turn.error,error);
  }
  const {db,turn}=turnDatabase((_next,error)=>error());
  await assert.rejects(createChatRunner(db,async()=>{throw Error('Unexpected model');})({sessionId:'s',message:'test'},{auth:{uid:'u'},turnId:'t'},()=>{}),(e:any)=>e.code==='unavailable'&&e.message==='TURN_OBSERVER_FAILED');
  assert.equal(turn.status,'failed');assert.equal(turn.error,'TURN_OBSERVER_FAILED');
});
