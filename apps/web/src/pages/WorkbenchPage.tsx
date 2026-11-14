import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  nextUtcMonthResetLabel,
  QUOTA_BUDGET_MICRO_USD,
  TIER_META,
  type ConsultationMode,
  type MessageRecord,
  type ProfileInput,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';
import { ChartFactCard } from '../components/ChartFactCard';
import { HistorySearchModal } from '../components/HistorySearchModal';
import {
  IconArrowUp,
  IconChevronsLeft,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconStop,
} from '../components/Icons';
import { NatalWheelSvg } from '../components/NatalWheelSvg';
import { ProfileSidebarPanel } from '../components/ProfileSidebarPanel';
import { SettingsModal, type SettingsTab } from '../components/SettingsModal';
import { navigate } from '../lib/router';
import {
  fetchNatalChart,
  loadCachedChart,
  loadLocalMessages,
  removeProfile,
  saveProfile,
  streamConsultationReply,
  type ChartSnapshot,
} from '../lib/store';

export interface PendingHandoff {
  draftProfiles: ProfileInput[];
  chart: ChartSnapshot | null;
  mode: ConsultationMode;
  selectedIndices: number[];
  question: string;
}

interface WorkbenchPageProps {
  uid: string | null;
  email: string;
  displayName: string;
  photoURL: string | null;
  tier: Tier;
  usage: UsageRecord;
  profiles: ProfileRecord[];
  sessions: SessionRecord[];
  activeSession: SessionRecord | null;
  pendingHandoff: PendingHandoff | null;
  onClearPendingHandoff: () => void;
  onRequireAuth: (handoff: PendingHandoff) => void;
  onStartSession: (mode: ConsultationMode, profiles: ProfileRecord[]) => SessionRecord;
  onSelectSession: (sessionId: string | null) => void;
  onUsageChange: (usage: UsageRecord) => void;
  onSignOut: () => void;
}

function renderFormattedText(text: string) {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((para, pIdx) => {
    const tokens = para.split(/(\*\*[^*]+\*\*)/g);
    return (
      <p key={pIdx} className="m-0 mb-3 last:mb-0 text-[15.5px] leading-[1.85] text-[#e8edf6] whitespace-pre-wrap">
        {tokens.map((tok, tIdx) => {
          if (tok.startsWith('**') && tok.endsWith('**')) {
            return (
              <strong key={tIdx} className="font-semibold text-[#f7d57f]">
                {tok.slice(2, -2)}
              </strong>
            );
          }
          return <span key={tIdx}>{tok}</span>;
        })}
      </p>
    );
  });
}

