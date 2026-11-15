import { useState } from 'react';
import { computeUsagePercent, nextUtcMonthResetLabel, TIER_META, type Tier, type UsageRecord } from '@vela-cf/shared';
import { createStripeCheckout, createStripePortal } from '../lib/accountStore';

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
  const pct = usage.unlimited ? 0 : computeUsagePercent(usage.used, tier, usage.bonusMicroUsd ?? 0);
  const tierMeta = TIER_META[tier];

  const handleUpgrade = async (target: 'go' | 'pro') => {
    if (!uid) {
      onRequestAuth();
      return;
    }
    setNotice(null);
    setCheckoutBusy(target);
    try {
      const url = await createStripeCheckout(uid, target);
      if (url) window.location.assign(url);
      else setNotice('当前环境尚未接入 Stripe 生产密钥，升级流程将在配置完成后开放。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '发起结账失败');
    } finally {
      setCheckoutBusy(null);
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
      if (url) window.location.assign(url);
      else setNotice('当前环境尚未接入 Stripe 客户门户，降级或取消订阅将在配置完成后开放。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '打开订阅管理失败');
    } finally {
      setCheckoutBusy(null);
    }
  };

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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(['go', 'pro'] as const).map((plan) => {
          const meta = TIER_META[plan];
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

      {tier !== 'free' && (
        <div className="p-4 rounded-[12px] border border-border bg-[#0b1020] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[13.5px] font-medium text-primary">管理或取消订阅</p>
            <p className="m-0 text-[13px] text-muted">降级或取消后将在当前计费周期结束时生效，期间仍可使用全部已购额度。</p>
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
