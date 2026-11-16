import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Firestore } from 'firebase-admin/firestore';
import { LOCATION_CATALOG_VERSION, locations, LocationSchema, listLocationCatalog, matchLocations, resolveProfileLocation, searchLocations } from './locations.js';
function database() {
  const store=new Map<string,any>();
  const doc=(key:string)=>({get:async()=>({data:()=>store.get(key)}),set:async(value:any)=>{store.set(key,value);},create:async(value:any)=>{if(store.has(key))throw Object.assign(new Error('exists'),{code:6});store.set(key,value);}});
  return {store,db:{collection:()=>({doc})} as unknown as Firestore};
}
const input=(city=locations.find(v=>v.id==='geonames-1816670')!)=>({name:'Synthetic',entityType:'person',gender:'unset',birthDateTime:'1994-06-03T08:20',locationName:city.displayName,latitude:city.latitude,longitude:city.longitude,timezone:city.timezone,locationRef:{id:city.id,version:city.version}});
const provider={id:2158177,name:'Melbourne',admin1:'Victoria',country:'Australia',country_code:'AU',latitude:-37.8136,longitude:144.9631,timezone:'Australia/Melbourne'};
const fetcher=(items:any[])=>async()=>Response.json({results:items});

test('published catalog is schema-valid, uniquely versioned and attributed to verified GeoNames extract',()=>{
  assert.equal(locations.length,2124); assert.equal(new Set(locations.map(v=>v.id)).size,locations.length);
  const manifest=JSON.parse(readFileSync(new URL('../data/locations-source.json',import.meta.url),'utf8'));
  assert.equal(manifest.license,'CC-BY-4.0'); assert.equal(manifest.catalogVersion,LOCATION_CATALOG_VERSION);assert.match(manifest.sourceSha256,/^[a-f0-9]{64}$/);
  for(const item of locations){LocationSchema.parse(item);const {version,...record}=item;assert.equal(version,createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0,16));}
});

test('catalog pagination requires a fixed version and never crosses catalog versions',()=>{
  const first=listLocationCatalog({limit:'500'});assert.equal(first.items.length,500);
  const second=listLocationCatalog({version:first.catalogVersion,cursor:first.nextCursor!,limit:'500'});assert.equal(second.items[0].id,locations[500].id);
  assert.throws(()=>listLocationCatalog({cursor:'500'}),/CATALOG_VERSION_REQUIRED/);
  assert.throws(()=>listLocationCatalog({version:'stale',cursor:'500'}),/LOCATION_CATALOG_VERSION_UNAVAILABLE/);
  assert.throws(()=>listLocationCatalog({version:LOCATION_CATALOG_VERSION,cursor:'99999999999999999'}),/INVALID_CURSOR/);
  assert.throws(()=>listLocationCatalog({limit:'501'}));
});

test('builtins match Chinese, English/pinyin and preserve disambiguating administrative labels without external calls',async()=>{
  const {db,store}=database();const noFetch=(async()=>{throw new Error('Unexpected network');}) as typeof fetch;
  for(const q of ['北京','beijing',' BEIJING ','上海']){
    const found=await searchLocations(db,{query:q},noFetch);assert(found.results.length>0);assert(found.results.length<=8);assert(found.results.every(v=>v.displayName.includes('，')));
  }
  assert.equal(matchLocations('Beijing')[0].id,'geonames-1816670');assert.equal(store.size,0);
  assert.deepEqual(await searchLocations(db,{query:'no-such-place',source:'builtin'},noFetch),{results:[]});
});

test('external lookup validates timezone/country, distinguishes outages, persists immutable references and caches',async()=>{
  const {db,store}=database();let calls=0;
  const request=(async(url:any)=>{calls++;assert(String(url).startsWith('https://geocoding-api.open-meteo.com/v1/search?'));return Response.json({results:[provider,{...provider,id:9,timezone:undefined},{...provider,id:10,country_code:undefined}]});}) as typeof fetch;
  const response=await searchLocations(db,{query:'Melbourne',source:'external'},request);assert.equal(response.results.length,1);assert.equal(response.results[0].countryCode,'AU');
  const record=response.results[0];assert.deepEqual(store.get(`${record.id}-${record.version}`),record);
  assert.deepEqual(await searchLocations(db,{query:'Melbourne',source:'external'},request),response);assert.equal(calls,1);
  await assert.rejects(searchLocations(db,{query:'unknown',source:'external'},(async()=>new Response(null,{status:503})) as typeof fetch),/LOCATION_PROVIDER_UNAVAILABLE/);
  assert.deepEqual(await searchLocations(db,{query:'none',source:'external'},fetcher([]) as typeof fetch),{results:[]});
  assert.deepEqual(await searchLocations(db,{query:'empty',source:'external'},fetcher([{...provider,timezone:'invalid/zone'}]) as typeof fetch),{results:[]});
  store.delete([...store.keys()].find(v=>v.startsWith('query-'))!);
  assert.deepEqual(await searchLocations(db,{query:'Melbourne',source:'external'},request),response);assert.equal(calls,2);
});

test('trusted profile location rejects coordinate conflicts, strips forged metadata, and clears stale country on edits',async()=>{
  const {db}=database(),raw=input();
  const valid=await resolveProfileLocation(db,{...raw,countryCode:'US',locationSource:'external'});
  assert.equal(valid.countryCode,'CN');assert.equal(valid.locationSource,'builtin');
  const {locationName,...direct}=raw;assert.equal((await resolveProfileLocation(db,direct)).locationName,locationName);
  await assert.rejects(resolveProfileLocation(db,{...raw,latitude:0}),/LOCATION_REFERENCE_MISMATCH/);
  await assert.rejects(resolveProfileLocation(db,{...raw,locationRef:{id:raw.locationRef.id,version:'bad'}}),/LOCATION_REFERENCE_UNAVAILABLE/);
  const renamed=await resolveProfileLocation(db,{name:'Renamed'},valid);assert.equal(renamed.countryCode,'CN');
  const changed=await resolveProfileLocation(db,{locationName:'Unknown'},valid);assert.equal(changed.countryCode,undefined);assert.equal(changed.locationSource,undefined);assert.equal(changed.locationRef,undefined);
  const {locationRef,...legacy}=raw;
  assert.equal((await resolveProfileLocation(db,{...legacy,countryCode:'US',locationSource:'external'})).countryCode,undefined);
});

test('saved external profiles retain verified snapshots after cache loss but new references fail',async()=>{
  const {db,store}=database();const result=await searchLocations(db,{query:'Melbourne',source:'external'},fetcher([provider]) as typeof fetch);
  const raw=input(result.results[0]),saved=await resolveProfileLocation(db,raw);assert.equal(saved.countryCode,'AU');store.clear();
  assert.equal((await resolveProfileLocation(db,{name:'Edited'},saved)).countryCode,'AU');
  assert.equal((await resolveProfileLocation(db,raw,saved)).countryCode,'AU');
  await assert.rejects(resolveProfileLocation(db,raw),/LOCATION_REFERENCE_UNAVAILABLE/);
});
