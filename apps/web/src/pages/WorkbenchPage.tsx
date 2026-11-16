import { CountryPanel } from '../components/CountryPanel';
import type { CountryChoice } from '../lib/geoStore';
import { usePlan, planBudget, planUsagePercent } from '../lib/planStore';
import { subscribeApi } from '../lib/apiClient';
import { pendingTurn } from '../lib/turnClient';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  sessionProfiles,
  nextUtcMonthResetLabel,
  ProfileInputSchema,
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
  IconGift,
  IconPencil,
  IconStop,
} from '../components/Icons';
import { ProfileManagerSubpage, type ProfileManagerLaunch } from '../components/ProfileSidebarPanel';
import { SoftAurora } from '../components/SoftAurora';
import { WorkbenchSidebar, type ActiveSubpage } from '../components/WorkbenchSidebar';
import { navigate, usePathname } from '../lib/router';
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

const MarkdownMessage = lazy(() => import('../components/MarkdownMessage'));
const NatalPortraitModal = lazy(() => import('../components/NatalPortraitModal').then((m) => ({ default: m.NatalPortraitModal })));
const SubscriptionSubpage = lazy(() => import('../components/SubscriptionSubpage').then((m) => ({ default: m.SubscriptionSubpage })));
const ShareBonusModal = lazy(() => import('../components/ShareBonusModal').then((m) => ({ default: m.ShareBonusModal })));

export interface PendingHandoff {
  draftProfiles: ProfileInput[];
  chart: ChartSnapshot | null;
  mode: ConsultationMode;
  selectedIndices: number[];
  question: string;
}

interface WorkbenchPageProps {
  uid: string | null;
  displayName: string;
  photoURL: string | null;
  tier: Tier;
  usage: UsageRecord;
  profiles: ProfileRecord[];
  sessions: SessionRecord[];
  activeSession: SessionRecord | null;
  pendingHandoff: PendingHandoff | null;
  onClearPendingHandoff: () => void;
  onOpenAccountModal: (handoff?: PendingHandoff) => void;
  onStartSession: (mode: ConsultationMode, profiles: ProfileRecord[], initialQuestion?: string, country?: CountryChoice) => Promise<SessionRecord>;
  onSelectSession: (sessionId: string | null) => void;
}

