// Real Firebase Auth -> Callable -> Vertex -> Firestore. Creates only isolated synthetic users.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { google, config, project, documentRoot, fields, writeDocument, deleteTree } from './google.mjs';
export function parseChat(body) {
  const events=[];let final;
  for(const line of body.split('\n')) if(line.startsWith('data:')) {
    const data=JSON.parse(line.slice(5));
    if(data.error) throw new Error(`Callable ${data.error.status}: ${data.error.message}`);
    if(data.message) events.push(data.message);
    if(data.result) final=data.result;
  }
  assert(final?.text?.trim().length>=30,'Missing final assistant answer');
  assert(events.some(e=>e.type==='text'&&e.text),'Missing streamed text');
  assert(events.some(e=>e.type==='done'),'Missing stream completion');
  return {characters:final.text.length,eventTypes:[...new Set(events.map(e=>e.type))],tools:events.filter(e=>e.type==='tool').map(e=>e.toolName)};
}
const identity=`https://identitytoolkit.googleapis.com/v1/accounts:`;
async function authCall(action,data) {
  const res=await fetch(`${identity}${action}?key=${config.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(30_000)});
  const out=await res.json();assert(res.ok,`Auth ${action} failed: ${out.error?.message}`);return out;
}
async function smoke(name,{unlimited=false,exhausted=false,legacy=false}={}) {
  const auth=await authCall('signUp',{email:`vela-ci-${randomUUID()}@vela.local`,password:randomUUID()+randomUUID(),returnSecureToken:true});
  const uid=auth.localId, idToken=auth.idToken;
  assert(uid&&idToken,'No synthetic identity returned');
  const root=`users/${uid}`;
  const call=async(fn,data,stream=false)=>{
    const res=await fetch(`https://asia-southeast1-${project}.cloudfunctions.net/${fn}`,{method:'POST',headers:{Authorization:`Bearer ${idToken}`,'Content-Type':'application/json',...(stream?{Accept:'text/event-stream'}:{})},body:JSON.stringify({data}),signal:AbortSignal.timeout(150_000)});
    return {res,body:await res.text()};
  };
  try {
    const now=new Date().toISOString(),periodStart=now.slice(0,7)+'-01T00:00:00Z';
    await writeDocument(`${root}/profiles/smoke`,{name:'CI Synthetic',entityType:'person',birthDateTime:'1994-06-03T08:20',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',locationName:'上海',gender:'female',createdAt:now,updatedAt:now});
    await writeDocument(`usage/${uid}`,{unlimited,overrideTier:unlimited?'pro':'free',used:unlimited||exhausted?999999999:0,periodStart});
    const created=await call('createSession',{mode:'personal',profileIds:['smoke'],initialQuestion:'CI synthetic smoke'});
    const session=JSON.parse(created.body).result?.session;
    assert(session?.id,`Session creation failed: HTTP ${created.res.status}`);
    if(legacy) {
      const bundle=JSON.parse(readFileSync(new URL('../../apps/api/playground-fixtures/ab-baseline.json',import.meta.url),'utf8'));
      await google(`${documentRoot}/${root}/sessions/${session.id}?updateMask.fieldPaths=frozenPrompt&updateMask.fieldPaths=frozenModel&updateMask.fieldPaths=frozenTools`,{method:'PATCH',body:{fields:fields({frozenPrompt:bundle.systemPrompt,frozenModel:bundle.modelName,frozenTools:bundle.allowedTools})}});
      await writeDocument(`${root}/sessions/${session.id}/private/prompt`,{bundle});
    }
    const message=legacy?'请分析未来三个月事业运势，先调用 transitEvents（windowMonths=3，startDate=2026-11-01），根据结果简要给一条建议。':'请简要解读性格与职业倾向，给出一条具体建议。';
    const reply=await call('chat',{sessionId:session.id,message},true);
    let result;
    if(exhausted) {
      assert(reply.body.includes('QUOTA_EXCEEDED'),'Expected explicit application quota denial');
      assert(!reply.body.includes('"type":"text"'),'Exhausted account must not generate a reply');
      result={quotaDenied:true};
    } else {
      assert.equal(reply.res.status,200);result=parseChat(reply.body);
      if(legacy) assert(result.tools.includes('transitEvents'),'No live transit tool execution');
      const usage=await google(`${documentRoot}/usage/${uid}`);
      assert(Number(usage.fields.used.integerValue)>0,'Missing usage settlement');
      assert.equal(usage.fields.unlimited.booleanValue,unlimited);
      assert.equal(Object.keys(usage.fields.reservations?.mapValue?.fields||{}).length,0,'Reservation leaked');
      const messages=await google(`${documentRoot}/${root}/sessions/${session.id}/messages`);
      assert.equal(messages.documents?.length,2,'Both messages must be persisted');
    }
    const state=await google(`${documentRoot}/${root}/sessions/${session.id}`);
    assert(!state.fields.activeTurnId?.stringValue,'Session turn lock leaked');
    console.log(`PASS production ${name}`,JSON.stringify(result));return {case:name,...result};
  } finally {
    // Always attempt every cleanup, even when one API fails. No pre-existing user is touched.
    const cleanup=await Promise.allSettled([deleteTree(root),google(`${documentRoot}/usage/${uid}`,{method:'DELETE'}),authCall('delete',{idToken})]);
    const failed=cleanup.filter(x=>x.status==='rejected');
    if(failed.length) throw new AggregateError(failed.map(x=>x.reason),'Synthetic account cleanup failed');
  }
}
export async function liveSmoke() {
  const evidence=[];
  evidence.push(await smoke('current-free'));
  evidence.push(await smoke('frozen-unlimited',{unlimited:true,legacy:true}));
  evidence.push(await smoke('exhausted-free',{exhausted:true}));
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/live-smoke.json',JSON.stringify(evidence,null,2));
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href) await liveSmoke();
