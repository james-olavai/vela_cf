import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import catalog from '../data/country-charts.json' with { type: 'json' };
import { getCountryChart, recommendCountry, countrySnapshot, dispatchCountryApi, CountryChartSchema, countryContentHash } from './country-charts.js';
import { resolveSubjects, validateBirthTime } from './subjects.js';
import { createFrozenSession } from './session.js';
import { dispatchBusinessApi } from './business-api.js';
import { locations } from './locations.js';
const chart=getCountryChart('country-cn-founding','1');
const profile={name:'Synthetic',entityType:'person',gender:'unset',birthDateTime:'1994-06-03T08:20',locationName:'上海',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',locationRef:{id:'builtin-shanghai',version:'1'},countryCode:'CN',locationSource:'builtin',updatedAt:'2026-11-16'};
function database() {
  const store=new Map<string,any>([['users/alice/profiles/a',profile],['users/bob/profiles/b',profile]]);let serial=0;
  const collection=(path:string):any=>({doc:(id=`s${++serial}`)=>({id,collection:(name:string)=>collection(`${path}/${id}/${name}`),get:async()=>({id,exists:store.has(`${path}/${id}`),data:()=>store.get(`${path}/${id}`)}),set:async(data:any)=>{store.set(`${path}/${id}`,data);}})});
  return {store,db:{collection} as unknown as Firestore};
}
const auth={uid:'alice',token:{} as any};
test('published country event has a verified source and immutable version fingerprint',()=>{
  assert.equal(countryContentHash(Object.fromEntries(Object.entries(catalog.items[0]).reverse())),chart.contentHash,'Object key order must not change immutable event hash');
  assert.equal(chart.contentHash,'591a1efd7cc7e54e8cd5f350a0a74577c2d8f9b129e773334877cb833d2d00e1','Published version changed: add a new version, never overwrite it');
  assert.equal(chart.sourceReferences[0].startsWith('https://www.fmprc.gov.cn/'),true);
  assert.equal(chart.timeReliability,'verified');assert.equal(chart.localTime,'15:00');
  assert.doesNotThrow(()=>validateBirthTime(`${chart.localDate}T${chart.localTime}`,chart.timezone));
  assert.equal(new Set(catalog.items.map(c=>`${c.id}:${c.version}`)).size,catalog.items.length);
  assert.deepEqual(catalog.defaults.CN,{id:chart.id,version:chart.version});
  assert.throws(()=>getCountryChart(chart.id,'latest'),/COUNTRY_CHART_NOT_FOUND/);
  assert.throws(()=>countrySnapshot({...chart,usable:false,timeReliability:'unknown',localTime:null}),/COUNTRY_CHART_TIME_UNVERIFIED/);
});
test('country recommendation uses verified location evidence and distinguishes company from birth',()=>{
  assert.equal(recommendCountry(profile).basis,'birth_location');assert.equal(recommendCountry(profile).chart?.id,chart.id);
  assert.equal(recommendCountry({...profile,entityType:'company'}).basis,'registration_location');
  assert.equal(recommendCountry({...profile,countryCode:'AU'}).reason,'COUNTRY_CHART_UNAVAILABLE');
  for(const p of [{...profile,locationRef:undefined},{...profile,locationSource:undefined},{...profile,entityType:'country'},{}])assert.equal(recommendCountry(p).reason,'LOCATION_COUNTRY_UNKNOWN');
});
test('catalog/detail are public; recommendation verifies profile ownership and query versions',async()=>{
  const {db}=database();
  const all=await dispatchCountryApi(db,{method:'GET',path:'/v1/country-charts',query:{}});assert.equal(all.status,200);
  assert.deepEqual((all.body as any).items.map((c:any)=>c.id),[chart.id]);
  assert.equal(((await dispatchCountryApi(db,{method:'GET',path:'/v1/country-charts',query:{countryCode:'AU'}})).body as any).items?.length,0);
  for(const query of [{version:'missing'},{cursor:'garbage'},{limit:'500'}])await assert.rejects(()=>dispatchCountryApi(db,{method:'GET',path:'/v1/country-charts',query}));
  await assert.rejects(()=>dispatchCountryApi(db,{method:'GET',path:`/v1/country-charts/${chart.id}`,query:{}}));
  const detail=await dispatchCountryApi(db,{method:'GET',path:`/v1/country-charts/${chart.id}`,query:{version:'1'}});assert.equal(CountryChartSchema.parse(detail.body).contentHash,chart.contentHash);
  await assert.rejects(()=>dispatchCountryApi(db,{method:'GET',path:'/v1/profiles/a/country-chart'}),/AUTH_REQUIRED/);
  await assert.rejects(()=>dispatchCountryApi(db,{method:'GET',path:'/v1/profiles/b/country-chart',auth}),/PROFILE_NOT_FOUND/);
  assert.equal(((await dispatchCountryApi(db,{method:'GET',path:'/v1/profiles/a/country-chart',auth})).body as any).status,'matched');
});
test('automatic country subjects resolve from owned snapshots, not caller nation strings or cyclic refs',async()=>{
  const {db,store}=database();
  const raw=[{ref:'country',country_chart:{mode:'auto',source_ref:'self'}},{ref:'self',profile_id:'a'}];
  const resolved=await resolveSubjects(db,'alice',raw);assert.equal(resolved[0].profile.entityType,'country');assert.equal(resolved[0].countryChart?.sourceRef,'self');
  assert.equal(resolved[0].profile.birthDateTime,'1949-10-01T15:00');assert.equal(store.size,2);
  await assert.rejects(()=>resolveSubjects(db,'', [{ref:'country',country_chart:{id:chart.id,version:'1'}}]),/AUTH_REQUIRED/);
  for(const source_ref of ['country','missing'])await assert.rejects(()=>resolveSubjects(db,'alice',[{ref:'country',country_chart:{mode:'auto',source_ref}}]),/INVALID_COUNTRY_SOURCE_REF/);
  await assert.rejects(()=>resolveSubjects(db,'alice',[{ref:'first',country_chart:{mode:'auto',source_ref:'second'}},{ref:'second',country_chart:{mode:'auto',source_ref:'first'}}]),/INVALID_COUNTRY_SOURCE_REF/);
  store.set('users/alice/profiles/a',{...profile,locationRef:undefined});await assert.rejects(()=>resolveSubjects(db,'alice',raw),/LOCATION_COUNTRY_UNKNOWN/);
});
test('country sessions freeze provenance, retain public metadata, and cannot bypass plan object limits',async()=>{
  const {db,store}=database(), subjects=[{ref:'self',profile_id:'a'},{ref:'country',country_chart:{mode:'auto',source_ref:'self'}}];
  const result=await createFrozenSession(db,{uid:'alice',tier:'pro',rawData:{mode:'synastry',subjects}});
  const frozen=structuredClone(store.get(`users/alice/sessions/${result.sessionId}`).frozenSubjects);
  store.delete('users/alice/profiles/a');
  assert.deepEqual(store.get(`users/alice/sessions/${result.sessionId}`).frozenSubjects,frozen);
  assert.equal(frozen[1].countryChart.contentHash,chart.contentHash);assert.equal(frozen[1].countryChart.catalogVersion,catalog.catalogVersion);
  const response=await dispatchBusinessApi(db,{method:'GET',path:`/v1/sessions/${result.sessionId}`,auth});
  assert.equal((response.body as any).subjects[1].countryChart.contentHash,chart.contentHash);
  const single=[{ref:'country',country_chart:{id:chart.id,version:'1'}}];
  for(const tier of ['free','go'] as const)await assert.rejects(()=>createFrozenSession(db,{uid:'alice',tier,rawData:{subjects:single}}),/ENTITY_CHART_REQUIRES_PRO/);
  await assert.rejects(()=>createFrozenSession(db,{uid:'alice',tier:'pro',rawData:{mode:'synastry',subjects:Array.from({length:5},(_,i)=>({ref:`c${i}`,country_chart:{id:chart.id,version:'1'}}))}}));
  assert.equal([...store.keys()].filter(k=>/^users\/alice\/sessions\/[^/]+$/.test(k)).length,1,'Failed requests must not create partial sessions');
});


test('direct birth can omit a label with a validated location reference, but cannot inject country metadata',async()=>{
  const {db}=database(),location=locations.find(row=>row.id==='geonames-1816670')!;
  const birth={datetime:'1994-06-03T08:20',latitude:location.latitude,longitude:location.longitude,timezone:location.timezone,locationRef:{id:location.id,version:location.version}};
  const subjects=[{ref:'self',birth},{ref:'country',country_chart:{mode:'auto',source_ref:'self'}}];
  const resolved=await resolveSubjects(db,'alice',subjects);assert.equal(resolved[0].profile.locationName,location.displayName);assert.equal(resolved[1].countryChart?.id,chart.id);
  await assert.rejects(()=>resolveSubjects(db,'alice',[{ref:'self',birth:{...birth,countryCode:'AU',locationSource:'builtin'}}]));
  await assert.rejects(()=>resolveSubjects(db,'alice',[{ref:'self',birth:{...birth,latitude:0}}]),/LOCATION_REFERENCE_MISMATCH/);
  await assert.rejects(()=>resolveSubjects(db,'alice',[{ref:'country',country_chart:{id:chart.id,version:'1',localTime:'12:00'}}]));
});
