import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['apps/web/src/lib/geoStore.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'isolated-api',setup(b){b.onResolve({filter:/apiClient$/},()=>({path:'api',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const businessApi=(...args)=>globalThis.geoApi(...args);'}));}}]});
const {loadCatalog,matchLocations,consultationSubjects}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const city=(name,aliases=[],displayName=name)=>({id:name,version:'v1',name,aliases,displayName,latitude:1,longitude:2,timezone:'Asia/Shanghai'});
test('matching ranks exact names and aliases, preserves duplicate locations and caps suggestions',()=>{
 const items=[city('Beijing',['北京','beijing'],'北京，中国'),city('Beijing suburb',[],'北京近郊，中国'),city('Springfield',[],'Springfield，Illinois'),city('Springfield',[],'Springfield，Massachusetts')];
 assert.equal(matchLocations(items,' 北京 ')[0].name,'Beijing');assert.equal(matchLocations(items,'BEIJING')[0].name,'Beijing');assert.equal(matchLocations(items,'ＢＥＩＪＩＮＧ')[0].name,'Beijing');
 assert.equal(matchLocations(items,'Springfield').length,2);assert.deepEqual(matchLocations(items,''),[]);
 assert.equal(matchLocations(Array.from({length:20},(_,i)=>city('City '+i)),'city').length,8);
});
test('catalog follows one immutable version and returns only a complete result; cache avoids another fetch',async()=>{
 const calls=[];globalThis.geoApi=async(_,url)=>{calls.push(url);return calls.length===1?{catalogVersion:'v7',items:[city('a')],nextCursor:'next'}:{catalogVersion:'v7',items:[city('b')],nextCursor:null};};
 const loaded=await loadCatalog('/catalog-ok');assert.equal(loaded.length,2);assert(calls[1].includes('version=v7'));assert(calls[1].includes('cursor=next'));
 await loadCatalog('/catalog-ok');assert.equal(calls.length,2);
});
test('failed partial catalog is discarded and retry starts at the first page',async()=>{
 let calls=0;globalThis.geoApi=async()=>{if(++calls===2)throw new Error('offline');return {catalogVersion:'v1',items:[city('partial')],nextCursor:'later'};};
 await assert.rejects(loadCatalog('/catalog-failed'),/offline/);
 globalThis.geoApi=async(_,url)=>{assert(!url.includes('cursor='));return {catalogVersion:'v2',items:[city('fresh')],nextCursor:null};};
 assert.equal((await loadCatalog('/catalog-failed'))[0].name,'fresh');
});
test('catalog rejects mixed versions and repeating cursors',async()=>{
 let calls=0;globalThis.geoApi=async()=>({catalogVersion:++calls%2?'v1':'v2',items:[],nextCursor:'same'});
 await assert.rejects(loadCatalog('/mixed'),/版本/);
 globalThis.geoApi=async()=>({catalogVersion:'v1',items:[],nextCursor:'same'});await assert.rejects(loadCatalog('/repeat'),/游标/);
});
test('country participates only when explicitly selected and never becomes a user profile',()=>{
 assert.deepEqual(consultationSubjects([{id:'mine'}]),[{ref:'subject_1',profile_id:'mine'}]);
 assert.deepEqual(consultationSubjects([{id:'mine'}],{id:'country-cn',version:'v1'}),[{ref:'subject_1',profile_id:'mine'},{ref:'country',country_chart:{id:'country-cn',version:'v1'}}]);
});
test('a retired catalog version restarts from page one instead of mixing snapshots',async()=>{
 let calls=0;globalThis.geoApi=async(_,url)=>{
  ++calls;if(calls===1)return {catalogVersion:'old',items:[city('old')],nextCursor:'next'};
  if(calls===2)throw Object.assign(new Error('retired'),{code:'CATALOG_VERSION_UNAVAILABLE'});
  assert(!url.includes('cursor='));assert(!url.includes('version='));return {catalogVersion:'new',items:[city('new')],nextCursor:null};
 };
 assert.deepEqual((await loadCatalog('/retired')).map(x=>x.name),['new']);assert.equal(calls,3);
});
test('concurrent consumers share a load and no partial directory escapes before the final page',async()=>{
 let release,calls=0,settled=false;const gate=new Promise(resolve=>{release=resolve;});
 globalThis.geoApi=async()=>{if(++calls===1)return {catalogVersion:'v1',items:[city('first')],nextCursor:'last'};await gate;return {catalogVersion:'v1',items:[city('last')],nextCursor:null};};
 const first=loadCatalog('/concurrent').then(value=>{settled=true;return value;}),second=loadCatalog('/concurrent');
 await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(settled,false);release();
 assert.deepEqual((await first).map(c=>c.name),['first','last']);assert.equal((await second).length,2);
});
