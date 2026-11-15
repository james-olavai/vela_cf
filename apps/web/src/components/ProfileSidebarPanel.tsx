import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  TIER_META,
  type EntityType,
  type Gender,
  type LocationCandidate,
  type ProfileInput,
  type ProfileRecord,
  type Tier,
} from '@vela-cf/shared';
import { updateAnalyticsConsent } from '../lib/firebase';
import { searchLocations } from '../lib/store';
import { IconNotebook, IconPlus, IconSearch } from './Icons';

export interface ProfileManagerLaunch {
  seq: number;
  startAdd?: boolean;
  editId?: string;
}

interface ProfileSidebarPanelProps {
  tier: Tier;
  profiles: ProfileRecord[];
  selectedProfileIds: string[];
  active: boolean;
  onOpenProfileManager: (opts?: { startAdd?: boolean; editId?: string }) => void;
  onSetPrimaryProfile: (id: string) => void;
  onToggleSynastryProfile: (id: string) => void;
}

interface ProfileManagerSubpageProps {
  uid: string | null;
  tier: Tier;
  profiles: ProfileRecord[];
  selectedProfileIds: string[];
  launch: ProfileManagerLaunch;
  onSetPrimaryProfile: (id: string) => void;
  onToggleSynastryProfile: (id: string) => void;
  onSaveProfile: (input: ProfileInput, editId?: string) => Promise<void>;
  onDeleteProfile: (id: string) => Promise<void>;
  onOpenSubscription: () => void;
}

const ENTITY_LABELS: Record<EntityType, string> = { person: '个人', company: '公司', country: '国家' };
const GENDER_LABELS: Record<Gender, string> = { female: '女', male: '男', unset: '' };

function orderWithPrimaryFirst(profiles: ProfileRecord[], primaryId?: string): ProfileRecord[] {
  if (!primaryId) return profiles;
  const idx = profiles.findIndex((p) => p.id === primaryId);
  return idx <= 0 ? profiles : [profiles[idx], ...profiles.slice(0, idx), ...profiles.slice(idx + 1)];
}

