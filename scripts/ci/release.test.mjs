import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import { parseChat, parseHttpChat } from './live-smoke.mjs';
import { rollback, validateArtifact } from './release.mjs';
const sse=data=>`data: ${JSON.stringify(data)}\n\n`;
test('HTTP 200 is insufficient: smoke requires text, done, final, and rejects stream errors',()=>{
  const text=sse({message:{type:'text',text:'reply'}}), done=sse({message:{type:'done'}}), final=sse({result:{text:'verified response '.repeat(4)}});
  assert.deepEqual(parseChat(text+done+final).eventTypes,['text','done']);
  for(const bad of [text,text+final,done+final,text+done,sse({error:{status:'RESOURCE_EXHAUSTED',message:'provider unavailable'}})]) assert.throws(()=>parseChat(bad));
});
const saved={functions:[{name:'projects/test/locations/asia-southeast1/functions/chat',buildConfig:{source:{storageSource:{bucket:'old',object:'source.zip',generation:'1'}},runtime:'nodejs22',entryPoint:'chat'}}],hosting:'sites/test/versions/old',rules:[{name:'projects/test/releases/cloud.firestore/test',rulesetName:'projects/test/rulesets/old'}]};
test('Rollback restores frozen Functions source, Hosting version, and Rules and waits for completion',async()=>{
  const calls=[];
  await rollback(saved,{sleep:async()=>{},request:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/functions/chat'))return {name:'projects/test/locations/asia-southeast1/operations/restore'};
    if(url.includes('/operations/'))return {done:true};
    return {};
  }});
  assert.deepEqual(calls[0].options.body.buildConfig.source,saved.functions[0].buildConfig.source);
  assert(calls.some(c=>c.url.includes('versionName=sites%2Ftest%2Fversions%2Fold')));
  assert(calls.some(c=>c.options?.body?.release?.rulesetName==='projects/test/rulesets/old'));
  assert(calls.some(c=>c.url.includes('/operations/')));
});
test('Partial rollback failure still attempts other services and fails the release',async()=>{
  const called=[];
  await assert.rejects(rollback(saved,{request:async(url)=>{
    called.push(url);
    if(url.includes('/functions/chat'))throw new Error('restore denied');
    return {};
  }}),/Rollback incomplete/);
  assert(called.some(x=>x.includes('firebaserules.googleapis.com')));
  assert(called.some(x=>x.includes('firebasehosting.googleapis.com')));
});

test('Release refuses a wrong SHA, modified file, or untracked artifact file',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vela-artifact-'));
  try {
    writeFileSync(join(dir,'asset.js'),'tested');
    writeFileSync(join(dir,'manifest.json'),JSON.stringify({sha:'abc',hashes:{'asset.js':createHash('sha256').update('tested').digest('hex')}}));
    assert.equal(validateArtifact(dir,'abc').sha,'abc');
    assert.throws(()=>validateArtifact(dir,'wrong'),/commit/);
    writeFileSync(join(dir,'asset.js'),'changed');assert.throws(()=>validateArtifact(dir,'abc'),/modified/);
    writeFileSync(join(dir,'asset.js'),'tested');writeFileSync(join(dir,'extra.js'),'extra');
    assert.throws(()=>validateArtifact(dir,'abc'),/inventory/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Rollback deletes only explicitly introduced functions absent before deployment',async()=>{
  const name='projects/test/locations/asia-southeast1/functions/businessApi', calls=[];
  await rollback({...saved,createdFunctions:[name]}, {request:async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/functions'))return {functions:[{name},{name:'projects/test/locations/asia-southeast1/functions/unrelated'}]};
    if(options?.method==='DELETE')return {name:'projects/test/locations/asia-southeast1/operations/delete'};
    if(url.includes('/functions/chat'))return {name:'projects/test/locations/asia-southeast1/operations/restore'};
    if(url.includes('/operations/'))return {done:true};
    return {};
  }});
  assert.deepEqual(calls.filter(c=>c.options?.method==='DELETE').map(c=>c.url),[`https://cloudfunctions.googleapis.com/v2/${name}`]);
});

test('HTTP chat smoke requires useful final result and streamed completion',()=>{
  const good=sse({type:'text',text:'text'})+sse({type:'done'})+sse({type:'result',result:{text:'Useful final answer '.repeat(3)}});
  assert(parseHttpChat(good).characters>30);
  assert.throws(()=>parseHttpChat(sse({type:'done'})));
  assert.throws(()=>parseHttpChat(good+sse({type:'error',error:{code:'FAILED'}})));
});
