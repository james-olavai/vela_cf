// Real Firebase Auth -> Callable -> Vertex -> Firestore. Creates only isolated synthetic users.
import assert from 'node:assert/strict';
import { apiClient, profileSmoke } from './api-smoke.mjs';
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
export function parseHttpChat(body) {
  const events=body.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
  assert(!events.some(e=>e.type==='error'),'HTTP stream returned an error');
  const final=events.find(e=>e.type==='result')?.result;
  assert(final?.text?.trim().length>=30,'Missing HTTP final answer');
  assert(events.some(e=>e.type==='text'&&e.text),'Missing HTTP streamed text');
  assert(events.some(e=>e.type==='done'),'Missing HTTP stream completion');
  return {characters:final.text.length,eventTypes:[...new Set(events.map(e=>e.type))],tools:events.filter(e=>e.type==='tool').map(e=>e.toolName)};
}
const identity=`https://identitytoolkit.googleapis.com/v1/accounts:`;
async function authCall(action,data) {
  const res=await fetch(`${identity}${action}?key=${config.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(30_000)});
  const out=await res.json();assert(res.ok,`Auth ${action} failed: ${out.error?.message}`);return out;
}
async function smoke(name,{unlimited=false,exhausted=false,legacy=false,apiOnly=false,country=false}={}) {
  const auth=await authCall('signUp',{email:`vela-ci-${randomUUID()}@vela.local`,password:randomUUID()+randomUUID(),returnSecureToken:true});
  const uid=auth.localId, idToken=auth.idToken;
  assert(uid&&idToken,'No synthetic identity returned');
  const root=`users/${uid}`;
  const api=apiClient(`https://asia-southeast1-${project}.cloudfunctions.net/businessApi`,idToken);
  const call=async(fn,data,stream=false)=>{
    const res=await fetch(`https://asia-southeast1-${project}.cloudfunctions.net/${fn}`,{method:'POST',headers:{Authorization:`Bearer ${idToken}`,'Content-Type':'application/json',...(stream?{Accept:'text/event-stream'}:{})},body:JSON.stringify({data}),signal:AbortSignal.timeout(150_000)});
    return {res,body:await res.text()};
  };
  try {
    const now=new Date().toISOString(),periodStart=now.slice(0,7)+'-01T00:00:00Z';
    const apiResult=await profileSmoke(api);
    if(apiOnly) { console.log("PASS production API ready");return apiResult; }
    const initialized=await api('PATCH','/v1/me',{acceptedTerms:true,confirmedAdult:true});
    assert.equal(initialized.status,200);
    let location={},countryChart;
    if(country) {
      const locations=await api('GET','/v1/locations?query=beijing&source=builtin');assert.equal(locations.status,200);
      const city=locations.body.results.find(item=>item.id==='geonames-1816670');assert(city,'Missing built-in Beijing');
      location={latitude:city.latitude,longitude:city.longitude,timezone:city.timezone,locationName:city.displayName,locationRef:{id:city.id,version:city.version}};
    }
    const profile=await api('POST','/v1/profiles',{name:'CI Synthetic',entityType:'person',birthDateTime:'1994-06-03T08:20',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',locationName:'上海',gender:'female',...location});
    assert.equal(profile.status,201);
    if(country) {
      const recommendation=await api('GET',`/v1/profiles/${profile.body.id}/country-chart`);
      assert.equal(recommendation.status,200);assert.equal(recommendation.body.status,'matched');countryChart=recommendation.body.chart;
      const denied=await api('POST','/v1/charts/natal',{subjects:[{ref:'country',country_chart:{id:countryChart.id,version:countryChart.version}}]});assert.equal(denied.status,403,'Free identity cannot compute country chart');
    }
    await writeDocument(`usage/${uid}`,{unlimited,overrideTier:unlimited||country?'pro':'free',used:unlimited||exhausted?999999999:0,periodStart});
    const created=await api('POST','/v1/sessions',{mode:'personal',...(country?{subjects:[{ref:'country',country_chart:{id:countryChart.id,version:countryChart.version}}]}:{profileIds:[profile.body.id]}),initialQuestion:'CI synthetic smoke'});
    const session=created.body;
    assert.equal(created.status,201,'User API session creation failed');
    assert(session?.id,'Session ID missing');
    if(country) {assert.equal(session.subjects[0].countryChart.contentHash,countryChart.contentHash);assert.equal(session.subjects[0].profile.birthDateTime,`${countryChart.localDate}T${countryChart.localTime}`);}

    if(legacy) {
      const bundle=JSON.parse(readFileSync(new URL('../../apps/api/playground-fixtures/ab-baseline.json',import.meta.url),'utf8'));
      await google(`${documentRoot}/${root}/sessions/${session.id}?updateMask.fieldPaths=frozenPrompt&updateMask.fieldPaths=frozenModel&updateMask.fieldPaths=frozenTools`,{method:'PATCH',body:{fields:fields({frozenPrompt:bundle.systemPrompt,frozenModel:bundle.modelName,frozenTools:bundle.allowedTools})}});
      await writeDocument(`${root}/sessions/${session.id}/private/prompt`,{bundle});
    }
    const message=country?'请先调用 natalWheel，根据所提供的国家事件盘简短解读两个象征主题，并说明采用的事件时间；不要预测具体社会事件。':legacy?'请分析未来三个月事业运势，先调用 transitEvents（windowMonths=3，startDate=2026-11-01），根据结果简要给一条建议。':'请简要解读性格与职业倾向，给出一条具体建议。';
    const reply=legacy ? await call('chat',{sessionId:session.id,message},true) : await (async()=>{
      const res=await fetch(`https://asia-southeast1-${project}.cloudfunctions.net/businessApi/v1/sessions/${session.id}/turns`,{method:'POST',headers:{Authorization:`Bearer ${idToken}`,'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({message}),signal:AbortSignal.timeout(180_000)});return {res,body:await res.text()};
    })();
    let result;
    if(exhausted) {
      assert(reply.body.includes('QUOTA_EXCEEDED'),'Expected explicit application quota denial');
      assert(!reply.body.includes('"type":"text"'),'Exhausted account must not generate a reply');
      result={quotaDenied:true};
    } else {
      assert.equal(reply.res.status,200);result=legacy?parseChat(reply.body):parseHttpChat(reply.body);
      if(legacy) assert(result.tools.includes('transitEvents'),'No live transit tool execution');
      if(country) {assert(result.tools.includes('natalWheel'),'No country chart tool execution');result.countryChart={id:countryChart.id,version:countryChart.version,contentHash:countryChart.contentHash};}
      const usage=await google(`${documentRoot}/usage/${uid}`);
      assert(Number(usage.fields.used.integerValue)>0,'Missing usage settlement');
      assert.equal(usage.fields.unlimited.booleanValue,unlimited);
      assert.equal(Object.keys(usage.fields.reservations?.mapValue?.fields||{}).length,0,'Reservation leaked');
      const messages=await api('GET',`/v1/sessions/${session.id}/messages`);
      assert.equal(messages.status,200);assert.equal(messages.body.items?.length,2,'Both messages must be user-readable');
      const publicUsage=await api('GET','/v1/me/usage');assert.equal(publicUsage.status,200);assert(publicUsage.body.used>0,'User cannot read settled usage');
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
export const liveApiSmoke=()=>smoke('api-ready',{apiOnly:true});
export async function liveSmoke() {
  const evidence=[];
  evidence.push(await smoke('current-free'));
  evidence.push(await smoke('frozen-unlimited',{unlimited:true,legacy:true}));
  evidence.push(await smoke('exhausted-free',{exhausted:true}));
  evidence.push(await smoke('country-chart-pro',{country:true}));
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/live-smoke.json',JSON.stringify(evidence,null,2));
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href) await liveSmoke();
