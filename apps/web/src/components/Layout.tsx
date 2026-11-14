import { useState, type ReactNode } from 'react';
import { QUOTA_LIMIT, TIER_META, type Tier } from '@vela-cf/shared';
import { updateAnalyticsConsent } from '../lib/firebase';
import { navigate } from '../lib/router';

interface AppHeaderProps {
  current: 'consult' | 'profiles' | 'account';
  tier: Tier;
  used: number;
  onSignOut?: () => void;
}

export function AppHeader({ current, tier, used, onSignOut }: AppHeaderProps) {
  const limit = QUOTA_LIMIT[tier];
  const tierLabel = TIER_META[tier].label;

  return (
    <header className="flex flex-wrap items-center gap-x-10 gap-y-3 px-6 sm:px-10 py-3.5 border-b border-[#1e2740]">
      <a
        href="/consult"
        onClick={(e) => {
          e.preventDefault();
          navigate('/consult');
        }}
        className="font-brand text-[20px] font-semibold tracking-[0.32em] text-[#e0b64a] no-underline py-2.5 whitespace-nowrap shrink-0"
      >
        VELA
      </a>

      <nav className="flex flex-wrap gap-2 text-[15px] flex-1" aria-label="主导航">
        {(
          [
            { key: 'consult', label: '咨询', href: '/consult' },
            { key: 'profiles', label: '档案', href: '/profiles' },
            { key: 'account', label: '账号', href: '/account' },
          ] as const
        ).map((item) => {
          const active = current === item.key;
          return (
            <a
              key={item.key}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.href);
              }}
              className={`no-underline px-3.5 py-3 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                active
                  ? 'text-[#f8fafc] border-[#e0b64a]'
                  : 'text-[#c3cde0] border-transparent hover:text-[#f8fafc]'
              }`}
            >
              {item.label}
            </a>
          );
        })}
      </nav>

      {current === 'account' && onSignOut ? (
        <button
          type="button"
          onClick={onSignOut}
          className="flex items-center min-h-[44px] px-3.5 text-[14px] text-[#c3cde0] hover:text-[#f8fafc] bg-transparent border-0 cursor-pointer whitespace-nowrap shrink-0"
        >
          退出登录
        </button>
      ) : (
        <a
          href="/account"
          onClick={(e) => {
            e.preventDefault();
            navigate('/account');
          }}
          className="flex items-center gap-2.5 min-h-[44px] px-3.5 border border-[#26304d] rounded-[22px] text-[#f8fafc] no-underline text-[14px] hover:border-[#3a4668] whitespace-nowrap shrink-0"
        >
          <span className="font-mono-num text-[#f7d57f]">
            {used} / {limit}
          </span>
          <span className="text-[#c3cde0]">本月已用 · {tierLabel}</span>
        </a>
      )}
    </header>
  );
}

export function AppFooter({ children }: { children?: ReactNode }) {
  const [consentSaved, setConsentSaved] = useState<boolean>(
    () => typeof window !== 'undefined' && localStorage.getItem('vela_consent_analytics') !== null,
  );

  const handleConsent = (granted: boolean) => {
    updateAnalyticsConsent(granted);
    setConsentSaved(true);
  };

  return (
    <>
      <footer className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-6 sm:px-10 py-5 border-t border-[#1e2740] text-[13px] leading-[1.7] text-[#a3b0c5]">
        <p className="m-0 max-w-[760px]">
          Vela 的解读由 AI 生成，仅供娱乐与自我探索，不构成医疗、法律、财务或心理健康建议。
        </p>
        <div className="flex items-center gap-6">
          {children}
          <nav className="flex gap-6" aria-label="法律条款">
            <a
              href="/privacy"
              onClick={(e) => {
                e.preventDefault();
                navigate('/privacy');
              }}
              className="text-[#c3cde0] py-2 no-underline hover:text-[#f7d57f] whitespace-nowrap"
            >
              隐私政策
            </a>
            <a
              href="/terms"
              onClick={(e) => {
                e.preventDefault();
                navigate('/terms');
              }}
              className="text-[#c3cde0] py-2 no-underline hover:text-[#f7d57f] whitespace-nowrap"
            >
              服务条款
            </a>
          </nav>
        </div>
      </footer>

      {!consentSaved && (
        <aside
          aria-label="站点统计同意"
          className="border-t border-[#26304d] bg-[#101527] px-6 sm:px-10 py-3.5 flex flex-wrap items-center justify-between gap-4 text-[13px] text-[#c3cde0]"
        >
          <p className="m-0 max-w-[720px]">
            我们使用基础访问统计（Google Analytics）改进页面体验，默认处于关闭状态。你可以选择是否允许。
          </p>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => handleConsent(false)}
              className="min-h-[44px] px-4 border border-[#3a4668] rounded-[10px] bg-transparent text-[#c3cde0] text-[13px] cursor-pointer hover:text-[#f8fafc] whitespace-nowrap"
            >
              仅必要运行
            </button>
            <button
              type="button"
              onClick={() => handleConsent(true)}
              className="min-h-[44px] px-4 rounded-[10px] bg-[#e0b64a] border-0 text-[#1a1405] text-[13px] font-bold cursor-pointer hover:bg-[#f7d57f] whitespace-nowrap"
            >
              允许统计
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
