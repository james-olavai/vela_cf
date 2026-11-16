import { planUsagePercent } from '../lib/planStore';
import { useEffect, useRef, useState } from 'react';
import { nextUtcMonthResetLabel, type Tier, type UsageRecord } from '@vela-cf/shared';
import { createStripeCheckout, createStripePortal, loadSubscriptionPage } from '../lib/accountStore';

interface SubscriptionSubpageProps {
  uid: string | null;
  tier: Tier;
  usage: UsageRecord;
  profileCount: number;
  onRequestAuth: () => void;
  onOpenShare: () => void;
}

export function SubscriptionSubpage({
  uid,
  tier,
  usage,
  profileCount,
  onRequestAuth,
  onOpenShare,
}: SubscriptionSubpageProps) {
  const [checkoutBusy, setCheckoutBusy] = useState<'go' | 'pro' | 'portal' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const owner=useRef(uid);owner.current=uid;
  const [reload,setReload]=useState(0);
  const [loaded,setLoaded]=useState<{uid:string|null;data?:Awaited<ReturnType<typeof loadSubscriptionPage>>;error?:string}>();
  useEffect(()=>{
    owner.current=uid;const controller=new AbortController();setLoaded(undefined);setNotice(null);setCheckoutBusy(null);
    void loadSubscriptionPage(uid,controller.signal).then(data=>{if(!controller.signal.aborted)setLoaded({uid,data});})
      .catch(error=>{if(!controller.signal.aborted)setLoaded({uid,error:error instanceof Error?error.message:'订阅信息加载失败'});});
    return ()=>{controller.abort();if(owner.current===uid)owner.current=null;};
  },[uid,reload]);
  const data=loaded?.uid===uid?loaded.data:undefined;
  const loadError=loaded?.uid===uid?loaded.error:undefined;
  const tierMeta=data?.plans.find(p=>p.id===tier);
  const pct=planUsagePercent(usage,tierMeta);
  const subscriptions=data?.subscriptions??[];
  const statusLabels:Record<string,string>={active:'生效中',trialing:'试用中',past_due:'付款逾期',unpaid:'未付款',canceled:'已取消',incomplete:'等待付款',incomplete_expired:'付款已过期',paused:'已暂停'};

  const handleUpgrade = async (target: 'go' | 'pro') => {
    if (!uid) {
      onRequestAuth();
      return;
    }
    setNotice(null);
    setCheckoutBusy(target);
    try {
      const url = await createStripeCheckout(uid, target);
      if(owner.current!==uid)return;
      if (url) window.location.assign(url);
      else setNotice('当前环境尚未接入 Stripe 生产密钥，升级流程将在配置完成后开放。');
    } catch (err) {
      if(owner.current===uid)setNotice(err instanceof Error ? err.message : '发起结账失败');
    } finally {
      if(owner.current===uid)setCheckoutBusy(null);
    }
  };

  const handleManageSubscription = async () => {
    if (!uid) {
      onRequestAuth();
      return;
    }
    setNotice(null);
    setCheckoutBusy('portal');
    try {
      const url = await createStripePortal();
      if(owner.current!==uid)return;
      if (url) window.location.assign(url);
      else setNotice('当前环境尚未接入 Stripe 客户门户，降级或取消订阅将在配置完成后开放。');
    } catch (err) {
      if(owner.current===uid)setNotice(err instanceof Error ? err.message : '打开订阅管理失败');
    } finally {
      if(owner.current===uid)setCheckoutBusy(null);
    }
  };

  if(!data || !tierMeta)return <div data-testid="subscription-subpage" className="p-5 text-secondary" aria-busy={!loadError}>
    {loadError?<><p role="alert">{loadError}</p><button type="button" className="min-h-[38px] px-4" onClick={()=>setReload(n=>n+1)}>重新加载订阅信息</button></>:<><progress aria-label="正在加载套餐与订阅" /><p>正在加载套餐与订阅…</p></>}
  </div>;

  return (
    <div data-testid="subscription-subpage" className="mx-auto w-full max-w-3xl flex flex-col gap-4 pb-16">
      {notice && (
        <div role="status" className="px-4 py-2.5 rounded-[10px] border border-accent/40 bg-selected text-[13px] text-accent-bright">
          {notice}
        </div>
      )}

      <div className="p-5 rounded-[14px] border border-border bg-panel flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[15px]">
          <span className="font-bold text-primary">当前方案：{tierMeta.label}</span>
          <span className="font-mono-num text-accent-bright">{usage.unlimited ? '无限额度' : `本月额度已用 ${pct}%`}</span>
        </div>
        <div className="h-2.5 w-full rounded-full bg-base overflow-hidden">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-secondary">
          <span>
            档案存储：<strong className="text-accent-bright font-mono-num">{profileCount} / {tierMeta.maxProfiles}</strong> 个 · 同盘上限 {Math.max(1, tierMeta.maxSynastryProfiles)} 人
          </span>
          {uid && (
            <button type="button" onClick={onOpenShare} className="px-3 py-1 rounded-[8px] border border-accent/50 bg-selected text-[13px] text-accent-bright cursor-pointer hover:border-accent">
              分享星盘领额外额度
            </button>
          )}
        </div>
        <p className="m-0 text-[13px] text-muted">
          按 Gemini 4 Hydrogen 实际对话与推理 Token 用量实时折算，{nextUtcMonthResetLabel()}（UTC）重置。
        </p>
      </div>

      {uid && <div data-testid="subscription-status" className="p-4 rounded-[12px] border border-border text-[13px] text-secondary">
        {subscriptions.length===0?'暂无订阅记录':<ul className="m-0 pl-4">{subscriptions.map(item=><li key={item.id}>
          {data.plans.find(p=>p.id===item.role)?.label??'订阅'}：{statusLabels[item.status]??'状态待确认'}
          {item.currentPeriodEnd?` · 当前周期结束：${new Date(item.currentPeriodEnd*1000).toLocaleDateString()}`:''}
        </li>)}</ul>}
      </div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.plans.filter((p):p is typeof p & {id:'go'|'pro'}=>p.id==='go'||p.id==='pro').map((meta) => {
          const plan = meta.id;
          const isCurrent = tier === plan;
          const isDowngrade = tier === 'pro' && plan === 'go';
          return (
            <div
              key={plan}
              className={`p-5 rounded-[14px] border flex flex-col gap-3 ${
                plan === 'pro' ? 'border-accent/60 bg-selected/50' : 'border-border bg-[#0b1020]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-serif-sc text-[19px] font-bold text-primary">{meta.label}</span>
                <span className="font-mono-num text-[15px] text-accent-bright">{meta.priceLabel} / 月</span>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[13px]">
                <span className="px-2 py-0.5 rounded bg-panel-2 text-accent-bright">最多存 {meta.maxProfiles} 个档案</span>
                <span className="px-2 py-0.5 rounded bg-panel-2 text-info">{meta.maxSynastryProfiles} 人合盘</span>
                {meta.allowsEntityCharts && <span className="px-2 py-0.5 rounded bg-panel-2 text-secondary">公司 / 国家盘</span>}
              </div>
              <ul className="m-0 pl-4 text-[13px] text-secondary leading-[1.7] flex flex-col gap-1">
                {meta.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              <button
                type="button"
                disabled={isCurrent || checkoutBusy !== null}
                onClick={() => void (isDowngrade ? handleManageSubscription() : handleUpgrade(plan))}
                className={`mt-auto min-h-[42px] rounded-[10px] text-[14px] font-bold cursor-pointer disabled:opacity-45 ${
                  isDowngrade
                    ? 'bg-transparent border border-border-strong text-secondary hover:text-primary'
                    : 'bg-accent text-on-accent border-0 hover:bg-accent-bright'
                }`}
              >
                {isCurrent
                  ? '当前方案'
                  : checkoutBusy === plan || (isDowngrade && checkoutBusy === 'portal')
                    ? '正在跳转…'
                    : isDowngrade
                      ? `降级到 ${meta.label}`
                      : `升级到 ${meta.label}`}
              </button>
            </div>
          );
        })}
      </div>

      {uid && subscriptions.some(s=>!['canceled','incomplete_expired'].includes(s.status)) && (
        <div className="p-4 rounded-[12px] border border-border bg-[#0b1020] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[13.5px] font-medium text-primary">管理或取消订阅</p>
            <p className="m-0 text-[13px] text-muted">具体变更时间与计费状态以账单管理页面为准。</p>
          </div>
          <button
            type="button"
            disabled={checkoutBusy !== null}
            onClick={() => void handleManageSubscription()}
            className="min-h-[38px] px-4 rounded-[10px] border border-border-strong bg-transparent text-[13px] text-secondary hover:border-danger/60 hover:text-danger cursor-pointer shrink-0 disabled:opacity-45"
          >
            {checkoutBusy === 'portal' ? '正在打开…' : '取消订阅 / 管理账单'}
          </button>
        </div>
      )}
    </div>
  );
}