export function ProfileSidebarPanel({
  tier, profiles, selectedProfileIds, active,
  onOpenProfileManager, onSetPrimaryProfile, onToggleSynastryProfile,
}: ProfileSidebarPanelProps) {
  const tierMeta = TIER_META[tier];
  const maxSelectable = Math.max(1, tierMeta.maxSynastryProfiles);
  const primaryId = selectedProfileIds[0] ?? profiles[0]?.id;
  const ordered = useMemo(() => orderWithPrimaryFirst(profiles, primaryId), [profiles, primaryId]);
  const partnerCount = Math.max(0, selectedProfileIds.length - 1);

  return (
    <div className="px-3 py-2 flex flex-col gap-2">
      <button
        type="button"
        onClick={() => onOpenProfileManager()}
        data-testid="sidebar-nav-profiles"
        className={`w-full px-2.5 py-2 rounded-[12px] border text-left flex items-center gap-3 cursor-pointer transition-colors ${
          active ? 'border-[#e0b64a]/70 bg-[#1d1a0f] text-[#f8fafc]' : 'border-[#26304d] bg-[#0e1426] hover:border-[#e0b64a] text-[#f8fafc]'
        }`}
      >
        <span className="w-9 h-9 rounded-[10px] bg-[#161d33] text-[#e0b64a] shrink-0 flex items-center justify-center"><IconNotebook size={20} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">档案管理</div>
          <div className="text-[11px] text-[#9aa8c7] truncate">已存 {profiles.length}/{tierMeta.maxProfiles} · 管理 / 设主档 / 合盘</div>
        </div>
      </button>

      <div className="flex items-center justify-between px-1 pt-1">
        <span className="text-[11.5px] font-medium text-[#9aa8c7]">快速选择档案</span>
        <span className="text-[11px] text-[#7f8da9]">{partnerCount > 0 ? `合盘 ${selectedProfileIds.length}/${maxSelectable} 人` : '点击切换主盘'}</span>
      </div>

      {ordered.length === 0 ? (
        <button
          type="button"
          onClick={() => onOpenProfileManager({ startAdd: true })}
          className="w-full min-h-[40px] px-3 py-2 rounded-[10px] border border-dashed border-[#3a4668] bg-transparent text-[12.5px] text-[#c3cde0] hover:border-[#e0b64a] hover:text-[#f8fafc] cursor-pointer text-left"
        >
          + 点击添加出生信息
        </button>
      ) : (
        <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto" data-testid="sidebar-quick-profiles">
          {ordered.map((p) => {
            const isPrimary = p.id === primaryId;
            const isPartner = !isPrimary && selectedProfileIds.includes(p.id);
            const et = p.entityType ?? 'person';
            const lockedEntity = et !== 'person' && !tierMeta.allowsEntityCharts;
            return (
              <div
                key={p.id}
                className={`flex items-center gap-1 px-1.5 py-1 rounded-[8px] border text-[12.5px] ${
                  isPrimary ? 'border-[#e0b64a]/50 bg-[#1d1a0f] text-[#f8fafc]'
                    : isPartner ? 'border-[#3a4668] bg-[#161d33] text-[#e8edf6]'
                    : 'border-transparent hover:bg-[#161d33] text-[#c3cde0]'
                }`}
              >
                <button
                  type="button"
                  disabled={lockedEntity}
                  onClick={() => onSetPrimaryProfile(p.id)}
                  title={isPrimary ? '当前主档案' : '设为主档案'}
                  aria-label={isPrimary ? `${p.name} 当前为主档案` : `将 ${p.name} 设为主档案`}
                  data-testid="sidebar-ps-star"
                  className="w-6 h-6 shrink-0 flex items-center justify-center rounded bg-transparent border-0 text-[13px] text-[#e0b64a] hover:bg-white/10 cursor-pointer disabled:opacity-40"
                >
                  {isPrimary ? '★' : '☆'}
                </button>
                <button
                  type="button"
                  disabled={lockedEntity}
                  onClick={() => onSetPrimaryProfile(p.id)}
                  title={`查看 ${p.name} 星盘`}
                  className="flex-1 min-w-0 flex items-center gap-1.5 bg-transparent border-0 text-left text-inherit cursor-pointer disabled:opacity-40 p-0"
                >
                  <span className="truncate font-medium">{p.name}</span>
                  {et !== 'person' && <span className="px-1 py-0.5 rounded bg-[#1d2540] text-[10px] text-[#a8c0f0] shrink-0">{ENTITY_LABELS[et]}</span>}
                </button>
                {!isPrimary && (
                  <button
                    type="button"
                    disabled={lockedEntity}
                    onClick={() => onToggleSynastryProfile(p.id)}
                    title={maxSelectable <= 1 ? '升级 Go/Pro 开启合盘勾选' : isPartner ? '取消合盘' : '勾选为合盘人'}
                    aria-label={isPartner ? `取消合盘 ${p.name}` : `勾选合盘 ${p.name}`}
                    data-testid="sidebar-ps-check"
                    className={`w-6 h-6 shrink-0 flex items-center justify-center rounded bg-transparent border-0 text-[13px] hover:bg-white/10 cursor-pointer disabled:opacity-40 ${
                      isPartner ? 'text-[#f7d57f]' : 'text-[#8e9bb5]'
                    }`}
                  >
                    {isPartner ? '☑' : '☐'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ProfileManagerSubpage({
  uid, tier, profiles, selectedProfileIds, launch,
  onSetPrimaryProfile, onToggleSynastryProfile, onSaveProfile, onDeleteProfile, onOpenSubscription,
}: ProfileManagerSubpageProps) {
  const [formMode, setFormMode] = useState<'none' | 'add' | 'edit'>('none');
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('person');
  const [birthDateTime, setBirthDateTime] = useState('1994-06-03T08:20');
  const [cityQuery, setCityQuery] = useState('');
  const [candidates, setCandidates] = useState<LocationCandidate[]>([]);
  const [selectedLoc, setSelectedLoc] = useState<LocationCandidate | null>(null);
  const [gender, setGender] = useState<Gender>('unset');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [needsConsent, setNeedsConsent] = useState(
    () => typeof window !== 'undefined' && !window.localStorage.getItem('vela_consent_choice'),
  );
  const [allowAnalytics, setAllowAnalytics] = useState(false);

  const tierMeta = TIER_META[tier];
  const maxProfiles = tierMeta.maxProfiles;
  const maxSelectable = Math.max(1, tierMeta.maxSynastryProfiles);
  const atCapacity = profiles.length >= maxProfiles;
  const primaryId = selectedProfileIds[0] ?? profiles[0]?.id;

  const resetForm = () => {
    setFormMode('none'); setEditingId(undefined); setName(''); setEntityType('person');
    setBirthDateTime('1994-06-03T08:20'); setCityQuery(''); setCandidates([]);
    setSelectedLoc(null); setGender('unset'); setErr(null);
  };

  const startAdd = () => {
    resetForm();
    if (atCapacity) { setErr(`当前${tierMeta.label}最多保存 ${maxProfiles} 个档案，请先删除旧档案或升级方案。`); return; }
    setFormMode('add');
  };

  const startEdit = (p: ProfileRecord) => {
    setFormMode('edit'); setEditingId(p.id); setName(p.name);
    setEntityType(p.entityType ?? 'person'); setBirthDateTime(p.birthDateTime);
    setCityQuery(p.locationName);
    setSelectedLoc({ displayName: p.locationName, latitude: p.latitude, longitude: p.longitude, timezone: p.timezone });
    setGender(p.gender ?? 'unset'); setCandidates([]); setErr(null);
  };

  useEffect(() => {
    if (launch.startAdd) startAdd();
    else if (launch.editId) {
      const target = profiles.find((p) => p.id === launch.editId);
      if (target) startEdit(target);
    }
  }, [launch.seq]);

  const ordered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? profiles.filter((p) => p.name.toLowerCase().includes(q) || p.locationName.toLowerCase().includes(q)) : profiles;
    return orderWithPrimaryFirst(list, primaryId);
  }, [profiles, query, primaryId]);

  const handleSearch = async () => {
    if (!cityQuery.trim()) return;
    setErr(null);
    try {
      const list = await searchLocations(cityQuery);
      setCandidates(list);
      if (list.length === 0) setErr('未找到城市，请尝试英文或拼音');
    } catch (e) { setErr(e instanceof Error ? e.message : '搜索失败'); }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedLoc) { setErr('请先搜索并选中城市'); return; }
    setBusy(true); setErr(null);
    try {
      await onSaveProfile({
        name: name.trim(), entityType, birthDateTime, locationName: selectedLoc.displayName,
        latitude: selectedLoc.latitude, longitude: selectedLoc.longitude, timezone: selectedLoc.timezone,
        gender: entityType === 'person' ? gender : 'unset',
      }, editingId);
      if (needsConsent && !editingId) {
        window.localStorage.setItem('vela_consent_choice', allowAnalytics ? 'granted' : 'denied');
        void updateAnalyticsConsent(allowAnalytics);
        setNeedsConsent(false);
      }
      resetForm();
    } catch (e) { setErr(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };

  const renderForm = () => (
    <form onSubmit={(e) => void handleSubmit(e)} data-testid="pm-form" className="p-4 rounded-[14px] border border-[#e0b64a]/40 bg-[#0b1020] flex flex-col gap-3">
      <div className="text-[13px] font-bold text-[#f7d57f]">✦ {editingId ? '编辑出生档案' : '添加新出生档案'}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <input required placeholder={entityType === 'person' ? '称呼（如：本人）' : '名称（如：Apple / 日本）'} value={name} onChange={(e) => setName(e.target.value)} className="min-h-[38px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[13px]" />
        <input required type="datetime-local" value={birthDateTime} onChange={(e) => setBirthDateTime(e.target.value)} className="min-h-[38px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[13px]" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 flex-1 min-w-[180px]">
          {(['person', 'company', 'country'] as const).map((et) => {
            const disabled = et !== 'person' && !tierMeta.allowsEntityCharts;
            return (
              <button key={et} type="button" disabled={disabled} onClick={() => setEntityType(et)} title={disabled ? 'Pro 订阅支持公司/国家盘' : undefined} className={`flex-1 min-h-[32px] rounded-[8px] border text-[12px] cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${entityType === et ? 'border-[#e0b64a] bg-[#1d1a0f] text-[#f7d57f]' : 'border-[#26304d] bg-[#101527] text-[#a3b0c5]'}`}>
                {ENTITY_LABELS[et]}
              </button>
            );
          })}
        </div>
        {entityType === 'person' && (
          <select value={gender} onChange={(e) => setGender(e.target.value as Gender)} className="min-h-[32px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#c3cde0] text-[12.5px]">
            <option value="unset">性别（可选，紫微需填写）</option>
            <option value="female">女</option>
            <option value="male">男</option>
          </select>
        )}
      </div>
      <div className="flex gap-2">
        <input placeholder="出生城市 / 地点" value={cityQuery} onChange={(e) => setCityQuery(e.target.value)} className="flex-1 min-w-0 min-h-[38px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[13px]" />
        <button type="button" onClick={() => void handleSearch()} className="min-h-[38px] px-4 rounded-[8px] border border-[#3a4668] bg-[#161d33] text-[#f8fafc] text-[12.5px] cursor-pointer shrink-0">搜</button>
      </div>
      {candidates.length > 0 && (
        <div className="flex flex-col gap-1 max-h-[130px] overflow-y-auto">
          {candidates.map((c, idx) => (
            <button key={idx} type="button" onClick={() => { setSelectedLoc(c); setCityQuery(c.displayName); setCandidates([]); }} className="text-left px-3 py-1.5 rounded-[8px] border border-[#26304d] bg-[#161d33] text-[12px] text-[#f8fafc] hover:border-[#e0b64a] cursor-pointer">
              {c.displayName}
            </button>
          ))}
        </div>
      )}
      {needsConsent && !editingId && (
        <label className="flex items-center gap-2 text-[12px] text-[#a3b0c5] cursor-pointer">
          <input type="checkbox" checked={allowAnalytics} onChange={(e) => setAllowAnalytics(e.target.checked)} className="accent-[#e0b64a]" />
          <span>允许匿名使用统计以改善体验（可选）</span>
        </label>
      )}
      {err && <p className="m-0 text-[12px] text-[#ff9d8a]">{err}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={resetForm} className="min-h-[36px] px-4 rounded-[8px] border border-[#3a4668] bg-transparent text-[#c3cde0] text-[12.5px] cursor-pointer">取消</button>
        <button type="submit" disabled={busy} className="min-h-[36px] px-5 rounded-[8px] border-0 bg-[#e0b64a] text-[#1a1405] text-[12.5px] font-bold cursor-pointer disabled:opacity-50">{busy ? '保存中…' : editingId ? '更新' : '保存'}</button>
      </div>
    </form>
  );

  return (
    <div data-testid="profile-manager" className="mx-auto w-full max-w-3xl flex flex-col gap-4 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1e2740] pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 font-serif-sc text-[18px] font-bold text-[#f8fafc]">出生档案管理</h2>
            <span data-testid="pm-quota" className="px-2.5 py-0.5 rounded-full border border-[#26304d] bg-[#161d33] font-mono-num text-[12px] text-[#f7d57f]">{profiles.length} / {maxProfiles} 容量</span>
            {tier !== 'pro' && (
              <button type="button" onClick={onOpenSubscription} className="px-2 py-0.5 rounded-full border border-[#e0b64a]/40 bg-[#1d1a0f] text-[11px] text-[#f7d57f] cursor-pointer hover:border-[#e0b64a]">
                {tier === 'free' ? 'Go 可放 5 个 / Pro 50 个' : '升级 Pro 扩容至 50 个'}
              </button>
            )}
          </div>
          <p className="m-0 mt-1 text-[12px] text-[#9aa8c7]">★ 星标设为主档案（当前看盘对象） · {maxSelectable >= 2 ? `☑ 勾选合盘人（最多 ${maxSelectable} 人同盘）` : '合盘勾选需 Go（2人）或 Pro（4人）'}{!uid ? ' · 访客资料仅保留在当前会话' : ''}</p>
        </div>
        <button type="button" onClick={startAdd} disabled={atCapacity} data-testid="pm-add" className="flex items-center gap-1.5 min-h-[38px] px-4 rounded-[10px] border-0 bg-[#e0b64a] text-[#1a1405] text-[13px] font-bold cursor-pointer hover:bg-[#f7d57f] disabled:opacity-45 disabled:cursor-not-allowed">
          <IconPlus size={15} /><span>添加档案</span>
        </button>
      </div>

      {err && formMode === 'none' && <p role="alert" className="m-0 text-[12.5px] text-[#ff9d8a]">{err}</p>}

      {profiles.length > 0 && (
        <div className="flex items-center gap-2 rounded-[10px] border border-[#26304d] bg-[#101527] px-3 py-2">
          <span className="text-[#8e9bb5] flex items-center"><IconSearch size={15} /></span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索姓名或出生地点…" className="w-full bg-transparent border-0 text-[13px] text-[#f8fafc] placeholder-[#7f8da9] focus:outline-none" />
        </div>
      )}

      {formMode === 'add' && renderForm()}

      {ordered.length === 0 && formMode !== 'add' ? (
        <div className="rounded-[14px] border border-dashed border-[#3a4668] bg-[#101527]/50 p-8 text-center flex flex-col items-center gap-3">
          <p className="m-0 text-[13px] text-[#a3b0c5]">{query.trim() ? '没有匹配的档案。' : '还没有出生档案，添加后即可开启本命盘画像与咨询。'}</p>
          {!query.trim() && (
            <button type="button" onClick={startAdd} className="min-h-[38px] px-4 rounded-[10px] border-0 bg-[#e0b64a] text-[#1a1405] text-[13px] font-bold cursor-pointer">+ 添加首个出生档案</button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {ordered.map((c) => {
            const isPrimary = c.id === primaryId;
            const isPartner = !isPrimary && selectedProfileIds.includes(c.id);
            const et = c.entityType ?? 'person';
            const lockedEntity = et !== 'person' && !tierMeta.allowsEntityCharts;
            return (
              <div key={c.id} data-testid="pm-item" className={`rounded-[14px] border p-4 flex flex-col gap-3 ${isPrimary ? 'border-[#e0b64a]/50 bg-[#151722]' : isPartner ? 'border-[#3a4668] bg-[#101527]' : 'border-[#1e2740] bg-[#0b1020]'}`}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button type="button" disabled={lockedEntity} onClick={() => onSetPrimaryProfile(c.id)} data-testid="pm-set-primary" title={isPrimary ? '当前主档案' : '设为主档案'} className="flex items-center gap-1.5 bg-transparent border-0 p-0 text-[14.5px] font-bold text-[#f8fafc] hover:text-[#f7d57f] cursor-pointer disabled:opacity-45">
                    <span className="text-[16px] text-[#e0b64a]">{isPrimary ? '★' : '☆'}</span><span>{c.name}</span>
                  </button>
                  {isPrimary && <span className="px-2 py-0.5 rounded-full border border-[#e0b64a]/40 bg-[#1d1a0f] text-[11px] font-semibold text-[#f7d57f]">主档案</span>}
                  {et !== 'person' && <span className="px-2 py-0.5 rounded bg-[#1d2540] text-[11px] text-[#a8c0f0]">{ENTITY_LABELS[et]}</span>}
                  <button type="button" disabled={isPrimary || lockedEntity} onClick={() => onToggleSynastryProfile(c.id)} data-testid="pm-synastry-check" className={`flex items-center gap-1 px-2 py-0.5 rounded-[6px] border text-[11.5px] cursor-pointer disabled:opacity-60 disabled:cursor-default ${isPrimary || isPartner ? 'border-[#e0b64a]/40 bg-[#1d1a0f] text-[#f7d57f]' : 'border-[#26304d] bg-[#101527] text-[#a3b0c5] hover:border-[#3a4668]'}`}>
                    <span>{isPrimary || isPartner ? '☑' : '☐'}</span>
                    <span>{isPrimary ? '主盘固定参与' : isPartner ? '合盘人已选' : maxSelectable >= 2 ? '勾选合盘' : '合盘需升级'}</span>
                  </button>
                  <span className="text-[12px] text-[#9aa8c7] font-mono-num">{c.locationName} · {c.birthDateTime.replace('T', ' ')}{c.gender && GENDER_LABELS[c.gender] ? ` · ${GENDER_LABELS[c.gender]}` : ''}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button type="button" onClick={() => startEdit(c)} className="px-2.5 py-1 rounded-[8px] border border-[#26304d] bg-[#161d33] text-[12px] text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer">编辑</button>
                    <button type="button" onClick={() => void onDeleteProfile(c.id)} className="px-2.5 py-1 rounded-[8px] border border-[#26304d] bg-transparent text-[12px] text-[#a3b0c5] hover:border-[#ff9d8a]/50 hover:text-[#ff9d8a] cursor-pointer">删除</button>
                  </div>
                </div>
                {formMode === 'edit' && editingId === c.id && renderForm()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
