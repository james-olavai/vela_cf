// Run using the same Node TypeScript resolver as npm test. Refresh only after reviewing engine changes.
import { readFileSync, writeFileSync } from 'node:fs';
import * as astro from '../../../packages/astrology/src/index.ts';
const root = new URL('./', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('catalog.json', root), 'utf8'));
const birth = ({ birthDateTime, latitude, longitude, timezone }) => ({ birthDateTime, latitude, longitude, timezone });
const [a, b, c] = catalog.profiles.map(birth);
const specs = [
  ...[a, b, c].map((input, i) => ({ id: `natal-${'abc'[i]}`, toolName: 'natalWheel', input })),
  { id: 'transit-a', toolName: 'transitEvents', input: { ...a, startDate: '2026-07-15', windowMonths: 6 } },
  { id: 'synastry-ab', toolName: 'synastryAspects', input: { charts: [{ ...a, label: '测试 A · 北京', entityType: 'person' }, { ...b, label: '测试 B · 纽约', entityType: 'person' }] } },
  { id: 'relocation-a-london', toolName: 'relocationChart', input: { ...a, destLatitude: 51.5074, destLongitude: -0.1278 } },
];
const fixed = { schemaVersion: 1, revision: 'current-engine-abc-v1', referenceTime: catalog.provenance.referenceTime, description: 'Current TypeScript engine outputs for reproducible prompt comparison; not an independently verified astronomical golden set.', entries: specs.map((spec) => ({ ...spec, output: astro[spec.toolName](spec.input) })) };
writeFileSync(new URL('fixed-results.json', root), `${JSON.stringify(fixed, null, 2)}\n`);
