import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { toJSONSchema } = require('zod');
const { toJsonSchema } = require('genkit/schema');

export function openApi(routes, server = 'http://127.0.0.1:5001/demo-vela-ci/asia-southeast1/businessApi') {
  const paths = {}, ids = new Set();
  const schema = (value, io = 'output') => { const out = value._zod ? toJSONSchema(value, { target: 'draft-2020-12', io }) : toJsonSchema({ schema: value }); delete out.$schema; return out; };
  for (const route of routes) {
    if (ids.has(route.operationId)) throw new Error(`Duplicate operationId ${route.operationId}`);
    ids.add(route.operationId);
    const pathSchema = route.params ? schema(route.params, 'input') : undefined;
    const parameters = [...route.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: pathSchema?.properties?.[name] || { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' } }));
    if (route.query) {
      const query = schema(route.query, 'input');
      for (const [name, value] of Object.entries(query.properties || {})) parameters.push({ name, in: 'query', required: query.required?.includes(name) || false, schema: value });
    }
    for (const [name, value] of Object.entries(route.headers || {})) parameters.push({name,in:'header',required:!value.isOptional(),schema:schema(value,'input')});
    const error = { description: 'Rejected request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } };
    const operation = { operationId: route.operationId, ...(route.description ? { description: route.description } : {}), security: route.public ? [] : [{ FirebaseIdToken: [] }], ...(parameters.length ? { parameters } : {}), ...(route.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(route.body, 'input') } } } } : {}), responses: { [route.status]: { description: 'Success', content: { [route.stream ? 'text/event-stream' : 'application/json']: { schema: route.stream ? {type:'string',description:'SSE frames; JSON data follows x-event-schema'} : schema(route.response), ...(route.stream ? {'x-event-schema':schema(route.response)} : {}) } } }, '400': error, '401': error, '403': error, '404': error, '409': error, '412': error, '429': error, '500': error, '503': error, '504': error } };
    (paths[route.path] ||= {})[route.method.toLowerCase()] = operation;
  }
  return { openapi: '3.1.0', info: { title: 'Vela business API', version: '1.0.0', description: 'Implemented business HTTP APIs including SSE chat and read-only compiled Prompt defaults. Turn status recovery and cancellation are supported; tuning mutations are not implemented.' }, servers: [{ url: server }], paths, components: { securitySchemes: { FirebaseIdToken: { type: 'http', scheme: 'bearer', bearerFormat: 'Firebase ID Token' } }, schemas: { ApiError: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'requestId', 'retryable'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, retryable: { type: 'boolean' } } } } } } } };
}

// Conservative compatibility gate: an existing operation must retain its complete contract.
// New paths/methods are allowed. Intentional changes need reviewed API versioning, not auto-baselining.
export function checkCompatibility(previous, candidate) {
  const changes = [];
  for (const [path, methods] of Object.entries(previous.paths)) for (const [method, operation] of Object.entries(methods)) {
    const next = candidate.paths[path]?.[method];
    if (!next) changes.push(`Removed ${method.toUpperCase()} ${path}`);
    else if (JSON.stringify(operation) !== JSON.stringify(next)) changes.push(`Changed ${method.toUpperCase()} ${path}`);
  }
  if (JSON.stringify(previous.components) !== JSON.stringify(candidate.components)) changes.push('Changed shared components');
  return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { businessRoutes } = await import('../apps/api/src/business-api.ts');
  const { tuningRoutes } = await import('../apps/api/src/tuning-api.ts');
  const { actionRoutes } = await import('../apps/api/src/action-api.ts');
  const { chatRoutes } = await import('../apps/api/src/chat-http.ts');
  const text = JSON.stringify(openApi([...businessRoutes, ...tuningRoutes, ...actionRoutes, ...chatRoutes]), null, 2) + '\n';
  const args = process.argv.slice(2), file = args.find(x => !x.startsWith('--')) || 'artifacts/openapi.json';
  if (args.includes('--check')) {
    if (readFileSync(file, 'utf8') !== text) throw new Error('OpenAPI artifact drift');
  } else { mkdirSync(new URL('.', pathToFileURL(file)).pathname, { recursive: true }); writeFileSync(file, text); }
  const baseline = args.find(x => x.startsWith('--baseline='))?.slice('--baseline='.length);
  if (baseline) {
    const changes = checkCompatibility(JSON.parse(readFileSync(baseline, 'utf8')), JSON.parse(text));
    if (changes.length) throw new Error(`Contract compatibility review required: ${changes.join('; ')}`);
  }
}
