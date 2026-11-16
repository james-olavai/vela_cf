import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openApi, checkCompatibility } from './api-contract.mjs';
import { businessRoutes } from '../apps/api/src/business-api.ts';
import { tuningRoutes } from '../apps/api/src/tuning-api.ts';
import { actionRoutes } from '../apps/api/src/action-api.ts';
import { countryRoutes } from '../apps/api/src/country-charts.ts';
import { chatRoutes } from '../apps/api/src/chat-http.ts';
import { apiClient } from './ci/api-smoke.mjs';

test('OpenAPI exports actual route schemas and flags breaking operation changes', () => {
  const spec = openApi([...businessRoutes, ...tuningRoutes, ...actionRoutes, ...chatRoutes, ...countryRoutes]);
  assert.equal(Object.values(spec.paths).reduce((n, methods) => n + Object.keys(methods).length, 0), businessRoutes.length + tuningRoutes.length + actionRoutes.length + chatRoutes.length + countryRoutes.length);
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
  assert(spec.paths['/v1/locations/catalog'].get.responses['304']);
  assert(spec.paths['/v1/country-charts'].get.parameters.some(p=>p.name==='If-None-Match'));
  assert(!spec.paths['/v1/profiles/{id}/country-chart'].get.responses['304']);
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

test('Compatibility admits optional metadata and request alternatives but rejects authorization and validation regressions', async () => {
  const { schemaCompatible } = await import('./api-contract.mjs');
  const object = {type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false};
  const extended = {...object,properties:{...object.properties,locationRef:{type:'string'}}};
  assert(schemaCompatible(object,extended,true)); assert(schemaCompatible(object,extended,false));
  assert(!schemaCompatible(object,{...extended,required:['name','locationRef']},true));
  assert(!schemaCompatible(object,{...extended,required:[]},false));
  assert(!schemaCompatible(object,{...object,additionalProperties:true},true));
  const openObject={type:'object',additionalProperties:{}};
  assert(schemaCompatible(openObject,object,false));
  assert(schemaCompatible({...openObject,propertyNames:{type:'string'}},object,false));
  assert(!schemaCompatible({...openObject,propertyNames:{type:'string',pattern:'^x'}},object,false));
  assert(!schemaCompatible(openObject,object,true));
  assert(!schemaCompatible(object,openObject,false));
  assert(!schemaCompatible({...openObject,minProperties:2},object,false));
  assert(!schemaCompatible({...openObject,additionalProperties:{type:'string'}},object,false));
  assert(!schemaCompatible(openObject,{type:'string'},false));
  const oldUnion={anyOf:[object]}, newUnion={anyOf:[extended,{type:'number'}]};
  assert(schemaCompatible(oldUnion,newUnion,true));assert(!schemaCompatible(oldUnion,newUnion,false));
  assert(!schemaCompatible({oneOf:[object]},{oneOf:[extended,{type:'object'}]},true));
  const spec=openApi(businessRoutes), candidate=structuredClone(spec);
  const create=candidate.paths['/v1/profiles'].post;
  create.requestBody.content['application/json'].schema.properties.optionalExtra={type:'string'};
  assert.deepEqual(checkCompatibility(spec,candidate),[]);
  create.security=[];assert(checkCompatibility(spec,candidate).length);
  const query=structuredClone(spec);query.paths['/v1/profiles'].get.parameters.push({in:'query',name:'source',required:false,schema:{type:'string'}});
  assert.deepEqual(checkCompatibility(spec,query),[]);
  query.paths['/v1/profiles'].get.parameters.at(-1).required=true;assert(checkCompatibility(spec,query).length);
});

test('PAT contract follows the runtime allowlist and keeps token management Firebase-only',async()=>{
  const {PAT_ROUTE_SCOPES,patRoutes}=await import('../apps/api/src/pat.ts');
  const routes=[...businessRoutes,...tuningRoutes,...actionRoutes,...chatRoutes,...countryRoutes,...patRoutes],spec=openApi(routes);
  for(const route of routes){
    const operation=spec.paths[route.path][route.method.toLowerCase()],scopes=PAT_ROUTE_SCOPES[`${route.method} ${route.path}`];
    assert.deepEqual(operation.security,route.public?[]:[{FirebaseIdToken:[]},...(scopes?[{PersonalAccessToken:[]}]:[])]);
    assert.deepEqual(operation['x-pat-scopes'],scopes);
  }
  for(const route of patRoutes){
    assert(!PAT_ROUTE_SCOPES[`${route.method} ${route.path}`]);
    assert.deepEqual(spec.paths[route.path][route.method.toLowerCase()].security,[{FirebaseIdToken:[]}]);
  }
  assert.equal(spec.paths['/v1/me/api-tokens'].post.responses['201'].content['application/json'].schema.properties.secret.type,'string');
  const listing=spec.paths['/v1/me/api-tokens'].get.responses['200'].content['application/json'].schema;
  assert(!JSON.stringify(listing).includes('"secret"'));
  const capabilities=spec.paths['/v1/me/api-token-capabilities'].get;
  assert.deepEqual(capabilities.security,[{FirebaseIdToken:[]}]);
  const capabilitySchema=capabilities.responses['200'].content['application/json'].schema;
  assert.deepEqual(Object.keys(capabilitySchema.properties).sort(),['canCreate','canManage']);
  assert.deepEqual(capabilitySchema.required.sort(),['canCreate','canManage']);
  for(const value of Object.values(capabilitySchema.properties))assert.equal(value.type,'boolean');
  const previous=structuredClone(spec);delete previous.paths['/v1/me/api-token-capabilities'];
  assert.deepEqual(checkCompatibility(previous,spec),[]);
});

test('Compatibility permits only exact allowlisted PAT additions and no other authorization relaxation',async()=>{
  const {PAT_ROUTE_SCOPES,patRoutes}=await import('../apps/api/src/pat.ts');
  const routes=[...businessRoutes,...tuningRoutes,...actionRoutes,...chatRoutes,...countryRoutes,...patRoutes],candidate=openApi(routes),previous=structuredClone(candidate);
  delete previous.components.securitySchemes.PersonalAccessToken;
  for(const methods of Object.values(previous.paths))for(const operation of Object.values(methods)){
    operation.security=operation.security.filter(value=>!('PersonalAccessToken' in value));delete operation['x-pat-scopes'];
  }
  assert.deepEqual(checkCompatibility(previous,candidate),[]);
  const route=routes.find(route=>!route.public && PAT_ROUTE_SCOPES[`${route.method} ${route.path}`]);
  assert(route,'Expected PAT-authenticated route');
  for(const mutate of [
    spec=>{spec.paths[route.path][route.method.toLowerCase()].security=[{PersonalAccessToken:[]}];},
    spec=>{spec.paths[route.path][route.method.toLowerCase()].security.push({});},
    spec=>{spec.paths[route.path][route.method.toLowerCase()]['x-pat-scopes']=['admin:*'];},
    spec=>{delete spec.paths[route.path][route.method.toLowerCase()]['x-pat-scopes'];},
    spec=>{spec.paths['/v1/me/api-tokens'].post.security.push({PersonalAccessToken:[]});},
    spec=>{spec.paths['/v1/unlisted-new-route']={get:{...spec.paths['/v1/me/api-tokens'].get,security:[{FirebaseIdToken:[]},{PersonalAccessToken:[]}]}};},
    spec=>{spec.components.securitySchemes.PersonalAccessToken.scheme='basic';},
    spec=>{spec.components.securitySchemes.FirebaseIdToken.bearerFormat='anything';},
    spec=>{spec.components.schemas.ApiError.required=[];},
  ]){const invalid=structuredClone(candidate);mutate(invalid);assert(checkCompatibility(previous,invalid).length,'Authorization regression was accepted');}
  const publicRoute=routes.find(route=>route.public && PAT_ROUTE_SCOPES[`${route.method} ${route.path}`]);
  assert(publicRoute,'Public PAT allowlist route must be documented');
  const invalid=structuredClone(candidate);invalid.paths[publicRoute.path][publicRoute.method.toLowerCase()].security=[{PersonalAccessToken:[]}];
  assert(checkCompatibility(previous,invalid).length,'Public anonymous access was removed');
});
