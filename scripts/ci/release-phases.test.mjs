import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentReceipt,verifyDeploymentReceipt,runReleasePhases} from './release.mjs';
import {releaseLock} from './release-lock.mjs';
test('Online job requires exact deployment, artifact, owner and rollback snapshot',()=>{
  const manifest={sha:'a'.repeat(40),codeHash:'code'},target={environment:'staging',configHash:'config',firebase:{projectId:'stage'}},saved={functions:[{name:'old',secretEnvironmentVariables:[]}],hosting:'old'};
  const receipt=deploymentReceipt(manifest,target,'run-1',saved);
  assert.equal(verifyDeploymentReceipt(manifest,target,'run-1',receipt,saved),saved);
  for(const patch of [{sha:'b'.repeat(40)},{codeHash:'changed'}])assert.throws(()=>verifyDeploymentReceipt({...manifest,...patch},target,'run-1',receipt,saved));
  for(const patch of [{environment:'production'},{configHash:'changed'},{firebase:{projectId:'other'}}])assert.throws(()=>verifyDeploymentReceipt(manifest,{...target,...patch},'run-1',receipt,saved));
  assert.throws(()=>verifyDeploymentReceipt(manifest,target,'run-2',receipt,saved));
  assert.throws(()=>verifyDeploymentReceipt(manifest,target,'run-1',receipt,{...saved,hosting:'tampered'}));
  assert.throws(()=>verifyDeploymentReceipt(manifest,target,'run-1',{...receipt,status:'verified'},saved));
});
function firestore(){
  let doc,revision=0;const writes=[];
  const request=async(url,options)=>{
    if(!options){if(!doc)throw Error('Google API 404: absent');return structuredClone(doc);}
    const w=options.body.writes[0];writes.push(w);
    if(w.currentDocument.exists===false&&doc || w.currentDocument.updateTime&&w.currentDocument.updateTime!==doc?.updateTime)throw Error('Google API 409: concurrent mutation');
    doc=w.delete?undefined:{...w.update,updateTime:String(++revision)};return {};
  };return {request,writes,get:()=>doc};
}
test('Only one release owns an environment across deploy and verify jobs; stale owners cannot release or rollback',async()=>{
  const db=firestore(),root='https://firestore.googleapis.com/v1/projects/stage/databases/(default)/documents',sha='a'.repeat(40);let time=100;
  const options={request:db.request,now:()=>time};
  await releaseLock(root,'run-1',sha,'acquire',options);
  assert.deepEqual(db.writes[0].currentDocument,{exists:false});
  await releaseLock(root,'run-1',sha,'check',options);
  await assert.rejects(releaseLock(root,'run-2',sha,'acquire',options),/Another release/);
  await assert.rejects(releaseLock(root,'run-2',sha,'release',options),/another pipeline/);
  await assert.rejects(releaseLock(root,'run-1','b'.repeat(40),'check',options),/lost/);
  time+=2*60*60_000+1;
  await assert.rejects(releaseLock(root,'run-1',sha,'check',options),/expired/);
  await releaseLock(root,'run-2',sha,'acquire',options);
  assert(db.writes.at(-1).currentDocument.updateTime);
  await assert.rejects(releaseLock(root,'run-1',sha,'release',options),/another pipeline/);
  await releaseLock(root,'run-2',sha,'release',options);assert.equal(db.get(),undefined);
});
test('Lock inspection errors fail closed; compare-and-set collisions are not retried as success',async()=>{
  const root='https://firestore.googleapis.com/v1/projects/stage/databases/(default)/documents',sha='a'.repeat(40);
  let writes=0;
  await assert.rejects(releaseLock(root,'run-1',sha,'acquire',{request:async()=>{writes++;throw Error('Google API 403: denied');}}),/403/);assert.equal(writes,1);
  await assert.rejects(releaseLock(root,'run-1',sha,'acquire',{request:async(url,opts)=>{if(!opts)throw Error('Google API 404: absent');throw Error('Google API 409: concurrent create');}}),/409/);
});

test('Deploy and online verification are separate phases; failed stages cannot advance',async()=>{
  for(const [phase,expected] of [['deploy',['deploy']],['verify',['verify']],['all',['deploy','verify']]]){
    const calls=[];await runReleasePhases(phase,{deploy:async()=>calls.push('deploy'),verify:async()=>calls.push('verify')});assert.deepEqual(calls,expected);
  }
  const calls=[];
  await assert.rejects(runReleasePhases('all',{deploy:async()=>{calls.push('deploy');throw Error('deployment failed');},verify:async()=>calls.push('verify')}),/deployment failed/);assert.deepEqual(calls,['deploy']);
  await assert.rejects(runReleasePhases('verify',{deploy:async()=>assert.fail('Verify must not redeploy'),verify:async()=>{throw Error('online failed');}}),/online failed/);
  await assert.rejects(runReleasePhases('unknown',{}),/Invalid/);
});
