import { useState } from 'react';
import { TIER_META } from '@vela-cf/shared';
import { AppFooter } from '../components/Layout';
import { NatalWheelSvg } from '../components/NatalWheelSvg';
import { navigate } from '../lib/router';

interface MainPageProps {
  isSignedIn: boolean;
  onGoogleLogin: () => Promise<void>;
  hasProfiles: boolean;
}

export function MainPage({ isSignedIn, onGoogleLogin, hasProfiles }: MainPageProps) {
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    if (!agreed || loading) return;
    setError(null);
    setLoading(true);
    try {
      await onGoogleLogin();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '登录未完成，请重试';
      if (msg.includes('popup-blocked')) {
        setError('浏览器拦截了登录弹窗，请允许弹窗后重试。');
      } else if (msg.includes('popup-closed-by-user')) {
        setError('你已关闭 Google 登录窗口。');
      } else {
        setError(`登录失败：${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#070812] text-[#f8fafc] flex flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-6 sm:px-10 py-5">
        <span className="font-brand text-[22px] font-semibold tracking-[0.32em] text-[#e0b64a] whitespace-nowrap">
          VELA
        </span>
        <nav className="flex flex-wrap items-center gap-7 text-[15px]" aria-label="首页导航">
          <a
            href="#how"
            className="text-[#c3cde0] no-underline py-3 hover:text-[#f8fafc] whitespace-nowrap"
          >
            如何使用
          </a>
          <a
            href="#plans"
            className="text-[#c3cde0] no-underline py-3 hover:text-[#f8fafc] whitespace-nowrap"
          >
            订阅方案
          </a>
          {isSignedIn && (
            <button
              type="button"
              onClick={() => navigate(hasProfiles ? '/consult' : '/profiles')}
              className="min-h-[44px] px-4 rounded-[10px] bg-[#e0b64a] border-0 text-[#1a1405] text-[14px] font-bold cursor-pointer hover:bg-[#f7d57f] whitespace-nowrap"
            >
              进入控制台
            </button>
          )}
        </nav>
      </header>

      <main className="flex-1 flex flex-col gap-16 max-w-[1200px] w-full mx-auto px-6 sm:px-10 pt-8 pb-14">
        <div className="flex flex-wrap items-center gap-x-16 gap-y-12">
          <section className="flex-[999_1_480px] min-w-0 flex flex-col gap-7">
            <p className="m-0 font-mono-num text-[13px] tracking-[0.14em] text-[#e0b64a]">
              西洋占星 · 八字 · 紫微斗数
            </p>
            <h1 className="m-0 font-serif-sc font-bold text-[40px] sm:text-[56px] leading-[1.25] [text-wrap:balance]">
              先排准星盘，
              <br />
              再谈你的处境。
            </h1>
            <p className="m-0 max-w-[520px] text-[18px] leading-[1.8] text-[#c3cde0]">
              输入出生时间与地点，Vela 先算出你的星盘事实，再由 AI
              顾问基于这些事实与你对话。每一句解读都能在盘面上找到出处。
            </p>

            <div id="how" className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-[560px]">
              {[
                { num: '01', label: '建立出生档案' },
                { num: '02', label: '选择咨询类型' },
                { num: '03', label: '开始对话' },
              ].map((step) => (
                <div
                  key={step.num}
                  className="flex flex-col gap-1.5 pt-3.5 border-t border-[#26304d]"
                >
                  <span className="font-mono-num text-[13px] text-[#e0b64a]">{step.num}</span>
                  <span className="text-[15px] leading-[1.6] text-[#f8fafc]">{step.label}</span>
                </div>
              ))}
            </div>
          </section>

          <section
            aria-label="登录卡片"
            className="flex-[1_1_380px] min-w-0 max-w-[440px] w-full flex flex-col gap-5 p-9 bg-[#101527] border border-[#26304d] rounded-[16px]"
          >
            <NatalWheelSvg decorative className="w-[132px] h-[132px] self-center" />
            <h2 className="m-0 font-serif-sc font-bold text-[24px] text-center">登录 Vela</h2>
            <p className="m-0 text-[15px] leading-[1.7] text-[#c3cde0] text-center">
              免费档每月可咨询 3 次，无需绑定支付方式。
            </p>

            {isSignedIn ? (
              <button
                type="button"
                onClick={() => navigate(hasProfiles ? '/consult' : '/profiles')}
                className="flex items-center justify-center gap-3 min-h-[52px] px-5 bg-[#e0b64a] text-[#1a1405] text-[16px] font-bold border-0 rounded-[10px] cursor-pointer hover:bg-[#f7d57f]"
              >
                {hasProfiles ? '前往选择咨询' : '前往创建出生档案'}
              </button>
            ) : (
              <>
                <label className="flex items-start gap-3 py-2 text-[14px] leading-[1.7] text-[#c3cde0] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="w-5 h-5 mt-0.5 accent-[#e0b64a] shrink-0"
                  />
                  <span>
                    我已年满 18 岁，并同意{' '}
                    <a
                      href="/terms"
                      onClick={(e) => {
                        e.preventDefault();
                        navigate('/terms');
                      }}
                    >
                      服务条款
                    </a>{' '}
                    与{' '}
                    <a
                      href="/privacy"
                      onClick={(e) => {
                        e.preventDefault();
                        navigate('/privacy');
                      }}
                    >
                      隐私政策
                    </a>
                    。
                  </span>
                </label>

                <button
                  type="button"
                  disabled={!agreed || loading}
                  onClick={handleLogin}
                  className={`flex items-center justify-center gap-3 min-h-[52px] px-5 text-[16px] font-bold border-0 rounded-[10px] transition-colors ${
                    agreed && !loading
                      ? 'bg-[#e0b64a] text-[#1a1405] cursor-pointer hover:bg-[#f7d57f]'
                      : 'bg-[#26304d] text-[#a3b0c5] cursor-not-allowed'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="flex items-center justify-center w-[26px] h-[26px] rounded-full bg-[#1a1405] text-[#e0b64a] font-mono-num text-[14px] font-medium"
                  >
                    G
                  </span>
                  {loading ? '正在登录...' : '使用 Google 账号继续'}
                </button>
              </>
            )}

            {error && (
              <p role="alert" className="m-0 text-[13px] leading-[1.6] text-[#ff9d8a] text-center">
                {error}
              </p>
            )}

            <p className="m-0 text-[13px] leading-[1.7] text-[#a3b0c5] text-center">
              我们只读取你的邮箱与昵称。
            </p>
          </section>
        </div>

        <section id="plans" className="pt-8 border-t border-[#1e2740] flex flex-col gap-5">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h2 className="m-0 font-serif-sc text-[24px] font-bold">订阅方案</h2>
            <span className="text-[14px] text-[#a3b0c5]">按月计费 · 可随时取消</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {(['free', 'go', 'pro'] as const).map((tierKey) => {
              const meta = TIER_META[tierKey];
              return (
                <article
                  key={tierKey}
                  className={`flex flex-col gap-3 p-6 rounded-[16px] border ${
                    tierKey === 'pro'
                      ? 'bg-[#1d1a0f] border-[#e0b64a]'
                      : 'bg-[#101527] border-[#26304d]'
                  }`}
                >
                  <div className="flex items-baseline justify-between">
                    <h3 className="m-0 font-serif-sc text-[20px] font-bold">{meta.label}</h3>
                    <span className="font-mono-num text-[22px] text-[#f7d57f]">
                      {meta.priceLabel}
                      {tierKey !== 'free' && (
                        <span className="text-[13px] text-[#a3b0c5]"> / 月</span>
                      )}
                    </span>
                  </div>
                  <ul className="m-0 p-0 list-none flex flex-col gap-2 text-[14px] text-[#c3cde0]">
                    {meta.highlights.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <AppFooter />
    </div>
  );
}
