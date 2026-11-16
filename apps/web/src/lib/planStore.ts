import { useEffect, useState } from 'react';
import type { Tier, UsageRecord } from '@vela-cf/shared';
import { loadPlans, type ApiPlan } from './accountStore';
import { invalidateApi, subscribeApi } from './apiClient';
export function usePlan(uid:string|null,tier:Tier){
  const [state,setState]=useState<{uid:string|null;plans?:ApiPlan[];error?:string}>();
  useEffect(()=>{
    setState(undefined);
    return subscribeApi(signal=>loadPlans(uid,signal),plans=>setState({uid,plans}),()=>{setState({uid,error:'套餐权益加载失败，操作将由服务端验证'});return;});
  },[uid]);
  const current=state?.uid===uid?state:undefined;
  return {plan:current?.plans?.find(p=>p.id===tier),error:current?.error,retry:invalidateApi};
}
export function planBudget(usage:UsageRecord,plan?:ApiPlan):number|undefined {
  return usage.budgetMicroUsd ?? (plan ? plan.monthlyBudgetMicroUsd+(usage.bonusMicroUsd??0) : undefined);
}
export function planUsagePercent(usage:UsageRecord,plan?:ApiPlan):number|null{
  const budget=planBudget(usage,plan);
  return usage.unlimited?0:budget===undefined?null:Math.min(100,Math.round(100*usage.used/budget));
}
