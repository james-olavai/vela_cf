import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PAT_ROUTE_SCOPES } from '../apps/api/src/pat.ts';
const patScheme = {type:'http',scheme:'bearer',bearerFormat:'Vela Personal Access Token'};
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
    const cacheable = route.method === 'GET' && route.public && /^\/v1\/(locations\/catalog|country-charts(?:\/\{id\})?)$/.test(route.path);
    if (cacheable) parameters.push({name:'If-None-Match',in:'header',required:false,schema:{type:'string'}});
    const error = { description: 'Rejected request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } };
    const scopes = PAT_ROUTE_SCOPES[`${route.method} ${route.path}`];
    const operation = { operationId: route.operationId, ...(route.description ? { description: route.description } : {}), security: route.public ? [] : [{ FirebaseIdToken: [] }, ...(scopes ? [{PersonalAccessToken:[]}] : [])], ...(scopes ? {'x-pat-scopes':scopes} : {}), ...(parameters.length ? { parameters } : {}), ...(route.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(route.body, 'input') } } } } : {}), responses: { [route.status]: { description: 'Success', content: { [route.stream ? 'text/event-stream' : 'application/json']: { schema: route.stream ? {type:'string',description:'SSE frames; JSON data follows x-event-schema'} : schema(route.response), ...(route.stream ? {'x-event-schema':schema(route.response)} : {}) } } }, '400': error, '401': error, '403': error, '404': error, '409': error, '412': error, '429': error, '500': error, '503': error, '504': error } };
    if (cacheable) {
      const headers = {ETag:{schema:{type:'string'}},'Cache-Control':{schema:{type:'string'}}};
      operation.responses[route.status].headers = headers;
      operation.responses['304'] = {description:'Public catalog unchanged',headers};
    }
    (paths[route.path] ||= {})[route.method.toLowerCase()] = operation;
  }
  return { openapi: '3.1.0', info: { title: 'Vela business API', version: '1.0.0', description: 'Implemented business HTTP APIs including SSE chat and read-only compiled Prompt defaults. Turn status recovery and cancellation are supported; tuning mutations are not implemented.' }, servers: [{ url: server }], paths, components: { securitySchemes: { PersonalAccessToken:patScheme, FirebaseIdToken: { type: 'http', scheme: 'bearer', bearerFormat: 'Firebase ID Token' } }, schemas: { ApiError: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'requestId', 'retryable'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, retryable: { type: 'boolean' } } } } } } } };
}

