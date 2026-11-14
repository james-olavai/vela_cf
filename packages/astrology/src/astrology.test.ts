import test from 'node:test';
import assert from 'node:assert/strict';
import { natalWheel, transitEvents, baziPillars, ziweiPalaces } from './index.ts';

const SAMPLE_TORONTO = {
  birthDateTime: '1994-06-03T08:20',
  latitude: 43.6532,
  longitude: -79.3832,
  timezone: 'America/Toronto',
};

test('natalWheel computes valid Placidus chart and Sun in Gemini', () => {
  const chart = natalWheel(SAMPLE_TORONTO);
  assert.equal(chart.houseSystem, 'Placidus');
  assert.equal(chart.houses.length, 12);
  assert.equal(chart.planets.length, 12);
  const sun = chart.planets.find((p) => p.key === 'Sun');
  assert.ok(sun);
  assert.equal(sun.signZh, '双子');
});

test('transitEvents returns chronological transit events', () => {
  const res = transitEvents({ ...SAMPLE_TORONTO, windowMonths: 3, startDate: '2026-01-01' });
  assert.equal(res.windowMonths, 3);
  assert.ok(Array.isArray(res.events));
});

test('baziPillars computes four pillars with True Solar Time', () => {
  const bazi = baziPillars({ ...SAMPLE_TORONTO, yearBoundary: 'lichun', gender: 'female' });
  assert.equal(bazi.pillars.length, 4);
  assert.equal(bazi.method, 'vela-eastern-lat-v1');
  assert.ok(bazi.dayMaster.length > 0);
});

test('ziweiPalaces computes 12 palaces with iztro', () => {
  const zw = ziweiPalaces({ ...SAMPLE_TORONTO, gender: 'female' });
  assert.equal(zw.palaces.length, 12);
  assert.ok(zw.fiveElementsClass.length > 0);
});
