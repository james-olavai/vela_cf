import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LocationSchema } from '../apps/api/src/locations.ts';
import { CountryChartSchema } from '../apps/api/src/country-charts.ts';
import { validateBirthTime } from '../apps/api/src/subjects.ts';

const files={locations:'locations.json',countries:'country-charts.json',locationSource:'locations-source.json',countrySource:'country-charts-source.json'};
const canonical=value=>JSON.stringify(value,(_key,v)=>v && typeof v==='object' && !Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const key=item=>`${item.id}:${item.version}`;
const https=url=>{assert.equal(new URL(url).protocol,'https:','Catalog sources require HTTPS');};
const nonempty=value=>assert(typeof value==='string' && value.trim().length>0,'Missing source metadata');
function immutable(previous,current,field,retain) {
  if(!previous)return;
  if(previous.catalogVersion===current.catalogVersion)assert.equal(canonical(current),canonical(previous),'Catalog content changed without a new catalogVersion');
  const next=new Map(current[field].map(item=>[key(item),item]));
  for(const old of previous[field]) {
    if(next.has(key(old)))assert.equal(canonical(next.get(key(old))),canonical(old),`Published ID/version mutated: ${key(old)}`);
    else if(retain)assert.fail(`Published country event removed: ${key(old)}; retain immutable history`);
  }
}
export function validateCatalogs(data,baseline={}) {
  const {locations,countries,locationSource,countrySource,countryAttribution}=data;
  for(const [catalog,rows,source] of [[locations,locations.records,locationSource],[countries,countries.items,countrySource]]) {
    assert.match(catalog.catalogVersion,/^[A-Za-z0-9_-]{1,128}$/);assert(rows.length>0,'Empty catalog');
    assert.equal(new Set(rows.map(key)).size,rows.length,'Duplicate catalog ID/version');
    assert.equal(source.catalogVersion,catalog.catalogVersion,'Source version mismatch');assert.equal(source.recordCount,rows.length,'Source count mismatch');
    for(const field of ['provider','license','retrievedAt'])nonempty(source[field]);
    assert.match(source.retrievedAt,/^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(locationSource.license,'CC-BY-4.0');
  for(const field of ['sourceUrl','licenseUrl','attributionUrl','adminSourceUrl'])https(locationSource[field]);
  for(const field of ['sourceSha256','adminSourceSha256'])assert.match(locationSource[field],/^[a-f0-9]{64}$/);
  assert.equal(new Set(locations.records.map(row=>row.id)).size,locations.records.length,'Current location IDs must be unique');
  for(const row of locations.records) {
    LocationSchema.strict().parse(row);assert.equal(row.source,'builtin');
    const aliases=row.aliases.map(alias=>alias.normalize('NFKC').trim().toLowerCase());
    assert(aliases.every(Boolean));assert.equal(new Set(aliases).size,aliases.length,`Duplicate aliases: ${row.id}`);
  }
  assert(countrySource.sourceUrls.length>0);countrySource.sourceUrls.forEach(https);
  nonempty(countrySource.attributionFile);nonempty(countryAttribution);
  for(const row of countries.items) {
    CountryChartSchema.strict().parse({...row,isDefault:false,contentHash:'validation',usable:false});
    assert.match(row.localDate,/^\d{4}-\d{2}-\d{2}$/);assert.equal(new Date(`${row.localDate}T00:00:00Z`).toISOString().slice(0,10),row.localDate,'Invalid event date');
    new Intl.DateTimeFormat('en',{timeZone:row.timezone});
    assert(row.latitude>=-90 && row.latitude<=90 && row.longitude>=-180 && row.longitude<=180,'Invalid event coordinates');
    assert(row.sourceReferences.length>0);row.sourceReferences.forEach(url=>{https(url);assert(countrySource.sourceUrls.includes(url),'Unattributed event source');assert(countryAttribution.includes(url),'Missing human-readable source attribution');});
    nonempty(row.sourceNote);
    if(row.timeReliability==='verified') {assert.match(row.localTime,/^\d{2}:\d{2}$/);validateBirthTime(`${row.localDate}T${row.localTime}`,row.timezone);}
    else if(row.localTime!==null)assert.match(row.localTime,/^\d{2}:\d{2}$/);
  }
  for(const [code,choice] of Object.entries(countries.defaults)) {
    assert.match(code,/^[A-Z]{2}$/);
    const selected=countries.items.find(row=>row.id===choice.id && row.version===choice.version);
    assert(selected && selected.countryCode===code && selected.timeReliability==='verified' && selected.localTime,'Default must reference a usable published event');
  }
  for(const [region,country] of Object.entries(countries.countryMappings)) {assert.match(region,/^[A-Z]{2}$/);assert.match(country,/^[A-Z]{2}$/);assert(countries.items.some(row=>row.countryCode===country),'Mapping targets no published event');}
  immutable(baseline.locations,locations,'records',false); // Old profiles retain validated location snapshots; absent catalog versions explicitly expire.
  immutable(baseline.countries,countries,'items',true);
  for(const [catalogName,sourceName] of [['locations','locationSource'],['countries','countrySource']])if(baseline[catalogName]?.catalogVersion===data[catalogName].catalogVersion && baseline[sourceName])assert.equal(canonical(baseline[sourceName]),canonical(data[sourceName]),'Source manifest changed without a catalog version');
  return {locations:locations.records.length,countryCharts:countries.items.length};
}
export function readCatalogs() {
  return {...Object.fromEntries(Object.entries(files).map(([key,file])=>[key,JSON.parse(readFileSync(new URL(`../apps/api/data/${file}`,import.meta.url),'utf8'))])),countryAttribution:readFileSync(new URL('../apps/api/data/country-charts.sources.md',import.meta.url),'utf8')};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const flag=process.argv.slice(2).find(value=>value.startsWith('--baseline=')),baseline={};
  assert(process.argv.slice(2).every(value=>value===flag),'Unknown catalog-check argument');
  if(flag) {
    const revision=flag.slice('--baseline='.length);assert(/^[a-f0-9]{7,40}$/.test(revision),'Baseline must be a commit SHA');
    execFileSync('git',['rev-parse','--verify',`${revision}^{commit}`],{stdio:'pipe'});
    for(const [key,file] of Object.entries(files)) {
      const path=`${revision}:apps/api/data/${file}`;
      try {execFileSync('git',['cat-file','-e',path],{stdio:'pipe'});}catch{continue;}
      baseline[key]=JSON.parse(execFileSync('git',['show',path],{encoding:'utf8'}));
    }
  }
  console.log('Catalog validation passed',validateCatalogs(readCatalogs(),baseline));
}
