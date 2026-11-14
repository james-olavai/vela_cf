import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  computeEffectiveBudget,
  computeUsagePercent,
  nextUtcMonthResetLabel,
  TIER_META,
  type AnalysisDepth,
  type AstroUiBlock,
  type ConsultationMode,
  type MessageRecord,
  type ProfileInput,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';
import { AstroUiRenderer } from '../components/AstroUiRenderer';
import { ChartFactCard } from '../components/ChartFactCard';
import { HistorySearchModal } from '../components/HistorySearchModal';
import {
  IconArrowUp,
  IconChevronsLeft,
  IconGift,
  IconNotebook,
  IconPencil,
  IconSearch,
  IconSparkles,
  IconSquarePen,
  IconStop,
} from '../components/Icons';
import { NatalPortraitModal } from '../components/NatalPortraitModal';
import { ProfileSidebarPanel } from '../components/ProfileSidebarPanel';
import { SettingsModal, type SettingsTab } from '../components/SettingsModal';
import { ShareBonusModal } from '../components/ShareBonusModal';
import { SoftAurora } from '../components/SoftAurora';
import { computePortraitSummary } from '../lib/portrait';
import { navigate } from '../lib/router';
import {
  fetchNatalChart,
  formatAppError,
  loadCachedChart,
  removeProfile,
  saveProfile,
  streamConsultationReply,
  subscribeMessages,
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
  onStartSession: (mode: ConsultationMode, profiles: ProfileRecord[]) => Promise<SessionRecord>;
  onSelectSession: (sessionId: string | null) => void;
  onSignOut: () => void;
}

