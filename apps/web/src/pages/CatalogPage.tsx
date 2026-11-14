import { useState } from 'react';
import {
  hasTierAccess,
  type CatalogProduct,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
} from '@vela-cf/shared';
import { AppFooter, AppHeader } from '../components/Layout';
import { navigate } from '../lib/router';

interface CatalogPageProps {
  tier: Tier;
  used: number;
  profiles: ProfileRecord[];
  products: CatalogProduct[];
  sessions: SessionRecord[];
  onStartSession: (product: CatalogProduct, profile: ProfileRecord) => void;
}

export function CatalogPage({
  tier,
  used,
  profiles,
  products,
  sessions,
  onStartSession,
}: CatalogPageProps) {
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => profiles[0]?.id ?? '',
  );
  const [notice, setNotice] = useState<string | null>(null);

  const effectiveProfile =
    profiles.find((p) => p.id === selectedProfileId) ?? profiles[0] ?? null;

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return '今天';
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  };

  const handleStart = (product: CatalogProduct) => {
    setNotice(null);
    if (!effectiveProfile) {
      navigate('/profiles');
      return;
    }
    if (product.requiresGender && effectiveProfile.gender === 'unset') {
      setNotice(
        `「${product.title}」包含紫微斗数，请先在档案页为「${effectiveProfile.name}」补充性别（男 / 女）。`,
      );
      return;
    }
    onStartSession(product, effectiveProfile);
  };

  return (
    <div className="min-h-screen bg-[#070812] text-[#f8fafc] flex flex-col">
      <AppHeader current="consult" tier={tier} used={used} />

      <main className="flex-1 max-w-[1200px] w-full mx-auto px-6 sm:px-10 py-12 flex flex-col gap-10">
        <section className="flex flex-col gap-4">
          <p className="m-0 font-mono-num text-[13px] tracking-[0.14em] text-[#e0b64a]">
            第 1 步
          </p>
          <h1 className="m-0 font-serif-sc font-bold text-[32px]">这次为谁咨询？</h1>

          <div className="flex flex-wrap gap-3">
            {profiles.map((profile) => {
              const selected = effectiveProfile?.id === profile.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedProfileId(profile.id);
                    setNotice(null);
                  }}
                  className={`flex flex-col items-start gap-1 min-h-[64px] px-[18px] py-3 rounded-[12px] text-left cursor-pointer border-[1.5px] transition-colors ${
                    selected
                      ? 'bg-[#1d1a0f] border-[#e0b64a] text-[#f8fafc]'
                      : 'bg-[#101527] border-[#26304d] text-[#f8fafc] hover:border-[#3a4668]'
                  }`}
                >
                  <span className="text-[16px] font-bold">{profile.name}</span>
                  <span className="font-mono-num text-[13px] text-[#c3cde0]">
                    {profile.birthDateTime.replace('T', ' ')} · {profile.locationName.split('，')[0]}
                  </span>
                </button>
              );
            })}

            <a
              href="/profiles"
              onClick={(e) => {
                e.preventDefault();
                navigate('/profiles');
              }}
              className="flex items-center gap-2 min-h-[64px] px-[18px] py-3 border-[1.5px] border-dashed border-[#3a4668] rounded-[12px] text-[#e0b64a] no-underline text-[15px] hover:border-[#e0b64a] whitespace-nowrap"
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              新建档案
            </a>
          </div>

          {profiles.length === 0 && (
            <p className="m-0 text-[14px] text-[#c3cde0]">
              你还没有出生档案，请先点击「新建档案」录入出生时间与城市。
            </p>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <p className="m-0 font-mono-num text-[13px] tracking-[0.14em] text-[#e0b64a]">
            第 2 步
          </p>
          <h2 className="m-0 font-serif-sc font-bold text-[32px]">选择咨询类型</h2>

          {notice && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-4 p-4 bg-[#1d1a0f] border border-[#e0b64a] rounded-[12px] text-[14px] text-[#f8fafc]"
            >
              <span>{notice}</span>
              <button
                type="button"
                onClick={() => navigate('/profiles')}
                className="min-h-[44px] px-4 rounded-[10px] bg-[#e0b64a] border-0 text-[#1a1405] font-bold cursor-pointer whitespace-nowrap"
              >
                去补填性别
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {products.map((product) => {
              const unlocked = hasTierAccess(tier, product.minTier);
              const badgeLabel = product.minTier.toUpperCase();
              const upgradeLabel =
                product.minTier === 'go' ? '升级到 Go 解锁' : '升级到 Pro 解锁';

              return (
                <article
                  key={product.slug}
                  className="flex flex-col gap-4 p-7 bg-[#101527] border border-[#26304d] rounded-[16px]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="m-0 font-serif-sc text-[22px] font-bold">
                      {product.title}
                    </h3>
                    <span
                      className={`px-2.5 py-1 rounded-[6px] font-mono-num text-[12px] ${
                        product.minTier === 'pro'
                          ? 'bg-[#e0b64a] text-[#1a1405] font-medium'
                          : product.minTier === 'go'
                            ? 'border border-[#e0b64a] text-[#f7d57f]'
                            : 'border border-[#3a4668] text-[#c3cde0]'
                      }`}
                    >
                      {badgeLabel}
                    </span>
                  </div>

                  <p className="m-0 text-[15px] leading-[1.8] text-[#c3cde0]">
                    {product.description}
                  </p>

                  <ul className="m-0 p-0 list-none flex flex-col gap-2 text-[14px] text-[#c3cde0]">
                    {product.toolLabels.map((label) => (
                      <li key={label} className="flex gap-2.5 items-center">
                        <span
                          aria-hidden="true"
                          className="w-1.5 h-1.5 rounded-full bg-[#e0b64a] shrink-0"
                        />
                        {label}
                      </li>
                    ))}
                  </ul>

                  {unlocked ? (
                    <button
                      type="button"
                      onClick={() => handleStart(product)}
                      className="mt-auto flex items-center justify-center min-h-[48px] bg-[#e0b64a] text-[#1a1405] text-[16px] font-bold border-0 rounded-[10px] cursor-pointer hover:bg-[#f7d57f]"
                    >
                      开始咨询
                    </button>
                  ) : (
                    <a
                      href="/account"
                      onClick={(e) => {
                        e.preventDefault();
                        navigate('/account');
                      }}
                      className="mt-auto flex items-center justify-center gap-2 min-h-[48px] border-[1.5px] border-[#e0b64a] text-[#f7d57f] text-[16px] font-bold no-underline rounded-[10px] hover:bg-[#1d1a0f]"
                    >
                      <svg
                        aria-hidden="true"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="5" y="11" width="14" height="9" rx="2" />
                        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                      </svg>
                      {upgradeLabel}
                    </a>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        {sessions.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-[16px] font-bold text-[#c3cde0]">最近的咨询</h2>
            <div className="flex flex-col gap-2.5">
              {sessions.slice(0, 6).map((s) => (
                <a
                  key={s.id}
                  href={`/consult/${s.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/consult/${s.id}`);
                  }}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 min-h-[56px] px-5 py-2 bg-[#101527] border border-[#26304d] rounded-[12px] text-[#f8fafc] no-underline text-[15px] hover:border-[#3a4668]"
                >
                  <span>{s.title}</span>
                  <span className="font-mono-num text-[13px] text-[#a3b0c5]">
                    {formatDate(s.updatedAt)}
                  </span>
                </a>
              ))}
            </div>
          </section>
        )}
      </main>

      <AppFooter />
    </div>
  );
}
