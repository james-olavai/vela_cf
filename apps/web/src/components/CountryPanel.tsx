import { useEffect, useState } from 'react';
import { businessApi } from '../lib/apiClient';
import { loadCatalog, type CountryChoice, type CountryChart, type CountryRecommendation } from '../lib/geoStore';
const reasons:Record<string,string>={LOCATION_COUNTRY_UNKNOWN:'请在档案中重新选择地点，或从目录选择国家盘',COUNTRY_MAPPING_AMBIGUOUS:'该地点有多个事件盘口径，请从目录选择',COUNTRY_CHART_UNAVAILABLE:'该地区尚无已审核国家盘，可从目录选择其他国家',COUNTRY_CHART_TIME_UNVERIFIED:'事件时刻尚未核实，暂不能用于排盘'};
export function CountryPanel({uid,profileId,value,onChange,allowed}:{uid:string|null;profileId?:string;value:CountryChoice|null;onChange:(v:CountryChoice|null)=>void;allowed:boolean}) {
  const [state,setState]=useState<{charts:CountryChart[];recommendation?:CountryRecommendation;error?:string}>({charts:[]});
  const [choice,setChoice]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setState({charts:[]});setChoice('');
    void Promise.all([loadCatalog<CountryChart>('/v1/country-charts'),uid&&profileId?businessApi<CountryRecommendation>(uid,`/v1/profiles/${encodeURIComponent(profileId)}/country-chart`,'GET',undefined,controller.signal):undefined]).then(([charts,recommendation])=>{
      if(controller.signal.aborted)return;setState({charts,recommendation});setChoice(recommendation?.chart?`${recommendation.chart.id}@${recommendation.chart.version}`:'');
    }).catch(error=>{if(!controller.signal.aborted)setState({charts:[],error:error.message});});
    return ()=>controller.abort();
  },[uid,profileId,retry]);
  const chart=state.charts.find(c=>`${c.id}@${c.version}`===choice), recommendation=state.recommendation;
  return <section className="mx-3 my-2 p-3 border border-border rounded-xl text-[13px] text-secondary" aria-label="关联国家盘">
    <label htmlFor="country-chart-choice">关联国家盘</label>
    <select id="country-chart-choice" className="mt-2 w-full min-h-12 bg-panel text-primary rounded-lg border border-border" value={choice} onChange={e=>{setChoice(e.target.value);onChange(null);}}>
      <option value="">选择已审核国家盘</option>
      {state.charts.map(c=><option key={`${c.id}@${c.version}`} value={`${c.id}@${c.version}`} disabled={!c.usable}>{c.name} · {c.eventName}{c.usable?'':'（时刻待核实）'}</option>)}
    </select>
    <p role="status">{state.error?<>目录加载失败 <button type="button" onClick={()=>setRetry(n=>n+1)}>重试</button></>:!uid?'登录并保存档案后可自动关联':!profileId?'请先保存个人或公司档案，也可浏览国家盘目录':chart&&(chart.id!==recommendation?.chart?.id||chart.version!==recommendation?.chart?.version)?`当前选择：${chart.name}`:recommendation?.status==='matched'?`已关联：${recommendation.chart?.name} · 根据${recommendation.basis==='registration_location'?'注册地':'出生地'}`:recommendation?reasons[recommendation.reason||'']||'请从目录选择国家盘':'正在加载国家盘…'}</p>
    {chart&&<details><summary className="min-h-12 cursor-pointer">查看事件来源 · 版本 {chart.version}</summary><p>{chart.eventName}<br />{chart.localDate} {chart.localTime??'时刻待核实'} · {chart.timezone}<br />{chart.placeLabel}</p><p>{chart.sourceNote}</p>{chart.sourceReferences.filter(url=>/^https:\/\//.test(url)).map((url,i)=><a key={url} href={url} target="_blank" rel="noreferrer" className="block min-h-12 underline">来源 {i+1}</a>)}</details>}
    <label className="flex items-center gap-2 min-h-12"><input type="checkbox" checked={Boolean(value)} disabled={!uid||!chart?.usable||(!value&&!allowed)} onChange={e=>onChange(e.target.checked&&chart?{id:chart.id,version:chart.version}:null)} />加入本次分析</label>
    {!allowed&&<p>需支持国家盘的套餐及一个空余分析名额</p>}
  </section>;
}
