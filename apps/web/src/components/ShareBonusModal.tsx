import { firebaseConfig } from '../lib/runtimeConfig';
import { Modal } from './Modal';
import { useEffect, useRef, useState } from 'react';
import { PRODUCTION_WEB_ORIGIN, PRODUCTION_FIREBASE_PROJECT, MAX_MONTHLY_SHARE_BONUSES, type ProfileRecord, type Tier, type UsageRecord } from '@vela-cf/shared';
import { renderVelaSharePoster } from '../lib/portrait';
import { claimDailyShareBonus, formatAppError, type ChartSnapshot, type ShareClaimMethod } from '../lib/store';
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
  const [posterReady, setPosterReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sharedActionDone, setSharedActionDone] = useState<ShareClaimMethod | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const summary = chart?.portrait ?? null;
  const shareUrl = !import.meta.env.DEV && firebaseConfig.projectId===PRODUCTION_FIREBASE_PROJECT ? PRODUCTION_WEB_ORIGIN : typeof window !== 'undefined' ? window.location.origin : '';
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    if (!open) {
      setSharedActionDone(null);
      setNotice(null);
      return;
    }
    if (!canvasRef.current) return;
    let alive = true;
    setPosterReady(false);
    const canvas = document.createElement('canvas');
    void renderVelaSharePoster(canvas, profile, summary, shareUrl).then(() => {
      const target = canvasRef.current;
      if (alive && target) { target.width = canvas.width; target.height = canvas.height; target.getContext('2d')?.drawImage(canvas, 0, 0); setPosterReady(true); }
    }).catch(() => { if (alive) setNotice('海报生成失败，请重新打开后重试'); });
    return () => { alive = false; };
  }, [open, profile, summary, shareUrl]);


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
    setSharedActionDone('poster');
    setNotice('已保存分享海报图片，发送给好友后即可点击下方领取。');
  };

  const handleCopyShareText = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareText);
      } else {
        throw new Error('NO_CLIPBOARD');
      }
      setSharedActionDone('copy');
      setNotice('已复制分享文案与链接，发送给好友后即可点击下方领取。');
    } catch {
      setNotice('当前浏览器限制自动复制，请先保存分享海报图片再领取。');
    }
  };

  const triggerNativeShare = async (): Promise<boolean> => {
    const title = 'Vela 观星台 · 星盘能量画像';
    const canvas = canvasRef.current;
    if (canvas && typeof navigator.canShare === 'function') {
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      if (blob) {
        const file = new File([blob], `vela-portrait-${profile?.name || 'card'}.png`, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ title, text: shareText, url: shareUrl, files: [file] });
            return true;
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return false;
          }
        }
      }
    }
    try {
      await navigator.share({ title, text: shareText, url: shareUrl });
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      throw err;
    }
  };

  const handleShareAndClaim = async () => {
    if (disabled) return;
    if (!canNativeShare && !sharedActionDone) {
      setNotice('请先保存分享海报或复制分享文案，完成分享后再领取额度。');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      let method: ShareClaimMethod = sharedActionDone ?? 'poster';
      if (canNativeShare) {
        const completed = await triggerNativeShare();
        if (!completed) {
          setNotice('已取消系统分享，完成分享后即可领取 +1 次额度。');
          return;
        }
        method = 'native';
      }
      const next = await claimDailyShareBonus(uid, method);
      onClaimed(next);
      setNotice(canNativeShare ? '已完成系统分享，成功领取 +1 次深度推演额度！' : '已确认分享，成功领取 +1 次深度推演额度！');
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
    <Modal open={open} onClose={onClose} labelledBy="share-bonus-title" className="w-[calc(100%_-_2rem)] max-w-[460px]">
      <div className="w-full max-w-[460px] max-h-[92dvh] rounded-[16px] border border-border bg-panel flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-divider">
          <div className="flex items-center gap-2.5">
            <span className="text-accent flex items-center"><IconGift size={20} /></span>
            <h2 id="share-bonus-title" className="m-0 font-serif-sc text-[18px] font-bold text-primary">分享星盘卡片领额度</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭分享弹窗" className="min-h-[34px] min-w-[34px] rounded-[8px] border border-border bg-transparent text-secondary hover:text-primary cursor-pointer">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          <div className="flex justify-center">
            <canvas role="img" aria-label="星盘画像分享海报，包含姓名、星座与元素分布" ref={canvasRef} className="w-full max-w-[270px] h-auto rounded-[12px] border border-accent/35 shadow-lg" />
          </div>

          <div className="p-3 rounded-[12px] border border-border bg-panel-2 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-secondary">本月分享领额度（每日限 1 次）</span>
              <span className="font-mono-num text-accent-bright font-semibold">{shareCount} / {MAX_MONTHLY_SHARE_BONUSES} 次</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((idx) => (
                <div key={idx} className={`h-2 rounded-full ${idx < shareCount ? 'bg-accent' : 'bg-border'}`} />
              ))}
            </div>
          </div>

          {notice && <div role="status" className="px-4 py-2 rounded-[10px] border border-accent/40 bg-selected text-[13px] text-accent-bright">{notice}</div>}

          <div className="flex flex-col gap-2">
            <div className={canNativeShare ? 'flex flex-col gap-2' : 'grid grid-cols-2 gap-2'}>
              <button type="button" disabled={!posterReady} onClick={handleSavePoster} className="min-h-[40px] w-full rounded-[10px] border border-border bg-panel-2 hover:border-accent text-primary text-[13px] font-medium cursor-pointer">
                保存分享海报 (PNG)
              </button>
              {!canNativeShare && (
                <button type="button" onClick={handleCopyShareText} className="min-h-[40px] w-full rounded-[10px] border border-border bg-panel-2 hover:border-accent text-primary text-[13px] font-medium cursor-pointer">
                  复制分享文案与链接
                </button>
              )}
            </div>
            <button type="button" disabled={disabled || !posterReady || (!canNativeShare && !sharedActionDone)} onClick={handleShareAndClaim} className="min-h-[44px] w-full rounded-[10px] border-0 bg-accent text-[#0d111d] text-[14px] font-bold hover:bg-accent-bright disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {busy
                ? '分享处理中...'
                : sharedToday
                  ? '今日已领取分享奖励'
                  : limitReached
                    ? '本月奖励已领满（3/3）'
                    : canNativeShare
                      ? '调起系统分享并领取 +1 次额度'
                      : sharedActionDone
                        ? '确认已分享，领取 +1 次额度'
                        : '请先保存海报或复制文案后再领取'}
            </button>
          </div>

          {tier === 'free' && (
            <button type="button" onClick={() => { onClose(); onOpenUpgrade(); }} className="bg-transparent border-0 p-0 text-[13px] text-muted hover:text-accent-bright cursor-pointer text-center">
              需要更多不间断推演额度？升级至 Vela Go →
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
