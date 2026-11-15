import { useState, type ReactNode } from 'react';
import { updateAnalyticsConsent } from '../lib/firebase';
import { navigate } from '../lib/router';

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
      <footer className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-6 sm:px-10 py-5 border-t border-divider text-[13px] leading-[1.7] text-muted">
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
              className="text-secondary py-2 no-underline hover:text-accent-bright whitespace-nowrap"
            >
              隐私政策
            </a>
            <a
              href="/terms"
              onClick={(e) => {
                e.preventDefault();
                navigate('/terms');
              }}
              className="text-secondary py-2 no-underline hover:text-accent-bright whitespace-nowrap"
            >
              服务条款
            </a>
          </nav>
        </div>
      </footer>

      {!consentSaved && (
        <aside
          aria-label="站点统计同意"
          className="border-t border-border bg-panel px-6 sm:px-10 py-3.5 flex flex-wrap items-center justify-between gap-4 text-[13px] text-secondary"
        >
          <p className="m-0 max-w-[720px]">
            我们使用基础访问统计（Google Analytics）改进页面体验，默认处于关闭状态。你可以选择是否允许。
          </p>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => handleConsent(false)}
              className="min-h-[44px] px-4 border border-border-strong rounded-[10px] bg-transparent text-secondary text-[13px] cursor-pointer hover:text-primary whitespace-nowrap"
            >
              仅必要运行
            </button>
            <button
              type="button"
              onClick={() => handleConsent(true)}
              className="min-h-[44px] px-4 rounded-[10px] bg-accent border-0 text-on-accent text-[13px] font-bold cursor-pointer hover:bg-accent-bright whitespace-nowrap"
            >
              允许统计
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