export function WorkbenchPage({
  uid,
  email,
  displayName,
  photoURL,
  tier,
  usage,
  profiles,
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [chartDrawerOpen, setChartDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('subscription');

  // Visitor local draft profiles before login
  const [draftProfiles, setDraftProfiles] = useState<ProfileRecord[]>([]);
  const effectiveProfiles = uid ? profiles : draftProfiles;

  const [mode, setMode] = useState<ConsultationMode>('personal');
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);

  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [chart, setChart] = useState<ChartSnapshot | null>(null);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const handoffConsumedRef = useRef(false);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [inputText]);

  // Keep selectedProfileIds valid when profiles or mode change
  useEffect(() => {
    if (effectiveProfiles.length === 0) {
      setSelectedProfileIds([]);
      return;
    }
    const validIds = selectedProfileIds.filter((id) =>
      effectiveProfiles.some((p) => p.id === id),
    );
    if (mode === 'personal') {
      if (validIds.length !== 1) {
        setSelectedProfileIds([validIds[0] ?? effectiveProfiles[0].id]);
      }
    } else {
      const maxCount = Math.max(2, TIER_META[tier].maxSynastryProfiles);
      if (validIds.length === 0) {
        setSelectedProfileIds(effectiveProfiles.slice(0, maxCount).map((p) => p.id));
      } else if (validIds.length > maxCount) {
        setSelectedProfileIds(validIds.slice(0, maxCount));
      }
    }
  }, [effectiveProfiles, mode, tier]);

  // Sync active session messages & chart
  useEffect(() => {
    if (!uid || !activeSession) {
      setMessages([]);
      return;
    }
    setMode(activeSession.mode ?? 'personal');
    const sessionPids =
      activeSession.profileIds && activeSession.profileIds.length > 0
        ? activeSession.profileIds
        : [activeSession.profileId];
    setSelectedProfileIds(sessionPids);

    const msgs = loadLocalMessages(uid, activeSession.id);
    setMessages(msgs);
    const cached = loadCachedChart(uid, sessionPids[0]);
    if (cached) {
      setChart(cached);
    } else {
      const p = profiles.find((x) => x.id === sessionPids[0]);
      if (p) {
        void fetchNatalChart(uid, p).then(setChart).catch(() => {});
      }
    }
  }, [uid, activeSession?.id]);

  // Preview primary profile's chart in drawer
  useEffect(() => {
    if (activeSession || selectedProfileIds.length === 0) return;
    const primary = effectiveProfiles.find((p) => p.id === selectedProfileIds[0]);
    if (!primary) return;
    void fetchNatalChart(uid, primary).then(setChart).catch(() => {});
  }, [uid, selectedProfileIds[0], activeSession?.id]);

  // Resume pending handoff after Google login
  useEffect(() => {
    if (!uid || !activeSession || !pendingHandoff || handoffConsumedRef.current) return;
    handoffConsumedRef.current = true;
    const sessionProfiles = profiles.filter((p) =>
      activeSession.profileIds?.includes(p.id) || p.id === activeSession.profileId,
    );
    if (sessionProfiles.length === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    setStreamError(null);

    void streamConsultationReply({
      uid,
      tier,
      session: activeSession,
      profiles: sessionProfiles,
      userText: pendingHandoff.question,
      signal: controller.signal,
      onUpdateMessages: setMessages,
      onUpdateChart: setChart,
      onUpdateUsage: onUsageChange,
      onQuotaExceeded: () => {},
    })
      .catch((err) => {
        setStreamError(err instanceof Error ? err.message : '生成回复失败');
      })
      .finally(() => {
        setIsStreaming(false);
        abortRef.current = null;
        onClearPendingHandoff();
      });
  }, [uid, activeSession?.id, pendingHandoff, profiles]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const quotaExhausted = Boolean(uid) && usage.used >= QUOTA_BUDGET_MICRO_USD[tier];
  const activeProfiles = effectiveProfiles.filter((p) => selectedProfileIds.includes(p.id));
  const needsMoreProfiles =
    effectiveProfiles.length === 0 ||
    (mode === 'synastry' && (TIER_META[tier].maxSynastryProfiles < 2 || activeProfiles.length < 2));

  const handleToggleProfile = (id: string) => {
    if (mode === 'personal') {
      setSelectedProfileIds([id]);
      return;
    }
    const maxCount = Math.max(2, TIER_META[tier].maxSynastryProfiles);
    setSelectedProfileIds((prev) => {
      if (prev.includes(id)) {
        return prev.length > 1 ? prev.filter((x) => x !== id) : prev;
      }
      if (prev.length >= maxCount) {
        return [...prev.slice(1), id];
      }
      return [...prev, id];
    });
  };

  const handleSaveSidebarProfile = async (input: ProfileInput, editId?: string) => {
    if (uid) {
      const savedId = await saveProfile(uid, editId ?? null, input);
      if (!editId) {
        setSelectedProfileIds((prev) =>
          mode === 'personal' ? [savedId] : [...prev.slice(0, 3), savedId],
        );
      }
      return;
    }
    const now = new Date().toISOString();
    const nextId = editId ?? `draft_${Date.now().toString(36)}`;
    const record: ProfileRecord = {
      ...input,
      id: nextId,
      createdAt: now,
      updatedAt: now,
    };
    setDraftProfiles((prev) =>
      editId ? prev.map((p) => (p.id === editId ? record : p)) : [record, ...prev],
    );
    setSelectedProfileIds((prev) =>
      mode === 'personal' ? [nextId] : [...prev.slice(0, 3), nextId],
    );
    const preview = await fetchNatalChart(null, record);
    setChart(preview);
  };

  const handleDeleteSidebarProfile = async (id: string) => {
    if (uid) {
      await removeProfile(uid, id);
    } else {
      setDraftProfiles((prev) => prev.filter((p) => p.id !== id));
    }
    setSelectedProfileIds((prev) => prev.filter((x) => x !== id));
  };

  const handleSend = async (rawText?: string) => {
    const text = (rawText ?? inputText).trim();
    if (!text || isStreaming) return;
    setStreamError(null);

    if (effectiveProfiles.length === 0) {
      setStreamError('请先在左侧边栏点击「+ 添加出生信息」');
      return;
    }
    if (mode === 'synastry') {
      if (TIER_META[tier].maxSynastryProfiles < 2) {
        setSettingsTab('subscription');
        setSettingsOpen(true);
        return;
      }
      if (activeProfiles.length < 2) {
        setStreamError('多人合盘请在左侧边栏至少勾选 2 个档案');
        return;
      }
    }

    if (!uid) {
      const selectedIndices = activeProfiles
        .map((p) => effectiveProfiles.findIndex((x) => x.id === p.id))
        .filter((i) => i >= 0);
      handoffConsumedRef.current = false;
      onRequireAuth({
        draftProfiles: effectiveProfiles.map((p) => ({
          name: p.name,
          entityType: p.entityType ?? 'person',
          birthDateTime: p.birthDateTime,
          locationName: p.locationName,
          latitude: p.latitude,
          longitude: p.longitude,
          timezone: p.timezone,
          gender: p.gender ?? 'unset',
        })),
        chart,
        mode,
        selectedIndices: selectedIndices.length > 0 ? selectedIndices : [0],
        question: text,
      });
      return;
    }

    if (quotaExhausted) return;
    setInputText('');

    const targetSession = activeSession ?? onStartSession(mode, activeProfiles);
    const sessionProfiles =
      activeSession && activeSession.profileIds?.length
        ? profiles.filter((p) => activeSession.profileIds.includes(p.id))
        : activeProfiles;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);

    try {
      await streamConsultationReply({
        uid,
        tier,
        session: targetSession,
        profiles: sessionProfiles.length > 0 ? sessionProfiles : activeProfiles,
        userText: text,
        signal: controller.signal,
        onUpdateMessages: setMessages,
        onUpdateChart: setChart,
        onUpdateUsage: onUsageChange,
        onQuotaExceeded: () => {},
      });
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : '发送失败，请重试');
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const handleSubmitForm = (e: FormEvent) => {
    e.preventDefault();
    void handleSend();
  };

  const avatarRingClass =
    tier === 'pro'
      ? 'ring-2 ring-[#e0b64a] shadow-[0_0_10px_rgba(224,182,74,0.55)]'
      : tier === 'go'
        ? 'ring-2 ring-[#cbd5e1] shadow-[0_0_8px_rgba(203,213,225,0.45)]'
        : 'ring-2 ring-[#64748b]';

  const renderAvatar = () =>
    photoURL ? (
      <img
        src={photoURL}
        alt={displayName}
        className={`w-8 h-8 rounded-full object-cover shrink-0 ${avatarRingClass}`}
      />
    ) : (
      <div
        className={`w-8 h-8 rounded-full bg-[#1d2540] flex items-center justify-center text-[12px] font-bold text-[#f7d57f] shrink-0 ${avatarRingClass}`}
      >
        {displayName.slice(0, 1).toUpperCase()}
      </div>
    );

  const renderCollapsedRail = () => (
    <div className="flex flex-col items-center justify-between h-full bg-[#070812]">
      <div className="w-full flex flex-col items-center gap-2">
        <div className="w-full h-[64px] px-2.5 flex items-center justify-center shrink-0">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            title="展开侧栏"
            aria-label="展开侧栏"
            className="flex items-center justify-center bg-transparent border-0 p-1 rounded-[12px] hover:bg-[#101527] cursor-pointer"
          >
            <img src="/assets/logo-small.webp" alt="Vela" className="brand-logo" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => onSelectSession(null)}
          title="新咨询"
          aria-label="新咨询"
          className="w-11 h-11 rounded-full border border-[#26304d] bg-[#101527] hover:border-[#e0b64a] text-[#e0b64a] flex items-center justify-center cursor-pointer"
        >
          <IconPlus size={18} />
        </button>

        <button
          type="button"
          onClick={() => setHistorySearchOpen(true)}
          title="搜索历史对话"
          aria-label="搜索历史对话"
          className="w-11 h-11 rounded-[12px] border-0 bg-transparent hover:bg-[#101527] text-[#c3cde0] hover:text-[#f8fafc] flex items-center justify-center cursor-pointer"
        >
          <IconSearch size={18} />
        </button>

        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          title="出生档案与合盘"
          aria-label="出生档案与合盘"
          className="w-11 h-11 rounded-[12px] border-0 bg-transparent hover:bg-[#101527] text-[#f7d57f] flex items-center justify-center cursor-pointer"
        >
          <IconSparkles size={18} />
        </button>
      </div>

      <div className="pb-3 flex flex-col items-center">
        <button
          type="button"
          onClick={() => {
            setSettingsTab('subscription');
            setSettingsOpen(true);
          }}
          title={`${displayName} · ${TIER_META[tier].label}`}
          aria-label={`账号与订阅：${displayName}`}
          className="w-11 h-11 rounded-full border-0 bg-transparent hover:bg-[#101527] flex items-center justify-center cursor-pointer"
        >
          {renderAvatar()}
        </button>
      </div>
    </div>
  );

  const renderSidebarContent = () => (
    <div className="flex flex-col h-full bg-[#101527] border-r border-[#1e2740]">
      <div className="h-[64px] px-2.5 flex items-center justify-between shrink-0">
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          title="收起侧栏"
          aria-label="收起侧栏"
          className="flex items-center gap-2.5 bg-transparent border-0 p-1 rounded-[12px] hover:bg-[#161d33] cursor-pointer"
        >
          <img src="/assets/logo-small.webp" alt="Vela" className="brand-logo" />
          <span className="wordmark text-[18px] font-semibold text-[#f8fafc]">VELA</span>
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setHistorySearchOpen(true)}
            title="搜索历史对话"
            aria-label="搜索历史对话"
            className="w-9 h-9 rounded-[10px] border-0 bg-transparent hover:bg-[#161d33] text-[#c3cde0] hover:text-[#f8fafc] flex items-center justify-center cursor-pointer"
          >
            <IconSearch size={18} />
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            title="折叠侧栏"
            aria-label="折叠侧栏"
            className="w-9 h-9 rounded-[10px] border-0 bg-transparent hover:bg-[#161d33] text-[#c3cde0] hover:text-[#f8fafc] flex items-center justify-center cursor-pointer"
          >
            <IconChevronsLeft size={18} />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => {
            onSelectSession(null);
            setSidebarOpen(false);
          }}
          className="w-full min-h-[40px] px-3 rounded-[20px] border border-[#26304d] bg-[#161d33] hover:border-[#e0b64a] text-[#f8fafc] text-[13.5px] font-medium flex items-center justify-center gap-2 cursor-pointer"
        >
          <span className="text-[#e0b64a] flex items-center">
            <IconPlus size={16} />
          </span>
          <span>新咨询</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <ProfileSidebarPanel
          tier={tier}
          mode={mode}
          profiles={effectiveProfiles}
          selectedProfileIds={selectedProfileIds}
          onToggleProfile={handleToggleProfile}
          onSaveProfile={handleSaveSidebarProfile}
          onDeleteProfile={handleDeleteSidebarProfile}
          onOpenUpgrade={() => {
            setSettingsTab('subscription');
            setSettingsOpen(true);
          }}
        />
      </div>

      <div className="p-3 border-t border-[#1e2740]">
        <button
          type="button"
          onClick={() => {
            setSettingsTab('subscription');
            setSettingsOpen(true);
          }}
          className="w-full flex items-center gap-2.5 min-w-0 p-1.5 rounded-[10px] border-0 bg-transparent hover:bg-[#161d33] text-left cursor-pointer"
        >
          {renderAvatar()}
          <div className="min-w-0 flex flex-col">
            <span className="text-[13px] font-medium text-[#f8fafc] truncate">{displayName}</span>
            <span className="text-[11px] text-[#a3b0c5]">{TIER_META[tier].label}</span>
          </div>
        </button>
      </div>
    </div>
  );

  const renderComposer = () => (
    <div className="no-print w-full max-w-[760px] mx-auto flex flex-col gap-2">
      {streamError && (
        <div className="px-3.5 py-2 rounded-[10px] border border-[#ff9d8a]/40 bg-[#1d1215] text-[13px] text-[#ff9d8a]">
          {streamError}
        </div>
      )}

      {quotaExhausted ? (
        <div className="p-4 rounded-[20px] border border-[#e0b64a]/50 bg-[#101527] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[14px] font-bold text-[#f8fafc]">
              本月额度已用完（100%）
            </p>
            <p className="m-0 text-[12px] text-[#a3b0c5]">
              下次重置：{nextUtcMonthResetLabel()}（UTC）
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setSettingsTab('subscription');
              setSettingsOpen(true);
            }}
            className="min-h-[40px] px-5 rounded-[20px] border-0 bg-[#e0b64a] text-[#1a1405] text-[13px] font-bold cursor-pointer"
          >
            升级订阅继续对话
          </button>
        </div>
      ) : (
        <form
          onSubmit={handleSubmitForm}
          className="rounded-[24px] border border-[#26304d] bg-[#101527] px-3.5 py-2.5 flex flex-col gap-2 focus-within:border-[#3a4668]"
        >
          <textarea
            ref={textareaRef}
            rows={1}
            maxLength={2000}
            disabled={needsMoreProfiles && effectiveProfiles.length === 0}
            placeholder={
              effectiveProfiles.length === 0
                ? '点击左上角 Logo 添加出生信息'
                : mode === 'synastry' && activeProfiles.length < 2
                  ? '请在左侧边栏勾选 2–4 个档案以开启多人合盘…'
                  : '问 Vela 任何关于星盘、行运或关系的问题…'
            }
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleSend();
              }
            }}
            className="w-full resize-none bg-transparent border-0 text-[15px] leading-[1.6] text-[#f8fafc] placeholder-[#a3b0c5] focus:outline-none disabled:opacity-60"
          />

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {(
                [
                  { id: 'personal', label: '个人星盘' },
                  {
                    id: 'synastry',
                    label: TIER_META[tier].maxSynastryProfiles < 2 ? '多人合盘 🔒' : '多人合盘',
                  },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={Boolean(activeSession)}
                  onClick={() => setMode(m.id)}
                  className={`min-h-[32px] px-3 rounded-[16px] border text-[12px] font-medium cursor-pointer disabled:opacity-60 ${
                    mode === m.id
                      ? 'border-[#e0b64a] bg-[#1d1a0f] text-[#f7d57f]'
                      : 'border-[#26304d] bg-[#161d33] text-[#c3cde0]'
                  }`}
                >
                  {m.label}
                </button>
              ))}
              {inputText.length > 1500 && (
                <span className="ml-1 font-mono-num text-[11px] text-[#a3b0c5]">
                  {inputText.length}/2000
                </span>
              )}
            </div>

            {isStreaming ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                aria-label="停止生成"
                className="w-9 h-9 rounded-full border-0 bg-[#e0b64a] text-[#1a1405] flex items-center justify-center cursor-pointer"
              >
                <IconStop size={15} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputText.trim() || needsMoreProfiles}
                aria-label="发送"
                className="w-9 h-9 rounded-full border-0 bg-[#e0b64a] text-[#1a1405] flex items-center justify-center cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
              >
                <IconArrowUp size={18} />
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );

  return (
    <div className="h-[100dvh] w-full flex bg-[#070812] text-[#f8fafc] overflow-hidden">
      {/* Desktop Persistent Left Rail / Expanded Sidebar */}
      <aside className={`no-print hidden lg:block h-full shrink-0 ${sidebarOpen ? 'w-[280px]' : 'w-[72px]'}`}>
        {sidebarOpen ? renderSidebarContent() : renderCollapsedRail()}
      </aside>

      {/* Mobile Slide-In Left Sidebar */}
      {sidebarOpen && (
        <div className="no-print fixed inset-0 z-40 flex lg:hidden">
          <aside className="w-[280px] h-full shrink-0">{renderSidebarContent()}</aside>
          <button
            type="button"
            aria-label="关闭侧栏"
            onClick={() => setSidebarOpen(false)}
            className="flex-1 bg-black/55 border-0 cursor-pointer"
          />
        </div>
      )}

      {/* Main Column */}
      <main className="flex-1 min-w-0 flex flex-col h-full relative">
        {isStreaming && (
          <div
            aria-hidden="true"
            className="no-print pointer-events-none absolute inset-x-0 top-0 h-[240px] vela-aurora-glow"
          />
        )}
        {/* Unified Borderless Top Header */}
        <header className="no-print shrink-0 h-[64px] px-2.5 lg:px-5 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              title="打开侧栏与档案"
              aria-label="打开侧栏与档案"
              className="lg:hidden flex items-center bg-transparent border-0 p-1 rounded-[12px] hover:bg-[#101527] cursor-pointer shrink-0"
            >
              <img src="/assets/logo-small.webp" alt="Vela" className="brand-logo" />
            </button>
            {(activeSession || activeProfiles.length > 0) && (
              <span className="hidden sm:inline text-[13px] text-[#a3b0c5] truncate">
                {activeSession
                  ? activeSession.title
                  : `${mode === 'synastry' ? '多人合盘' : '个人星盘'} · ${activeProfiles.map((p) => p.name).join(' × ')}`}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {chart && (
              <button
                type="button"
                onClick={() => setChartDrawerOpen((v) => !v)}
                className="min-h-[34px] px-3 rounded-[17px] border border-[#26304d] bg-[#101527] hover:border-[#e0b64a] text-[12.5px] text-[#f7d57f] flex items-center gap-1.5 cursor-pointer"
              >
                <IconSparkles size={14} />
                <span>星盘</span>
              </button>
            )}
          </div>
        </header>

        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4 pb-10">
            <h1 className="m-0 mb-6 font-serif-sc text-[28px] sm:text-[34px] font-bold text-[#f8fafc] text-center">
              你好，想从哪颗星开始聊？
            </h1>
            {renderComposer()}
          </div>
        ) : (
          <>
            {/* Scrollable Conversation Area */}
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="mx-auto w-full max-w-[760px] flex flex-col gap-6">
                {messages.map((msg, idx) => {
                  const isLastAssistant =
                    msg.role === 'assistant' && idx === messages.length - 1;
                  const textContent = msg.parts
                    .filter((p) => p.type === 'text')
                    .map((p) => p.text)
                    .join('\n');
                  const toolCalls = msg.parts.filter((p) => p.type === 'tool-call');

                  if (msg.role === 'user') {
                    return (
                      <div key={msg.id} className="flex justify-end">
                        <div className="max-w-[82%] px-4 py-3 rounded-[18px] bg-[#1d2540] text-[15.5px] leading-[1.7] text-[#f8fafc] whitespace-pre-wrap">
                          {textContent}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={msg.id} className="flex flex-col gap-3">
                      {toolCalls.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {toolCalls.map((t, tIdx) => (
                            <span
                              key={tIdx}
                              className="px-2.5 py-1 rounded-[12px] border border-[#26304d] bg-[#101527] text-[12px] text-[#a8c0f0]"
                            >
                              ✓ {t.label}
                            </span>
                          ))}
                        </div>
                      )}

                      {chart && (idx === 1 || toolCalls.length > 0) && (
                        <ChartFactCard
                          chart={chart}
                          profileName={activeProfiles[0]?.name ?? activeSession?.profileName ?? '本命盘'}
                          birthSummary={
                            activeProfiles[0]
                              ? `${activeProfiles[0].birthDateTime.replace('T', ' ')} · ${activeProfiles[0].locationName}`
                              : ''
                          }
                        />
                      )}

                      {isLastAssistant && isStreaming && !textContent ? (
                        <div className="flex items-center gap-2.5 py-2 text-[14px] text-[#c3cde0]">
                          <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#e0b64a] vela-thinking-dot" />
                          <span>
                            {toolCalls.length > 0
                              ? `已排盘（${toolCalls.map((t) => t.label.replace(/^已排盘：/, '')).join(' · ')}），正在推演解读…`
                              : '正在计算星盘坐标与调用排盘工具…'}
                          </span>
                        </div>
                      ) : (
                        <div className="py-1">{renderFormattedText(textContent)}</div>
                      )}

                      {msg.suggestions && msg.suggestions.length > 0 && !isStreaming && (
                        <div className="no-print flex flex-wrap gap-2 pt-1">
                          {msg.suggestions.map((sug, sIdx) => (
                            <button
                              key={sIdx}
                              type="button"
                              onClick={() => void handleSend(sug)}
                              className="min-h-[36px] px-3.5 py-1.5 rounded-[18px] border border-[#26304d] bg-[#101527] hover:border-[#e0b64a] text-[13px] text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer text-left"
                            >
                              {sug}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>
            </div>

            <div className="no-print shrink-0 px-4 pb-2 pt-2">
              {renderComposer()}
            </div>
          </>
        )}

        <footer className="no-print shrink-0 px-4 py-2 text-center text-[11px] text-[#a3b0c5]">
          AI 生成内容仅供自我探索，不构成医疗、法律或财务建议 ·{' '}
          <a
            href="/privacy"
            onClick={(e) => {
              e.preventDefault();
              navigate('/privacy');
            }}
          >
            隐私政策
          </a>{' '}
          ·{' '}
          <a
            href="/terms"
            onClick={(e) => {
              e.preventDefault();
              navigate('/terms');
            }}
          >
            服务条款
          </a>
        </footer>
      </main>

      {/* Right Slide-Over Chart Drawer */}
      {chartDrawerOpen && chart && (
        <aside className="no-print fixed inset-y-0 right-0 z-40 w-[340px] max-w-[92vw] bg-[#101527] border-l border-[#1e2740] p-4 flex flex-col gap-4 overflow-y-auto">
          <div className="flex items-center justify-between">
            <h2 className="m-0 font-serif-sc text-[17px] font-bold text-[#f8fafc]">星盘事实</h2>
            <button
              type="button"
              onClick={() => setChartDrawerOpen(false)}
              aria-label="关闭星盘"
              className="min-h-[34px] min-w-[34px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] cursor-pointer"
            >
              ✕
            </button>
          </div>
          <NatalWheelSvg chart={chart} />
          <div className="flex flex-col gap-1.5 text-[12.5px]">
            <p className="m-0 font-mono-num text-[#f7d57f]">
              上升 {chart.natal.ascendant.formatted} · 天顶 {chart.natal.midheaven.formatted}
            </p>
            {chart.natal.planets.map((p) => (
              <div key={p.key} className="flex justify-between py-1 border-b border-[#1e2740]/60">
                <span className="text-[#c3cde0]">{p.nameZh}</span>
                <span className="font-mono-num text-[#f8fafc]">
                  {p.formatted} · 第{p.house}宫{p.retrograde ? ' ℞' : ''}
                </span>
              </div>
            ))}
          </div>
        </aside>
      )}

      <HistorySearchModal
        open={historySearchOpen}
        sessions={sessions}
        activeSessionId={activeSession?.id ?? null}
        onSelectSession={(sid) => {
          onSelectSession(sid);
          setSidebarOpen(false);
        }}
        onClose={() => setHistorySearchOpen(false)}
      />

      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        uid={uid}
        email={email}
        tier={tier}
        usage={usage}
        profiles={effectiveProfiles}
        onClose={() => setSettingsOpen(false)}
        onSignOut={onSignOut}
        onRequireLogin={() => {
          setSettingsOpen(false);
          onRequireAuth({
            draftProfiles: effectiveProfiles.map((p) => ({
              name: p.name,
              entityType: p.entityType ?? 'person',
              birthDateTime: p.birthDateTime,
              locationName: p.locationName,
              latitude: p.latitude,
              longitude: p.longitude,
              timezone: p.timezone,
              gender: p.gender ?? 'unset',
            })),
            chart,
            mode,
            selectedIndices: [0],
            question: '',
          });
        }}
      />
    </div>
  );
}
