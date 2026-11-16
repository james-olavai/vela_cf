import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openApi, checkCompatibility } from './api-contract.mjs';
import { businessRoutes } from '../apps/api/src/business-api.ts';
import { tuningRoutes } from '../apps/api/src/tuning-api.ts';
import { actionRoutes } from '../apps/api/src/action-api.ts';
import { chatRoutes } from '../apps/api/src/chat-http.ts';
import { apiClient } from './ci/api-smoke.mjs';

test('OpenAPI exports actual route schemas and flags breaking operation changes', () => {
  const spec = openApi([...businessRoutes, ...tuningRoutes, ...actionRoutes, ...chatRoutes]);
  assert.equal(Object.values(spec.paths).reduce((n, methods) => n + Object.keys(methods).length, 0), businessRoutes.length + tuningRoutes.length + actionRoutes.length + chatRoutes.length);
  const profile = spec.paths['/v1/profiles'].post.requestBody.content['application/json'].schema;
  assert(profile.required.includes('birthDateTime')); assert.equal(profile.additionalProperties, false);
  assert.equal(spec.paths['/v1/profiles'].get.parameters.find(p => p.name === 'limit').schema.type, 'string');
  const turn=spec.paths['/v1/sessions/{id}/turns'].post;
  assert.equal(turn.parameters.find(p=>p.name==='Idempotency-Key').in,'header');
  assert.equal(turn.parameters.find(p=>p.name==='Idempotency-Key').required,false);
  const portrait=spec.paths['/v1/charts/natal'].post.responses['200'].content['application/json'].schema;
  assert(portrait.required.includes('portrait'));
  assert(portrait.properties.portrait.required.includes('dominantPlanets'));
  assert(!spec.paths['/v1/tuning/evaluations']);
  assert.equal(spec.paths['/v1/tuning/prompts/{id}'].get.responses['200'].content['application/json'].schema.properties.source.const, 'compiled-default');
  assert.deepEqual(checkCompatibility(spec, structuredClone(spec)), []);
  const removed = structuredClone(spec); delete removed.paths['/v1/profiles'].post;
  assert(checkCompatibility(spec, removed).some(x => x.includes('Removed POST')));
  const changed = structuredClone(spec); changed.paths['/v1/profiles'].post.requestBody.required = false;
  assert(checkCompatibility(spec, changed).some(x => x.includes('Changed POST')));
  const added = structuredClone(spec); added.paths['/v1/new'] = { get: structuredClone(spec.paths['/v1/me'].get) };
  assert.deepEqual(checkCompatibility(spec, added), []);
});

test('User API client sends token only in headers, supports function base path, and refuses cross-origin paths', async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ url: req.url, authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    let refreshes = 0;
    const client = apiClient(`http://127.0.0.1:${server.address().port}/businessApi`, async () => `token-${++refreshes}`);
    assert.equal((await client('POST', '/v1/profiles', { name: 'Synthetic' })).status, 200);
    assert.equal(received[0].url, '/businessApi/v1/profiles'); assert.equal(received[0].authorization, 'Bearer token-1'); assert(!received[0].body.includes('token-'));
    await client('GET', '/v1/me'); assert.equal(received[1].authorization, 'Bearer token-2');
    await assert.rejects(() => client('GET', 'https://evil.example/v1/me'));
    await assert.rejects(() => client('GET', '/v1/../secrets'));
    await assert.rejects(() => client('GET', '/v1/%2e%2e/secrets'));
    assert.throws(() => apiClient('http://example.com', 'token'));
    assert.throws(() => apiClient('https://user:secret@example.com', 'token'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('read preparation allows only optional response metadata without weakening request contracts',()=>{
  const spec=openApi(businessRoutes), add=structuredClone(spec), path='/v1/profiles/{id}';
  add.paths[path].get.responses['200'].content['application/json'].schema.properties.futureReadMetadata={type:'string'};
  assert.deepEqual(checkCompatibility(spec,add),[]);
  const required=structuredClone(add);required.paths[path].get.responses['200'].content['application/json'].schema.required.push('futureReadMetadata');assert(checkCompatibility(spec,required).length>0);
  const changed=structuredClone(spec);changed.paths[path].get.responses['200'].content['application/json'].schema.properties.name={type:'number'};assert(checkCompatibility(spec,changed).length>0);
  const writable=structuredClone(spec);writable.paths['/v1/profiles'].post.requestBody.content['application/json'].schema.properties.locationRef={type:'object'};assert(checkCompatibility(spec,writable).length>0);
});
