import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  nextUtcMonthResetLabel,
  QUOTA_LIMIT,
  type MessageRecord,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';
import { AppHeader } from '../components/Layout';
import { NatalWheelSvg } from '../components/NatalWheelSvg';
import { navigate } from '../lib/router';
import {
  fetchNatalChart,
  loadCachedChart,
  loadLocalMessages,
  streamConsultationReply,
  type ChartSnapshot,
} from '../lib/store';

interface ChatPageProps {
  uid: string;
  tier: Tier;
  usage: UsageRecord;
  session: SessionRecord;
  sessions: SessionRecord[];
  profile: ProfileRecord | null;
  onUsageChange: (usage: UsageRecord) => void;
}

function renderFormattedText(text: string) {
  const lines = text.split('\n');
  return lines.map((line, lineIdx) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <p key={lineIdx} className="m-0">
        {parts.map((part, idx) =>
          part.startsWith('**') && part.endsWith('**') ? (
            <strong key={idx} className="text-[#f7d57f] font-bold">
              {part.slice(2, -2)}
            </strong>
          ) : (
            <span key={idx}>{part}</span>
          ),
        )}
      </p>
    );
  });
}

export function ChatPage({
  uid,
  tier,
  usage,
  session,
  sessions,
  profile,
  onUsageChange,
}: ChatPageProps) {
  const [messages, setMessages] = useState<MessageRecord[]>(() =>
    loadLocalMessages(uid, session.id),
  );
  const [chart, setChart] = useState<ChartSnapshot | null>(() =>
    profile ? loadCachedChart(uid, profile.id) : null,
  );
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFacts, setExpandedFacts] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const limit = QUOTA_LIMIT[tier];
  const remaining = Math.max(0, limit - usage.used);
  const quotaExhausted = usage.used >= limit;

  useEffect(() => {
    setMessages(loadLocalMessages(uid, session.id));
    setError(null);
  }, [uid, session.id]);

  useEffect(() => {
    if (!profile) return;
    const cached = loadCachedChart(uid, profile.id);
    if (cached) {
      setChart(cached);
      return;
    }
    void fetchNatalChart(uid, profile)
      .then(setChart)
      .catch(() => undefined);
  }, [uid, profile?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streaming]);

  const sendMessage = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || streaming || !profile) return;
    if (trimmed.length > 2000) {
      setError('单条消息最多 2000 字。');
      return;
    }
    if (quotaExhausted) return;

    setError(null);
    setInput('');
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamConsultationReply({
        uid,
        tier,
        session,
        profile,
        userText: trimmed,
        signal: controller.signal,
        onUpdateMessages: setMessages,
        onUpdateChart: setChart,
        onUpdateUsage: onUsageChange,
        onQuotaExceeded: () => setError('本月额度已用完'),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，请重试');
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendMessage(input);
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const formatSessionDate = (iso: string) => {
    const d = new Date(iso);
    if (d.toDateString() === new Date().toDateString()) return '今天';
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  };

  const coreKeys = ['Sun', 'Moon', 'Mercury', 'Saturn'];
  const coreRows = chart
    ? [
        ...chart.natal.planets
          .filter((p) => coreKeys.includes(p.key))
          .map((p) => ({ label: p.nameZh, value: p.formatted, house: String(p.house) })),
        { label: '上升', value: chart.natal.ascendant.formatted, house: '1' },
        { label: '天顶', value: chart.natal.midheaven.formatted, house: '10' },
      ]
    : [];

  const allPlanetRows = chart
    ? [
        ...chart.natal.planets.map((p) => ({
          label: `${p.nameZh}${p.retrograde ? ' 逆' : ''}`,
          value: p.formatted,
          house: String(p.house),
        })),
        { label: '上升', value: chart.natal.ascendant.formatted, house: '1' },
        { label: '天顶', value: chart.natal.midheaven.formatted, house: '10' },
      ]
    : [];

  const displayRows = expandedFacts ? allPlanetRows : coreRows;

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  const factsPanelContent = (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 font-serif-sc text-[18px] font-bold">星盘事实</h2>
        <span className="text-[12px] text-[#a3b0c5]">
          {chart ? chart.natal.houseSystem : '计算中'}
        </span>
      </div>

      <NatalWheelSvg chart={chart} className="w-full max-w-[260px] self-center" />

      {displayRows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="text-left text-[#a3b0c5] text-[12px]">
                <th className="py-2 font-medium border-b border-[#26304d]">星体</th>
                <th className="py-2 font-medium border-b border-[#26304d]">位置</th>
                <th className="py-2 font-medium border-b border-[#26304d] text-right">宫位</th>
              </tr>
            </thead>
            <tbody className="font-mono-num">
              {displayRows.map((row, idx) => (
                <tr key={row.label}>
                  <td
                    className={`py-2.5 ${
                      idx < displayRows.length - 1 ? 'border-b border-[#1e2740]' : ''
                    }`}
                  >
                    {row.label}
                  </td>
                  <td
                    className={`py-2.5 text-[#f7d57f] ${
                      idx < displayRows.length - 1 ? 'border-b border-[#1e2740]' : ''
                    }`}
                  >
                    {row.value}
                  </td>
                  <td
                    className={`py-2.5 text-right ${
                      idx < displayRows.length - 1 ? 'border-b border-[#1e2740]' : ''
                    }`}
                  >
                    {row.house}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="m-0 text-[13px] text-[#a3b0c5]">正在排盘计算...</p>
      )}

      {expandedFacts && chart && (
        <div className="flex flex-col gap-4 pt-2 border-t border-[#1e2740]">
          <div>
            <h3 className="m-0 mb-2 text-[13px] font-bold text-[#c3cde0]">主要相位</h3>
            <ul className="m-0 p-0 list-none flex flex-col gap-1.5 text-[13px] font-mono-num text-[#c3cde0]">
              {chart.natal.aspects.slice(0, 8).map((a, idx) => (
                <li key={idx} className="flex justify-between gap-2">
                  <span>
                    {a.pointA} {a.aspect} {a.pointB}
                  </span>
                  <span className="text-[#a3b0c5]">{a.orb}°</span>
                </li>
              ))}
            </ul>
          </div>

          {chart.bazi && (
            <div>
              <h3 className="m-0 mb-2 text-[13px] font-bold text-[#c3cde0]">八字四柱</h3>
              <p className="m-0 font-mono-num text-[13px] text-[#f7d57f]">
                {chart.bazi.pillars.map((p) => p.ganZhi).join(' · ')}
              </p>
            </div>
          )}

          {chart.ziwei && (
            <div>
              <h3 className="m-0 mb-2 text-[13px] font-bold text-[#c3cde0]">紫微命盘</h3>
              <p className="m-0 text-[13px] text-[#f7d57f]">
                {chart.ziwei.fiveElementsClass} · 命主{chart.ziwei.soulStar} · 身主
                {chart.ziwei.bodyStar}
              </p>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpandedFacts((v) => !v)}
        className="min-h-[44px] bg-transparent border border-[#3a4668] rounded-[10px] text-[#c3cde0] text-[14px] cursor-pointer hover:text-[#f8fafc]"
      >
        {expandedFacts ? '收起部分星体与相位' : '查看全部星体与相位'}
      </button>

      {profile && (
        <p className="m-0 text-[13px] leading-[1.7] text-[#a3b0c5]">
          档案：{profile.name} · {profile.birthDateTime.replace('T', ' ')} ·{' '}
          {profile.locationName.split('，')[0]}（{profile.timezone}）
        </p>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-[#070812] text-[#f8fafc] flex flex-col">
      <div className="hidden lg:block">
        <AppHeader current="consult" tier={tier} used={usage.used} />
      </div>

      {/* Mobile Header matching ChatMobile.dc.html */}
      <header className="flex lg:hidden items-center gap-1 p-2 border-b border-[#1e2740]">
        <a
          href="/consult"
          aria-label="返回咨询列表"
          onClick={(e) => {
            e.preventDefault();
            navigate('/consult');
          }}
          className="flex items-center justify-center w-11 h-11 text-[#c3cde0] no-underline shrink-0"
        >
          <svg
            aria-hidden="true"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </a>
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <h1 className="m-0 font-serif-sc text-[17px] font-bold truncate">
            {session.title}
          </h1>
          <span className="text-[12px] text-[#a8c0f0]">回复由 AI 生成</span>
        </div>
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-1.5 min-h-[44px] px-3 bg-transparent border border-[#3a4668] rounded-[22px] text-[#f7d57f] text-[14px] cursor-pointer shrink-0"
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="4" />
            <path d="M12 3v5M12 16v5M3 12h5M16 12h5" />
          </svg>
          星盘
        </button>
      </header>

      <div className="flex-1 flex items-stretch min-h-0">
        {/* Desktop Left Sidebar: History */}
        <aside className="hidden lg:flex w-[240px] shrink-0 p-6 px-5 border-r border-[#1e2740] flex-col gap-4">
          <a
            href="/consult"
            onClick={(e) => {
              e.preventDefault();
              navigate('/consult');
            }}
            className="flex items-center justify-center gap-2 min-h-[44px] border-[1.5px] border-[#e0b64a] rounded-[10px] text-[#f7d57f] no-underline text-[15px] font-bold hover:bg-[#1d1a0f]"
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
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            新咨询
          </a>

          <h2 className="m-0 mt-2 text-[13px] font-medium text-[#a3b0c5]">历史咨询</h2>
          <nav className="flex flex-col gap-1" aria-label="历史咨询列表">
            {sessions.map((s) => {
              const active = s.id === session.id;
              return (
                <a
                  key={s.id}
                  href={`/consult/${s.id}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/consult/${s.id}`);
                  }}
                  className={`flex flex-col gap-0.5 px-3 py-2.5 rounded-[8px] no-underline ${
                    active
                      ? 'bg-[#161d33] text-[#f8fafc]'
                      : 'text-[#c3cde0] hover:bg-[#101527]'
                  }`}
                >
                  <span className="text-[15px] truncate">{s.title}</span>
                  <span className="font-mono-num text-[12px] text-[#a3b0c5]">
                    {formatSessionDate(s.updatedAt)}
                  </span>
                </a>
              );
            })}
          </nav>
        </aside>

        {/* Main Chat Area */}
        <main className="flex-1 min-w-0 flex flex-col">
          <div className="hidden lg:flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-8 py-4 border-b border-[#1e2740]">
            <h1 className="m-0 font-serif-sc text-[20px] font-bold">{session.title}</h1>
            <span className="flex items-center gap-2 text-[13px] text-[#a8c0f0]">
              <svg
                aria-hidden="true"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8v.5" />
              </svg>
              回复由 AI 生成，仅供自我探索
            </span>
          </div>

          <div className="flex-1 max-w-[760px] w-full mx-auto px-4 sm:px-8 py-6 sm:py-8 flex flex-col gap-6">
            {messages.length === 0 && (
              <div className="p-6 bg-[#101527] border border-[#26304d] rounded-[16px] flex flex-col gap-4">
                <p className="m-0 text-[16px] leading-[1.8] text-[#e8edf6]">
                  已就绪为 <strong className="text-[#f7d57f]">{session.profileName}</strong> 进行「
                  {session.productTitle}」。你可以直接输入最近让你困扰或想厘清的事情，或者先试试下面几个方向：
                </p>
                <div className="flex flex-wrap gap-2.5">
                  {[
                    '最近在考虑工作变动，盘面上有哪些需要注意的特点？',
                    '我现阶段的人际与情绪节律有什么特征？',
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => void sendMessage(prompt)}
                      className="min-h-[44px] px-4 bg-transparent border border-[#3a4668] rounded-[22px] text-[#c3cde0] text-[14px] text-left cursor-pointer hover:border-[#e0b64a] hover:text-[#f8fafc]"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => {
              if (msg.role === 'user') {
                const txt = msg.parts
                  .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                  .map((p) => p.text)
                  .join('\n');
                return (
                  <div
                    key={msg.id}
                    className="self-end max-w-[85%] px-[18px] py-3.5 bg-[#1d2540] rounded-[16px_16px_4px_16px] text-[16px] leading-[1.8]"
                  >
                    {txt}
                  </div>
                );
              }

              const toolCalls = msg.parts.filter(
                (p): p is { type: 'tool-call'; toolName: SessionRecord['frozenTools'][number]; label: string } =>
                  p.type === 'tool-call',
              );
              const textParts = msg.parts
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map((p) => p.text)
                .join('\n');

              return (
                <div key={msg.id} className="flex flex-col gap-4">
                  {toolCalls.map((tc, idx) => (
                    <div
                      key={`${tc.toolName}-${idx}`}
                      className="flex items-center gap-3 px-4 py-3 border border-[#26304d] rounded-[10px] text-[14px] text-[#c3cde0]"
                    >
                      <svg
                        aria-hidden="true"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#e0b64a"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12.5l4.5 4.5L19 7.5" />
                      </svg>
                      <span className="flex-1">{tc.label}</span>
                      <span className="font-mono-num text-[12px] text-[#a3b0c5]">
                        Placidus · 实盘计算
                      </span>
                    </div>
                  ))}

                  {textParts ? (
                    <div className="flex flex-col gap-3.5 text-[16px] leading-[1.9] text-[#e8edf6]">
                      {renderFormattedText(textParts)}
                    </div>
                  ) : (
                    streaming && (
                      <p className="m-0 text-[15px] text-[#a3b0c5]">正在结合星盘事实整理回复...</p>
                    )
                  )}

                  {msg.id === lastAssistant?.id &&
                    !streaming &&
                    !quotaExhausted &&
                    msg.suggestions &&
                    msg.suggestions.length > 0 && (
                      <div className="flex flex-wrap gap-2.5 pt-1">
                        {msg.suggestions.map((sug) => (
                          <button
                            key={sug}
                            type="button"
                            onClick={() => void sendMessage(sug)}
                            className="min-h-[44px] px-4 bg-transparent border border-[#3a4668] rounded-[22px] text-[#c3cde0] text-[14px] text-left cursor-pointer hover:border-[#e0b64a] hover:text-[#f8fafc]"
                          >
                            {sug}
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              );
            })}

            {error && (
              <p role="alert" className="m-0 text-[14px] text-[#ff9d8a]">
                {error}
              </p>
            )}
            <div ref={bottomRef} />
          </div>

          {quotaExhausted ? (
            <section
              aria-label="额度已用完"
              className="flex flex-col gap-3.5 px-4 sm:px-8 pt-5 pb-6 bg-[#101527] border-t border-[#e0b64a] rounded-t-[20px] max-w-[760px] w-full mx-auto"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="m-0 font-serif-sc text-[20px] font-bold">本月额度已用完</h2>
                <span className="font-mono-num text-[15px] text-[#f7d57f]">
                  {usage.used} / {limit}
                </span>
              </div>
              <p className="m-0 text-[15px] leading-[1.7] text-[#c3cde0]">
                这段对话会保留。{nextUtcMonthResetLabel()}额度重置后可以接着聊，或现在升级继续。
              </p>
              <a
                href="/account"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('/account');
                }}
                className="flex items-center justify-center min-h-[52px] bg-[#e0b64a] text-[#1a1405] text-[16px] font-bold no-underline rounded-[12px] hover:bg-[#f7d57f]"
              >
                查看升级方案
              </a>
              <a
                href="/consult"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('/consult');
                }}
                className="flex items-center justify-center min-h-[44px] text-[#c3cde0] text-[15px] no-underline hover:text-[#f8fafc]"
              >
                回到咨询列表
              </a>
            </section>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="max-w-[760px] w-full mx-auto px-4 sm:px-8 pb-6 flex flex-col gap-2.5"
            >
              <div className="flex items-end gap-3 p-2.5 pl-[18px] bg-[#101527] border border-[#3a4668] rounded-[16px]">
                <label htmlFor="msg" className="sr-only">
                  输入消息
                </label>
                <textarea
                  id="msg"
                  rows={2}
                  maxLength={2000}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage(input);
                    }
                  }}
                  placeholder="说说你的处境，或追问上面的任何一点"
                  className="flex-1 min-w-0 py-2 bg-transparent border-0 outline-0 resize-none text-[#f8fafc] text-[16px] leading-[1.6]"
                />
                {streaming ? (
                  <button
                    type="button"
                    aria-label="停止生成"
                    onClick={handleStop}
                    className="flex items-center justify-center w-11 h-11 shrink-0 bg-[#3a4668] border-0 rounded-[12px] text-[#f8fafc] cursor-pointer"
                  >
                    <svg
                      aria-hidden="true"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="submit"
                    aria-label="发送"
                    disabled={!input.trim()}
                    className="flex items-center justify-center w-11 h-11 shrink-0 bg-[#e0b64a] border-0 rounded-[12px] text-[#1a1405] cursor-pointer hover:bg-[#f7d57f] disabled:opacity-40"
                  >
                    <svg
                      aria-hidden="true"
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
                    </svg>
                  </button>
                )}
              </div>
              <p className="m-0 text-[13px] leading-[1.6] text-[#a3b0c5]">
                每条消息消耗 1 次额度，本月还剩 {remaining} 次。
                <a
                  href="/account"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/account');
                  }}
                  className="ml-1"
                >
                  升级方案
                </a>
              </p>
            </form>
          )}
        </main>

        {/* Desktop Right Sidebar: Astro Facts */}
        <aside
          aria-label="星盘事实"
          className="hidden lg:flex w-[320px] shrink-0 p-6 border-l border-[#1e2740] flex-col"
        >
          {factsPanelContent}
        </aside>
      </div>

      {/* Mobile Bottom Drawer for Astro Facts */}
      {drawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="星盘事实"
          className="fixed inset-0 z-50 bg-black/70 flex items-end lg:hidden"
        >
          <div className="w-full max-h-[85vh] overflow-y-auto bg-[#101527] border-t border-[#e0b64a] rounded-t-[20px] p-6 flex flex-col gap-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="min-h-[44px] px-4 bg-transparent border border-[#3a4668] rounded-[10px] text-[#c3cde0] text-[14px] cursor-pointer"
              >
                关闭
              </button>
            </div>
            {factsPanelContent}
          </div>
        </div>
      )}
    </div>
  );
}
