import {
  TIER_META,
  type ProfileInput,
  type ProfileRecord,
  type Tier,
} from '@vela-cf/shared';
import {
  IconChevronsLeft,
  IconNotebook,
  IconSearch,
  IconSparkles,
  IconSquarePen,
} from './Icons';
import { ProfileSidebarPanel } from './ProfileSidebarPanel';

interface WorkbenchSidebarProps {
  uid: string | null;
  displayName: string;
  photoURL: string | null;
  tier: Tier;
  sidebarOpen: boolean;
  needsMoreProfiles: boolean;
  portraitSubtitle: string;
  profiles: ProfileRecord[];
  selectedProfileIds: string[];
  onSetSidebarOpen: (open: boolean) => void;
  onNewSession: () => void;
  onOpenHistorySearch: () => void;
  onOpenPortrait: () => void;
  onOpenAccountOrAuth: () => void;
  onToggleProfile: (id: string) => void;
  onSaveProfile: (input: ProfileInput, editId?: string) => Promise<void>;
  onDeleteProfile: (id: string) => Promise<void>;
}

export function WorkbenchSidebar({
  uid,
  displayName,
  photoURL,
  tier,
  sidebarOpen,
  needsMoreProfiles,
  portraitSubtitle,
  profiles,
  selectedProfileIds,
  onSetSidebarOpen,
  onNewSession,
  onOpenHistorySearch,
  onOpenPortrait,
  onOpenAccountOrAuth,
  onToggleProfile,
  onSaveProfile,
  onDeleteProfile,
}: WorkbenchSidebarProps) {
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

  const renderCollapsedRail = () => {
    const railCls = 'w-10 h-10 rounded-[12px] border-0 bg-transparent hover:bg-[#101527] text-[#c3cde0] hover:text-[#f8fafc] flex items-center justify-center cursor-pointer';
    return (
      <div className="flex flex-col items-center justify-between h-full bg-[#070812]">
        <div className="w-full flex flex-col items-center gap-2">
          <div className="w-full h-[64px] px-2.5 flex items-center justify-center shrink-0">
            <button type="button" onClick={() => onSetSidebarOpen(true)} title="展开侧栏" aria-label="展开侧栏" className="flex items-center justify-center bg-transparent border-0 p-0.5 rounded-[12px] hover:bg-[#101527] cursor-pointer">
              <img src="/assets/logo-small.webp" alt="Vela" className="brand-logo" />
            </button>
          </div>
          <button type="button" onClick={onNewSession} title="新咨询" aria-label="新咨询" className={railCls}><IconSquarePen size={20} /></button>
          <button type="button" onClick={onOpenHistorySearch} title="搜索历史对话" aria-label="搜索历史对话" className={railCls}><IconSearch size={20} /></button>
          <button type="button" onClick={() => onSetSidebarOpen(true)} title="出生档案与合盘" aria-label="出生档案与合盘" className={railCls}><IconNotebook size={20} /></button>
          <button
            type="button"
            disabled={needsMoreProfiles}
            onClick={onOpenPortrait}
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
            onClick={onOpenAccountOrAuth}
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

  const renderExpandedSidebar = () => (
    <div className="flex flex-col h-full bg-[#101527] border-r border-[#1e2740]">
      <div className="h-[64px] px-2.5 flex items-center justify-between shrink-0">
        <button
          type="button"
          onClick={() => onSetSidebarOpen(false)}
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
            onClick={onOpenHistorySearch}
            title="搜索历史对话"
            aria-label="搜索历史对话"
            className="w-9 h-9 rounded-[10px] border-0 bg-transparent hover:bg-[#161d33] text-[#c3cde0] hover:text-[#f8fafc] flex items-center justify-center cursor-pointer"
          >
            <IconSearch size={18} />
          </button>
          <button
            type="button"
            onClick={() => onSetSidebarOpen(false)}
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
          onClick={() => { onNewSession(); onSetSidebarOpen(false); }}
          className="w-full min-h-[40px] px-3 rounded-[20px] border border-[#26304d] bg-[#161d33] hover:border-[#e0b64a] text-[#f8fafc] text-[13.5px] font-medium flex items-center justify-center gap-2 cursor-pointer"
        >
          <span className="text-[#c3cde0] flex items-center"><IconSquarePen size={18} /></span>
          <span>新咨询</span>
        </button>

        <button
          type="button"
          disabled={needsMoreProfiles}
          onClick={() => { onOpenPortrait(); onSetSidebarOpen(false); }}
          className="w-full px-3 py-2.5 rounded-[12px] border border-[#26304d] bg-[#0e1426] hover:border-[#e0b64a] disabled:opacity-45 disabled:hover:border-[#26304d] disabled:cursor-not-allowed text-left flex items-center gap-2.5 cursor-pointer transition-colors"
        >
          <span className="text-[#e0b64a] shrink-0 flex items-center"><IconSparkles size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[#f8fafc]">个人星盘画像</div>
            <div className="text-[11px] text-[#9aa8c7] truncate">{portraitSubtitle}</div>
          </div>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <ProfileSidebarPanel
          tier={tier}
          profiles={profiles}
          selectedProfileIds={selectedProfileIds}
          onToggleProfile={onToggleProfile}
          onSaveProfile={onSaveProfile}
          onDeleteProfile={onDeleteProfile}
        />
      </div>

      <div className="p-3 border-t border-[#1e2740]">
        <button
          type="button"
          onClick={() => {
            if (!uid) onSetSidebarOpen(false);
            onOpenAccountOrAuth();
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

  return (
    <>
      <aside className={`no-print hidden lg:block h-full shrink-0 ${sidebarOpen ? 'w-[280px]' : 'w-[72px]'}`}>
        {sidebarOpen ? renderExpandedSidebar() : renderCollapsedRail()}
      </aside>
      {sidebarOpen && (
        <div className="no-print fixed inset-0 z-40 flex lg:hidden">
          <aside className="w-[280px] h-full shrink-0">{renderExpandedSidebar()}</aside>
          <button
            type="button"
            aria-label="关闭侧栏"
            onClick={() => onSetSidebarOpen(false)}
            className="flex-1 bg-black/55 border-0 cursor-pointer"
          />
        </div>
      )}
    </>
  );
}
