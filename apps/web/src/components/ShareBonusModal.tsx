import { useEffect, useRef, useState } from 'react';
import { MAX_MONTHLY_SHARE_BONUSES, type ProfileRecord, type Tier, type UsageRecord } from '@vela-cf/shared';
import { computePortraitSummary, renderVelaSharePoster } from '../lib/portrait';
import { claimDailyShareBonus, formatAppError, type ChartSnapshot } from '../lib/store';
import { IconGift } from './Icons';

interface ShareBonusModalProps {
  open: boolean;
  uid: string;
  tier: Tier;
  usage: UsageRecord;
  profile: ProfileRecord | null;
  chart: ChartSnapshot | null;
  onClose: () => void;
  onClaimed: (next: UsageRecord) => void;
  onOpenUpgrade: () => void;
}

export function ShareBonusModal({ open, uid, tier, usage, profile, chart, onClose, onClaimed, onOpenUpgrade }: ShareBonusModalProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const summary = chart?.natal ? computePortraitSummary(chart.natal) : null;
  const shareUrl = typeof window !== 'undefined' ? window.location.origin : '';

  useEffect(() => {
    if (!open || !canvasRef.current) return;
    void renderVelaSharePoster(canvasRef.current, profile, summary, shareUrl);
  }, [open, profile, summary, shareUrl]);

  if (!open) return null;

  const today = new Date().toISOString().slice(0, 10);
  const shareCount = Math.min(MAX_MONTHLY_SHARE_BONUSES, usage.shareCount ?? 0);
  const sharedToday = usage.lastShareDate === today;
  const limitReached = shareCount >= MAX_MONTHLY_SHARE_BONUSES;
  const disabled = busy || sharedToday || limitReached;

  const shareText = summary && profile
    ? `我在 Vela 观星台生成了「${summary.archetype}」星盘画像（太阳${summary.sunSign} · 月亮${summary.moonSign} · 上升${summary.ascSign}），邀你一起来聊此刻最在意的事 ${shareUrl}`
    : `我在 Vela 观星台推演本命星盘，邀你一起来聊此刻最在意的事 ${shareUrl}`;

  const handleSavePoster = () => {
    if (!canvasRef.current) return;
    const link = document.createElement('a');
    link.download = `vela-portrait-${profile?.name || 'card'}.png`;
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
  };

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
      setNotice('已复制分享卡片文案，成功领取 +1 次深度推演额度！');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setNotice(
        msg === 'ALREADY_SHARED_TODAY'
          ? '今日已领取过分享奖励，明天再来吧。'
          : msg === 'MONTHLY_SHARE_LIMIT_REACHED'
            ? '本月 3 次分享奖励已全部领满。'
            : formatAppError(err, '领取失败，请稍后重试'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="share-bonus-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-[460px] max-h-[92dvh] rounded-[16px] border border-[#26304d] bg-[#101527] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e2740]">
          <div className="flex items-center gap-2.5">
            <span className="text-[#e0b64a] flex items-center"><IconGift size={20} /></span>
            <h2 id="share-bonus-title" className="m-0 font-serif-sc text-[18px] font-bold text-[#f8fafc]">分享星盘卡片领额度</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭分享弹窗" className="min-h-[34px] min-w-[34px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          <div className="flex justify-center">
            <canvas ref={canvasRef} className="w-full max-w-[270px] h-auto rounded-[12px] border border-[#e0b64a]/35 shadow-lg" />
          </div>

          <div className="p-3 rounded-[12px] border border-[#26304d] bg-[#161d33] flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="text-[#c3cde0]">本月分享领额度（每日限 1 次）</span>
              <span className="font-mono-num text-[#f7d57f] font-semibold">{shareCount} / {MAX_MONTHLY_SHARE_BONUSES} 次</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((idx) => (
                <div key={idx} className={`h-2 rounded-full ${idx < shareCount ? 'bg-[#e0b64a]' : 'bg-[#26304d]'}`} />
              ))}
            </div>
          </div>

          {notice && <div role="status" className="px-4 py-2 rounded-[10px] border border-[#e0b64a]/40 bg-[#1d1a0f] text-[12.5px] text-[#f7d57f]">{notice}</div>}

          <div className="flex flex-col gap-2">
            <button type="button" onClick={handleSavePoster} className="min-h-[40px] w-full rounded-[10px] border border-[#26304d] bg-[#161d33] hover:border-[#e0b64a] text-[#f8fafc] text-[13.5px] font-medium cursor-pointer">
              保存 Vela 分享卡片图片 (PNG)
            </button>
            <button type="button" disabled={disabled} onClick={handleShareAndClaim} className="min-h-[44px] w-full rounded-[10px] border-0 bg-[#e0b64a] text-[#0d111d] text-[14px] font-bold hover:bg-[#f7d57f] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {busy ? '领取中...' : sharedToday ? '今日已领取分享奖励' : limitReached ? '本月奖励已领满（3/3）' : '分享卡片并领取 +1 次额度'}
            </button>
          </div>

          {tier === 'free' && (
            <button type="button" onClick={() => { onClose(); onOpenUpgrade(); }} className="bg-transparent border-0 p-0 text-[12px] text-[#9aa8c7] hover:text-[#f7d57f] cursor-pointer text-center">
              需要更多不间断推演额度？升级至 Vela Go →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
