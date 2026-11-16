import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const directory=await mkdtemp(resolve('.plan-test-'));
async function bundle(entry,name){
  const built=await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',packages:'external',plugins:[{name:'isolated-services',setup(b){
    b.onResolve({filter:/\/(firebase|store|accountStore|apiClient)$/},()=>({path:'services',namespace:'test'}));
    b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const updateAnalyticsConsent=()=>{};export const searchLocations=async()=>[];export const loadPlans=async()=>[];export const subscribeApi=()=>()=>{};export const invalidateApi=()=>{};'}));
  }}]});const path=resolve(directory,name+'.mjs');await writeFile(path,built.outputFiles[0].text);return import(pathToFileURL(path));
}
const {ProfileSidebarPanel,ProfileManagerSubpage}=await bundle('apps/web/src/components/ProfileSidebarPanel.tsx','components');
const {planBudget,planUsagePercent}=await bundle('apps/web/src/lib/planStore.ts','plans');
await rm(directory,{recursive:true});
const profiles=Array.from({length:6},(_,i)=>({id:String(i),name:'Profile'+i,entityType:'company',birthDateTime:'2000-01-01T12:00',locationName:'Test'}));
const props={tier:'free',profiles,selectedProfileIds:['0','1'],launch:{seq:0},uid:'owner'};
const plan={id:'free',label:'Server plan',maxProfiles:23,maxSynastryProfiles:7,monthlyBudgetMicroUsd:1000,allowsEntityCharts:false,analysisDepths:[]};
const render=(component,extra={})=>renderToStaticMarkup(createElement(component,{...props,...extra}));
test('unknown plan does not lock entity choices or invent capacity; API plan supplies actual limits',()=>{
  const unknown=render(ProfileSidebarPanel);assert(!unknown.includes('disabled=""'));assert(unknown.includes('已选 2 人'));assert(!unknown.includes('Infinity'));
  const manager=render(ProfileManagerSubpage);assert(manager.includes('套餐加载中'));assert(!manager.includes('Infinity'));assert(!/disabled=""[^>]*data-testid="pm-add"/.test(manager));
  const known=render(ProfileSidebarPanel,{plan});assert(known.includes('6 / 23'));assert(known.includes('已选 2/7 人'));assert(known.includes('disabled=""'));
  const full=render(ProfileManagerSubpage,{plan:{...plan,maxProfiles:6}});assert(/disabled=""[^>]*data-testid="pm-add"/.test(full));
});
test('usage budget comes from effective API budget then API plan plus bonus, never tier constants',()=>{
  const usage={used:250,bonusMicroUsd:100};assert.equal(planBudget(usage),undefined);assert.equal(planUsagePercent(usage),null);
  assert.equal(planBudget(usage,plan),1100);assert.equal(planUsagePercent(usage,plan),23);
  assert.equal(planBudget({...usage,budgetMicroUsd:500},plan),500);assert.equal(planUsagePercent({...usage,budgetMicroUsd:500},plan),50);
  assert.equal(planUsagePercent({...usage,unlimited:true}),0);assert.equal(planUsagePercent({...usage,used:2000},plan),100);
});
