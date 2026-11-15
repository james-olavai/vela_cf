import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {resolve} from 'node:path';
import {createEvaluationJobs,confinedFile} from './prompt-mcp-jobs.mjs';
test('local job isolation, comparability, cancellation, confinement and restart', async t => {
const dir=await mkdtemp(resolve(tmpdir(),'vela-qa-'));t.after(()=>rm(dir,{recursive:true,force:true}));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let active=0,peak=0;
const snapshot={timeoutMs:100,repeats:1,cases:[{id:'A'},{id:'B'}],bundle:{modelName:'test',temperature:.6},provenance:{runtimeCommit:'test'},tier:'go'};
const manager=await createEvaluationJobs({directory:dir,prepare:async input=>({...snapshot,...input}),evaluate:async(s,c,signal)=>{active++;peak=Math.max(peak,active);try{await sleep(4);signal.throwIfAborted();return {text:c.id};}finally{active--;}}});
const runs=await Promise.all([manager.start({}),manager.start({})]);
for(let i=0;i<50&&runs.some(r=>manager.get(r.jobId).status!=='completed');i++)await sleep(10);
assert.equal(peak,1);for(const r of runs)assert.equal(manager.get(r.jobId,0,5).results.length,2);
assert.equal(manager.compare(runs[0].jobId,runs[1].jobId).comparable,true);
const changed=await manager.start({bundle:{modelName:'test',temperature:1.2}});await sleep(50);assert.equal(manager.compare(runs[0].jobId,changed.jobId).comparable,false);
const cancel=await manager.start({repeats:3});await manager.cancel(cancel.jobId);await sleep(40);assert.equal(JSON.parse(await readFile(resolve(dir,cancel.jobId+'.json'))).status,'cancelled');
await assert.rejects(()=>confinedFile(dir,'../x'));await symlink('/etc/passwd',resolve(dir,'escape'));await assert.rejects(()=>confinedFile(dir,'escape'));
const fake='00000000-0000-0000-0000-000000000000';await writeFile(resolve(dir,fake+'.json'),JSON.stringify({id:fake,status:'running',snapshot,results:[]}));
const restored=await createEvaluationJobs({directory:dir,prepare:async()=>snapshot,evaluate:async()=>{throw Error('should not resume')}});assert.equal(restored.get(fake).status,'interrupted');
});

test('failed jobs persist safe errors without exposing provider details', async t => {
  const directory=await mkdtemp(resolve(tmpdir(),'vela-failure-qa-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const jobs=await createEvaluationJobs({directory,prepare:async()=>({timeoutMs:100,repeats:1,cases:[{id:'A'}],bundle:{modelName:'test'}}),evaluate:async()=>{throw Error('SECRET_PROVIDER_DETAIL');}});
  const {jobId}=await jobs.start({});
  for(let i=0;i<50&&jobs.get(jobId).status!=='failed';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(jobs.get(jobId).status,'failed');
  const saved=JSON.parse(await readFile(resolve(directory,jobId+'.json')));
  assert.equal(saved.status,'failed');
  assert.ok(!JSON.stringify(saved).includes('SECRET_PROVIDER_DETAIL'));
});

test('concurrent starts cannot bypass queued-job budget', async t => {
  const directory=await mkdtemp(resolve(tmpdir(),'vela-budget-qa-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const jobs=await createEvaluationJobs({directory,prepare:async()=>{await new Promise(r=>setTimeout(r,5));return {timeoutMs:10,repeats:1,cases:[{id:'A'}],bundle:{modelName:'test'}};},evaluate:async(_s,_c,signal)=>{await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
  const results=await Promise.allSettled(Array.from({length:10},()=>jobs.start({})));
  assert.ok(results.filter(r=>r.status==='fulfilled').length<=4);
  for(const item of results)if(item.status==='fulfilled')await jobs.cancel(item.value.jobId);
  await new Promise(r=>setTimeout(r,10));
});
