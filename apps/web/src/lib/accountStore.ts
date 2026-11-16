import type { UserRecord, Tier, TIER_META, AnalysisDepth } from '@vela-cf/shared';
import { auth } from './firebase';
import { businessApi } from './apiClient';

export type ApiPlan = {id:Tier;analysisDepths:AnalysisDepth[]} & (typeof TIER_META)[Tier];
export interface ApiSubscription {id:string;status:string;role?:string;currentPeriodEnd?:number}
export async function loadPlans(uid:string|null,signal:AbortSignal):Promise<ApiPlan[]>{
  const {items}=await businessApi<{items:ApiPlan[]}>(uid,'/v1/plans','GET',undefined,signal);
  if(!Array.isArray(items)||!['free','go','pro'].every(id=>items.some(p=>p.id===id)) || items.some(p=>!Number.isFinite(p.maxProfiles)||p.maxProfiles<1||!Number.isFinite(p.maxSynastryProfiles)||p.maxSynastryProfiles<0||!Number.isFinite(p.monthlyBudgetMicroUsd)||p.monthlyBudgetMicroUsd<=0||typeof p.allowsEntityCharts!=='boolean'||!Array.isArray(p.analysisDepths)||p.analysisDepths.some(d=>!['quick','balanced','deep'].includes(d))))throw new Error('套餐信息不完整，请重试');
  return items;
}
export async function loadSubscriptionPage(uid:string|null,signal:AbortSignal):Promise<{plans:ApiPlan[];subscriptions:ApiSubscription[]}>{
  const [plans,subscriptions]=await Promise.all([
    loadPlans(uid,signal),
    uid?businessApi<{items:ApiSubscription[]}>(uid,'/v1/me/subscription','GET',undefined,signal):Promise.resolve({items:[]}),
  ]);
  return {plans,subscriptions:subscriptions.items};
}

export async function ensureUserRecord(uid:string,email:string,displayName:string):Promise<UserRecord>{
  try{return await businessApi<UserRecord>(uid,'/v1/me');}
  catch(error){if((error as {code?:string}).code!=='RESOURCE_NOT_FOUND')throw error;}
  return businessApi(uid,'/v1/me','PATCH',{displayName:displayName||email.split('@')[0]||'用户',acceptedTerms:true,confirmedAdult:true});
}
export async function exportUserDataJson(uid:string):Promise<void>{
  const data=await businessApi(uid,'/v1/me/exports','POST',{});
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`vela-export-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);
}
export async function deleteUserAccount(uid:string):Promise<void>{
  const result=await businessApi<{deleted:boolean}>(uid,'/v1/me','DELETE');
  if(!result.deleted)throw new Error('ACCOUNT_DELETE_INCOMPLETE');
  await auth.signOut();
}
export async function createStripeCheckout(uid:string,tier:'go'|'pro'):Promise<string|null>{
  const created=await businessApi<{id:string}>(uid,'/v1/billing/checkout-sessions','POST',{tier,successUrl:`${window.location.origin}/account?checkout=success`,cancelUrl:`${window.location.origin}/account?checkout=cancel`});
  const signal=AbortSignal.timeout(6000);
  while(true){
    const session=await businessApi<{status:string;url?:string;error?:string}>(uid,`/v1/billing/checkout-sessions/${encodeURIComponent(created.id)}`,'GET',undefined,signal);
    if(session.status==='completed')return session.url??null;
    if(session.status==='failed')throw new Error(session.error||'创建支付页面失败');
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},500);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  }
}
export async function createStripePortal():Promise<string|null>{
  const uid=auth.currentUser?.uid;if(!uid)throw new Error('AUTH_REQUIRED');
  return (await businessApi<{url:string}>(uid,'/v1/billing/portal-sessions','POST',{returnUrl:window.location.href})).url;
}

export function formatAppError(err: unknown, fallback: string): string {
  const rawCode = (err as { code?: string })?.code ?? '';
  const code = ({AUTH_REQUIRED:'functions/unauthenticated',INVALID_TOKEN:'functions/unauthenticated',MODEL_BUSY:'functions/resource-exhausted',INVALID_REQUEST:'functions/invalid-argument',RESOURCE_NOT_FOUND:'functions/not-found',INTERNAL_ERROR:'functions/internal'} as Record<string,string>)[rawCode] || rawCode;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return '邮箱或密码错误，若尚未注册请切换至「注册账号」';
  }
  if (code === 'auth/email-already-in-use') {
    return '该邮箱已注册，请直接切换至「邮箱登录」';
  }
  if (code === 'auth/weak-password') {
    return '密码强度不足，请设置至少 6 位字符';
  }
  if (code === 'auth/invalid-email') {
    return '邮箱格式不正确，请检查后重试';
  }
  if (code === 'auth/operation-not-allowed') {
    return '当前未在 Firebase 控制台开启邮箱登录，请前往 Authentication → Sign-in method 启用 Email/Password';
  }
  if (code === 'auth/too-many-requests') {
    return '尝试次数过多，请稍后再试或重置密码';
  }
  if (code === 'functions/unauthenticated' || msg.includes('AUTH_REQUIRED')) {
    return '登录状态已失效，请重新登录后重试';
  }
  if (msg === 'PROFILE_LIMIT_REACHED') return '已达到当前套餐的档案数量上限，请删除不再使用的档案或升级套餐';
  if (['TURN_FAILED','TURN_INTERRUPTED'].includes(msg)) return '上一条请求未完成，请重试';
  if (msg === 'TURN_CANCELLED') return '上一条请求已取消，可重新发送';
  if (msg.includes('SESSION_BUSY') || msg === 'TURN_RUNNING') {
    return '当前会话正在生成回复，请等待上一条消息完成后再试';
  }
  if (msg.includes('SUBSCRIPTION_CANCEL_FAILED') || msg.includes('STRIPE_NOT_CONFIGURED_FOR_ACTIVE_SUBSCRIPTION')) {
    return '取消活跃订阅未完成，为避免继续扣费已保留账号状态，请稍后重试或先在订阅管理中取消订阅';
  }
  if (code === 'functions/permission-denied') {
    return `权限或套餐受限：${msg}`;
  }
  if (msg === 'QUOTA_EXCEEDED') return '本月额度已用完，可分享领额度或升级套餐';
  if (code === 'functions/resource-exhausted') {
    return '模型服务暂时繁忙或请求受限，请稍后重试；本次错误不代表你的月度额度已用完';
  }
  if (code === 'functions/not-found') {
    return `未找到目标记录或模型：${msg}`;
  }
  if (code === 'functions/invalid-argument') {
    return `参数有误：${msg}`;
  }
  if (code === 'functions/internal' || msg === 'INTERNAL') {
    return msg && msg !== 'INTERNAL'
      ? `云端函数异常：${msg}`
      : '云端函数返回 INTERNAL（请确认已部署最新 functions，并检查 Vertex AI 权限/模型配置）';
  }
  return msg || fallback;
}
