import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as astro from '../../../packages/astrology/src/index.ts';
const load = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const catalog = load('catalog.json');
const fixed = load('fixed-results.json');

test('built-in cases resolve profiles and pin time, retaining distinct timezone/hemisphere paths', () => {
  const ids = new Set(catalog.profiles.map((p) => p.id));
  assert.equal(ids.size, catalog.profiles.length);
  assert.ok(catalog.profiles.some((p) => p.latitude < 0));
  assert.ok(catalog.profiles.some((p) => p.longitude < 0));
  assert.ok(catalog.profiles.some((p) => p.timezone === 'America/New_York'));
  for (const c of catalog.cases) {
    assert.ok(c.profileIds.every((id) => ids.has(id)), c.id);
    assert.equal(c.referenceTime, '2026-07-15T12:00:00Z');
    assert.equal(c.mode === 'synastry', c.profileIds.length > 1);
    assert.ok(c.criteria.length > 0);
  }
});

test('fixed tool results still match their exact input and current engine', () => {
  for (const entry of fixed.entries) {
    assert.deepEqual(astro[entry.toolName](entry.input), entry.output, entry.id);
  }
});

test('relocation preserves natal time and planetary longitudes while changing houses', () => {
  const natal = fixed.entries.find((e) => e.id === 'natal-a');
  const moved = fixed.entries.find((e) => e.id === 'relocation-a-london');
  assert.equal(moved.input.birthDateTime, natal.input.birthDateTime);
  assert.equal(moved.input.timezone, natal.input.timezone);
  for (const point of natal.output.planets) {
    assert.equal(moved.output.planets.find((p) => p.key === point.key).longitude, point.longitude);
  }
  assert.notDeepEqual(moved.output.houses, natal.output.houses);
  assert.equal(fixed.entries.find((e) => e.id === 'synastry-ab').output.chartCount, 2);
});
