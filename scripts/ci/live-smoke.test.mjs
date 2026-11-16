import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {liveSmoke,LIVE_CASES,parseHttpChat,smokeFailure} from './live-smoke.mjs';
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
test('stream failure evidence keeps machine code/request ID without provider secrets',()=>{
  const secret='Bearer sensitive-user-token';
  assert.throws(()=>parseHttpChat(frame({type:'error',error:{code:'MODEL_TIMEOUT',requestId:'req-1',message:secret}})),e=>e.code==='MODEL_TIMEOUT'&&e.phase==='stream'&&e.requestId==='req-1'&&!JSON.stringify(e).includes(secret));
  const bad=smokeFailure(secret,secret,secret);assert.equal(bad.code,'LIVE_SMOKE_FAILED');assert.equal(bad.phase,'verification');assert.equal(bad.requestId,undefined);
  const good=frame({type:'text',text:'partial'})+frame({type:'done'})+frame({type:'result',result:{text:'CI Subject 1 and CI Subject 2 have distinct collaboration strengths.'}});
  assert.equal(parseHttpChat(good,['CI Subject 1','CI Subject 2']).allProfilesAddressed,true);
  assert.throws(()=>parseHttpChat(good,['CI Subject 3']));
});
test('staging matrix covers each required case once; production has a smaller matrix',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vela-live-'));
  try{
    const calls=[],path=join(directory,'evidence.json');
    const result=await liveSmoke({mode:'staging',evidencePath:path,execute:async(name,options,record)=>{calls.push([name,options]);record.cleanup='passed';record.settledMicroUsd=1000;return {case:name};}});
    assert.deepEqual(calls.map(([name])=>name),['current-free','single-pro','pair-pro','four-person-pro','company-pro','country-chart-pro','frozen-unlimited','exhausted-free']);
    assert.equal(calls.find(([n])=>n==='four-person-pro')[1].profileCount,4);
    assert(result.every(r=>r.status==='passed'&&r.cleanup==='passed'));
    const evidence=JSON.parse(await readFile(path,'utf8'));assert.equal(evidence.cases.length,8);assert(evidence.finishedAt);assert(LIVE_CASES.production.length<LIVE_CASES.staging.length);
  }finally{await rm(directory,{recursive:true});}
});
test('first failed case persists evidence, cleanup status and phase; no retry or later model calls',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vela-live-'));
  try{
    const path=join(directory,'evidence.json');let calls=0;
    await assert.rejects(liveSmoke({mode:'staging',evidencePath:path,execute:async(name,opts,record)=>{calls++;record.phase='generation';record.cleanup='passed';throw Object.assign(new Error('secret prompt and token'),{code:'MODEL_TIMEOUT',requestId:'request-1'});}}),{code:'MODEL_TIMEOUT'});
    assert.equal(calls,1);const raw=await readFile(path,'utf8'),evidence=JSON.parse(raw);assert(!raw.includes('secret prompt'));assert.equal(evidence.cases[0].status,'failed');assert.equal(evidence.cases[0].error.phase,'generation');assert.equal(evidence.cases[0].cleanup,'passed');
  }finally{await rm(directory,{recursive:true});}
});
test('settlement budget stops before any following generation and preserves the overshoot evidence',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vela-live-'));
  try{let calls=0;const path=join(directory,'evidence.json');
    await assert.rejects(liveSmoke({mode:'staging',evidencePath:path,execute:async(name,opts,record)=>{calls++;record.settledMicroUsd=1000001;return {case:name};}}),{code:'LIVE_BUDGET_EXCEEDED'});
    assert.equal(calls,1);assert.equal(JSON.parse(await readFile(path,'utf8')).failure.phase,'budget');
  }finally{await rm(directory,{recursive:true});}
});
