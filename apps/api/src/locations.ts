import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';
import { ResolveLocationRequestSchema, type ProfileInput } from '@vela-cf/shared';
import catalog from '../data/locations.json' with { type: 'json' };

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const LocationSchema = z.object({ id:Id,version:Id,displayName:z.string().min(1),name:z.string().min(1),aliases:z.array(z.string()),admin1:z.string().optional(),countryCode:z.string().regex(/^[A-Z]{2}$/),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),timezone:z.string().refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}}),source:z.enum(['builtin','external']) });
export const LOCATION_CATALOG_VERSION = catalog.catalogVersion;
export const locations = z.array(LocationSchema).parse(catalog.records);
const byId = new Map(locations.map(item=>[item.id,item]));
const Query = z.object({version:Id.optional(),cursor:z.string().regex(/^\d+$/).optional(),limit:z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(500)).optional()}).strict();
export const locationRoutes = [
  {method:'GET',path:'/v1/locations/catalog',operationId:'listLocationCatalog',query:Query,response:z.object({catalogVersion:z.string(),items:z.array(LocationSchema),nextCursor:z.string().nullable()}),status:200,public:true},
  {method:'GET',path:'/v1/locations',operationId:'searchLocations',query:ResolveLocationRequestSchema.strict(),response:z.object({results:z.array(LocationSchema.partial().extend({displayName:z.string(),latitude:z.number(),longitude:z.number(),timezone:z.string()}))}),status:200,public:true},
];
export function listLocationCatalog(raw:unknown) {
  const {version,cursor,limit=200}=Query.parse(raw);
  if(version && version!==LOCATION_CATALOG_VERSION)throw new HttpsError('failed-precondition','LOCATION_CATALOG_VERSION_UNAVAILABLE');
  if(cursor && !version)throw new HttpsError('invalid-argument','CATALOG_VERSION_REQUIRED');
  const offset=Number(cursor||0);
  if(!Number.isSafeInteger(offset)||offset>locations.length)throw new HttpsError('invalid-argument','INVALID_CURSOR');
  return {catalogVersion:LOCATION_CATALOG_VERSION,items:locations.slice(offset,offset+limit),nextCursor:offset+limit<locations.length?String(offset+limit):null};
}
const normalized=(v:string)=>v.normalize('NFKC').trim().toLowerCase();
export function matchLocations(query:string) {
  const q=normalized(query);
  return locations.map(item=>{const names=[item.name,...item.aliases].map(normalized);return {item,rank:names.includes(q)?0:names.some(v=>v.startsWith(q))?1:normalized(item.displayName).includes(q)?2:3};}).filter(v=>v.rank<3).sort((a,b)=>a.rank-b.rank).slice(0,8).map(v=>v.item);
}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,16);
export async function searchLocations(db:Firestore,raw:unknown,request:typeof fetch=fetch) {
  const {query,source='auto'}=ResolveLocationRequestSchema.parse(raw);
  const builtin=source==='external'?[]:matchLocations(query);
  if(source==='builtin'||builtin.length)return {results:builtin};
  const cache=db.collection('locations_cache').doc('query-'+digest(normalized(query)));
  try {const saved=(await cache.get()).data();if(saved && saved.expiresAt>Date.now())return {results:z.array(LocationSchema).parse(saved.results)};}catch{/* Optional query cache. */}
  let results:z.infer<typeof LocationSchema>[]=[];
  try {
    const response=await request(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=zh&format=json`,{signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw new Error('Provider unavailable');
    const data=await response.json() as {results?:Array<Record<string,any>>;error?:boolean};
    if(data.error || (data.results!==undefined && !Array.isArray(data.results)))throw new Error('Invalid provider response');
    for(const v of (data.results||[]).slice(0,8)) {
      const item={id:`external-${v.id}`,displayName:[v.name,v.admin1,v.country].filter(Boolean).join('，'),name:v.name,aliases:[],...(v.admin1?{admin1:v.admin1}:{}),countryCode:v.country_code,latitude:v.latitude,longitude:v.longitude,timezone:v.timezone,source:'external'};
      const parsed=LocationSchema.safeParse({...item,version:digest(item)});
      if(!Number.isSafeInteger(v.id)||!parsed.success)continue;
      const record=parsed.data,ref=db.collection('locations_cache').doc(`${record.id}-${record.version}`);
      try {await ref.create(record);}catch(error){if((error as {code?:number}).code!==6)throw error;const existing=LocationSchema.parse((await ref.get()).data());if(JSON.stringify(existing)!==JSON.stringify(record))throw new Error('Immutable location conflict');}
      results.push(record);
    }
  }catch{if(source==='external')throw new HttpsError('unavailable','LOCATION_PROVIDER_UNAVAILABLE');return {results:[]};}
  await cache.set({results,expiresAt:Date.now()+86400000}).catch(()=>undefined);
  return {results};
}
const fields=['locationName','latitude','longitude','timezone'] as const;
export async function resolveProfileLocation(db:Firestore,input:Record<string,any>,previous?:Record<string,any>):Promise<ProfileInput & {countryCode?:string;locationSource?:'builtin'|'external'}> {
  const {countryCode:_untrustedCountry,locationSource:_untrustedSource,...safe}=input; input=safe;
  const merged={...previous,...input};
  const unchanged=previous && fields.every(key=>input[key]===undefined||input[key]===previous[key]) && (input.locationRef===undefined||JSON.stringify(input.locationRef)===JSON.stringify(previous.locationRef));
  if(unchanged)return merged as ProfileInput;
  const {countryCode:_country,locationSource:_source,locationRef:_ref,...plain}=merged;
  if(!input.locationRef)return plain as ProfileInput;
  const {id,version}=input.locationRef;
  let record=byId.get(id);
  if(id.startsWith('external-')){const parsed=LocationSchema.safeParse((await db.collection('locations_cache').doc(`${id}-${version}`).get()).data());record=parsed.success?parsed.data:undefined;}
  if(!record||record.id!==id||record.version!==version)throw new HttpsError('failed-precondition','LOCATION_REFERENCE_UNAVAILABLE');
  if(fields.some(key=>merged[key]!==undefined && merged[key]!==record![key==='locationName'?'displayName':key]))throw new HttpsError('invalid-argument','LOCATION_REFERENCE_MISMATCH');
  return {...plain as ProfileInput,locationName:record.displayName,latitude:record.latitude,longitude:record.longitude,timezone:record.timezone,locationRef:{id,version},countryCode:record.countryCode,locationSource:record.source};
}