export function WorkbenchPage({
  uid,
  displayName,
  photoURL,
  tier,
  usage,
  profiles,
  sessions,
  activeSession,
  pendingHandoff,
  onClearPendingHandoff,
  onOpenAccountModal,
  onStartSession,
  onSelectSession,
}: WorkbenchPageProps) {
  const pathname = usePathname();
  const {plan,error:planError,retry:retryPlan}=usePlan(import.meta.env.DEV && uid==='e2e_test_user'?null:uid,tier);
  const depths=plan?.analysisDepths??[];
  const [messageRetry, setMessageRetry] = useState(0);
  const [chartRetry, setChartRetry] = useState(0);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartOwner, setChartOwner] = useState('');
  const followEndRef = useRef(true);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [replyNotice, setReplyNotice] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeSubpage, setActiveSubpage] = useState<ActiveSubpage>(null);
  const [profileLaunch, setProfileLaunch] = useState<ProfileManagerLaunch>({ seq: 0 });
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [portraitOpen, setPortraitOpen] = useState(false);
  const [usageOverride, setUsageOverride] = useState<UsageRecord | null>(null);

  useEffect(() => {
    setUsageOverride(null);
  }, [usage]);

  const effectiveUsage = usageOverride ?? usage;

  const [draftProfiles, setDraftProfiles] = useState<ProfileRecord[]>([]);
  const effectiveProfiles = uid ? profiles : draftProfiles;

  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [countrySelection,setCountrySelection]=useState<{owner:string;chart:CountryChoice}|null>(null);
  const maxSelectable = plan ? Math.max(1, plan.maxSynastryProfiles) : Infinity;

  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [chart, setChart] = useState<ChartSnapshot | null>(null);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [failedTurn, setFailedTurn] = useState<{ text: string; edit: boolean } | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [depth, setDepth] = useState<AnalysisDepth>('balanced');

  const abortRef = useRef<{ controller: AbortController; path: string } | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const focusAfterSaveRef = useRef(false);
  const handoffConsumedRef = useRef(false);
  const isStreamingRef = useRef(false);

  useEffect(() => {
    if (!activeSubpage && effectiveProfiles.length && focusAfterSaveRef.current) {
      focusAfterSaveRef.current = false;
      textareaRef.current?.focus();
    }
  }, [activeSubpage, effectiveProfiles]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [inputText, activeSubpage]);

  useEffect(() => {
    if (activeSession?.subjects?.length) return;
    if (effectiveProfiles.length === 0) {
      setSelectedProfileIds([]);
      setChart(null);
      return;
    }
    const validIds = [...new Set(selectedProfileIds)].filter((id) =>
      effectiveProfiles.some((p) => p.id === id),
    );
    if (validIds.length === 0) {
      setSelectedProfileIds([effectiveProfiles[0].id]);
    } else if (validIds.length > maxSelectable) {
      setSelectedProfileIds(validIds.slice(0, maxSelectable));
    } else if (validIds.length !== selectedProfileIds.length) {
      setSelectedProfileIds(validIds);
    }
  }, [effectiveProfiles, maxSelectable, activeSession?.subjects]);

  const cancelStream = () => {
    const request = abortRef.current;
    abortRef.current = null;
    request?.controller.abort();
    isStreamingRef.current = false;
    setIsStreaming(false);
    setStreamError(null);
    setFailedTurn(null);
    setReplyNotice('');
  };
  useEffect(() => () => { abortRef.current?.controller.abort(); abortRef.current = null; }, []);
  useEffect(() => {
    if (abortRef.current && abortRef.current.path !== pathname) cancelStream();
    setEditingMsgId(null);
    followEndRef.current = true;
    setAwayFromEnd(false);
    if (!abortRef.current) setMessages([]);
    if (!uid || !activeSession) return;
    setSelectedProfileIds(activeSession.profileIds?.length ? activeSession.profileIds : [activeSession.profileId]);
    let alive = true;
    const stopRecovery=subscribeApi(signal=>pendingTurn(uid,activeSession.id,signal),turn=>{
      if(isStreamingRef.current)return false;
      if(alive && turn)setReplyNotice(turn.status==='running'?'上一条请求仍在处理，正在同步结果':turn.status==='completed'?'上一条回复已恢复':turn.status==='cancelled'?'上一条请求已停止':'上一条请求未完成，可重试');
    },()=>{});
    const unsub = subscribeMessages(uid, activeSession.id, (serverMsgs) => {
      if (!alive || isStreamingRef.current) return false;
      setMessages(serverMsgs);
    }, () => { if (alive) setStreamError('历史消息加载失败，请重试'); });
    return () => { alive = false; stopRecovery(); unsub(); };
  }, [uid, pathname, activeSession?.id, messageRetry]);

  const notifyQuotaExceeded = () => {
    const budget = planBudget(effectiveUsage,plan) ?? effectiveUsage.used;
    setUsageOverride({ ...effectiveUsage, used: Math.max(effectiveUsage.used, budget) });
    setStreamError(
      `本月额度已用完（100%），下次重置时间为 ${nextUtcMonthResetLabel()}（UTC）；可分享星盘卡片领额度或升级套餐。`,
    );
  };

  const sessionProfileIds = activeSession ? (activeSession.profileIds?.length ? activeSession.profileIds : [activeSession.profileId]) : null;
  const activeProfiles = activeSession?.subjects?.length ? sessionProfiles(activeSession, effectiveProfiles) : (sessionProfileIds ?? selectedProfileIds)
    .map((id) => effectiveProfiles.find((p) => p.id === id))
    .filter((p): p is ProfileRecord => Boolean(p));
  const primaryProfile = activeProfiles[0] ?? (activeSession ? null : effectiveProfiles[0]) ?? null;
  const chartSignature = JSON.stringify(primaryProfile && [primaryProfile.id, primaryProfile.birthDateTime, primaryProfile.latitude, primaryProfile.longitude, primaryProfile.timezone, primaryProfile.gender]);
  const visibleChart = chartOwner === chartSignature ? chart : null;
  const portraitSummary = visibleChart?.portrait ?? null;
  useEffect(() => {
    let alive = true;
    setChart(null);
    setChartOwner(chartSignature);
    setChartError(null);
    if (!primaryProfile) return;
    const cached = uid ? loadCachedChart(uid, primaryProfile) : null;
    if (cached) { setChart(cached); return; }
    void fetchNatalChart(uid, primaryProfile).then((next) => { if (alive) setChart(next); })
      .catch(() => { if (alive) setChartError('星盘加载失败，请检查网络后重试'); });
    return () => { alive = false; };
  }, [uid, chartSignature, chartRetry]);
  const countryOwner=JSON.stringify([uid,primaryProfile?.id,primaryProfile?.updatedAt]);
  useEffect(()=>setCountrySelection(null),[countryOwner,activeSession?.id]);
  const country=!activeSession&&countrySelection?.owner===countryOwner?countrySelection.chart:null;
  const mode: ConsultationMode = activeProfiles.length + Number(Boolean(country)) >= 2 ? 'synastry' : 'personal';
  const needsMoreProfiles = activeProfiles.length === 0 && effectiveProfiles.length === 0;
  const consultationLabel = `${(activeSession?.mode ?? mode) === 'synastry' ? '合盘' : '个人'} · ${activeSession?.profileName ?? (activeProfiles.map((p) => p.name).join(' × ') || primaryProfile?.name || '')}`;

  const requestAuthWithDrafts = (question = '', selectedIndices = [0]) => {
    onOpenAccountModal({
      draftProfiles: effectiveProfiles.map((p) => ({
        name: p.name,
        entityType: p.entityType ?? 'person',
        birthDateTime: p.birthDateTime,
        locationName: p.locationName,
        latitude: p.latitude,
        longitude: p.longitude,
        timezone: p.timezone,
        gender: p.gender ?? 'unset',
        ...(p.locationRef?{locationRef:p.locationRef}:{}),
        consentedOther: p.consentedOther,
      })),
      chart: visibleChart,
      mode,
      selectedIndices,
      question,
    });
  };

  useEffect(() => {
    if (followEndRef.current) endRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages, isStreaming, activeSubpage]);

  const budget=planBudget(effectiveUsage,plan);
  const quotaExhausted = !effectiveUsage.unlimited && Boolean(uid) && budget!==undefined && effectiveUsage.used>=budget;
  const usagePercent = planUsagePercent(effectiveUsage,plan);
  const quotaNearLimit = !quotaExhausted && Boolean(uid) && usagePercent!==null && usagePercent>=80;

  const handleSetPrimaryProfile = (id: string) => {
    cancelStream();
    if (activeSession) onSelectSession(null);
    setSelectedProfileIds((prev) => {
      const others = prev.length > 1 ? prev.filter((x) => x !== id).slice(0, Math.max(0, maxSelectable - 1)) : [];
      return [id, ...others];
    });
  };

  const handleToggleSynastryProfile = (id: string) => {
    if(country&&!selectedProfileIds.includes(id)&&selectedProfileIds.length+1>=maxSelectable){setReplyNotice('已达到本次分析对象上限，请先取消一个对象');return;}
    cancelStream();
    if (activeSession) onSelectSession(null);
    if (maxSelectable <= 1) {
      setActiveSubpage('subscription');
      return;
    }
    setSelectedProfileIds((prev) => {
      const primary = prev[0] ?? effectiveProfiles[0]?.id;
      if (!primary || id === primary) return prev;
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= maxSelectable) return [primary, ...prev.slice(2), id];
      return [...prev, id];
    });
  };

  const openProfileManager = (opts?: { startAdd?: boolean; editId?: string }) => {
    setProfileLaunch((prev) => ({ seq: prev.seq + 1, ...opts }));
    setActiveSubpage('profiles');
  };

  const handleSaveSidebarProfile = async (input: ProfileInput, editId?: string) => {
    cancelStream();
    input = ProfileInputSchema.parse(input);

    const finishSave = (savedId: string) => {
      focusAfterSaveRef.current = true;
      setActiveSubpage(null);
      setReplyNotice('档案已保存，可以开始咨询');
      if (editId) return;
      if (activeSession) onSelectSession(null);
      setSelectedProfileIds((prev) => {
        const rest = prev.filter((x) => x !== savedId);
        return maxSelectable <= 1
          ? [savedId]
          : rest.length < maxSelectable
            ? [...rest, savedId]
            : [...rest.slice(1), savedId];
      });
    };

    if (uid) {
      const savedId = await saveProfile(uid, editId ?? null, input);
      finishSave(savedId);
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
    finishSave(nextId);
  };

  const handleDeleteSidebarProfile = async (id: string) => {
    cancelStream();
    if (uid) {
      await removeProfile(uid, id);
    } else {
      setDraftProfiles((prev) => prev.filter((p) => p.id !== id));
    }
    setSelectedProfileIds((prev) => prev.filter((x) => x !== id));
  };

  const handleSend = async (rawText?: string, editLastTurn = false) => {
    const text = (rawText ?? inputText).trim();
    if (!text || isStreamingRef.current) return;
    setStreamError(null);
    setFailedTurn(null);
    setReplyNotice('');

    if (!activeProfiles.length && effectiveProfiles.length === 0) {
      setStreamError('请先在左侧「档案管理」添加出生信息');
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

    if (!activeSession?.subjects?.length && sessionProfileIds?.some((id) => !profiles.some((p) => p.id === id))) {
      setStreamError('此咨询的档案已删除，请切换对象开启新咨询');
      return;
    }
    if (quotaExhausted) {
      notifyQuotaExceeded();
      return;
    }
    if (editLastTurn) setEditingMsgId(null);
    else setInputText('');

    const prevMessages = messages;
    const controller = new AbortController();
    const request = { controller, path: window.location.pathname };
    abortRef.current = request;
    let exceeded = false;
    const current = () => abortRef.current === request && request.path === window.location.pathname;
    isStreamingRef.current = true;
    setIsStreaming(true);
    followEndRef.current = true;
    setAwayFromEnd(false);

    try {
      const targetSession = activeSession ?? (await onStartSession(mode, activeProfiles, text, country ?? undefined));
      if (!current()) return;
      if (!activeSession) {
        request.path = `/consult/${targetSession.id}`;
        onSelectSession(targetSession.id);
      }
      if (controller.signal.aborted) { setInputText((draft) => draft || text); return; }
      const turnProfiles = targetSession.subjects?.length ? sessionProfiles(targetSession, profiles) : activeProfiles;

      await streamConsultationReply({
        uid,
        tier,
        usage: effectiveUsage,
        session: targetSession,
        profiles: turnProfiles,
        existingMessages: prevMessages,
        userText: text,
        editLastTurn,
        depth: depths.includes(depth) ? depth : depths[0],
        signal: controller.signal,
        onUpdateMessages: (next) => { if (current()) setMessages(next); },
        onUpdateChart: (next) => { if (current() && chartSignature === chartOwner) setChart(next); },
        onQuotaExceeded: () => { exceeded = true; if (current()) { notifyQuotaExceeded(); setMessages(prevMessages); setInputText((draft) => draft || text); } },
      });
      if (current() && !exceeded && !controller.signal.aborted) setReplyNotice('回复已完成');
    } catch (err) {
      if (current()) {
        setMessages(prevMessages);
        if (editLastTurn) setEditingMsgId([...messages].reverse().find((m) => m.role === 'user')?.id ?? null);
        else setInputText((draft) => draft || text);
        setFailedTurn({ text, edit: editLastTurn });
        setStreamError(formatAppError(err, '发送失败，请重试'));
      }
    } finally {
      if (current()) {
        if (controller.signal.aborted) setReplyNotice('已请求停止，最终结果以同步后的消息为准');
        isStreamingRef.current = false;
        setIsStreaming(false);
        abortRef.current = null;
      }
    }
  };

  useEffect(() => {
    if (!pendingHandoff) { handoffConsumedRef.current = false; return; }
    if (!uid || !activeSession || !pendingHandoff.question || handoffConsumedRef.current) return;
    if (!(activeSession.profileIds ?? [activeSession.profileId]).every((id) => profiles.some((p) => p.id === id))) return;
    handoffConsumedRef.current = true;
    onClearPendingHandoff();
    void handleSend(pendingHandoff.question);
  }, [uid, activeSession?.id, pendingHandoff, profiles]);

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

  const portraitSubtitle = needsMoreProfiles
    ? '添加出生档案后自动生成'
    : portraitSummary
      ? `太阳${portraitSummary.sunSign} · 月亮${portraitSummary.moonSign}`
      : '正在自动生成画像…';

  const renderComposer = () => (
    <div className="no-print w-full max-w-[760px] mx-auto flex flex-col gap-2">
      <p role="status" className="m-0 min-h-5 px-1 text-[13px] text-muted">{isStreaming ? '正在生成回复…' : failedTurn ? '生成失败，可重试上一条' : replyNotice}</p>
      {streamError && (
        <div role="alert" className="px-3.5 py-2 rounded-[10px] border border-danger/40 bg-[#1d1215] text-[13px] text-danger">
          {streamError}
          {failedTurn
            ? <button type="button" onClick={() => void handleSend(failedTurn.text, failedTurn.edit)} className="ml-2 underline">重试上一条</button>
            : <button type="button" onClick={() => { setStreamError(null); setMessageRetry((n) => n + 1); }} className="ml-2 underline">重新加载消息</button>}
        </div>
      )}

      {quotaNearLimit && (
        <div className="px-3.5 py-2 rounded-[12px] border border-accent/40 bg-selected/80 flex items-center justify-between gap-3 text-[13px]">
          <span className="text-accent-bright">
            本月额度已使用 {usagePercent}%，即将用完（{nextUtcMonthResetLabel()} UTC 重置）
          </span>
          <button
            type="button"
            onClick={() => setActiveSubpage('subscription')}
            className="px-2.5 py-1 rounded-[12px] border-0 bg-accent text-on-accent text-[13px] font-bold cursor-pointer shrink-0 hover:bg-accent-bright"
          >
            升级套餐
          </button>
        </div>
      )}

      {quotaExhausted ? (
        <div className="p-4 rounded-[20px] border border-accent/50 bg-panel flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[13px] text-secondary [overflow-wrap:anywhere]">{consultationLabel}</p>
            <p className="m-0 text-[14px] font-bold text-primary">
              本月额度已用完（100%）
            </p>
            <p className="m-0 text-[13px] text-muted">
              下次重置：{nextUtcMonthResetLabel()}（UTC）
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(effectiveUsage.shareCount ?? 0) < 3 &&
              effectiveUsage.lastShareDate !== new Date().toISOString().slice(0, 10) && (
                <button
                  type="button"
                  onClick={() => setShareModalOpen(true)}
                  className="min-h-[40px] px-4 rounded-[20px] border border-accent/60 bg-transparent text-accent-bright text-[13px] font-medium cursor-pointer hover:bg-selected"
                >
                  分享领额度
                </button>
              )}
            <button
              type="button"
              onClick={() => setActiveSubpage('subscription')}
              className="min-h-[40px] px-5 rounded-[20px] border-0 bg-accent text-on-accent text-[13px] font-bold cursor-pointer"
            >
              升级订阅继续对话
            </button>
          </div>
        </div>
      ) : (
        <form id="consult-composer"
          onSubmit={handleSubmitForm}
          className="rounded-[22px] border border-border bg-panel p-3 flex flex-col gap-2 focus-within:border-border-strong"
        >
          <label htmlFor="consult-question" className="sr-only">咨询问题</label>
          <textarea
            id="consult-question" ref={textareaRef}
            rows={1}
            maxLength={2000}
            disabled={needsMoreProfiles}
            placeholder={
              needsMoreProfiles
                ? '请先添加出生信息'
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
            className="w-full min-w-0 resize-none bg-transparent border-0 px-1 py-2 text-[15px] leading-[24px] text-primary placeholder-muted focus:outline-none disabled:opacity-60"
          />

          <div className="flex w-full min-w-0 items-center justify-end gap-2">
            {depths.length>0 && <>
              <select aria-label="推演深度" value={depths.includes(depth)?depth:depths[0]} onChange={(e) => setDepth(e.target.value as AnalysisDepth)} disabled={isStreaming}
                className="sm:hidden min-w-0 max-w-[96px] shrink-0 rounded-[12px] border border-border bg-panel px-2 text-secondary">
                {depths.map(d=><option key={d} value={d}>{({quick:'速览',balanced:'均衡',deep:'全维'})[d]}</option>)}
              </select>
              <div role="group" aria-label="推演深度" className="hidden sm:flex shrink-0 items-center rounded-full border border-border p-0.5">
                {([{ id: 'quick', label: '速览' }, { id: 'balanced', label: '均衡' }, { id: 'deep', label: '全维' }] as const).filter(opt=>depths.includes(opt.id)).map((opt) => (
                  <button key={opt.id} type="button" disabled={isStreaming} aria-pressed={(depths.includes(depth)?depth:depths[0]) === opt.id} onClick={() => setDepth(opt.id)}
                    className={`px-3 rounded-full border-0 text-[13px] cursor-pointer ${(depths.includes(depth)?depth:depths[0]) === opt.id ? 'bg-accent/20 text-accent-bright' : 'bg-transparent text-muted'}`}>{opt.label}</button>
                ))}
              </div>
            </>}

          {isStreaming ? (
            <button
              type="button"
              onClick={() => abortRef.current?.controller.abort()}
              aria-label="停止生成"
              className="shrink-0 w-9 h-9 rounded-full border-0 bg-accent text-on-accent flex items-center justify-center cursor-pointer"
            >
              <IconStop size={15} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!inputText.trim() || needsMoreProfiles}
              aria-label="发送"
              className="shrink-0 w-9 h-9 rounded-full border-0 bg-accent text-on-accent flex items-center justify-center cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
            >
              <IconArrowUp size={18} />
            </button>
          )}
          </div>
          {inputText.length > 1500 && <span className="text-right text-[13px] text-muted">{inputText.length}/2000</span>}
        </form>
      )}
    </div>
  );

  return (
    <div className="h-[100dvh] w-full flex bg-base text-primary overflow-hidden">
      <WorkbenchSidebar
        uid={uid}
        displayName={displayName}
        photoURL={photoURL}
        tier={tier}
        plan={plan}
        usage={effectiveUsage}
        sidebarOpen={sidebarOpen}
        activeSubpage={activeSubpage}
        needsMoreProfiles={needsMoreProfiles}
        portraitSubtitle={portraitSubtitle}
        profiles={effectiveProfiles}
        selectedProfileIds={selectedProfileIds}
        countryPanel={!activeSession&&<CountryPanel key={countryOwner} uid={uid} profileId={primaryProfile?.id} value={country} onChange={chart=>setCountrySelection(chart?{owner:countryOwner,chart}:null)} allowed={Boolean(plan?.allowsEntityCharts)&&activeProfiles.length<maxSelectable} />}
        onSetSidebarOpen={setSidebarOpen}
        onNewSession={() => { cancelStream(); setMessages([]); setActiveSubpage(null); onSelectSession(null); }}
        onOpenHistorySearch={() => setHistorySearchOpen(true)}
        onOpenPortrait={() => setPortraitOpen(true)}
        onOpenProfileManager={openProfileManager}
        onOpenSubscription={() => setActiveSubpage('subscription')}
        onOpenAccountOrAuth={() => (uid ? onOpenAccountModal() : requestAuthWithDrafts())}
        onSetPrimaryProfile={handleSetPrimaryProfile}
        onToggleSynastryProfile={handleToggleSynastryProfile}
      />

      <main className="flex-1 min-w-0 flex flex-col h-full relative overflow-hidden isolate">
        {chartError && <div role="alert" className="px-4 py-2 text-danger">{chartError}<button type="button" onClick={() => setChartRetry((n) => n + 1)} className="ml-2 underline">重试星盘</button></div>}
        {isStreaming && <SoftAurora />}
        <header className="no-print relative z-10 shrink-0 h-[64px] px-2.5 lg:px-5 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              title="打开侧栏与档案"
              aria-label="打开侧栏与档案"
              className="lg:hidden flex items-center bg-transparent border-0 p-1 rounded-[12px] hover:bg-panel cursor-pointer shrink-0"
            >
              <img src="/assets/logo-small.webp" alt="Vela" className="brand-logo" />
            </button>
            {activeSession && (
              <span className="hidden sm:inline text-[13px] text-muted truncate">
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
              className="relative min-h-[38px] min-w-[38px] flex items-center justify-center rounded-[10px] border-0 bg-transparent text-secondary hover:text-accent-bright hover:bg-panel cursor-pointer transition-colors"
            >
              <IconGift size={18} />
              {(tier === 'free' || quotaNearLimit || quotaExhausted) &&
                (effectiveUsage.shareCount ?? 0) < 3 &&
                effectiveUsage.lastShareDate !== new Date().toISOString().slice(0, 10) && (
                  <span aria-hidden="true" className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-accent" />
                )}
            </button>
          )}
        </header>
        {planError && <p role="alert" className="m-0 px-4 py-2 text-[13px] text-secondary">{planError} <button type="button" onClick={retryPlan}>重新加载权益</button></p>}

        {activeSubpage ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-divider">
              <button
                type="button"
                onClick={() => setActiveSubpage(null)}
                data-testid="subpage-back"
                className="rounded-[8px] px-2.5 py-1 border-0 bg-transparent text-[13px] text-muted hover:bg-panel hover:text-primary cursor-pointer"
              >
                ← 返回对话
              </button>
              <span className="text-[14px] font-semibold text-primary">
                {activeSubpage === 'profiles' ? '✦ 档案管理' : '✦ 订阅与额度'}
              </span>
              <span className="w-16" />
            </div>
            <div className="flex-1 overflow-y-auto p-4 md:p-6">
              {activeSubpage === 'profiles' ? (
                <>
                {activeSession && <p role="note" className="mx-auto max-w-3xl mb-4 text-[14px] text-secondary">本咨询对象固定为 {consultationLabel}；切换档案将开启新咨询，原对话保留在历史记录中。</p>}
                <ProfileManagerSubpage
                  uid={uid}
                  tier={tier}
                  plan={plan}
                  profiles={effectiveProfiles}
                  selectedProfileIds={selectedProfileIds}
                  launch={profileLaunch}
                  onSetPrimaryProfile={handleSetPrimaryProfile}
                  onToggleSynastryProfile={handleToggleSynastryProfile}
                  onSaveProfile={handleSaveSidebarProfile}
                  onDeleteProfile={handleDeleteSidebarProfile}
                  onOpenSubscription={() => setActiveSubpage('subscription')}
                />
                </>
              ) : (
                <Suspense fallback={<p role="status">正在加载订阅信息…</p>}><SubscriptionSubpage
                  uid={uid}
                  tier={tier}
                  usage={effectiveUsage}
                  profileCount={effectiveProfiles.length}
                  onRequestAuth={() => requestAuthWithDrafts()}
                  onOpenShare={() => setShareModalOpen(true)}
                /></Suspense>
              )}
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4 pb-10">
            <h1 className="m-0 mb-6 font-serif-sc text-[28px] sm:text-[34px] font-bold text-primary text-center">
              此刻你最在意什么？
            </h1>
            {needsMoreProfiles ? <div className="flex flex-col items-center gap-4 text-center">
              <p className="m-0 text-[15px] text-secondary">填写出生时间和地点，先看看你的星盘，再开始咨询。</p>
              <button type="button" onClick={() => openProfileManager({ startAdd: true })} className="rounded-[14px] border-0 bg-accent px-6 py-3 text-[15px] font-semibold text-on-accent cursor-pointer hover:bg-accent-bright">添加出生信息，查看星盘</button>
            </div> : renderComposer()}
          </div>
        ) : (
          <>
            <div className="relative flex-1 min-h-0">
            <div className="h-full overflow-y-auto px-4 py-4" onScroll={(e) => {
              const el = e.currentTarget;
              const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
              followEndRef.current = nearEnd;
              setAwayFromEnd(!nearEnd);
            }}>
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
                            <div className="w-full max-w-[600px] rounded-[16px] border border-border-strong bg-panel-2 p-3 flex flex-col gap-2">
                              <label htmlFor="edit-question" className="sr-only">编辑咨询问题</label>
                              <textarea id="edit-question"
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
                                className="w-full resize-none rounded-[10px] border border-border bg-[#0b1020] px-3 py-2 text-[15px] leading-[1.6] text-primary focus:outline-none focus:border-accent"
                              />
                              <div className="flex justify-end gap-2">
                                <button type="button" onClick={() => setEditingMsgId(null)} className="px-3 py-1.5 rounded-[8px] border border-border-strong bg-transparent text-[13px] text-secondary hover:text-primary cursor-pointer">
                                  取消
                                </button>
                                <button type="button" disabled={!editingText.trim() || isStreaming} onClick={() => void handleSend(editingText, true)} className="px-3.5 py-1.5 rounded-[8px] border-0 bg-accent text-on-accent text-[13px] font-bold hover:bg-accent-bright disabled:opacity-40 cursor-pointer">
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
                              className="no-print w-8 h-8 rounded-full border-0 bg-transparent text-muted hover:text-accent-bright hover:bg-panel-2 flex items-center justify-center cursor-pointer opacity-70 lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0"
                            >
                              <IconPencil size={15} />
                            </button>
                          )}
                          <div className="max-w-[82%] px-4 py-3 rounded-[18px] bg-bubble text-[15.5px] leading-[1.7] text-primary whitespace-pre-wrap [overflow-wrap:anywhere]">
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
                                className="px-2.5 py-1 rounded-[12px] border border-border bg-panel text-[13px] text-info"
                              >
                                ✓ {t.label}
                              </span>
                            ))}
                          </div>
                        )}

                        {visibleChart && (idx === 1 || toolCalls.length > 0) && (
                          <ChartFactCard
                            chart={visibleChart}
                            profileName={activeProfiles[0]?.name ?? activeSession?.profileName ?? '本命盘'}
                            birthSummary={
                              activeProfiles[0]
                                ? `${activeProfiles[0].birthDateTime.replace('T', ' ')} · ${activeProfiles[0].locationName}`
                                : ''
                            }
                          />
                        )}

                        {isLastAssistant && isStreaming && !textContent ? (
                          <div className="flex items-center gap-2.5 py-2 text-[14px] text-secondary">
                            <span className="inline-block w-2.5 h-2.5 rounded-full bg-accent vela-thinking-dot" />
                            <span>
                              {toolCalls.length > 0
                                ? `已排盘（${toolCalls.map((t) => t.label.replace(/^已排盘：/, '')).join(' · ')}），正在推演解读…`
                                : '正在计算星盘坐标与调用排盘工具…'}
                            </span>
                          </div>
                        ) : (
                          <div className="py-1 min-w-0"><Suspense fallback={<p className="text-body whitespace-pre-wrap [overflow-wrap:anywhere]">{textContent}</p>}><MarkdownMessage text={textContent} /></Suspense></div>
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
                              className="px-2.5 py-1 rounded-[8px] border border-border bg-transparent text-[13px] text-muted hover:text-primary hover:border-border-strong cursor-pointer"
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
                                className="min-h-[36px] px-3.5 py-1.5 rounded-[18px] border border-border bg-panel hover:border-accent text-[13px] text-secondary hover:text-primary cursor-pointer text-left disabled:opacity-45 disabled:cursor-not-allowed"
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
            {awayFromEnd && <button type="button" onClick={() => { followEndRef.current = true; endRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); setAwayFromEnd(false); textareaRef.current?.focus({ preventScroll: true }); }}
              className="no-print absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border-strong bg-panel px-4 text-[13px] text-primary hover:border-accent">回到最新回复 ↓</button>}
            </div>

            <div className="no-print shrink-0 px-4 pb-2 pt-2">{renderComposer()}</div>
          </>
        )}

        <footer className="no-print shrink-0 px-4 py-2 text-center text-[13px] text-muted">
          AI 生成内容仅供自我探索，不构成医疗、法律或财务建议 ·{' '}
          <a href="/privacy" onClick={(e) => { e.preventDefault(); navigate('/privacy'); }}>隐私政策</a>{' '}·{' '}
          <a href="/terms" onClick={(e) => { e.preventDefault(); navigate('/terms'); }}>服务条款</a>
        </footer>
      </main>

      <HistorySearchModal
        open={historySearchOpen}
        sessions={sessions}
        activeSessionId={activeSession?.id ?? null}
        onSelectSession={(sid) => { cancelStream(); setActiveSubpage(null); onSelectSession(sid); setSidebarOpen(false); }}
        onClose={() => setHistorySearchOpen(false)}
      />

      <Suspense fallback={<p role="status" className="sr-only">正在加载界面</p>}>
      {portraitOpen && <NatalPortraitModal
        open={portraitOpen}
        profile={primaryProfile}
        chart={visibleChart}
        onClose={() => setPortraitOpen(false)}
        onOpenShare={() => (uid ? setShareModalOpen(true) : requestAuthWithDrafts())}
      />}

      {uid && shareModalOpen && (
        <ShareBonusModal
          open={shareModalOpen}
          uid={uid}
          tier={tier}
          usage={effectiveUsage}
          profile={primaryProfile}
          chart={visibleChart}
          onClose={() => setShareModalOpen(false)}
          onClaimed={(next) => setUsageOverride(next)}
          onOpenUpgrade={() => { setShareModalOpen(false); setActiveSubpage('subscription'); }}
        />
      )}
      </Suspense>
    </div>
  );
}
