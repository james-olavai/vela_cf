import test from 'node:test';
import assert from 'node:assert/strict';
import {readCatalogs,validateCatalogs} from './catalog-check.mjs';
const baseline=readCatalogs();
const copy=()=>structuredClone(baseline);
test('real catalog sources, location schemas and historical event times are valid',()=>{
  const result=validateCatalogs(copy());assert(result.locations>=2106);assert.equal(result.countryCharts,1);
});
test('catalog validation rejects invalid zones, duplicate records/aliases, missing licenses and uncertain defaults',()=>{
  for(const corrupt of [
    d=>d.locations.records.push(d.locations.records[0]),
    d=>d.locations.records[0].timezone='Invalid/Zone',
    d=>d.locations.records[0].aliases=['abc','ABC'],
    d=>d.locationSource.license='',
    d=>d.countrySource.sourceUrls=[],
    d=>d.countries.items[0].localTime='25:00',
    d=>d.countries.items[0].localDate='1949-02-30',
    d=>d.countries.items[0].timeReliability='unknown',
    d=>d.countries.defaults.CN.version='missing',
  ]){const data=copy();corrupt(data);assert.throws(()=>validateCatalogs(data));}
});
test('baseline preserves immutable events and versions while permitting a new default under a new catalog',()=>{
  const mutated=copy();mutated.countries.items[0].sourceNote+=' changed';assert.throws(()=>validateCatalogs(mutated,baseline),/catalogVersion/);
  mutated.countries.catalogVersion=mutated.countrySource.catalogVersion='next';assert.throws(()=>validateCatalogs(mutated,baseline),/ID\/version mutated/);
  const next=copy();next.countries.catalogVersion=next.countrySource.catalogVersion='next';
  next.countries.items.push({...next.countries.items[0],version:'2',sourceNote:'New independently versioned event description'});next.countrySource.recordCount++;
  next.countries.defaults.CN.version='2';assert.doesNotThrow(()=>validateCatalogs(next,baseline));
  next.countries.items.shift();next.countrySource.recordCount--;assert.throws(()=>validateCatalogs(next,baseline),/removed/);
  const moved=copy();moved.locations.records[0].latitude+=0.001;moved.locations.catalogVersion=moved.locationSource.catalogVersion='new';
  assert.throws(()=>validateCatalogs(moved,baseline),/ID\/version mutated/);
  moved.locations.records[0].version='new';assert.doesNotThrow(()=>validateCatalogs(moved,baseline));
});