// Deliberately narrow additive compatibility: preserve old constraints and authorization.
// Accept optional additions, request union alternatives and unconstrained-object output refinement.
export function schemaCompatible(previous, candidate, input = false) {
  if (JSON.stringify(previous) === JSON.stringify(candidate)) return true;
  if (!previous || !candidate || typeof previous !== 'object' || typeof candidate !== 'object' || Array.isArray(previous) || Array.isArray(candidate)) return false;
  // A previously arbitrary JSON object can safely return a documented object shape.
  // This is output-only; never narrow previously accepted request objects.
  if (!input && previous.type === 'object' && candidate.type === 'object'
      && Object.keys(previous).every(key => ['type','additionalProperties','propertyNames'].includes(key))
      && (!previous.propertyNames || JSON.stringify(previous.propertyNames) === '{"type":"string"}')
      && (previous.additionalProperties === true || JSON.stringify(previous.additionalProperties) === '{}')) return true;
  const a = {...previous}, b = {...candidate};
  if (a.properties && b.properties) {
    const oldRequired = new Set(a.required || []), newRequired = new Set(b.required || []);
    if ([...new Set([...oldRequired,...newRequired])].some(key => oldRequired.has(key) !== newRequired.has(key))) return false;
    for (const [key,value] of Object.entries(a.properties)) if (!schemaCompatible(value,b.properties[key],input)) return false;
    for (const key of Object.keys(b.properties)) if (!(key in a.properties) && newRequired.has(key)) return false;
    delete a.properties; delete b.properties; delete a.required; delete b.required;
  }
  for (const key of ['anyOf','oneOf']) if (a[key] && b[key]) {
    const remaining = [...b[key]];
    for (const branch of a[key]) {
      const index = remaining.findIndex(next => schemaCompatible(branch,next,input));
      if (index < 0) return false;
      remaining.splice(index,1);
    }
    // Adding overlapping oneOf alternatives can reject an old valid input.
    if (remaining.length && (!input || key === 'oneOf')) return false;
    delete a[key]; delete b[key];
  }
  if (a.items && b.items) {
    if (!schemaCompatible(a.items,b.items,input)) return false;
    delete a.items; delete b.items;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
function operationCompatible(previous, candidate, routeKey) {
  const a = structuredClone(previous), b = structuredClone(candidate);
  const scopes=PAT_ROUTE_SCOPES[routeKey], equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  // Only the backend's explicit allowlist may add PAT, while preserving Firebase auth.
  if(scopes && !('x-pat-scopes' in a) && equal(b['x-pat-scopes'],scopes)) {
    if(equal(a.security,[{FirebaseIdToken:[]}]) && equal(b.security,[{FirebaseIdToken:[]},{PersonalAccessToken:[]}]))b.security=a.security;
    if(equal(a.security,b.security))delete b['x-pat-scopes'];
  }
  const oldParams = a.parameters || [], newParams = b.parameters || [];
  for (const p of oldParams) {
    const n = newParams.find(v => v.name === p.name && v.in === p.in);
    if (!n || !schemaCompatible(p.schema,n.schema,true) || JSON.stringify({...p,schema:null}) !== JSON.stringify({...n,schema:null})) return false;
  }
  if (newParams.some(p => !oldParams.some(v => v.name === p.name && v.in === p.in) && p.required)) return false;
  delete a.parameters; delete b.parameters;
  function checkContent(oldContent,newContent,input) {
    for (const [mime,content] of Object.entries(oldContent || {})) {
      const next = newContent?.[mime];
      if (!next) return false;
      for (const key of ['schema','x-event-schema']) if (content[key]) {
        if (!schemaCompatible(content[key],next[key],input)) return false;
        delete content[key]; delete next[key];
      }
    }
    return JSON.stringify(oldContent) === JSON.stringify(newContent);
  }
  if (a.requestBody && b.requestBody && !checkContent(a.requestBody.content,b.requestBody.content,true)) return false;
  for (const [code,response] of Object.entries(a.responses || {})) {
    if (!b.responses?.[code] || !checkContent(response.content,b.responses[code].content,false)) return false;
  }
  // New status codes need explicit review; only standard public-cache 304 is additive here.
  for (const code of Object.keys(b.responses || {})) if (!(code in (a.responses || {}))) {
    if (code !== '304' || b.responses[code].content) return false;
    delete b.responses[code];
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
export function checkCompatibility(previous, candidate) {
  const changes = [];
  for(const [path,methods] of Object.entries(candidate.paths))for(const [method,operation] of Object.entries(methods)){
    const scopes=PAT_ROUTE_SCOPES[`${method.toUpperCase()} ${path}`],hasPat=operation.security?.some(value=>'PersonalAccessToken' in value);
    if((hasPat && (!scopes || JSON.stringify(operation.security)!==JSON.stringify([{FirebaseIdToken:[]},{PersonalAccessToken:[]}]))) || ('x-pat-scopes' in operation && JSON.stringify(operation['x-pat-scopes'])!==JSON.stringify(scopes)))changes.push(`Invalid PAT authorization ${method.toUpperCase()} ${path}`);
  }
  for (const [path, methods] of Object.entries(previous.paths)) for (const [method, operation] of Object.entries(methods)) {
    const next = candidate.paths[path]?.[method];
    if (!next) changes.push(`Removed ${method.toUpperCase()} ${path}`);
    else if (!operationCompatible(operation,next,`${method.toUpperCase()} ${path}`)) changes.push(`Changed ${method.toUpperCase()} ${path}`);
  }
  const oldComponents=structuredClone(previous.components),newComponents=structuredClone(candidate.components);
  if(!oldComponents?.securitySchemes?.PersonalAccessToken && JSON.stringify(newComponents?.securitySchemes?.PersonalAccessToken)===JSON.stringify(patScheme))delete newComponents.securitySchemes.PersonalAccessToken;
  if (JSON.stringify(oldComponents) !== JSON.stringify(newComponents)) changes.push('Changed shared components');
  return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { businessRoutes } = await import('../apps/api/src/business-api.ts');
  const { tuningRoutes } = await import('../apps/api/src/tuning-api.ts');
  const { actionRoutes } = await import('../apps/api/src/action-api.ts');
  const { countryRoutes } = await import('../apps/api/src/country-charts.ts');
  const { chatRoutes } = await import('../apps/api/src/chat-http.ts');
  const { patRoutes } = await import('../apps/api/src/pat.ts');
  const text = JSON.stringify(openApi([...businessRoutes, ...tuningRoutes, ...actionRoutes, ...chatRoutes, ...countryRoutes, ...patRoutes]), null, 2) + '\n';
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
