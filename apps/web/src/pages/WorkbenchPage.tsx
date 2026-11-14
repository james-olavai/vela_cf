import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  hasTierAccess,
  nextUtcMonthResetLabel,
  QUOTA_LIMIT,
  TIER_META,
  type CatalogProduct,
  type Gender,
  type LocationCandidate,
  type MessageRecord,
  type ProfileInput,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';
import { ChartFactCard } from '../components/ChartFactCard';
import { SettingsModal, type SettingsTab } from '../components/SettingsModal';
import { updateAnalyticsConsent } from '../lib/firebase';
import { navigate } from '../lib/router';
import {
  fetchNatalChart,
  loadCachedChart,
  loadLocalMessages,
  searchLocations,
  streamConsultationReply,
  type ChartSnapshot,
} from '../lib/store';

export interface PendingHandoff {
  draftProfile: ProfileInput;
  chart: ChartSnapshot | null;
  product: CatalogProduct;
  question: string;
}

interface WorkbenchPageProps {
  uid: string | null;
  email: string;
  tier: Tier;
  usage: UsageRecord;
  profiles: ProfileRecord[];
  products: CatalogProduct[];
  sessions: SessionRecord[];
  activeSession: SessionRecord | null;
  pendingHandoff: PendingHandoff | null;
  onClearPendingHandoff: () => void;
  onRequireAuth: (handoff: PendingHandoff) => void;
  onStartSession: (product: CatalogProduct, profile: ProfileRecord) => SessionRecord;
  onSelectSession: (sessionId: string | null) => void;
  onUsageChange: (usage: UsageRecord) => void;
  onSignOut: () => void;
}

const SAMPLE_PROMPTS = [
  '看看我的性格天赋与核心人生课题',
  '结合星盘，我适合怎样的事业方向？',
  '我在亲密关系中最需要注意什么模式？',
];

