import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTuningApi } from './tuning-api.js';
import { bundleHash, parseCompleteBundle } from './prompt-bundle.js';
const request = (path: string, token: Record<string, unknown> = { tuningEditor: true }, method = 'GET') =>
  dispatchTuningApi({ method, path, auth: { uid: 'synthetic-tuner', token } });

test('compiled prompt inventory requires an explicit tuning role, including unknown paths', async () => {
  for (const claims of [{}, { admin: true }, { tuningEditor: 'true' }, { tuningPublisher: 1 }]) {
    await assert.rejects(request('/v1/tuning/prompts', claims), { code: 'permission-denied' });
    await assert.rejects(request('/v1/tuning/prompts/free', claims), { code: 'permission-denied' });
  }
  await assert.rejects(dispatchTuningApi({ method: 'GET', path: '/v1/tuning/prompts', auth: { uid: '', token: { tuningEditor: true } } }), { code: 'unauthenticated' });
});

test('inventory identifies compiled defaults and immutable complete snapshots for each tier', async () => {
  const inventory = (await request('/v1/tuning/prompts')).body as any;
  assert.equal(inventory.source, 'compiled-default');
  assert.deepEqual(inventory.items.map((item: any) => item.id), ['free', 'go', 'pro']);
  for (const item of inventory.items) {
    const detail = (await request(`/v1/tuning/prompts/${item.id}`, { tuningPublisher: true })).body as any;
    assert.equal(detail.source, 'compiled-default');
    assert.equal(detail.bundleHash, item.bundleHash);
    assert.equal(detail.bundleHash, bundleHash(parseCompleteBundle(detail.bundle)));
    detail.bundle.systemPrompt = 'client mutation';
    const reread = (await request(`/v1/tuning/prompts/${item.id}`)).body as any;
    assert.notEqual(reread.bundle.systemPrompt, 'client mutation');
    assert.equal(reread.bundleHash, item.bundleHash);
  }
  assert(!JSON.stringify(inventory).includes('systemPrompt'));
});

test('read-only API rejects mutations and identifiers outside the compiled inventory', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE'])
    await assert.rejects(request('/v1/tuning/prompts/free', undefined, method), { code: 'not-found' });
  for (const path of ['/v1/tuning/prompts/../private', '/v1/tuning/prompts/unknown', '/v1/tuning/releases', '/v1/tuning/evaluations'])
    await assert.rejects(request(path), { code: 'not-found' });
});
