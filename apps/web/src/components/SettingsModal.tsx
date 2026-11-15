import { useEffect, useState, type FormEvent } from 'react';
import {
  computeUsagePercent,
  nextUtcMonthResetLabel,
  TIER_META,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';
import { auth, updateAnalyticsConsent } from '../lib/firebase';
import { navigate } from '../lib/router';
import {
  createStripeCheckout,
  createStripePortal,
  deleteUserAccount,
  exportUserDataJson,
  formatAppError,
} from '../lib/store';

export type EmailAuthMode = 'login' | 'register' | 'magic';

interface SettingsModalProps {
  open: boolean;
  uid: string | null;
  email: string;
  authBusy: boolean;
  authError: string | null;
  authNotice: string | null;
  pendingQuestion?: string;
  onConfirmGoogleLogin: () => void;
  onEmailAuth: (mode: EmailAuthMode, email: string, password: string) => void;
  onResetPassword: (email: string) => void;
  onClose: () => void;
  onSignOut: () => void;
}

export function SettingsModal({
  open,
  uid,
  email,
  authBusy,
  authError,
  authNotice,
  pendingQuestion,
  onConfirmGoogleLogin,
  onEmailAuth,
  onResetPassword,
  onClose,
  onSignOut,
}: SettingsModalProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [emailMode, setEmailMode] = useState<EmailAuthMode>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [password, setPassword] = useState('');
  const [deleteText, setDeleteText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('vela_consent_choice') === 'granted',
  );

  useEffect(() => {
    if (open) setNotice(null);
  }, [open]);

  if (!open) return null;

  const handleEmailSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agreed || authBusy || !authEmail.trim()) return;
    onEmailAuth(emailMode, authEmail.trim(), password);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-[580px] max-h-[88dvh] rounded-[16px] border border-[#26304d] bg-[#101527] flex flex-col overflow-hidden">
        <div className="h-[56px] shrink-0 flex items-center justify-between px-6 border-b border-[#1e2740]">
          <h2 id="settings-title" className="m-0 font-serif-sc text-[19px] font-bold text-[#f8fafc]">
            {uid ? '账号与合规设置' : '登录或注册账号'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="min-h-[34px] min-w-[34px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
          {notice && (
            <div role="status" className="px-4 py-2.5 rounded-[10px] border border-[#e0b64a]/40 bg-[#1d1a0f] text-[13px] text-[#f7d57f]">
              {notice}
            </div>
          )}

          {!uid ? (
            <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#0b1020] flex flex-col gap-3.5">
              <div>
                <p className="m-0 text-[14px] font-bold text-[#f8fafc]">登录或创建你的 Vela 账号</p>
                <p className="m-0 mt-1 text-[12.5px] leading-[1.6] text-[#a3b0c5]">
                  登录后自动保存出生档案与历史咨询，并开启免费本命盘 AI 解读（每月 3 次）。
                </p>
              </div>

              {pendingQuestion && (
                <div className="px-3.5 py-2 rounded-[10px] border border-[#26304d] bg-[#161d33] text-[12.5px] text-[#e8edf6]">
                  <span className="text-[#a3b0c5]">即将为你解读：</span>
                  <span className="line-clamp-2">{pendingQuestion}</span>
                </div>
              )}

              {authError && <p role="alert" className="m-0 text-[12.5px] text-[#ff9d8a]">{authError}</p>}
              {authNotice && <p role="status" className="m-0 text-[12.5px] text-[#f7d57f]">{authNotice}</p>}

              <button
                type="button"
                disabled={!agreed || authBusy}
                onClick={onConfirmGoogleLogin}
                className="min-h-[42px] w-full rounded-[10px] bg-[#e0b64a] text-[#1a1405] text-[14px] font-bold border-0 cursor-pointer hover:bg-[#f7d57f] disabled:opacity-45 disabled:cursor-not-allowed"
              >
                {authBusy ? '正在处理…' : '使用 Google 账号继续并开始解读'}
              </button>

              <div className="flex items-center gap-3 text-[11.5px] text-[#7f8da9]">
                <div className="h-px flex-1 bg-[#1e2740]" />
                <span>或使用邮箱认证</span>
                <div className="h-px flex-1 bg-[#1e2740]" />
              </div>

              <form onSubmit={handleEmailSubmit} className="flex flex-col gap-2.5">
                <div className="flex gap-1 rounded-[8px] border border-[#26304d] bg-[#070812] p-1">
                  {([
                    { id: 'login', label: '邮箱登录' },
                    { id: 'register', label: '注册账号' },
                    { id: 'magic', label: '免密邮件链接' },
                  ] as const).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setEmailMode(m.id)}
                      className={`flex-1 min-h-[28px] rounded-[6px] border-0 text-[12px] font-medium cursor-pointer ${
                        emailMode === m.id ? 'bg-[#1d2540] text-[#f7d57f]' : 'bg-transparent text-[#9aa8c7] hover:text-[#f8fafc]'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                <input
                  required
                  type="email"
                  placeholder="邮箱地址（如 name@example.com）"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="min-h-[40px] px-3 rounded-[8px] border border-[#3a4668] bg-[#070812] text-[#f8fafc] text-[13.5px]"
                />

                {emailMode !== 'magic' && (
                  <input
                    required
                    type="password"
                    minLength={6}
                    placeholder={emailMode === 'register' ? '设置密码（至少 6 位）' : '输入密码'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="min-h-[40px] px-3 rounded-[8px] border border-[#3a4668] bg-[#070812] text-[#f8fafc] text-[13.5px]"
                  />
                )}

                <div className="flex items-center justify-between gap-2 pt-0.5">
                  {emailMode === 'login' && (
                    <button
                      type="button"
                      disabled={authBusy || !authEmail.trim()}
                      onClick={() => onResetPassword(authEmail.trim())}
                      className="bg-transparent border-0 p-0 text-[12px] text-[#a3b0c5] hover:text-[#f7d57f] underline cursor-pointer disabled:opacity-45"
                    >
                      忘记密码？发送重置邮件
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!agreed || authBusy || !authEmail.trim() || (emailMode !== 'magic' && password.length < 6)}
                    className="ml-auto min-h-[38px] px-4 rounded-[8px] border border-[#e0b64a]/70 bg-[#1d1a0f] text-[#f7d57f] text-[13px] font-semibold cursor-pointer hover:bg-[#e0b64a] hover:text-[#1a1405] disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    {emailMode === 'login' ? '邮箱登录并继续' : emailMode === 'register' ? '注册邮箱并继续' : '发送免密登录链接'}
                  </button>
                </div>
              </form>

              <label className="flex items-start gap-2.5 pt-1 border-t border-[#1e2740] text-[12px] leading-[1.55] text-[#c3cde0] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[#e0b64a] cursor-pointer shrink-0"
                />
                <span>
                  我已年满 18 岁，并同意{' '}
                  <a href="/terms" onClick={(e) => { e.preventDefault(); onClose(); navigate('/terms'); }} className="underline text-[#f7d57f]">服务条款</a>{' '}
                  与{' '}
                  <a href="/privacy" onClick={(e) => { e.preventDefault(); onClose(); navigate('/privacy'); }} className="underline text-[#f7d57f]">隐私政策</a>
                  ；如录入亲友出生信息，确认已获对方同意。
                </span>
              </label>
            </div>
          ) : (
            <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#161d33] flex items-center justify-between gap-4">
              <div>
                <p className="m-0 text-[14px] font-bold text-[#f8fafc]">{email}</p>
                <p className="m-0 mt-0.5 text-[12px] text-[#a3b0c5]">
                  {auth.currentUser?.providerData.some((p) => p.providerId === 'google.com') ? 'Google 账号登录' : '邮箱账号登录'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { onClose(); onSignOut(); }}
                className="min-h-[38px] px-4 rounded-[8px] border border-[#3a4668] bg-transparent text-[13px] text-[#f8fafc] hover:border-[#e0b64a] cursor-pointer"
              >
                退出登录
              </button>
            </div>
          )}

          <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#070812] flex flex-col gap-3">
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <p className="m-0 text-[14px] font-bold text-[#f8fafc]">匿名使用统计与隐私</p>
                <p className="m-0 mt-0.5 text-[12px] text-[#a3b0c5]">允许使用匿名统计改善产品体验（默认仅必要存储）。</p>
              </div>
              <input
                type="checkbox"
                checked={analyticsEnabled}
                onChange={(e) => {
                  const granted = e.target.checked;
                  setAnalyticsEnabled(granted);
                  window.localStorage.setItem('vela_consent_choice', granted ? 'granted' : 'denied');
                  void updateAnalyticsConsent(granted);
                }}
                className="w-4 h-4 accent-[#e0b64a] shrink-0"
              />
            </label>
            <div className="flex items-center gap-4 pt-2 border-t border-[#1e2740] text-[12px] text-[#9aa8c7]">
              <a href="/terms" onClick={(e) => { e.preventDefault(); onClose(); navigate('/terms'); }} className="hover:text-[#f7d57f]">服务条款</a>
              <a href="/privacy" onClick={(e) => { e.preventDefault(); onClose(); navigate('/privacy'); }} className="hover:text-[#f7d57f]">隐私政策</a>
            </div>
          </div>

          {uid && (
            <>
              <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#070812] flex items-center justify-between gap-4">
                <div>
                  <p className="m-0 text-[14px] font-bold text-[#f8fafc]">导出个人数据</p>
                  <p className="m-0 text-[12px] text-[#a3b0c5]">导出本人全部出生档案、咨询会话与消息为 JSON。</p>
                </div>
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={async () => {
                    setExportBusy(true);
                    setNotice(null);
                    try { await exportUserDataJson(uid); }
                    catch (err) { setNotice(formatAppError(err, '导出失败，请重试')); }
                    finally { setExportBusy(false); }
                  }}
                  className="min-h-[38px] px-4 rounded-[8px] border border-[#3a4668] bg-[#161d33] text-[13px] text-[#f8fafc] cursor-pointer shrink-0 disabled:opacity-45"
                >
                  {exportBusy ? '导出中…' : '导出 JSON'}
                </button>
              </div>

              <div className="p-4 rounded-[12px] border border-[#ff9d8a]/40 bg-[#070812] flex flex-col gap-3">
                <p className="m-0 text-[14px] font-bold text-[#ff9d8a]">删除账号（不可恢复）</p>
                <p className="m-0 text-[12px] text-[#c3cde0]">输入「删除」二字确认注销账号、取消订阅并永久清除所有档案与对话。</p>
                <div className="flex gap-2">
                  <input
                    placeholder="请输入：删除"
                    value={deleteText}
                    onChange={(e) => setDeleteText(e.target.value)}
                    className="flex-1 min-h-[38px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[13px]"
                  />
                  <button
                    type="button"
                    disabled={deleteText !== '删除' || deleteBusy}
                    onClick={async () => {
                      setDeleteBusy(true);
                      try { await deleteUserAccount(uid); onClose(); }
                      catch (err) { setNotice(formatAppError(err, '删除失败，请重新登录后重试')); }
                      finally { setDeleteBusy(false); }
                    }}
                    className="min-h-[38px] px-4 rounded-[8px] border border-[#ff9d8a] bg-transparent text-[13px] font-bold text-[#ff9d8a] cursor-pointer disabled:opacity-40"
                  >
                    {deleteBusy ? '删除中…' : '确认删除'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

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
        <div role="status" className="px-4 py-2.5 rounded-[10px] border border-[#e0b64a]/40 bg-[#1d1a0f] text-[13px] text-[#f7d57f]">
          {notice}
        </div>
      )}

      <div className="p-5 rounded-[14px] border border-[#26304d] bg-[#101527] flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[15px]">
          <span className="font-bold text-[#f8fafc]">当前方案：{tierMeta.label}</span>
          <span className="font-mono-num text-[#f7d57f]">{usage.unlimited ? '无限额度' : `本月额度已用 ${pct}%`}</span>
        </div>
        <div className="h-2.5 w-full rounded-full bg-[#070812] overflow-hidden">
          <div className="h-full bg-[#e0b64a] transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-[#c3cde0]">
          <span>
            档案存储：<strong className="text-[#f7d57f] font-mono-num">{profileCount} / {tierMeta.maxProfiles}</strong> 个 · 同盘上限 {Math.max(1, tierMeta.maxSynastryProfiles)} 人
          </span>
          {uid && (
            <button type="button" onClick={onOpenShare} className="px-3 py-1 rounded-[8px] border border-[#e0b64a]/50 bg-[#1d1a0f] text-[12px] text-[#f7d57f] cursor-pointer hover:border-[#e0b64a]">
              分享星盘领额外额度
            </button>
          )}
        </div>
        <p className="m-0 text-[12px] text-[#a3b0c5]">
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
                plan === 'pro' ? 'border-[#e0b64a]/60 bg-[#1d1a0f]/50' : 'border-[#26304d] bg-[#0b1020]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-serif-sc text-[19px] font-bold text-[#f8fafc]">{meta.label}</span>
                <span className="font-mono-num text-[15px] text-[#f7d57f]">{meta.priceLabel} / 月</span>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11.5px]">
                <span className="px-2 py-0.5 rounded bg-[#161d33] text-[#f7d57f]">最多存 {meta.maxProfiles} 个档案</span>
                <span className="px-2 py-0.5 rounded bg-[#161d33] text-[#a8c0f0]">{meta.maxSynastryProfiles} 人合盘</span>
                {meta.allowsEntityCharts && <span className="px-2 py-0.5 rounded bg-[#161d33] text-[#c3cde0]">公司 / 国家盘</span>}
              </div>
              <ul className="m-0 pl-4 text-[13px] text-[#c3cde0] leading-[1.7] flex flex-col gap-1">
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
                    ? 'bg-transparent border border-[#3a4668] text-[#c3cde0] hover:text-[#f8fafc]'
                    : 'bg-[#e0b64a] text-[#1a1405] border-0 hover:bg-[#f7d57f]'
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
        <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#0b1020] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[13.5px] font-medium text-[#f8fafc]">管理或取消订阅</p>
            <p className="m-0 text-[12px] text-[#a3b0c5]">降级或取消后将在当前计费周期结束时生效，期间仍可使用全部已购额度。</p>
          </div>
          <button
            type="button"
            disabled={checkoutBusy !== null}
            onClick={() => void handleManageSubscription()}
            className="min-h-[38px] px-4 rounded-[10px] border border-[#3a4668] bg-transparent text-[13px] text-[#c3cde0] hover:border-[#ff9d8a]/60 hover:text-[#ff9d8a] cursor-pointer shrink-0 disabled:opacity-45"
          >
            {checkoutBusy === 'portal' ? '正在打开…' : '取消订阅 / 管理账单'}
          </button>
        </div>
      )}
    </div>
  );
}
