import type { LocationCandidate, CountryChartRef, Subject } from '@vela-cf/shared';
import { businessApi } from './apiClient';
export type CatalogLocation = LocationCandidate & {id:string;version:string;name:string;aliases:string[]};
export type CountryChoice = Extract<CountryChartRef,{id:string}>;
export type CountryChart = CountryChoice & {name:string;eventName:string;usable:boolean;sourceReferences:string[];sourceNote:string;timeReliability:string;localDate:string;localTime:string|null;timezone:string;placeLabel:string};
export type CountryRecommendation = {status:string;basis:string;chart?:CountryChart;reason?:string};
const catalogs = new Map<string, Promise<unknown[]>>(), versions=new Map<string,{key:string;expires:number}>(), snapshots=new Map<string,unknown[]>();
export async function loadCatalog<T>(path:string):Promise<T[]> {
  const cached=versions.get(path);if(cached&&cached.expires>Date.now())return snapshots.get(cached.key)! as T[];
  if (!catalogs.has(path)) catalogs.set(path, (async()=>{
    for(let attempt=0;attempt<2;attempt++) {
      const items:T[]=[], seen=new Set<string>();let version='',cursor:string|null=null;
      try {
        do {
          const page:{catalogVersion:string;items:T[];nextCursor:string|null}=await businessApi(null,`${path}?limit=${path==='/v1/locations/catalog'?500:100}${version?`&version=${encodeURIComponent(version)}`:''}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
          if(!page.catalogVersion || (version && page.catalogVersion!==version))throw Object.assign(new Error('目录版本已改变，请重试'),{code:'CATALOG_VERSION_CHANGED'});
          version=page.catalogVersion;items.push(...page.items);cursor=page.nextCursor;
          if(cursor && seen.has(cursor))throw new Error('目录分页游标重复');if(cursor)seen.add(cursor);
        }while(cursor);
        const key=`${path}@${version}`;if(cached&&cached.key!==key)snapshots.delete(cached.key);snapshots.set(key,items);versions.set(path,{key,expires:Date.now()+300_000});return items;
      }catch(error){if(attempt || !(String((error as {code?:string}).code).includes('VERSION')))throw error;}
    }
    return [];
  })().finally(()=>{catalogs.delete(path);}));
  return catalogs.get(path)! as Promise<T[]>;
}
export function matchLocations(items:CatalogLocation[],input:string):CatalogLocation[] {
  const normalized=(value:string)=>value.normalize('NFKC').trim().toLowerCase(),q=normalized(input);if(!q)return [];
  return items.map(item=>{const names=[item.name,...item.aliases].map(normalized);return {item,rank:names.includes(q)?0:names.some(n=>n.startsWith(q))?1:normalized(item.displayName).includes(q)?2:3};}).filter(v=>v.rank<3).sort((a,b)=>a.rank-b.rank).slice(0,8).map(v=>v.item);
}

export function consultationSubjects(profiles:{id:string}[],country?:CountryChoice):Subject[] {
  return [...profiles.map((p,index)=>({ref:`subject_${index+1}`,profile_id:p.id})),...(country?[{ref:'country',country_chart:country}]:[])];
}
