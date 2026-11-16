import { z } from 'zod';
import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';
import type { BusinessRequest } from './business-api.js';
import catalog from '../data/country-charts.json' with { type: 'json' };

const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const CountryChartSchema = z.object({ id:Id,version:Id,countryCode:z.string().regex(/^[A-Z]{2}$/),name:z.string(),eventName:z.string(),localDate:z.string(),localTime:z.string().nullable(),timezone:z.string(),placeLabel:z.string(),latitude:z.number(),longitude:z.number(),sourceReferences:z.array(z.string().url()),sourceNote:z.string(),timeReliability:z.enum(['verified','approximate','unknown']),isDefault:z.boolean(),contentHash:z.string(),usable:z.boolean(),reason:z.string().optional() });
export const CountrySnapshotSchema = CountryChartSchema.extend({catalogVersion:z.string(),sourceRef:Id.optional(),basis:z.enum(['birth_location','registration_location','explicit']).optional()});
export const countryContentHash=(item:Record<string,unknown>)=>createHash('sha256').update(JSON.stringify(item,Object.keys(item).sort())).digest('hex');
const charts = catalog.items.map(item => CountryChartSchema.parse({...item,isDefault:(catalog.defaults as Record<string,{id:string;version:string}>)[item.countryCode]?.id===item.id && (catalog.defaults as Record<string,{id:string;version:string}>)[item.countryCode]?.version===item.version,contentHash:countryContentHash(item),usable:item.timeReliability==='verified' && Boolean(item.localTime),...(item.timeReliability==='verified' && item.localTime ? {} : {reason:'COUNTRY_CHART_TIME_UNVERIFIED'})}));
export type CountryChart = z.infer<typeof CountryChartSchema>;
export type CountrySnapshot = z.infer<typeof CountrySnapshotSchema>;
const Recommendation = z.object({status:z.enum(['matched','needs_selection','unavailable']),basis:z.enum(['birth_location','registration_location','none']),countryCode:z.string().optional(),chart:CountryChartSchema.optional(),reason:z.string().optional(),catalogVersion:z.string(),profileUpdatedAt:z.string()});
const PageQuery = z.object({countryCode:z.string().regex(/^[A-Z]{2}$/).optional(),version:Id.optional(),cursor:z.string().max(200).optional(),limit:z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).transform(Number).optional()}).strict();
export const countryRoutes = [
  {method:'GET',path:'/v1/country-charts',operationId:'listCountryCharts',public:true,query:PageQuery,response:z.object({catalogVersion:z.string(),items:z.array(CountryChartSchema),nextCursor:z.string().nullable()}),status:200},
  {method:'GET',path:'/v1/country-charts/{id}',operationId:'getCountryChart',public:true,params:z.object({id:Id}),query:z.object({version:Id}).strict(),response:CountryChartSchema,status:200},
  {method:'GET',path:'/v1/profiles/{id}/country-chart',operationId:'recommendCountryChart',params:z.object({id:Id}),response:Recommendation,status:200},
];
export function getCountryChart(id:string,version:string):CountryChart {
  const chart=charts.find(item=>item.id===id && item.version===version);
  if(!chart)throw new HttpsError('not-found','COUNTRY_CHART_NOT_FOUND');
  return chart;
}
export function recommendCountry(profile:Record<string,unknown>):z.infer<typeof Recommendation> {
  const basis=profile.entityType==='company'?'registration_location':profile.entityType==='country'?'none':'birth_location';
  const base={basis,catalogVersion:catalog.catalogVersion,profileUpdatedAt:String(profile.updatedAt||'')} as const;
  if(basis==='none' || !profile.locationRef || !['builtin','external'].includes(String(profile.locationSource)) || typeof profile.countryCode!=='string')return {...base,status:'needs_selection',reason:'LOCATION_COUNTRY_UNKNOWN'};
  const countryCode=profile.countryCode, mapped=(catalog.countryMappings as Record<string,string>)[countryCode];
  if(!mapped)return {...base,countryCode,status:'unavailable',reason:'COUNTRY_CHART_UNAVAILABLE'};
  const candidates=charts.filter(chart=>chart.countryCode===mapped && chart.isDefault);
  if(candidates.length>1)return {...base,countryCode,status:'needs_selection',reason:'COUNTRY_MAPPING_AMBIGUOUS'};
  const chart=candidates[0];
  if(!chart)return {...base,countryCode,status:'unavailable',reason:'COUNTRY_CHART_UNAVAILABLE'};
  return chart.usable?{...base,countryCode,chart,status:'matched'}:{...base,countryCode,status:'unavailable',reason:'COUNTRY_CHART_TIME_UNVERIFIED'};
}
export function countrySnapshot(chart:CountryChart, source?:{sourceRef:string;basis:'birth_location'|'registration_location'}):CountrySnapshot {
  if(!chart.usable)throw new HttpsError('failed-precondition','COUNTRY_CHART_TIME_UNVERIFIED');
  return {...chart,catalogVersion:catalog.catalogVersion,...(source||{basis:'explicit' as const})};
}
export async function dispatchCountryApi(db:Firestore,input:BusinessRequest) {
  if(input.method!=='GET')throw new HttpsError('not-found','ROUTE_NOT_FOUND');
  if(input.path==='/v1/country-charts') {
    const query=PageQuery.parse(input.query||{});
    if(query.version && query.version!==catalog.catalogVersion)throw new HttpsError('failed-precondition','CATALOG_VERSION_UNAVAILABLE');
    const items=charts.filter(chart=>!query.countryCode || chart.countryCode===query.countryCode), prefix=`${catalog.catalogVersion}:${query.countryCode||'all'}:`;
    const offset=query.cursor?.startsWith(prefix)?Number(query.cursor.slice(prefix.length)):0;
    if(query.cursor && (!query.version || !query.cursor.startsWith(prefix) || !Number.isSafeInteger(offset) || offset<0 || offset>=items.length))throw new HttpsError('invalid-argument','INVALID_CURSOR');
    const limit=query.limit||50, page=items.slice(offset,offset+limit);
    return {status:200,body:{catalogVersion:catalog.catalogVersion,items:page,nextCursor:offset+limit<items.length?`${prefix}${offset+limit}`:null}};
  }
  const detail=/^\/v1\/country-charts\/([\w-]+)$/.exec(input.path);
  if(detail)return {status:200,body:getCountryChart(Id.parse(detail[1]),z.object({version:Id}).strict().parse(input.query||{}).version)};
  const profile=/^\/v1\/profiles\/([\w-]+)\/country-chart$/.exec(input.path);
  if(!profile)throw new HttpsError('not-found','ROUTE_NOT_FOUND');
  if(!input.auth?.uid)throw new HttpsError('unauthenticated','AUTH_REQUIRED');
  z.object({}).strict().parse(input.query||{});
  const saved=await db.collection('users').doc(input.auth.uid).collection('profiles').doc(Id.parse(profile[1])).get();
  if(!saved.exists)throw new HttpsError('not-found','PROFILE_NOT_FOUND');
  return {status:200,body:recommendCountry(saved.data()!)};
}
