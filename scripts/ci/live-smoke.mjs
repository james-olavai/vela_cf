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
    if(data.error) throw smokeFailure(data.error.status,'legacy-stream');
    if(data.message) events.push(data.message);
    if(data.result) final=data.result;
  }
  assert(final?.text?.trim().length>=30,'Missing final assistant answer');
  assert(events.some(e=>e.type==='text'&&e.text),'Missing streamed text');
  assert(events.some(e=>e.type==='done'),'Missing stream completion');
  return {characters:final.text.length,eventTypes:[...new Set(events.map(e=>e.type))],tools:events.filter(e=>e.type==='tool').map(e=>e.toolName)};
}
export function parseHttpChat(body, expectedNames=[]) {
  const events=body.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
  const failure=events.find(e=>e.type==='error');
  if(failure)throw smokeFailure(failure.error?.code,'stream',failure.error?.requestId);
  const final=events.find(e=>e.type==='result')?.result;
  assert(final?.text?.trim().length>=30,'Missing HTTP final answer');
  assert(expectedNames.every(name=>final.text.toLowerCase().includes(name.toLowerCase())),'Answer omitted a required profile');
  assert(events.some(e=>e.type==='text'&&e.text),'Missing HTTP streamed text');
  assert(events.some(e=>e.type==='done'),'Missing HTTP stream completion');
  return {characters:final.text.length,eventTypes:[...new Set(events.map(e=>e.type))],tools:events.filter(e=>e.type==='tool').map(e=>e.toolName),...(expectedNames.length?{allProfilesAddressed:true}:{})};
}
export function smokeFailure(code,phase,requestId) {
  const error=new Error('Live verification failed');
  return Object.assign(error,{code:typeof code==='string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'LIVE_SMOKE_FAILED',phase:['auth','profiles','session','generation','stream','legacy-stream','verification','cleanup','budget','start'].includes(phase)?phase:'verification',requestId:typeof requestId==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId)?requestId:undefined});
}
const identity=`https://identitytoolkit.googleapis.com/v1/accounts:`;
async function authCall(action,data) {
  const res=await fetch(`${identity}${action}?key=${config.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(30_000)});
  const out=await res.json();if(!res.ok)throw smokeFailure('SYNTHETIC_AUTH_FAILED','auth');return out;
}
async function smoke(name,{unlimited=false,exhausted=false,legacy=false,apiOnly=false,country=false,pro=false,profileCount=1,company=false}={},record={}) {
  record.phase='auth';
  const auth=await authCall('signUp',{email:`vela-ci-${randomUUID()}@vela.local`,password:randomUUID()+randomUUID(),returnSecureToken:true});
  const uid=auth.localId, idToken=auth.idToken;
  assert(uid&&idToken,'No synthetic identity returned');
  const root=`users/${uid}`;
  const api=apiClient(`https://asia-southeast1-${project}.cloudfunctions.net/businessApi`,idToken);
  const call=async(fn,data,stream=false)=>{
    const res=await fetch(`https://asia-southeast1-${project}.cloudfunctions.net/${fn}`,{method:'POST',headers:{Authorization:`Bearer ${idToken}`,'Content-Type':'application/json',...(stream?{Accept:'text/event-stream'}:{})},body:JSON.stringify({data}),signal:AbortSignal.timeout(180_000)});
    return {res,body:await res.text()};
  };
  try {
    const now=new Date().toISOString(),periodStart=now.slice(0,7)+'-01T00:00:00Z';
    record.phase='profiles';
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
    const profile=await api('POST','/v1/profiles',{name:'CI Subject 1',entityType:company?'company':'person',birthDateTime:'1994-06-03T08:20',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',locationName:'上海',gender:'female',...location});
    assert.equal(profile.status,201);
    if(country) {
      const recommendation=await api('GET',`/v1/profiles/${profile.body.id}/country-chart`);
      assert.equal(recommendation.status,200);assert.equal(recommendation.body.status,'matched');countryChart=recommendation.body.chart;
      const denied=await api('POST','/v1/charts/natal',{subjects:[{ref:'country',country_chart:{id:countryChart.id,version:countryChart.version}}]});assert.equal(denied.status,403,'Free identity cannot compute country chart');
    }
    await writeDocument(`usage/${uid}`,{unlimited,overrideTier:unlimited||country||pro?'pro':'free',used:unlimited||exhausted?999999999:0,periodStart});
    const profiles=[profile.body];
    for(let index=1;index<profileCount;index++){
      const added=await api('POST','/v1/profiles',{name:`CI Subject ${index+1}`,entityType:'person',birthDateTime:`199${index}-0${index+1}-12T10:30`,latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',locationName:'上海',gender:'unset'});
      assert.equal(added.status,201);profiles.push(added.body);
    }
    record.phase='session';
    const created=await api('POST','/v1/sessions',{mode:profileCount>1?'synastry':'personal',...(country?{subjects:[{ref:'country',country_chart:{id:countryChart.id,version:countryChart.version}}]}:{profileIds:profiles.map(p=>p.id)}),initialQuestion:'CI synthetic smoke'});
    const session=created.body;
    assert.equal(created.status,201,'User API session creation failed');
    assert(session?.id,'Session ID missing');
    assert.equal(session.subjects.length,country?1:profileCount,'Wrong number of frozen analysis objects');
    if(country) {assert.equal(session.subjects[0].countryChart.contentHash,countryChart.contentHash);assert.equal(session.subjects[0].profile.birthDateTime,`${countryChart.localDate}T${countryChart.localTime}`);}

    if(legacy) {
      const bundle=JSON.parse(readFileSync(new URL('../../apps/api/playground-fixtures/ab-baseline.json',import.meta.url),'utf8'));
      await google(`${documentRoot}/${root}/sessions/${session.id}?updateMask.fieldPaths=frozenPrompt&updateMask.fieldPaths=frozenModel&updateMask.fieldPaths=frozenTools`,{method:'PATCH',body:{fields:fields({frozenPrompt:bundle.systemPrompt,frozenModel:bundle.modelName,frozenTools:bundle.allowedTools})}});
      await writeDocument(`${root}/sessions/${session.id}/private/prompt`,{bundle});
    }
    const message=company?`请调用公司本命盘及 transitEvents，分析从 ${now.slice(0,10)} 开始未来三个月的经营节奏与团队协作，给两条简短建议，不作确定性预测。`:profileCount>1?`请调用合盘工具分析这 ${profileCount} 位成员的合作倾向。逐一使用完整档案称呼（${profiles.map(p=>p.name).join('、')}），每位给一条具体分工建议，不要虚构关系。`:country?'请先调用 natalWheel，根据所提供的国家事件盘简短解读两个象征主题，并说明采用的事件时间；不要预测具体社会事件。':legacy?'请分析未来三个月事业运势，先调用 transitEvents（windowMonths=3，startDate=2026-11-01），根据结果简要给一条建议。':'请先调用 natalWheel，再简要解读性格与职业倾向，给出一条具体建议。';
    record.phase='generation';
    const reply=legacy ? await call('chat',{sessionId:session.id,message},true) : await (async()=>{
      const res=await fetch(`https://asia-southeast1-${project}.cloudfunctions.net/businessApi/v1/sessions/${session.id}/turns`,{method:'POST',headers:{Authorization:`Bearer ${idToken}`,'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({message,depth:'balanced'}),signal:AbortSignal.timeout(180_000)});return {res,body:await res.text()};
    })();
    record.phase='verification';
    let result;
    if(exhausted) {
      assert(reply.body.includes('QUOTA_EXCEEDED'),'Expected explicit application quota denial');
      assert(!reply.body.includes('"type":"text"'),'Exhausted account must not generate a reply');
      result={quotaDenied:true};
    } else {
      assert.equal(reply.res.status,200);result=legacy?parseChat(reply.body):parseHttpChat(reply.body,profileCount>1?profiles.map(p=>p.name):[]);
      assert(result.tools.length>0,'No astrology tool execution');
      if(profileCount>1)assert(result.tools.includes('synastryAspects'),'No synastry tool execution');
      if(company)assert(result.tools.includes('transitEvents'),'Company outlook did not use transit events');
      if(legacy) assert(result.tools.includes('transitEvents'),'No live transit tool execution');
      if(country) {assert(result.tools.includes('natalWheel'),'No country chart tool execution');result.countryChart={id:countryChart.id,version:countryChart.version,contentHash:countryChart.contentHash};}
      const usage=await google(`${documentRoot}/usage/${uid}`);
      assert(Number(usage.fields.used.integerValue)>(unlimited?999999999:0),'Missing usage settlement');
      record.settledMicroUsd=Number(usage.fields.used.integerValue)-(unlimited?999999999:0);
      assert.equal(usage.fields.unlimited.booleanValue,unlimited);
      assert.equal(Object.keys(usage.fields.reservations?.mapValue?.fields||{}).length,0,'Reservation leaked');
      const messages=await api('GET',`/v1/sessions/${session.id}/messages`);
      assert.equal(messages.status,200);assert.equal(messages.body.items?.length,2,'Both messages must be user-readable');
      assert.deepEqual(messages.body.items.map(item=>item.role).sort(),['assistant','user']);
      if(!legacy){
        const started=reply.body.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))).find(event=>event.type==='started');assert(started?.turnId,'Missing durable turn ID');
        const turn=await api('GET',`/v1/sessions/${session.id}/turns/${started.turnId}`);assert.equal(turn.status,200);assert.equal(turn.body.status,'completed');result.turnStatus=turn.body.status;
      }
      const publicUsage=await api('GET','/v1/me/usage');assert.equal(publicUsage.status,200);assert(publicUsage.body.used>0,'User cannot read settled usage');
    }
    const state=await google(`${documentRoot}/${root}/sessions/${session.id}`);
    assert(!state.fields.activeTurnId?.stringValue,'Session turn lock leaked');
    const savedProfiles=await api('GET','/v1/profiles?limit=50');assert.equal(savedProfiles.status,200);
    assert.deepEqual(savedProfiles.body.items.sort((a,b)=>a.id.localeCompare(b.id)),profiles.sort((a,b)=>a.id.localeCompare(b.id)),'Read-only analysis changed profile data');
    console.log(`PASS live ${name}`,JSON.stringify(result));return {case:name,...result};
  } catch(error) {record.failure=smokeFailure(error.code, error.phase||record.phase, error.requestId);throw error;} finally {
    // Always attempt every cleanup, even when one API fails. No pre-existing user is touched.
    const cleanup=await Promise.allSettled([deleteTree(root),google(`${documentRoot}/usage/${uid}`,{method:'DELETE'}),authCall('delete',{idToken})]);
    record.cleanup=cleanup.every(x=>x.status==='fulfilled')?'passed':'failed';
    if(record.cleanup==='failed' && !record.failure)throw smokeFailure('SYNTHETIC_CLEANUP_FAILED','cleanup');
    delete record.failure;
  }
}
export const liveApiSmoke=()=>smoke('api-ready',{apiOnly:true});
export const LIVE_CASES = {
  production:[['current-free',{}],['frozen-unlimited',{unlimited:true,legacy:true}],['exhausted-free',{exhausted:true}],['country-chart-pro',{country:true}]],
  staging:[['current-free',{}],['single-pro',{pro:true}],['pair-pro',{pro:true,profileCount:2}],['four-person-pro',{pro:true,profileCount:4}],['company-pro',{pro:true,company:true}],['country-chart-pro',{country:true}],['frozen-unlimited',{unlimited:true,legacy:true}],['exhausted-free',{exhausted:true}]],
};
export async function liveSmoke({mode='production',evidencePath='artifacts/live-smoke.json',execute=smoke,now=Date.now}={}) {
  assert(Object.hasOwn(LIVE_CASES,mode),'Unknown live verification mode');
  const started=now(),report={mode,startedAt:new Date(started).toISOString(),limits:{maxCases:8,maxElapsedMs:20*60_000,maxSettledMicroUsd:1_000_000,accounting:'application-settlement; not an upstream invoice cap'},cases:[]};
  assert(LIVE_CASES[mode].length<=report.limits.maxCases,'Live verification case budget exceeded');
  mkdirSync('artifacts',{recursive:true});
  const persist=()=>writeFileSync(evidencePath,JSON.stringify(report,null,2));
  try {
    for(const [name,options] of LIVE_CASES[mode]) {
      assert(now()-started<report.limits.maxElapsedMs,'Live verification time budget exhausted');
      assert(report.cases.reduce((total,item)=>total+(item.settledMicroUsd||0),0)<report.limits.maxSettledMicroUsd,'Live verification settlement budget exhausted');
      const record={case:name,status:'running',phase:'start'},begin=now();report.cases.push(record);persist();
      try {
        Object.assign(record,await execute(name,options,record));
        if(now()-started>=report.limits.maxElapsedMs || report.cases.reduce((total,item)=>total+(item.settledMicroUsd||0),0)>report.limits.maxSettledMicroUsd)throw smokeFailure('LIVE_BUDGET_EXCEEDED','budget');
        record.status='passed';
      }
      catch(error){const safe=smokeFailure(error.code,error.phase||record.phase,error.requestId);Object.assign(record,{status:'failed',error:{code:safe.code,phase:safe.phase,...(safe.requestId?{requestId:safe.requestId}:{})}});throw safe;}
      finally {record.durationMs=now()-begin;persist();}
    }
    return report.cases;
  } catch(error){const safe=smokeFailure(error.code,error.phase||'budget',error.requestId);report.failure={code:safe.code,phase:safe.phase};throw safe;} finally {report.finishedAt=new Date(now()).toISOString();persist();}
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href) await liveSmoke({mode:process.env.VELA_LIVE_MODE||'production'});
