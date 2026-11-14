import { useState } from 'react';
import {
  MAX_MONTHLY_SHARE_BONUSES,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';
import { claimDailyShareBonus, formatAppError } from '../lib/store';
import { IconGift } from './Icons';

interface ShareBonusModalProps {
  open: boolean;
  uid: string;
  tier: Tier;
  usage: UsageRecord;
  onClose: () => void;
  onClaimed: (next: UsageRecord) => void;
  onOpenUpgrade: () => void;
}

export function ShareBonusModal({
  open,
  uid,
  tier,
  usage,
  onClose,
  onClaimed,
  onOpenUpgrade,
}: ShareBonusModalProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!open) return null;

  const today = new Date().toISOString().slice(0, 10);
  const shareCount = Math.min(MAX_MONTHLY_SHARE_BONUSES, usage.shareCount ?? 0);
  const sharedToday = usage.lastShareDate === today;
  const limitReached = shareCount >= MAX_MONTHLY_SHARE_BONUSES;
  const disabled = busy || sharedToday || limitReached;

  const shareText = `我在 Vela 观星台推演本命星盘，邀你一起来聊此刻最在意的事 ${window.location.origin}`;

  const handleShareAndClaim = async () => {
    if (disabled) return;
    setBusy(true);
    setNotice(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareText).catch(() => undefined);
      }
      const next = await claimDailyShareBonus(uid);
      onClaimed(next);
      setNotice('已复制邀请文案，成功领取 +1 次深度推演额度！');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'ALREADY_SHARED_TODAY') {
        setNotice('今日已领取过分享奖励，明天再来吧。');
      } else if (msg === 'MONTHLY_SHARE_LIMIT_REACHED') {
        setNotice('本月 3 次分享奖励已全部领满。');
      } else {
        setNotice(formatAppError(err, '领取失败，请稍后重试'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-bonus-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-[460px] rounded-[16px] border border-[#26304d] bg-[#101527] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e2740]">
          <div className="flex items-center gap-2.5">
            <span className="text-[#e0b64a] flex items-center">
              <IconGift size={20} />
            </span>
            <h2 id="share-bonus-title" className="m-0 font-serif-sc text-[19px] font-bold text-[#f8fafc]">
              每日分享礼遇
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭分享弹窗"
            className="min-h-[34px] min-w-[34px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <p className="m-0 text-[14px] leading-relaxed text-[#c3cde0]">
            将 Vela 观星台分享给朋友，每日首次分享可获赠{' '}
            <span className="text-[#f7d57f] font-semibold">+1 次深度推演额度</span>
            ，每月最多可领 {MAX_MONTHLY_SHARE_BONUSES} 次。
          </p>

          <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#161d33] flex flex-col gap-3">
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-[#c3cde0]">本月分享进度</span>
              <span className="font-mono-num text-[#f7d57f] font-semibold">
                {shareCount} / {MAX_MONTHLY_SHARE_BONUSES} 次
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((idx) => (
                <div
                  key={idx}
                  className={`h-2 rounded-full transition-colors ${
                    idx < shareCount ? 'bg-[#e0b64a]' : 'bg-[#26304d]'
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] border border-[#26304d] bg-[#0b1020] text-[12px] leading-relaxed text-[#9aa8c7] select-all">
            {shareText}
          </div>

          {notice && (
            <div role="status" className="px-4 py-2.5 rounded-[10px] border border-[#e0b64a]/40 bg-[#1d1a0f] text-[13px] text-[#f7d57f]">
              {notice}
            </div>
          )}

          <button
            type="button"
            disabled={disabled}
            onClick={handleShareAndClaim}
            className="min-h-[44px] w-full rounded-[10px] border-0 bg-[#e0b64a] text-[#0d111d] text-[14px] font-bold hover:bg-[#f7d57f] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {busy
              ? '领取中...'
              : sharedToday
                ? '今日已领取分享奖励'
                : limitReached
                  ? '本月奖励已领满（3/3）'
                  : '复制分享链接并领取 +1 次额度'}
          </button>

          {tier === 'free' && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenUpgrade();
              }}
              className="bg-transparent border-0 p-0 text-[12px] text-[#9aa8c7] hover:text-[#f7d57f] cursor-pointer text-center"
            >
              需要更多不间断推演额度？升级至 Vela Go →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