function renderFormattedText(text: string) {
  return text.split('\n').map((line, lineIdx) => {
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

export function WorkbenchPage({
  uid,
  email,
  tier,
  usage,
  profiles,
  products,
  sessions,
  activeSession,
  pendingHandoff,
  onClearPendingHandoff,
  onRequireAuth,
  onStartSession,
  onSelectSession,
  onUsageChange,
  onSignOut,
}: WorkbenchPageProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [chartDrawerOpen, setChartDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('subscription');

  const [selectedProductSlug, setSelectedProductSlug] = useState<string>('free-natal');
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');

  // Guest / quick-entry draft state
  const [draftName, setDraftName] = useState('本人');
  const [draftBirth, setDraftBirth] = useState('1994-06-03T08:20');
  const [cityQuery, setCityQuery] = useState('');
  const [cityCandidates, setCityCandidates] = useState<LocationCandidate[]>([]);
  const [selectedCity, setSelectedCity] = useState<LocationCandidate | null>(null);
  const [draftGender, setDraftGender] = useState<Gender>('unset');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [guestChart, setGuestChart] = useState<ChartSnapshot | null>(null);

  // Chat stream state
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [sessionChart, setSessionChart] = useState<ChartSnapshot | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [thinkingPhase, setThinkingPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consentSaved, setConsentSaved] = useState<boolean>(
    () => typeof window !== 'undefined' && localStorage.getItem('vela_consent_analytics') !== null,
  );

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const handoffRunningRef = useRef(false);

  const activeProfile =
    (activeSession && profiles.find((p) => p.id === activeSession.profileId)) ||
    profiles.find((p) => p.id === selectedProfileId) ||
    profiles[0] ||
    null;

  const activeProduct =
    products.find((p) => p.slug === (activeSession?.productSlug ?? selectedProductSlug)) ||
    products[0];

  const limit = QUOTA_LIMIT[tier];
  const quotaExhausted = Boolean(uid) && usage.used >= limit;
  const displayChart = activeSession ? sessionChart : activeProfile ? loadCachedChart(uid ?? 'guest', activeProfile.id) ?? guestChart : guestChart;

  // Sync messages & cached chart when switching session
  useEffect(() => {
    if (!uid || !activeSession) {
      setMessages([]);
      setSessionChart(null);
      return;
    }
    setMessages(loadLocalMessages(uid, activeSession.id));
    setSessionChart(loadCachedChart(uid, activeSession.profileId));
  }, [uid, activeSession?.id]);

  // Auto-calculate chart for logged-in user's active profile if not cached yet
  useEffect(() => {
    if (!uid || !activeProfile) return;
    const cached = loadCachedChart(uid, activeProfile.id);
    if (cached) {
      setGuestChart(cached);
      if (activeSession) setSessionChart(cached);
      return;
    }
    void fetchNatalChart(uid, activeProfile)
      .then((snap) => {
        setGuestChart(snap);
        if (activeSession) setSessionChart(snap);
      })
      .catch(() => {
        // ignore background preview errors
      });
  }, [uid, activeProfile?.id]);

  // Execute pending handoff automatically right after login
  useEffect(() => {
    if (!uid || !activeSession || !pendingHandoff || handoffRunningRef.current) return;
    const prof = profiles.find((p) => p.id === activeSession.profileId);
    if (!prof) return;
    handoffRunningRef.current = true;
    const question = pendingHandoff.question;
    onClearPendingHandoff();
    void runStream(activeSession, prof, question).finally(() => {
      handoffRunningRef.current = false;
    });
  }, [uid, activeSession?.id, pendingHandoff, profiles]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streaming]);

  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setMobileSidebarOpen(false);
  };

  const handleSearchCity = async () => {
    if (!cityQuery.trim()) return;
    setError(null);
    try {
      const list = await searchLocations(cityQuery);
      setCityCandidates(list);
      if (list.length === 0) setError('未找到匹配城市，请尝试英文或拼音（如 Toronto、Beijing）。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '城市搜索失败');
    }
  };

  const buildDraftProfile = (): ProfileInput | null => {
    if (!selectedCity) {
      setError('请先搜索并选中出生城市。');
      return null;
    }
    return {
      name: draftName.trim() || '本人',
      birthDateTime: draftBirth,
      locationName: selectedCity.displayName,
      latitude: selectedCity.latitude,
      longitude: selectedCity.longitude,
      timezone: selectedCity.timezone,
      gender: draftGender,
    };
  };

  const handlePreviewChart = async (e: FormEvent) => {
    e.preventDefault();
    const draft = buildDraftProfile();
    if (!draft) return;
    setPreviewBusy(true);
    setError(null);
    try {
      const tempProfile: ProfileRecord = {
        ...draft,
        id: 'guest_preview',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const snap = await fetchNatalChart(uid ?? 'guest', tempProfile);
      setGuestChart(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : '排盘计算失败');
    } finally {
      setPreviewBusy(false);
    }
  };

  async function runStream(targetSession: SessionRecord, targetProfile: ProfileRecord, text: string) {
    if (!uid) return;
    setError(null);
    setStreaming(true);
    setThinkingPhase('正在核对星盘参数与相位…');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamConsultationReply({
        uid,
        tier,
        session: targetSession,
        profile: targetProfile,
        userText: text,
        signal: controller.signal,
        onUpdateMessages: (next) => {
          setThinkingPhase(null);
          setMessages(next);
        },
        onUpdateChart: (c) => {
          setSessionChart(c);
          setGuestChart(c);
        },
        onUpdateUsage: onUsageChange,
        onQuotaExceeded: () => {
          onUsageChange({ ...usage, used: limit });
        },
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : '生成回复失败，请稍后重试');
      }
    } finally {
      setStreaming(false);
      setThinkingPhase(null);
      abortRef.current = null;
    }
  }

  const handleSend = async (rawText?: string) => {
    const text = (rawText ?? input).trim();
    if (!text || streaming) return;
    setError(null);

    if (!hasTierAccess(tier, activeProduct.minTier)) {
      openSettings('subscription');
      return;
    }

    if (!uid) {
      const draft = buildDraftProfile();
      if (!draft) return;
      onRequireAuth({
        draftProfile: draft,
        chart: guestChart,
        product: activeProduct,
        question: text,
      });
      return;
    }

    let targetProfile = activeProfile;
    if (!targetProfile) {
      openSettings('profiles');
      return;
    }

    let targetSession = activeSession;
    if (!targetSession) {
      if (activeProduct.requiresGender && targetProfile.gender === 'unset') {
        setError(`「${activeProduct.title}」需要性别参数，请在设置中为「${targetProfile.name}」补充性别。`);
        openSettings('profiles');
        return;
      }
      targetSession = onStartSession(activeProduct, targetProfile);
    }

    if (!rawText) setInput('');
    await runStream(targetSession, targetProfile, text);
  };

  const sidebarContent = (isCompact: boolean) => (
    <div className="flex flex-col h-full justify-between">
      <div className="flex flex-col gap-3 min-h-0 flex-1 overflow-y-auto">
        <div className={`flex items-center ${isCompact ? 'justify-center' : 'justify-between gap-2'}`}>
          <button
            type="button"
            onClick={() => {
              onSelectSession(null);
              setMobileSidebarOpen(false);
            }}
            aria-label="新咨询"
            title="新咨询"
            className={`flex items-center justify-center gap-2 min-h-[42px] rounded-[10px] border-[1.5px] border-[#e0b64a] bg-transparent text-[#f7d57f] text-[14px] font-bold hover:bg-[#1d1a0f] cursor-pointer ${
              isCompact ? 'w-10 px-0' : 'flex-1 px-3'
            }`}
          >
            <span>＋</span>
            {!isCompact && <span>新咨询</span>}
          </button>

          {!isCompact && (
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="收起侧栏"
              title="收起侧栏"
              className="hidden lg:flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer"
            >
              ◧
            </button>
          )}
        </div>

        {isCompact ? (
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="展开侧栏"
            title="展开侧栏"
            className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:border-[#e0b64a] cursor-pointer"
          >
            ◨
          </button>
        ) : (
          <>
            {uid && (
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-[12px] text-[#a3b0c5]">
                  <span>出生档案</span>
                  <button
                    type="button"
                    onClick={() => openSettings('profiles')}
                    className="bg-transparent border-0 p-0 text-[12px] text-[#e0b64a] cursor-pointer"
                  >
                    管理
                  </button>
                </div>
                {profiles.length > 0 ? (
                  <select
                    aria-label="切换出生档案"
                    value={activeProfile?.id ?? ''}
                    onChange={(e) => {
                      setSelectedProfileId(e.target.value);
                      onSelectSession(null);
                    }}
                    className="w-full min-h-[38px] px-2.5 rounded-[8px] border border-[#26304d] bg-[#101527] text-[13px] text-[#f8fafc]"
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.birthDateTime.slice(0, 10)})
                      </option>
                    ))}
                  </select>
                ) : (
                  <button
                    type="button"
                    onClick={() => openSettings('profiles')}
                    className="min-h-[38px] rounded-[8px] border border-dashed border-[#3a4668] bg-transparent text-[13px] text-[#e0b64a] cursor-pointer"
                  >
                    + 新建档案
                  </button>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-col gap-1">
              <p className="m-0 mb-1 text-[12px] font-medium text-[#a3b0c5]">历史咨询</p>
              {sessions.length === 0 ? (
                <p className="m-0 text-[12px] text-[#a3b0c5]/70">暂无咨询记录</p>
              ) : (
                sessions.map((s) => {
                  const isCurrent = s.id === activeSession?.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        onSelectSession(s.id);
                        setMobileSidebarOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 rounded-[8px] border-0 cursor-pointer transition-colors ${
                        isCurrent
                          ? 'bg-[#161d33] text-[#f8fafc]'
                          : 'bg-transparent text-[#c3cde0] hover:bg-[#101527]'
                      }`}
                    >
                      <div className="text-[13px] truncate">{s.title}</div>
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>

      {/* Bottom Gear: Settings & Subscription (Gemini style) */}
      <div className="pt-3 border-t border-[#1e2740]">
        <button
          type="button"
          onClick={() => openSettings('subscription')}
          aria-label="设置与订阅"
          title="设置与订阅"
          className={`w-full flex items-center min-h-[44px] rounded-[10px] border border-transparent bg-transparent text-[#c3cde0] hover:bg-[#101527] hover:text-[#f8fafc] cursor-pointer ${
            isCompact ? 'justify-center px-0' : 'justify-between px-3'
          }`}
        >
          <span className="flex items-center gap-2.5 text-[14px]">
            <span aria-hidden="true">⚙</span>
            {!isCompact && <span>设置与订阅</span>}
          </span>
          {!isCompact && (
            <span className="font-mono-num text-[12px] text-[#f7d57f]">
              {TIER_META[tier].label}
            </span>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-dvh bg-[#070812] text-[#f8fafc] flex overflow-hidden">
      {/* Desktop Left Sidebar */}
      <aside
        aria-label="工作台侧栏"
        className={`no-print hidden lg:flex shrink-0 border-r border-[#1e2740] bg-[#090c18] flex-col transition-[width] duration-200 ${
          sidebarOpen ? 'w-[260px] p-4' : 'w-16 py-4 px-2'
        }`}
      >
        {sidebarContent(!sidebarOpen)}
      </aside>

      {/* Mobile Left Drawer */}
      {mobileSidebarOpen && (
        <div className="no-print fixed inset-0 z-40 flex lg:hidden">
          <div className="w-[270px] h-full bg-[#090c18] border-r border-[#1e2740] p-4">
            {sidebarContent(false)}
          </div>
          <button
            type="button"
            aria-label="关闭侧栏"
            onClick={() => setMobileSidebarOpen(false)}
            className="flex-1 bg-black/60 border-0"
          />
        </div>
      )}

      {/* Main Column (Gemini-style single workspace) */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Minimal Top Bar */}
        <header className="no-print flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-[#1e2740]">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label="打开菜单"
              className="lg:hidden min-h-[40px] min-w-[40px] rounded-[8px] border border-[#26304d] bg-transparent text-[#f8fafc] cursor-pointer"
            >
              ☰
            </button>
            <span className="font-brand text-[18px] font-semibold tracking-[0.28em] text-[#e0b64a]">
              VELA
            </span>

            {/* Mode Switcher */}
            <div className="hidden sm:flex items-center gap-1.5 ml-2 p-1 rounded-[10px] border border-[#26304d] bg-[#101527]">
              {products.map((p) => {
                const locked = !hasTierAccess(tier, p.minTier);
                const selected = activeProduct.slug === p.slug;
                return (
                  <button
                    key={p.slug}
                    type="button"
                    onClick={() => {
                      if (locked) {
                        openSettings('subscription');
                        return;
                      }
                      setSelectedProductSlug(p.slug);
                      if (activeSession && activeSession.productSlug !== p.slug) {
                        onSelectSession(null);
                      }
                    }}
                    className={`min-h-[32px] px-3 rounded-[7px] border-0 text-[13px] cursor-pointer transition-colors ${
                      selected
                        ? 'bg-[#1d2540] text-[#f8fafc] font-medium'
                        : 'bg-transparent text-[#c3cde0] hover:text-[#f8fafc]'
                    }`}
                  >
                    {p.title}
                    {locked && ' 🔒'}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {displayChart && (
              <button
                type="button"
                onClick={() => setChartDrawerOpen(true)}
                className="min-h-[38px] px-3 rounded-[10px] border border-[#26304d] bg-[#101527] text-[13px] text-[#f7d57f] hover:border-[#e0b64a] cursor-pointer"
              >
                ✦ 星盘
              </button>
            )}
            <button
              type="button"
              onClick={() => openSettings('subscription')}
              className="min-h-[38px] px-3 rounded-[20px] border border-[#26304d] bg-transparent font-mono-num text-[13px] text-[#f7d57f] cursor-pointer hover:border-[#3a4668]"
            >
              {usage.used} / {limit}
            </button>
          </div>
        </header>

        {/* Scrollable Content */}
        <main className="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
          <div className="max-w-[780px] mx-auto flex flex-col gap-6">
            {!activeSession ? (
              <>
                <div className="text-center pt-2 flex flex-col gap-2">
                  <h1 className="m-0 font-serif-sc text-[28px] sm:text-[32px] font-bold text-[#f8fafc]">
                    以星盘事实为依据的 AI 深度对话
                  </h1>
                  <p className="m-0 text-[14px] text-[#c3cde0]">
                    先免费算出你的 Placidus 本命星盘，再随时向 AI 提问解读。
                  </p>
                </div>

                {/* Guest / Quick Birth Entry Card */}
                {!activeProfile && (
                  <form
                    onSubmit={(e) => void handlePreviewChart(e)}
                    className="no-print rounded-[16px] border border-[#26304d] bg-[#101527] p-5 flex flex-col gap-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[14px] font-bold text-[#f8fafc]">
                        第 1 步：录入出生信息（免登录即时看盘）
                      </span>
                      <span className="text-[12px] text-[#a3b0c5]">Placidus 宫位制</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <input
                        placeholder="称呼（如：本人）"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        className="min-h-[42px] px-3 rounded-[8px] border border-[#3a4668] bg-[#070812] text-[#f8fafc] text-[14px]"
                      />
                      <input
                        type="datetime-local"
                        value={draftBirth}
                        onChange={(e) => setDraftBirth(e.target.value)}
                        className="min-h-[42px] px-3 rounded-[8px] border border-[#3a4668] bg-[#070812] text-[#f8fafc] text-[14px]"
                      />
                      <select
                        value={draftGender}
                        onChange={(e) => setDraftGender(e.target.value as Gender)}
                        aria-label="性别"
                        className="min-h-[42px] px-3 rounded-[8px] border border-[#3a4668] bg-[#070812] text-[#f8fafc] text-[14px]"
                      >
                        <option value="unset">性别（可选）</option>
                        <option value="female">女</option>
                        <option value="male">男</option>
                      </select>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <input
                        placeholder="搜索出生城市（如：Toronto、北京、台北）"
                        value={cityQuery}
                        onChange={(e) => setCityQuery(e.target.value)}
                        className="flex-1 min-w-[200px] min-h-[42px] px-3 rounded-[8px] border border-[#3a4668] bg-[#070812] text-[#f8fafc] text-[14px]"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSearchCity()}
                        className="min-h-[42px] px-4 rounded-[8px] border border-[#3a4668] bg-[#161d33] text-[#f8fafc] text-[13px] cursor-pointer"
                      >
                        搜索城市
                      </button>
                      <button
                        type="submit"
                        disabled={previewBusy}
                        className="min-h-[42px] px-5 rounded-[8px] bg-[#e0b64a] text-[#1a1405] text-[14px] font-bold border-0 cursor-pointer hover:bg-[#f7d57f]"
                      >
                        {previewBusy ? '计算中…' : '生成我的星盘'}
                      </button>
                    </div>
                    {cityCandidates.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {cityCandidates.map((c, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => {
                              setSelectedCity(c);
                              setCityQuery(c.displayName);
                              setCityCandidates([]);
                            }}
                            className="px-3 py-1.5 rounded-[8px] border border-[#26304d] bg-[#161d33] text-[12px] text-[#f8fafc] hover:border-[#e0b64a] cursor-pointer"
                          >
                            {c.displayName}
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="m-0 text-[12px] text-[#a3b0c5]">
                      仅用于实时计算星盘，登录确认后才会保存档案。
                    </p>
                  </form>
                )}

                {/* Inline Chart Preview Card */}
                {displayChart && (
                  <ChartFactCard
                    chart={displayChart}
                    profileName={activeProfile?.name ?? draftName}
                    birthSummary={
                      activeProfile
                        ? `${activeProfile.birthDateTime.replace('T', ' ')}`
                        : draftBirth.replace('T', ' ')
                    }
                    defaultExpanded
                  />
                )}

                {/* Retained 2-Column Consultation Cards */}
                <section className="no-print flex flex-col gap-3">
                  <p className="m-0 text-[13px] font-medium text-[#a3b0c5]">选择咨询模式</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {products.map((p) => {
                      const locked = !hasTierAccess(tier, p.minTier);
                      const selected = activeProduct.slug === p.slug;
                      return (
                        <button
                          key={p.slug}
                          type="button"
                          onClick={() => {
                            if (locked) openSettings('subscription');
                            else setSelectedProductSlug(p.slug);
                          }}
                          className={`p-4 rounded-[14px] border text-left flex flex-col gap-2 cursor-pointer transition-colors ${
                            selected
                              ? 'border-[#e0b64a] bg-[#1d1a0f]'
                              : 'border-[#26304d] bg-[#101527] hover:border-[#3a4668]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-serif-sc text-[17px] font-bold text-[#f8fafc]">
                              {p.title}
                            </span>
                            <span className="px-2 py-0.5 rounded-[6px] border border-[#3a4668] font-mono-num text-[11px] text-[#f7d57f]">
                              {p.minTier.toUpperCase()}
                              {locked ? ' 🔒' : ''}
                            </span>
                          </div>
                          <p className="m-0 text-[13px] leading-[1.6] text-[#c3cde0]">
                            {p.description}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Sample Prompt Chips */}
                <div className="no-print flex flex-wrap gap-2">
                  {SAMPLE_PROMPTS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => void handleSend(q)}
                      className="px-3.5 py-2 rounded-[20px] border border-[#26304d] bg-[#101527] text-[13px] text-[#c3cde0] hover:border-[#e0b64a] hover:text-[#f8fafc] cursor-pointer"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                {/* Inline Chart Card at top of conversation */}
                {displayChart && (
                  <ChartFactCard
                    chart={displayChart}
                    profileName={activeProfile?.name ?? activeSession.profileName}
                    birthSummary={activeProfile?.birthDateTime.replace('T', ' ')}
                  />
                )}

                {messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  const textPart = msg.parts.find((p) => p.type === 'text');
                  const toolParts = msg.parts.filter((p) => p.type === 'tool-result');
                  return (
                    <div key={msg.id} className={`flex flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}>
                      {toolParts.map((tp, idx) => (
                        <div
                          key={idx}
                          className="px-3 py-1.5 rounded-[8px] border border-[#26304d] bg-[#101527] text-[12px] text-[#f7d57f]"
                        >
                          ✓ 已排盘：{tp.label}
                        </div>
                      ))}

                      {textPart && textPart.type === 'text' && (
                        <div
                          className={
                            isUser
                              ? 'max-w-[82%] px-4 py-3 rounded-[14px] bg-[#1d2540] text-[15px] leading-[1.7] text-[#f8fafc]'
                              : 'w-full text-[15px] leading-[1.8] text-[#e8edf6] flex flex-col gap-2.5'
                          }
                        >
                          {renderFormattedText(textPart.text)}
                        </div>
                      )}

                      {!isUser && msg.suggestions && msg.suggestions.length > 0 && !streaming && (
                        <div className="no-print flex flex-wrap gap-2 mt-1">
                          {msg.suggestions.map((sug) => (
                            <button
                              key={sug}
                              type="button"
                              onClick={() => void handleSend(sug)}
                              className="px-3 py-1.5 rounded-[18px] border border-[#26304d] bg-[#101527] text-[12px] text-[#c3cde0] hover:border-[#e0b64a] hover:text-[#f8fafc] cursor-pointer"
                            >
                              {sug}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Thinking Animation */}
                {streaming && thinkingPhase && (
                  <div role="status" className="flex items-center gap-3 px-4 py-3 rounded-[12px] border border-[#26304d] bg-[#101527] text-[14px] text-[#f7d57f]">
                    <span className="vela-thinking-dot inline-block h-2.5 w-2.5 rounded-full bg-[#e0b64a]" />
                    <span>{thinkingPhase}</span>
                  </div>
                )}

                <div ref={bottomRef} />
              </>
            )}

            {error && (
              <p role="alert" className="m-0 px-4 py-2.5 rounded-[10px] border border-[#ff9d8a]/40 bg-[#101527] text-[13px] text-[#ff9d8a]">
                {error}
              </p>
            )}
          </div>
        </main>

        {/* Bottom Composer or In-Place Quota Exhausted Bar */}
        <footer className="no-print px-4 sm:px-8 pb-4 pt-2 border-t border-[#1e2740]/60 bg-[#070812]">
          <div className="max-w-[780px] mx-auto flex flex-col gap-2">
            {quotaExhausted ? (
              <div className="p-4 rounded-[14px] border border-[#e0b64a]/50 bg-[#1d1a0f] flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="m-0 text-[14px] font-bold text-[#f8fafc]">
                    本月免费额度已用完（{usage.used} / {limit}）
                  </p>
                  <p className="m-0 text-[12px] text-[#c3cde0]">
                    将于 {nextUtcMonthResetLabel()} 重置，已有对话与星盘保持可读。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openSettings('subscription')}
                  className="min-h-[42px] px-5 rounded-[10px] bg-[#e0b64a] text-[#1a1405] text-[14px] font-bold border-0 cursor-pointer"
                >
                  查看升级方案
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSend();
                }}
                className="flex items-end gap-2 p-2 rounded-[14px] border border-[#26304d] bg-[#101527]"
              >
                <textarea
                  rows={1}
                  maxLength={2000}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder={uid ? '输入你想探讨的星盘问题…' : '输入你的第一个问题（发送时登录保存档案）…'}
                  className="flex-1 min-h-[42px] max-h-[140px] resize-none bg-transparent border-0 px-2.5 py-2 text-[15px] text-[#f8fafc] focus:outline-none"
                />
                {streaming ? (
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    className="min-h-[42px] px-4 rounded-[10px] border border-[#ff9d8a]/60 bg-transparent text-[#ff9d8a] text-[13px] font-bold cursor-pointer shrink-0"
                  >
                    停止
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    className="min-h-[42px] px-5 rounded-[10px] bg-[#e0b64a] text-[#1a1405] text-[14px] font-bold border-0 cursor-pointer hover:bg-[#f7d57f] disabled:opacity-40 shrink-0"
                  >
                    发送
                  </button>
                )}
              </form>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#a3b0c5] px-1">
              <span>AI 生成内容仅供娱乐与自我探索，不构成医疗、法律或财务建议 · 每轮消耗 1 次额度</span>
              <span className="flex items-center gap-3">
                <a
                  href="/privacy"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/privacy');
                  }}
                >
                  隐私政策
                </a>
                <a
                  href="/terms"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/terms');
                  }}
                >
                  服务条款
                </a>
                {!consentSaved && (
                  <button
                    type="button"
                    onClick={() => {
                      updateAnalyticsConsent(true);
                      setConsentSaved(true);
                    }}
                    className="bg-transparent border-0 p-0 text-[11px] text-[#e0b64a] underline cursor-pointer"
                  >
                    允许匿名统计
                  </button>
                )}
              </span>
            </div>
          </div>
        </footer>
      </div>

      {/* On-Demand Right Slide-Over Chart Drawer */}
      {chartDrawerOpen && displayChart && (
        <div className="no-print fixed inset-0 z-40 flex justify-end">
          <button
            type="button"
            aria-label="关闭星盘抽屉"
            onClick={() => setChartDrawerOpen(false)}
            className="flex-1 bg-black/60 border-0"
          />
          <aside className="w-full max-w-[460px] h-full bg-[#070812] border-l border-[#1e2740] p-5 overflow-y-auto flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="m-0 font-serif-sc text-[18px] font-bold text-[#f8fafc]">星盘事实对照</h2>
              <button
                type="button"
                onClick={() => setChartDrawerOpen(false)}
                className="min-h-[36px] min-w-[36px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] cursor-pointer"
              >
                ✕
              </button>
            </div>
            <ChartFactCard
              chart={displayChart}
              profileName={activeProfile?.name ?? draftName}
              birthSummary={activeProfile?.birthDateTime.replace('T', ' ') ?? draftBirth.replace('T', ' ')}
              defaultExpanded
            />
          </aside>
        </div>
      )}

      {/* Unified Settings & Subscription Modal */}
      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        uid={uid}
        email={email}
        tier={tier}
        usage={usage}
        profiles={profiles}
        onClose={() => setSettingsOpen(false)}
        onSignOut={onSignOut}
        onRequireLogin={() => {
          const draft = buildDraftProfile();
          if (draft) {
            onRequireAuth({
              draftProfile: draft,
              chart: guestChart,
              product: activeProduct,
              question: input.trim(),
            });
          } else {
            onRequireAuth({
              draftProfile: {
                name: draftName || '本人',
                birthDateTime: draftBirth,
                locationName: '多伦多，安大略省，加拿大',
                latitude: 43.6532,
                longitude: -79.3832,
                timezone: 'America/Toronto',
                gender: draftGender,
              },
              chart: guestChart,
              product: activeProduct,
              question: '',
            });
          }
        }}
      />
    </div>
  );
}
