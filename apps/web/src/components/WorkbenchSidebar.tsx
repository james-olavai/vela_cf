import { useEffect, useState } from 'react';
import type { ApiPlan } from '../lib/accountStore';
import { planUsagePercent } from '../lib/planStore';
import { Modal } from './Modal';
import {
  type ProfileRecord,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';
import {
  IconChevronsLeft,
  IconCrown,
  IconNotebook,
  IconSearch,
  IconSparkles,
  IconSquarePen,
} from './Icons';
import { ProfileSidebarPanel } from './ProfileSidebarPanel';

export type ActiveSubpage = 'profiles' | 'subscription' | null;

interface WorkbenchSidebarProps {
  uid: string | null;
  displayName: string;
  photoURL: string | null;
  tier: Tier;
  plan?: ApiPlan;
  usage: UsageRecord;
  sidebarOpen: boolean;
  activeSubpage: ActiveSubpage;
  needsMoreProfiles: boolean;
  portraitSubtitle: string;
  profiles: ProfileRecord[];
  selectedProfileIds: string[];
  onSetSidebarOpen: (open: boolean) => void;
  onNewSession: () => void;
  onOpenHistorySearch: () => void;
  onOpenPortrait: () => void;
  onOpenProfileManager: (opts?: { startAdd?: boolean; editId?: string }) => void;
  onOpenSubscription: () => void;
  onOpenAccountOrAuth: () => void;
  onSetPrimaryProfile: (id: string) => void;
  onToggleSynastryProfile: (id: string) => void;
}

export function WorkbenchSidebar({
  uid,
  displayName,
  photoURL,
  tier,
  plan,
  usage,
  sidebarOpen,
  activeSubpage,
  needsMoreProfiles,
  portraitSubtitle,
  profiles,
  selectedProfileIds,
  onSetSidebarOpen,
  onNewSession,
  onOpenHistorySearch,
  onOpenPortrait,
  onOpenProfileManager,
  onOpenSubscription,
  onOpenAccountOrAuth,
  onSetPrimaryProfile,
  onToggleSynastryProfile,
}: WorkbenchSidebarProps) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 1023px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)');
    const sync = () => setMobile(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  const closeOnMobile = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) onSetSidebarOpen(false);
  };

  const pct = planUsagePercent(usage, plan);
  const usageSummary = usage.unlimited ? '无限额度' : pct === null ? '额度加载中' : `已用 ${pct}%`;

  const avatarRingClass =
    tier === 'pro'
      ? 'ring-2 ring-accent'
      : tier === 'go'
        ? 'ring-2 ring-secondary'
        : 'ring-2 ring-[#64748b]';

  const renderAvatar = () =>
    photoURL ? (
      <img src={photoURL} alt={displayName} className={`w-9 h-9 rounded-full object-cover shrink-0 ${avatarRingClass}`} />
    ) : (
      <div className={`w-9 h-9 rounded-full bg-bubble flex items-center justify-center text-[13px] font-bold text-accent-bright shrink-0 ${avatarRingClass}`}>
        {displayName.slice(0, 1).toUpperCase()}
      </div>
    );

  const railItems = [
    { id: 'new', label: '新咨询', icon: <IconSquarePen size={18} />, active: false, disabled: false, onClick: () => { onNewSession(); closeOnMobile(); } },
    { id: 'history', label: '搜索历史对话', icon: <IconSearch size={18} />, active: false, disabled: false, onClick: onOpenHistorySearch },
    { id: 'profiles', label: '档案管理', icon: <IconNotebook size={18} />, active: activeSubpage === 'profiles', disabled: false, onClick: () => { onOpenProfileManager(); closeOnMobile(); } },
    { id: 'portrait', label: needsMoreProfiles ? '个人星盘画像（请先添加档案）' : '个人星盘画像', icon: <IconSparkles size={18} />, active: false, disabled: needsMoreProfiles, onClick: onOpenPortrait },
    { id: 'subscription', label: '订阅与额度', icon: <IconCrown size={18} />, active: activeSubpage === 'subscription', disabled: false, onClick: () => { onOpenSubscription(); closeOnMobile(); } },
  ];

  const renderCollapsedRail = () => (
    <div className="flex flex-col items-center justify-between h-full bg-base" data-testid="sidebar-rail">
      <div className="w-full flex flex-col items-center gap-2">
        <div className="w-full h-[64px] px-2.5 flex items-center justify-center shrink-0">
          <button type="button" onClick={() => onSetSidebarOpen(true)} title="展开侧栏" aria-label="展开侧栏" className="flex items-center justify-center bg-transparent border-0 p-0.5 rounded-[12px] hover:bg-panel cursor-pointer">
            <img src="/assets/logo-small.webp" alt="Vela" className="brand-logo" />
          </button>
        </div>
        {railItems.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={item.onClick}
            title={item.label}
            aria-label={item.label}
            data-testid={`rail-btn-${item.id}`}
            className={`w-10 h-10 rounded-[12px] border-0 flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
              item.active ? 'bg-selected text-accent-bright' : 'bg-transparent hover:bg-panel text-secondary hover:text-primary'
            }`}
          >
            {item.icon}
          </button>
        ))}
      </div>
      <div className="pb-3 flex flex-col items-center">
        <button
          type="button"
          onClick={onOpenAccountOrAuth}
          title={uid ? `账号设置：${displayName}` : '登录 / 注册账号'}
          aria-label={uid ? `账号设置：${displayName}` : '登录 / 注册账号'}
          data-testid="rail-btn-auth"
          className="w-10 h-10 rounded-full border-0 bg-transparent hover:bg-panel flex items-center justify-center cursor-pointer"
        >
          {renderAvatar()}
        </button>
      </div>
    </div>
  );

  const renderExpandedSidebar = () => (
    <div className="flex flex-col h-full bg-panel border-r border-divider" data-testid="sidebar-expanded">
      <div className="h-[64px] px-2.5 flex items-center justify-between shrink-0">
        <button type="button" onClick={() => onSetSidebarOpen(false)} title="收起侧栏" aria-label="收起侧栏" className="flex items-center gap-2.5 bg-transparent border-0 p-1 rounded-[12px] hover:bg-panel-2 cursor-pointer">
          <img src="/assets/logo-small.webp" alt="Vela" className="brand-logo" />
          <span className="wordmark text-[18px] font-semibold text-primary">VELA</span>
        </button>
        <button type="button" onClick={() => onSetSidebarOpen(false)} title="折叠侧栏" aria-label="折叠侧栏" className="w-9 h-9 rounded-[10px] border-0 bg-transparent hover:bg-panel-2 text-secondary hover:text-primary flex items-center justify-center cursor-pointer">
          <IconChevronsLeft size={18} />
        </button>
      </div>

      <div className="px-3 pb-1 flex flex-col gap-2">
        {railItems.filter((item) => item.id !== 'profiles').map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={() => { item.onClick(); closeOnMobile(); }}
            title={item.id === 'portrait' ? portraitSubtitle : item.label}
            data-testid={`sidebar-nav-${item.id}`}
            className={`w-full min-h-11 px-3 py-2 rounded-[12px] border text-left flex items-center gap-3 cursor-pointer disabled:opacity-45 ${
              item.id === 'new' ? 'border-accent bg-accent text-on-accent font-semibold' : item.active ? 'border-border bg-panel-2 text-primary' : 'border-transparent bg-transparent text-secondary hover:bg-panel-2'
            }`}
          >
            <span aria-hidden="true" className="shrink-0">{item.icon}</span>
            <span className="text-[14px] flex-1">{item.label}</span>
            {item.id === 'subscription' && <span className="text-[13px]">{usageSummary}</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto border-t border-divider/70 mt-1">
        <ProfileSidebarPanel
          tier={tier}
          plan={plan}
          profiles={profiles}
          selectedProfileIds={selectedProfileIds}
          active={activeSubpage === 'profiles'}
          onOpenProfileManager={(opts) => { onOpenProfileManager(opts); closeOnMobile(); }}
          onSetPrimaryProfile={onSetPrimaryProfile}
          onToggleSynastryProfile={onToggleSynastryProfile}
        />
      </div>

      <div className="p-3 border-t border-divider">
        <button
          type="button"
          onClick={() => { closeOnMobile(); onOpenAccountOrAuth(); }}
          data-testid="sidebar-auth-btn"
          className="w-full flex items-center gap-2.5 min-w-0 p-1.5 rounded-[10px] border-0 bg-transparent hover:bg-panel-2 text-left cursor-pointer"
        >
          {renderAvatar()}
          <div className="min-w-0 flex-1 flex flex-col">
            <span className="text-[13px] font-medium text-primary truncate">{uid ? displayName : '登录 / 注册账号'}</span>
            <span className="text-[13px] text-muted truncate">{uid ? (plan?.label ?? '套餐加载中') : '同步已有档案与历史对话'}</span>
          </div>
          {!uid && <span className="px-2 py-0.5 rounded-[6px] bg-accent text-on-accent text-[13px] font-bold shrink-0">登录</span>}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className={`no-print hidden lg:block h-full shrink-0 ${sidebarOpen ? 'w-[280px]' : 'w-[72px]'}`}>
        {sidebarOpen ? renderExpandedSidebar() : renderCollapsedRail()}
      </aside>
      {mobile && <Modal open={sidebarOpen} onClose={() => onSetSidebarOpen(false)} label="导航与档案" className="vela-drawer">
        <aside className="h-full">{renderExpandedSidebar()}</aside>
      </Modal>}
    </>
  );
}