function renderFormattedText(text: string) {
  return text.split(/\n{2,}/).map(( rawPara, pIdx) => {
    const para = rawPara.trim();
    if (/^-{3,}$/.test(para)) return <hr key={pIdx} className="my-3 border-0 border-t border-[#26304d]" />;
    const headingMatch = para.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      return <h3 key={pIdx} className="m-0 mt-4 mb-2 font-serif-sc text-[17px] font-bold text-[#f7d57f]">{headingMatch[2].replace(/\*\*/g, '')}</h3>;
    }
    const cleaned = para.replace(/^#{1,4}\s+/gm, '');
    return (
      <p key={pIdx} className="m-0 mb-3 last:mb-0 text-[15.5px] leading-[1.85] text-[#e8edf6] whitespace-pre-wrap">
        {cleaned.split(/(\*\*[^*]+\*\*)/g).map((tok, tIdx) =>
          tok.startsWith('**') && tok.endsWith('**') ? (
            <strong key={tIdx} className="font-semibold text-[#f7d57f]">{tok.slice(2, -2)}</strong>
          ) : (
            <span key={tIdx}>{tok}</span>
          ),
        )}
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
  onSignOut,
}: WorkbenchPageProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('subscription');
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [portraitOpen, setPortraitOpen] = useState(false);
  const [usageOverride, setUsageOverride] = useState<UsageRecord | null>(null);

  useEffect(() => {
    setUsageOverride(null);
  }, [usage]);

  const effectiveUsage = usageOverride ?? usage;

  // Visitor local draft profiles before login
  const [draftProfiles, setDraftProfiles] = useState<ProfileRecord[]>([]);
  const effectiveProfiles = uid ? profiles : draftProfiles;

  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const maxSelectable = Math.max(1, TIER_META[tier].maxSynastryProfiles);

  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [chart, setChart] = useState<ChartSnapshot | null>(null);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [depth, setDepth] = useState<AnalysisDepth>('balanced');

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const handoffConsumedRef = useRef(false);
  const isStreamingRef = useRef(false);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [inputText]);

  // Keep selectedProfileIds valid within tier limit when profiles or tier change
  useEffect(() => {
    if (effectiveProfiles.length === 0) {
      setSelectedProfileIds([]);
      setChart(null);
      return;
    }
    const validIds = selectedProfileIds.filter((id) =>
      effectiveProfiles.some((p) => p.id === id),
    );
    if (validIds.length === 0) {
      setSelectedProfileIds([effectiveProfiles[0].id]);
    } else if (validIds.length > maxSelectable) {
      setSelectedProfileIds(validIds.slice(0, maxSelectable));
    } else if (validIds.length !== selectedProfileIds.length) {
      setSelectedProfileIds(validIds);
    }
  }, [effectiveProfiles, maxSelectable]);

  // Sync active session messages & chart from Firestore
  useEffect(() => {
    setEditingMsgId(null);
    if (!uid || !activeSession) {
      setMessages([]);
      return;
    }
    const sessionPids =
      activeSession.profileIds && activeSession.profileIds.length > 0
        ? activeSession.profileIds
        : [activeSession.profileId];
    setSelectedProfileIds(sessionPids);

    const unsubMsgs = subscribeMessages(uid, activeSession.id, (serverMsgs) => {
      if (!isStreamingRef.current) {
        setMessages(serverMsgs);
      }
    });

    const cached = loadCachedChart(uid, sessionPids[0]);
    if (cached) {
      setChart(cached);
    } else {
      const p = profiles.find((x) => x.id === sessionPids[0]);
      if (p) {
        void fetchNatalChart(uid, p).then(setChart).catch(() => {});
      }
    }
    return () => unsubMsgs();
  }, [uid, activeSession?.id]);

  // Preview primary profile's chart in drawer
  useEffect(() => {
    if (activeSession || selectedProfileIds.length === 0) return;
    const primary = effectiveProfiles.find((p) => p.id === selectedProfileIds[0]);
    if (!primary) return;
    void fetchNatalChart(uid, primary).then(setChart).catch(() => {});
  }, [uid, selectedProfileIds[0], activeSession?.id]);

  const notifyQuotaExceeded = () => {
    const budget = computeEffectiveBudget(tier, effectiveUsage.bonusMicroUsd ?? 0);
    setUsageOverride({ ...effectiveUsage, used: Math.max(effectiveUsage.used, budget) });
    setStreamError(
      `本月额度已用完（100%），下次重置时间为 ${nextUtcMonthResetLabel()}（UTC）；可分享星盘卡片领额度或升级套餐。`,
    );
  };

  const requestAuthWithDrafts = (question = '', selectedIndices = [0]) => {
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
      selectedIndices,
      question,
    });
  };

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
    isStreamingRef.current = true;
    setIsStreaming(true);
    setStreamError(null);

    void streamConsultationReply({
      uid,
      tier,
      usage: effectiveUsage,
      session: activeSession,
      profiles: sessionProfiles,
      existingMessages: [],
      userText: pendingHandoff.question,
      signal: controller.signal,
      onUpdateMessages: setMessages,
      onUpdateChart: setChart,
      onQuotaExceeded: notifyQuotaExceeded,
    })
      .catch((err) => {
        setStreamError(formatAppError(err, '生成回复失败'));
      })
      .finally(() => {
        isStreamingRef.current = false;
        setIsStreaming(false);
        abortRef.current = null;
        onClearPendingHandoff();
      });
  }, [uid, activeSession?.id, pendingHandoff, profiles]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const quotaExhausted =
    !effectiveUsage.unlimited &&
    Boolean(uid) &&
    effectiveUsage.used >= computeEffectiveBudget(tier, effectiveUsage.bonusMicroUsd ?? 0);
  const usagePercent = effectiveUsage.unlimited
    ? 0
    : computeUsagePercent(
        effectiveUsage.used,
        tier,
        effectiveUsage.bonusMicroUsd ?? 0,
      );
  const quotaNearLimit = !quotaExhausted && Boolean(uid) && usagePercent >= 80;
  const activeProfiles = effectiveProfiles.filter((p) => selectedProfileIds.includes(p.id));
  const primaryProfile = activeProfiles[0] ?? effectiveProfiles[0] ?? null;
  const portraitSummary = chart?.natal ? computePortraitSummary(chart.natal) : null;
  const mode: ConsultationMode = activeProfiles.length >= 2 ? 'synastry' : 'personal';
  const needsMoreProfiles = effectiveProfiles.length === 0;

  const handleToggleProfile = (id: string) => {
    if (maxSelectable <= 1) {
      setSelectedProfileIds([id]);
      return;
    }
    setSelectedProfileIds((prev) => {
      if (prev.includes(id)) {
        return prev.length > 1 ? prev.filter((x) => x !== id) : prev;
      }
      if (prev.length >= maxSelectable) {
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
          maxSelectable <= 1
            ? [savedId]
            : prev.length < maxSelectable
              ? [...prev, savedId]
              : [...prev.slice(1), savedId],
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
      maxSelectable <= 1
        ? [nextId]
        : prev.length < maxSelectable
          ? [...prev, nextId]
          : [...prev.slice(1), nextId],
    );
    void fetchNatalChart(null, record)
      .then((preview) => setChart(preview))
      .catch(() => undefined);
  };

  const handleDeleteSidebarProfile = async (id: string) => {
    if (uid) {
      await removeProfile(uid, id);
    } else {
      setDraftProfiles((prev) => prev.filter((p) => p.id !== id));
    }
    setSelectedProfileIds((prev) => prev.filter((x) => x !== id));
  };

  const handleSend = async (rawText?: string, editLastTurn = false) => {
    const text = (rawText ?? inputText).trim();
    if (!text || isStreaming) return;
    setStreamError(null);

    if (effectiveProfiles.length === 0) {
      setStreamError('请先在左侧边栏点击「+ 添加出生信息」');
      return;
    }

    if (!uid) {
      const selectedIndices = activeProfiles
        .map((p) => effectiveProfiles.findIndex((x) => x.id === p.id))
        .filter((i) => i >= 0);
      handoffConsumedRef.current = false;
      requestAuthWithDrafts(text, selectedIndices.length > 0 ? selectedIndices : [0]);
      return;
    }

    if (quotaExhausted) {
      notifyQuotaExceeded();
      return;
    }
    if (editLastTurn) setEditingMsgId(null);
    else setInputText('');

    const prevMessages = messages;
    const lastUserIdx = editLastTurn ? prevMessages.map((m) => m.role).lastIndexOf('user') : -1;
    const baseMessages = editLastTurn && lastUserIdx >= 0 ? prevMessages.slice(0, lastUserIdx) : prevMessages;
    const nowIso = new Date().toISOString();
    setMessages([
      ...baseMessages,
      { id: `opt_${Date.now()}_u`, role: 'user', parts: [{ type: 'text', text }], createdAt: nowIso },
      { id: `opt_${Date.now()}_a`, role: 'assistant', parts: [], createdAt: nowIso },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    isStreamingRef.current = true;
    setIsStreaming(true);

    try {
      const targetSession = activeSession ?? (await onStartSession(mode, activeProfiles));
      const sessionProfiles =
        activeSession && activeSession.profileIds?.length
          ? profiles.filter((p) => activeSession.profileIds.includes(p.id))
          : activeProfiles;

      await streamConsultationReply({
        uid,
        tier,
        usage: effectiveUsage,
        session: targetSession,
        profiles: sessionProfiles.length > 0 ? sessionProfiles : activeProfiles,
        existingMessages: prevMessages,
        userText: text,
        editLastTurn,
        depth: tier === 'pro' ? depth : undefined,
        signal: controller.signal,
        onUpdateMessages: setMessages,
        onUpdateChart: setChart,
        onQuotaExceeded: notifyQuotaExceeded,
      });
    } catch (err) {
      setMessages(prevMessages);
      setStreamError(formatAppError(err, '发送失败，请重试'));
    } finally {
      isStreamingRef.current = false;
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const handleCopyMessage = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMsgId(id);
      setTimeout(() => setCopiedMsgId((cur) => (cur === id ? null : cur)), 1800);
    } catch {
      // ignore clipboard errors
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
        className={`w-9 h-9 rounded-full object-cover shrink-0 ${avatarRingClass}`}
      />
    ) : (
      <div
        className={`w-9 h-9 rounded-full bg-[#1d2540] flex items-center justify-center text-[13px] font-bold text-[#f7d57f] shrink-0 ${avatarRingClass}`}
      >
        {displayName.slice(0, 1).toUpperCase()}
      </div>
    );

  const renderCollapsedRail = () => {
    const railCls = 'w-10 h-10 rounded-[12px] border-0 bg-transparent hover:bg-[#101527] text-[#c3cde0] hover:text-[#f8fafc] flex items-center justify-center cursor-pointer';
    return (
      <div className="flex flex-col items-center justify-between h-full bg-[#070812]">
        <div className="w-full flex flex-col items-center gap-2">
          <div className="w-full h-[64px] px-2.5 flex items-center justify-center shrink-0">
            <button type="button" onClick={() => setSidebarOpen(true)} title="展开侧栏" aria-label="展开侧栏" className="flex items-center justify-center bg-transparent border-0 p-0.5 rounded-[12px] hover:bg-[#101527] cursor-pointer">
              <img src="/assets/logo-small.webp" alt="Vela" className="brand-logo" />
            </button>
          </div>
          <button type="button" onClick={() => onSelectSession(null)} title="新咨询" aria-label="新咨询" className={railCls}><IconSquarePen size={20} /></button>
          <button type="button" onClick={() => setHistorySearchOpen(true)} title="搜索历史对话" aria-label="搜索历史对话" className={railCls}><IconSearch size={20} /></button>
          <button type="button" onClick={() => setSidebarOpen(true)} title="出生档案与合盘" aria-label="出生档案与合盘" className={railCls}><IconNotebook size={20} /></button>
          <button
            type="button"
            disabled={needsMoreProfiles}
            onClick={() => setPortraitOpen(true)}
            title={needsMoreProfiles ? '个人星盘画像（请先添加档案）' : '个人星盘画像'}
            aria-label="个人星盘画像"
            className="w-10 h-10 rounded-[12px] border-0 bg-transparent hover:bg-[#101527] text-[#c3cde0] hover:text-[#f7d57f] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center cursor-pointer"
          >
            <IconSparkles size={20} />
          </button>
        </div>
        <div className="pb-3 flex flex-col items-center">
          <button
            type="button"
            onClick={() => (uid ? (setSettingsTab('subscription'), setSettingsOpen(true)) : requestAuthWithDrafts())}
            title={uid ? `${displayName} · ${TIER_META[tier].label}` : '登录 / 注册账号'}
            aria-label={uid ? `账号与订阅：${displayName}` : '登录 / 注册账号'}
            className="w-10 h-10 rounded-full border-0 bg-transparent hover:bg-[#101527] flex items-center justify-center cursor-pointer"
          >
            {renderAvatar()}
          </button>
        </div>
      </div>
    );
  };

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

      <div className="px-3 pb-2 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => { onSelectSession(null); setSidebarOpen(false); }}
          className="w-full min-h-[40px] px-3 rounded-[20px] border border-[#26304d] bg-[#161d33] hover:border-[#e0b64a] text-[#f8fafc] text-[13.5px] font-medium flex items-center justify-center gap-2 cursor-pointer"
        >
          <span className="text-[#c3cde0] flex items-center"><IconSquarePen size={18} /></span>
          <span>新咨询</span>
        </button>

        <button
          type="button"
          disabled={needsMoreProfiles}
          onClick={() => { setPortraitOpen(true); setSidebarOpen(false); }}
          className="w-full px-3 py-2.5 rounded-[12px] border border-[#26304d] bg-[#0e1426] hover:border-[#e0b64a] disabled:opacity-45 disabled:hover:border-[#26304d] disabled:cursor-not-allowed text-left flex items-center gap-2.5 cursor-pointer transition-colors"
        >
          <span className="text-[#e0b64a] shrink-0 flex items-center"><IconSparkles size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[#f8fafc]">个人星盘画像</div>
            <div className="text-[11px] text-[#9aa8c7] truncate">
              {needsMoreProfiles
                ? '添加出生档案后自动生成'
                : portraitSummary
                  ? `太阳${portraitSummary.sunSign} · 月亮${portraitSummary.moonSign}`
                  : '正在自动生成画像…'}
            </div>
          </div>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <ProfileSidebarPanel
          tier={tier}
          profiles={effectiveProfiles}
          selectedProfileIds={selectedProfileIds}
          onToggleProfile={handleToggleProfile}
          onSaveProfile={handleSaveSidebarProfile}
          onDeleteProfile={handleDeleteSidebarProfile}
        />
      </div>

      <div className="p-3 border-t border-[#1e2740]">
        <button
          type="button"
          onClick={() => {
            if (!uid) {
              setSidebarOpen(false);
              requestAuthWithDrafts();
              return;
            }
            setSettingsTab('subscription');
            setSettingsOpen(true);
          }}
          className="w-full flex items-center gap-2.5 min-w-0 p-1.5 rounded-[10px] border-0 bg-transparent hover:bg-[#161d33] text-left cursor-pointer"
        >
          {renderAvatar()}
          <div className="min-w-0 flex-1 flex flex-col">
            <span className="text-[13px] font-medium text-[#f8fafc] truncate">
              {uid ? displayName : '登录 / 注册账号'}
            </span>
            <span className="text-[11px] text-[#a3b0c5] truncate">
              {uid ? TIER_META[tier].label : '同步已有档案与历史对话'}
            </span>
          </div>
          {!uid && (
            <span className="px-2 py-0.5 rounded-[6px] bg-[#e0b64a] text-[#1a1405] text-[11px] font-bold shrink-0">
              登录
            </span>
          )}
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

      {quotaNearLimit && (
        <div className="px-3.5 py-2 rounded-[12px] border border-[#e0b64a]/40 bg-[#1d1a0f]/80 flex items-center justify-between gap-3 text-[12.5px]">
          <span className="text-[#f7d57f]">
            本月额度已使用 {usagePercent}%，即将用完（{nextUtcMonthResetLabel()} UTC 重置）
          </span>
          <button
            type="button"
            onClick={() => {
              setSettingsTab('subscription');
              setSettingsOpen(true);
            }}
            className="px-2.5 py-1 rounded-[12px] border-0 bg-[#e0b64a] text-[#1a1405] text-[12px] font-bold cursor-pointer shrink-0 hover:bg-[#f7d57f]"
          >
            升级套餐
          </button>
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
          <div className="flex flex-wrap items-center gap-2">
            {(effectiveUsage.shareCount ?? 0) < 3 &&
              effectiveUsage.lastShareDate !== new Date().toISOString().slice(0, 10) && (
                <button
                  type="button"
                  onClick={() => setShareModalOpen(true)}
                  className="min-h-[40px] px-4 rounded-[20px] border border-[#e0b64a]/60 bg-transparent text-[#f7d57f] text-[13px] font-medium cursor-pointer hover:bg-[#1d1a0f]"
                >
                  分享领额度
                </button>
              )}
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
        </div>
      ) : (
        <form
          onSubmit={handleSubmitForm}
          className="rounded-[26px] border border-[#26304d] bg-[#101527] pl-4 pr-2 py-2 flex items-end gap-2 focus-within:border-[#3a4668]"
        >
          <textarea
            ref={textareaRef}
            rows={1}
            maxLength={2000}
            disabled={needsMoreProfiles}
            placeholder={
              effectiveProfiles.length === 0
                ? '点击左上角 Logo 添加出生信息'
                : '问问Vela，问问宇宙'
            }
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleSend();
              }
            }}
            className="flex-1 min-w-0 resize-none bg-transparent border-0 py-[6px] text-[15px] leading-[24px] text-[#f8fafc] placeholder-[#a3b0c5] focus:outline-none disabled:opacity-60"
          />

          {inputText.length > 1500 && (
            <span className="shrink-0 pb-2 font-mono-num text-[11px] text-[#a3b0c5]">
              {inputText.length}/2000
            </span>
          )}

          {tier === 'pro' && (
            <div className="shrink-0 flex items-center rounded-full border border-[#26304d] bg-[#0b0e1a] p-0.5" title="推演深度：控制每轮披露的星盘工具与技法层级">
              {([
                { id: 'quick', label: '速览' },
                { id: 'balanced', label: '均衡' },
                { id: 'deep', label: '全维' },
              ] as const).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDepth(opt.id)}
                  className={`px-2 py-1 rounded-full border-0 text-[11px] font-medium cursor-pointer transition-colors ${
                    depth === opt.id
                      ? 'bg-[#e0b64a]/20 text-[#f7d57f]'
                      : 'bg-transparent text-[#8e9bb5] hover:text-[#f8fafc]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {isStreaming ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              aria-label="停止生成"
              className="shrink-0 w-9 h-9 rounded-full border-0 bg-[#e0b64a] text-[#1a1405] flex items-center justify-center cursor-pointer"
            >
              <IconStop size={15} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!inputText.trim() || needsMoreProfiles}
              aria-label="发送"
              className="shrink-0 w-9 h-9 rounded-full border-0 bg-[#e0b64a] text-[#1a1405] flex items-center justify-center cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
            >
              <IconArrowUp size={18} />
            </button>
          )}
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
      <main className="flex-1 min-w-0 flex flex-col h-full relative overflow-hidden isolate">
        {isStreaming && <SoftAurora />}
        {/* Unified Borderless Top Header */}
        <header className="no-print relative z-10 shrink-0 h-[64px] px-2.5 lg:px-5 flex items-center justify-between">
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
            {activeSession && (
              <span className="hidden sm:inline text-[13px] text-[#a3b0c5] truncate">
                {activeSession.title}
              </span>
            )}
          </div>
          {uid && (
            <button
              type="button"
              onClick={() => setShareModalOpen(true)}
              title="每日分享领额度"
              aria-label="每日分享领额度"
              className="relative min-h-[38px] min-w-[38px] flex items-center justify-center rounded-[10px] border-0 bg-transparent text-[#c3cde0] hover:text-[#f7d57f] hover:bg-[#101527] cursor-pointer transition-colors"
            >
              <IconGift size={18} />
              {(tier === 'free' || quotaNearLimit || quotaExhausted) &&
                (effectiveUsage.shareCount ?? 0) < 3 &&
                effectiveUsage.lastShareDate !== new Date().toISOString().slice(0, 10) && (
                  <span aria-hidden="true" className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[#e0b64a]" />
                )}
            </button>
          )}
        </header>

        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4 pb-10">
            <h1 className="m-0 mb-6 font-serif-sc text-[28px] sm:text-[34px] font-bold text-[#f8fafc] text-center">
              此刻你最在意什么？
            </h1>
            {renderComposer()}
          </div>
        ) : (
          <>
            {/* Scrollable Conversation Area */}
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="mx-auto w-full max-w-[760px] flex flex-col gap-6">
                {(() => {
                  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
                  return messages.map((msg, idx) => {
                  const isLastAssistant = msg.role === 'assistant' && idx === messages.length - 1;
                  const textContent = msg.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
                  const toolCalls = msg.parts.filter((p) => p.type === 'tool-call');
                  const uiBlocks = msg.parts.filter((p): p is AstroUiBlock => p.type === 'ui-block');

                  if (msg.role === 'user') {
                    const isLastUser = idx === lastUserIdx;
                    if (editingMsgId === msg.id) {
                      return (
                        <div key={msg.id} className="flex justify-end">
                          <div className="w-full max-w-[600px] rounded-[16px] border border-[#3a4668] bg-[#161d33] p-3 flex flex-col gap-2">
                            <textarea
                              autoFocus
                              rows={2}
                              maxLength={2000}
                              value={editingText}
                              onChange={(e) => setEditingText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setEditingMsgId(null);
                                else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                  e.preventDefault();
                                  void handleSend(editingText, true);
                                }
                              }}
                              className="w-full resize-none rounded-[10px] border border-[#26304d] bg-[#0b1020] px-3 py-2 text-[15px] leading-[1.6] text-[#f8fafc] focus:outline-none focus:border-[#e0b64a]"
                            />
                            <div className="flex justify-end gap-2">
                              <button type="button" onClick={() => setEditingMsgId(null)} className="px-3 py-1.5 rounded-[8px] border border-[#3a4668] bg-transparent text-[12.5px] text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer">
                                取消
                              </button>
                              <button type="button" disabled={!editingText.trim() || isStreaming} onClick={() => void handleSend(editingText, true)} className="px-3.5 py-1.5 rounded-[8px] border-0 bg-[#e0b64a] text-[#1a1405] text-[12.5px] font-bold hover:bg-[#f7d57f] disabled:opacity-40 cursor-pointer">
                                更新并发送
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={msg.id} className="group flex items-center justify-end gap-1.5">
                        {isLastUser && !isStreaming && !quotaExhausted && (
                          <button
                            type="button"
                            title="编辑并重新发送"
                            aria-label="编辑并重新发送"
                            onClick={() => { setEditingMsgId(msg.id); setEditingText(textContent); }}
                            className="no-print w-8 h-8 rounded-full border-0 bg-transparent text-[#9aa8c7] hover:text-[#f7d57f] hover:bg-[#161d33] flex items-center justify-center cursor-pointer opacity-70 lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0"
                          >
                            <IconPencil size={15} />
                          </button>
                        )}
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

                      <AstroUiRenderer
                        blocks={uiBlocks}
                        disabled={isStreaming || quotaExhausted}
                        onQuickAsk={(q) => void handleSend(q)}
                      />

                      {textContent && !(isLastAssistant && isStreaming) && (
                        <div className="no-print flex items-center gap-2 pt-0.5">
                          <button
                            type="button"
                            onClick={() => void handleCopyMessage(msg.id, textContent)}
                            className="px-2.5 py-1 rounded-[8px] border border-[#26304d] bg-transparent text-[11.5px] text-[#a3b0c5] hover:text-[#f8fafc] hover:border-[#3a4668] cursor-pointer"
                          >
                            {copiedMsgId === msg.id ? '已复制' : '复制'}
                          </button>
                        </div>
                      )}

                      {msg.suggestions && msg.suggestions.length > 0 && !isStreaming && (
                        <div className="no-print flex flex-wrap gap-2 pt-1">
                          {msg.suggestions.map((sug, sIdx) => (
                            <button
                              key={sIdx}
                              type="button"
                              disabled={quotaExhausted}
                              onClick={() => void handleSend(sug)}
                              className="min-h-[36px] px-3.5 py-1.5 rounded-[18px] border border-[#26304d] bg-[#101527] hover:border-[#e0b64a] text-[13px] text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer text-left disabled:opacity-45 disabled:cursor-not-allowed"
                            >
                              {sug}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                });
                })()}
                <div ref={endRef} />
              </div>
            </div>

            <div className="no-print shrink-0 px-4 pb-2 pt-2">{renderComposer()}</div>
          </>
        )}

        <footer className="no-print shrink-0 px-4 py-2 text-center text-[11px] text-[#a3b0c5]">
          AI 生成内容仅供自我探索，不构成医疗、法律或财务建议 ·{' '}
          <a href="/privacy" onClick={(e) => { e.preventDefault(); navigate('/privacy'); }}>隐私政策</a>{' '}·{' '}
          <a href="/terms" onClick={(e) => { e.preventDefault(); navigate('/terms'); }}>服务条款</a>
        </footer>
      </main>

      <HistorySearchModal
        open={historySearchOpen}
        sessions={sessions}
        activeSessionId={activeSession?.id ?? null}
        onSelectSession={(sid) => { onSelectSession(sid); setSidebarOpen(false); }}
        onClose={() => setHistorySearchOpen(false)}
      />

      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        uid={uid}
        email={email}
        tier={tier}
        usage={effectiveUsage}
        profiles={effectiveProfiles}
        onClose={() => setSettingsOpen(false)}
        onSignOut={onSignOut}
        onRequireLogin={() => { setSettingsOpen(false); requestAuthWithDrafts(); }}
      />

      <NatalPortraitModal
        open={portraitOpen}
        profile={primaryProfile}
        chart={chart}
        onClose={() => setPortraitOpen(false)}
        onOpenShare={() => (uid ? setShareModalOpen(true) : requestAuthWithDrafts())}
      />

      {uid && (
        <ShareBonusModal
          open={shareModalOpen}
          uid={uid}
          tier={tier}
          usage={effectiveUsage}
          profile={primaryProfile}
          chart={chart}
          onClose={() => setShareModalOpen(false)}
          onClaimed={(next) => setUsageOverride(next)}
          onOpenUpgrade={() => { setSettingsTab('subscription'); setSettingsOpen(true); }}
        />
      )}
    </div>
  );
}
