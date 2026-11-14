import { useState } from 'react';
import { QUOTA_LIMIT, TIER_META, type Tier, type UsageRecord } from '@vela-cf/shared';
import { AppFooter, AppHeader } from '../components/Layout';
import { navigate } from '../lib/router';
import {
  createStripeCheckout,
  deleteUserAccount,
  exportUserDataJson,
} from '../lib/store';

interface AccountPageProps {
  uid: string;
  email: string;
  tier: Tier;
  usage: UsageRecord;
  onSignOut: () => Promise<void>;
}

export function AccountPage({ uid, email, tier, usage, onSignOut }: AccountPageProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const limit = QUOTA_LIMIT[tier];
  const pct = Math.min(100, Math.round((usage.used / limit) * 100));

  const handleUpgrade = async (target: 'go' | 'pro') => {
    setNotice(null);
    setBusy(true);
    try {
      const checkoutUrl = await createStripeCheckout(uid, target);
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
      } else {
        setNotice(
          `Stripe 结账链接尚未在当前预览环境配置（需先在 Firebase 安装 Run Payments with Stripe 扩展并设置 ${target.toUpperCase()} 价格 ID）。`,
        );
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '无法发起结账');
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setNotice(null);
    setBusy(true);
    try {
      await exportUserDataJson(uid);
      setNotice('已导出你的档案与咨询记录（JSON 文件）。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (confirmText.trim() !== '删除') return;
    setBusy(true);
    setNotice(null);
    try {
      await deleteUserAccount(uid);
      navigate('/');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '删除账号失败，请重新登录后再试');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#070812] text-[#f8fafc] flex flex-col">
      <AppHeader current="account" tier={tier} used={usage.used} onSignOut={onSignOut} />

      <main className="flex-1 max-w-[1080px] w-full mx-auto px-6 sm:px-10 py-12 flex flex-col gap-12">
        <section className="flex flex-col gap-5">
          <h1 className="m-0 font-serif-sc font-bold text-[32px]">账号与订阅</h1>

          <div className="flex flex-wrap items-center gap-x-12 gap-y-5 p-7 bg-[#101527] border border-[#26304d] rounded-[16px]">
            <div className="flex-[1_1_260px] min-w-0 flex flex-col gap-1.5">
              <span className="text-[14px] text-[#a3b0c5]">当前方案</span>
              <span className="font-serif-sc text-[24px] font-bold">
                {TIER_META[tier].label}
              </span>
              <span className="text-[14px] text-[#c3cde0]">额度在每月 1 日（UTC）重置</span>
            </div>

            <div className="flex-[2_1_320px] min-w-0 flex flex-col gap-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[14px] text-[#a3b0c5]">本月已用</span>
                <span className="font-mono-num text-[20px] text-[#f7d57f]">
                  {usage.used} / {limit} 次
                </span>
              </div>
              <div
                role="img"
                aria-label={`已使用 ${limit} 次中的 ${usage.used} 次`}
                className="h-2 bg-[#26304d] rounded-[4px] overflow-hidden"
              >
                <div className="h-full bg-[#e0b64a]" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-5">
          <h2 className="m-0 font-serif-sc font-bold text-[24px]">升级方案</h2>

          {notice && (
            <p
              role="status"
              className="m-0 p-4 bg-[#101527] border border-[#e0b64a] rounded-[12px] text-[14px] text-[#f7d57f]"
            >
              {notice}
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <article className="flex flex-col gap-4 p-7 bg-[#101527] border border-[#26304d] rounded-[16px]">
              <div className="flex items-center justify-between gap-3">
                <h3 className="m-0 font-serif-sc text-[22px] font-bold">免费</h3>
                {tier === 'free' && (
                  <span className="px-2.5 py-1 border border-[#3a4668] rounded-[6px] text-[12px] text-[#c3cde0]">
                    当前方案
                  </span>
                )}
              </div>
              <p className="m-0 font-mono-num text-[28px] text-[#f8fafc]">$0</p>
              <ul className="m-0 p-0 list-none flex flex-col gap-2.5 text-[15px] leading-[1.6] text-[#c3cde0]">
                {TIER_META.free.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </article>

            <article className="flex flex-col gap-4 p-7 bg-[#101527] border border-[#26304d] rounded-[16px]">
              <div className="flex items-center justify-between gap-3">
                <h3 className="m-0 font-serif-sc text-[22px] font-bold">Go</h3>
                {tier === 'go' && (
                  <span className="px-2.5 py-1 border border-[#e0b64a] rounded-[6px] text-[12px] text-[#f7d57f]">
                    当前方案
                  </span>
                )}
              </div>
              <p className="m-0 font-mono-num text-[28px] text-[#f8fafc]">
                {TIER_META.go.priceLabel}{' '}
                <span className="text-[14px] text-[#a3b0c5]">/ 月</span>
              </p>
              <ul className="m-0 p-0 list-none flex flex-col gap-2.5 text-[15px] leading-[1.6] text-[#c3cde0]">
                {TIER_META.go.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy || tier === 'go'}
                onClick={() => void handleUpgrade('go')}
                className="mt-auto min-h-[48px] bg-transparent border-[1.5px] border-[#e0b64a] rounded-[10px] text-[#f7d57f] text-[16px] font-bold cursor-pointer hover:bg-[#1d1a0f] disabled:opacity-50"
              >
                {tier === 'go' ? '当前方案' : '升级到 Go'}
              </button>
            </article>

            <article className="flex flex-col gap-4 p-7 bg-[#1d1a0f] border-[1.5px] border-[#e0b64a] rounded-[16px]">
              <div className="flex items-center justify-between gap-3">
                <h3 className="m-0 font-serif-sc text-[22px] font-bold">Pro</h3>
                {tier === 'pro' && (
                  <span className="px-2.5 py-1 bg-[#e0b64a] rounded-[6px] text-[12px] text-[#1a1405] font-medium">
                    当前方案
                  </span>
                )}
              </div>
              <p className="m-0 font-mono-num text-[28px] text-[#f8fafc]">
                {TIER_META.pro.priceLabel}{' '}
                <span className="text-[14px] text-[#c3cde0]">/ 月</span>
              </p>
              <ul className="m-0 p-0 list-none flex flex-col gap-2.5 text-[15px] leading-[1.6] text-[#e8edf6]">
                {TIER_META.pro.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy || tier === 'pro'}
                onClick={() => void handleUpgrade('pro')}
                className="mt-auto min-h-[48px] bg-[#e0b64a] border-0 rounded-[10px] text-[#1a1405] text-[16px] font-bold cursor-pointer hover:bg-[#f7d57f] disabled:opacity-50"
              >
                {tier === 'pro' ? '当前方案' : '升级到 Pro'}
              </button>
            </article>
          </div>

          <p className="m-0 text-[13px] leading-[1.8] text-[#a3b0c5]">
            订阅按月自动续订，可随时在账单管理中取消。价格不含税，结账时按所在地区计算。付款由
            Stripe 处理，Vela 不保存卡号。详见{' '}
            <a
              href="/terms"
              onClick={(e) => {
                e.preventDefault();
                navigate('/terms');
              }}
            >
              服务条款
            </a>
            。
          </p>
        </section>

        <section className="flex flex-col gap-1">
          <h2 className="m-0 mb-3 font-serif-sc font-bold text-[24px]">你的数据</h2>

          <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-5 border-t border-[#26304d]">
            <div className="flex-[1_1_320px] min-w-0 flex flex-col gap-1">
              <span className="text-[16px] font-bold">登录账号</span>
              <span className="text-[14px] text-[#c3cde0]">通过 Google 登录 · {email}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-5 border-t border-[#26304d]">
            <div className="flex-[1_1_320px] min-w-0 flex flex-col gap-1">
              <span className="text-[16px] font-bold">导出数据</span>
              <span className="text-[14px] leading-[1.7] text-[#c3cde0]">
                下载你的全部档案、咨询记录与消息（JSON 文件）。
              </span>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleExport()}
              className="min-h-[48px] px-5 bg-transparent border border-[#3a4668] rounded-[10px] text-[#f8fafc] text-[15px] cursor-pointer hover:border-[#e0b64a]"
            >
              导出
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-5 border-t border-b border-[#26304d]">
            <div className="flex-[1_1_320px] min-w-0 flex flex-col gap-1">
              <span className="text-[16px] font-bold">删除账号</span>
              <span className="text-[14px] leading-[1.7] text-[#c3cde0]">
                永久删除账号、全部档案与咨询记录，并取消订阅。此操作无法撤销。
              </span>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmText('');
                setConfirmOpen(true);
              }}
              className="min-h-[48px] px-5 bg-transparent border border-[#ff9d8a] rounded-[10px] text-[#ff9d8a] text-[15px] cursor-pointer hover:bg-[#ff9d8a]/10"
            >
              删除账号
            </button>
          </div>
        </section>
      </main>

      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="del-title"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="max-w-[440px] w-full bg-[#101527] border border-[#ff9d8a] rounded-[16px] p-6 flex flex-col gap-4">
            <h2 id="del-title" className="m-0 font-serif-sc text-[22px] font-bold">
              确认删除账号
            </h2>
            <p className="m-0 text-[14px] leading-[1.7] text-[#c3cde0]">
              此操作将永久删除你的出生档案、咨询会话与账号数据，无法恢复。请在下方输入{' '}
              <strong className="text-[#ff9d8a]">删除</strong> 以确认：
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="输入「删除」"
              className="min-h-[48px] px-3.5 bg-[#070812] border border-[#3a4668] rounded-[10px] text-[#f8fafc] text-[16px]"
            />
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="min-h-[44px] px-4 bg-transparent border border-[#3a4668] rounded-[10px] text-[#c3cde0] text-[14px] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={confirmText.trim() !== '删除' || busy}
                onClick={() => void handleDeleteAccount()}
                className="min-h-[44px] px-5 bg-[#ff9d8a] border-0 rounded-[10px] text-[#1a1405] text-[14px] font-bold cursor-pointer disabled:opacity-40"
              >
                确认永久删除
              </button>
            </div>
          </div>
        </div>
      )}

      <AppFooter />
    </div>
  );
}
