import {
  computeUsagePercent,
  TIER_META,
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
  const closeOnMobile = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) onSetSidebarOpen(false);
  };

  const pct = usage.unlimited ? 0 : computeUsagePercent(usage.used, tier, usage.bonusMicroUsd ?? 0);
  const usageSummary = usage.unlimited ? '无限额度' : `已用 ${pct}%`;

  const avatarRingClass =
    tier === 'pro'
      ? 'ring-2 ring-[#e0b64a] shadow-[0_0_10px_rgba(224,182,74,0.55)]'
      : tier === 'go'
        ? 'ring-2 ring-[#cbd5e1] shadow-[0_0_8px_rgba(203,213,225,0.45)]'
        : 'ring-2 ring-[#64748b]';

  const renderAvatar = () =>
    photoURL ? (
      <img src={photoURL} alt={displayName} className={`w-9 h-9 rounded-full object-cover shrink-0 ${avatarRingClass}`} />
    ) : (
      <div className={`w-9 h-9 rounded-full bg-[#1d2540] flex items-center justify-center text-[13px] font-bold text-[#f7d57f] shrink-0 ${avatarRingClass}`}>
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

  const expandedNavItems = [
    { id: 'new', label: '新咨询', subtitle: '开启新的星盘对话', icon: <IconSquarePen size={20} />, active: false, disabled: false, onClick: () => { onNewSession(); closeOnMobile(); } },
    { id: 'history', label: '搜索历史对话', subtitle: '检索过往咨询记录', icon: <IconSearch size={20} />, active: false, disabled: false, onClick: () => { onOpenHistorySearch(); closeOnMobile(); } },
    { id: 'portrait', label: '个人星盘画像', subtitle: portraitSubtitle, icon: <IconSparkles size={20} />, active: false, disabled: needsMoreProfiles, onClick: () => { onOpenPortrait(); closeOnMobile(); } },
    { id: 'subscription', label: '订阅与额度', subtitle: `${TIER_META[tier].label} · ${usageSummary} · ${TIER_META[tier].maxProfiles} 档案`, icon: <IconCrown size={20} />, active: activeSubpage === 'subscription', disabled: false, onClick: () => { onOpenSubscription(); closeOnMobile(); } },
  ];

  const renderCollapsedRail = () => (
    <div className="flex flex-col items-center justify-between h-full bg-[#070812]" data-testid="sidebar-rail">
      <div className="w-full flex flex-col items-center gap-2">
        <div className="w-full h-[64px] px-2.5 flex items-center justify-center shrink-0">
          <button type="button" onClick={() => onSetSidebarOpen(true)} title="展开侧栏" aria-label="展开侧栏" className="flex items-center justify-center bg-transparent border-0 p-0.5 rounded-[12px] hover:bg-[#101527] cursor-pointer">
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
              item.active ? 'bg-[#1d1a0f] text-[#f7d57f]' : 'bg-transparent hover:bg-[#101527] text-[#c3cde0] hover:text-[#f8fafc]'
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
          className="w-10 h-10 rounded-full border-0 bg-transparent hover:bg-[#101527] flex items-center justify-center cursor-pointer"
        >
          {renderAvatar()}
        </button>
      </div>
    </div>
  );

  const renderExpandedSidebar = () => (
    <div className="flex flex-col h-full bg-[#101527] border-r border-[#1e2740]" data-testid="sidebar-expanded">
      <div className="h-[64px] px-2.5 flex items-center justify-between shrink-0">
        <button type="button" onClick={() => onSetSidebarOpen(false)} title="收起侧栏" aria-label="收起侧栏" className="flex items-center gap-2.5 bg-transparent border-0 p-1 rounded-[12px] hover:bg-[#161d33] cursor-pointer">
          <img src="/assets/logo-small.webp" alt="Vela" className="brand-logo" />
          <span className="wordmark text-[18px] font-semibold text-[#f8fafc]">VELA</span>
        </button>
        <button type="button" onClick={() => onSetSidebarOpen(false)} title="折叠侧栏" aria-label="折叠侧栏" className="w-9 h-9 rounded-[10px] border-0 bg-transparent hover:bg-[#161d33] text-[#c3cde0] hover:text-[#f8fafc] flex items-center justify-center cursor-pointer">
          <IconChevronsLeft size={18} />
        </button>
      </div>

      <div className="px-3 pb-1 flex flex-col gap-2">
        {expandedNavItems.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={item.onClick}
            data-testid={`sidebar-nav-${item.id}`}
            className={`w-full px-2.5 py-2 rounded-[12px] border text-left flex items-center gap-3 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors ${
              item.active ? 'border-[#e0b64a]/70 bg-[#1d1a0f] text-[#f8fafc]' : 'border-[#26304d] bg-[#0e1426] hover:border-[#e0b64a] text-[#f8fafc]'
            }`}
          >
            <span className="w-9 h-9 rounded-[10px] bg-[#161d33] text-[#e0b64a] shrink-0 flex items-center justify-center">
              {item.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold">{item.label}</div>
              <div className="text-[11px] text-[#9aa8c7] truncate">{item.subtitle}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto border-t border-[#1e2740]/70 mt-1">
        <ProfileSidebarPanel
          tier={tier}
          profiles={profiles}
          selectedProfileIds={selectedProfileIds}
          active={activeSubpage === 'profiles'}
          onOpenProfileManager={(opts) => { onOpenProfileManager(opts); closeOnMobile(); }}
          onSetPrimaryProfile={onSetPrimaryProfile}
          onToggleSynastryProfile={onToggleSynastryProfile}
        />
      </div>

      <div className="p-3 border-t border-[#1e2740]">
        <button
          type="button"
          onClick={() => { closeOnMobile(); onOpenAccountOrAuth(); }}
          data-testid="sidebar-auth-btn"
          className="w-full flex items-center gap-2.5 min-w-0 p-1.5 rounded-[10px] border-0 bg-transparent hover:bg-[#161d33] text-left cursor-pointer"
        >
          {renderAvatar()}
          <div className="min-w-0 flex-1 flex flex-col">
            <span className="text-[13px] font-medium text-[#f8fafc] truncate">{uid ? displayName : '登录 / 注册账号'}</span>
            <span className="text-[11px] text-[#a3b0c5] truncate">{uid ? '账号登录与合规设置' : '同步已有档案与历史对话'}</span>
          </div>
          {!uid && <span className="px-2 py-0.5 rounded-[6px] bg-[#e0b64a] text-[#1a1405] text-[11px] font-bold shrink-0">登录</span>}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className={`no-print hidden lg:block h-full shrink-0 ${sidebarOpen ? 'w-[280px]' : 'w-[72px]'}`}>
        {sidebarOpen ? renderExpandedSidebar() : renderCollapsedRail()}
      </aside>
      {sidebarOpen && (
        <div className="no-print fixed inset-0 z-40 flex lg:hidden">
          <aside className="w-[280px] h-full shrink-0">{renderExpandedSidebar()}</aside>
          <button type="button" aria-label="关闭侧栏" onClick={() => onSetSidebarOpen(false)} className="flex-1 bg-black/55 border-0 cursor-pointer" />
        </div>
      )}
    </>
  );
}
