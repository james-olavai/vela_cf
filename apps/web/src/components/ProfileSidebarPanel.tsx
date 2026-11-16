import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  type EntityType,
  type Gender,
  type LocationCandidate,
  type ProfileInput,
  type ProfileRecord,
  type Tier,
} from '@vela-cf/shared';
import type { ApiPlan } from '../lib/accountStore';
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
  plan?: ApiPlan;
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
  plan?: ApiPlan;
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
  plan, profiles, selectedProfileIds, active,
  onOpenProfileManager, onSetPrimaryProfile, onToggleSynastryProfile,
}: ProfileSidebarPanelProps) {
  const maxSelectable = plan ? Math.max(1, plan.maxSynastryProfiles) : Infinity;
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
          active ? 'border-border bg-panel-2 text-primary' : 'border-transparent bg-transparent hover:bg-panel-2 text-secondary'
        }`}
      >
        <span className="shrink-0 flex items-center justify-center"><IconNotebook size={20} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">档案管理</div>
          <div className="text-[13px] text-muted truncate">{profiles.length}{plan ? ` / ${plan.maxProfiles}` : ''} 个档案</div>
        </div>
      </button>

      <div className="flex items-center justify-between px-1 pt-1">
        <span className="text-[13px] font-medium text-muted">快速选择档案</span>
        <span className="text-[13px] text-muted">{partnerCount > 0 ? `已选 ${selectedProfileIds.length}${plan ? `/${maxSelectable}` : ''} 人` : '点击切换主盘'}</span>
      </div>

      {ordered.length === 0 ? (
        <button
          type="button"
          onClick={() => onOpenProfileManager({ startAdd: true })}
          className="w-full min-h-[40px] px-3 py-2 rounded-[10px] border border-dashed border-border-strong bg-transparent text-[13px] text-secondary hover:border-accent hover:text-primary cursor-pointer text-left"
        >
          + 点击添加出生信息
        </button>
      ) : (
        <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto" data-testid="sidebar-quick-profiles">
          {ordered.map((p) => {
            const isPrimary = p.id === primaryId;
            const isPartner = !isPrimary && selectedProfileIds.includes(p.id);
            const et = p.entityType ?? 'person';
            const lockedEntity = et !== 'person' && plan?.allowsEntityCharts === false;
            return (
              <div
                key={p.id}
                className={`flex items-center gap-1 px-1.5 py-1 rounded-[8px] border text-[13px] ${
                  isPrimary ? 'border-accent/50 bg-selected text-primary'
                    : isPartner ? 'border-border-strong bg-panel-2 text-body'
                    : 'border-transparent hover:bg-panel-2 text-secondary'
                }`}
              >
                <button
                  type="button"
                  disabled={lockedEntity}
                  onClick={() => onSetPrimaryProfile(p.id)}
                  aria-pressed={isPrimary} title={isPrimary ? '当前主档案' : '设为主档案'}
                  aria-label={isPrimary ? `${p.name} 当前为主档案` : `将 ${p.name} 设为主档案`}
                  data-testid="sidebar-ps-star"
                  className="w-6 h-6 shrink-0 flex items-center justify-center rounded bg-transparent border-0 text-[13px] text-accent hover:bg-white/10 cursor-pointer disabled:opacity-40"
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
                  {et !== 'person' && <span className="px-1 py-0.5 rounded bg-bubble text-[13px] text-info shrink-0">{ENTITY_LABELS[et]}</span>}
                </button>
                {!isPrimary && (
                  <button
                    type="button"
                    disabled={lockedEntity}
                    aria-pressed={isPartner} onClick={() => onToggleSynastryProfile(p.id)}
                    title={maxSelectable <= 1 ? '查看支持合盘的套餐' : isPartner ? '取消合盘' : '勾选为合盘人'}
                    aria-label={isPartner ? `取消合盘 ${p.name}` : `勾选合盘 ${p.name}`}
                    data-testid="sidebar-ps-check"
                    className={`w-6 h-6 shrink-0 flex items-center justify-center rounded bg-transparent border-0 text-[13px] hover:bg-white/10 cursor-pointer disabled:opacity-40 ${
                      isPartner ? 'text-accent-bright' : 'text-muted'
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
  uid, plan, profiles, selectedProfileIds, launch,
  onSetPrimaryProfile, onToggleSynastryProfile, onSaveProfile, onDeleteProfile, onOpenSubscription,
}: ProfileManagerSubpageProps) {
  const [formMode, setFormMode] = useState<'none' | 'add' | 'edit'>('none');
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('person');
  const [birthDateTime, setBirthDateTime] = useState('');
  const [cityQuery, setCityQuery] = useState('');
  const searchRun = useRef(0);
  const [searchBusy, setSearchBusy] = useState(false);
  useEffect(() => () => { ++searchRun.current; }, []);
  const [candidates, setCandidates] = useState<LocationCandidate[]>([]);
  const [selectedLoc, setSelectedLoc] = useState<LocationCandidate | null>(null);
  const [gender, setGender] = useState<Gender>('unset');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [needsConsent, setNeedsConsent] = useState(
    () => typeof window !== 'undefined' && !window.localStorage.getItem('vela_consent_choice'),
  );
  const [allowAnalytics, setAllowAnalytics] = useState(false);

  const maxProfiles = plan?.maxProfiles ?? Infinity;
  const maxSelectable = plan ? Math.max(1, plan.maxSynastryProfiles) : Infinity;
  const atCapacity = profiles.length >= maxProfiles;
  const primaryId = selectedProfileIds[0] ?? profiles[0]?.id;

  const resetForm = () => {
    ++searchRun.current; setSearchBusy(false);
    setFormMode('none'); setEditingId(undefined); setName(''); setEntityType('person');
    setBirthDateTime(''); setCityQuery(''); setCandidates([]);
    setSelectedLoc(null); setGender('unset'); setErr(null);
  };

  const startAdd = () => {
    resetForm();
    if (atCapacity) { setErr(`当前${plan?.label ?? '套餐'}最多保存 ${maxProfiles} 个档案，请先删除旧档案或升级方案。`); return; }
    setFormMode('add');
  };

  const startEdit = (p: ProfileRecord) => {
    ++searchRun.current; setSearchBusy(false);
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
    const run = ++searchRun.current;
    setErr(null); setSearchBusy(true); setCandidates([]);
    try {
      const list = await searchLocations(cityQuery);
      if (run !== searchRun.current) return;
      setCandidates(list);
      if (list.length === 0) setErr('未找到城市，请尝试英文或拼音');
    } catch (e) { if (run === searchRun.current) setErr(e instanceof Error ? e.message : '搜索失败'); }
    finally { if (run === searchRun.current) setSearchBusy(false); }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) { setErr('请填写称呼或名称'); return; }
    if (!selectedLoc || selectedLoc.displayName !== cityQuery) { setErr('请先搜索并选中城市'); return; }
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
    <form onSubmit={(e) => void handleSubmit(e)} data-testid="pm-form" className="p-4 rounded-[14px] border border-accent/40 bg-[#0b1020] flex flex-col gap-3">
      <div className="text-[13px] font-bold text-accent-bright">✦ {editingId ? '编辑出生档案' : '添加新出生档案'}</div>
      <div className="grid grid-cols-1 gap-2.5">
        <label htmlFor="profile-name">称呼 / 名称（必填）</label>
        <input id="profile-name" name="name" autoFocus required maxLength={64} placeholder={entityType === 'person' ? '称呼（如：本人）' : '名称（如：Apple / 日本）'} value={name} onChange={(e) => setName(e.target.value)} className="min-h-[38px] px-3 rounded-[8px] border border-border-strong bg-panel text-primary text-[13px]" />
        <label htmlFor="profile-birth">出生日期与时间（出生地当地时间，必填）</label>
        <input id="profile-birth" name="birthDateTime" required type="datetime-local" value={birthDateTime} onChange={(e) => setBirthDateTime(e.target.value)} className="min-h-[38px] px-3 rounded-[8px] border border-border-strong bg-panel text-primary text-[13px]" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 flex-1 min-w-[180px]">
          {(['person', 'company', 'country'] as const).map((et) => {
            const disabled = et !== 'person' && plan?.allowsEntityCharts === false;
            return (
              <button key={et} type="button" disabled={disabled} aria-pressed={entityType === et} onClick={() => setEntityType(et)} title={disabled ? '查看支持公司/国家盘的套餐' : undefined} className={`flex-1 min-h-[32px] rounded-[8px] border text-[13px] cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${entityType === et ? 'border-accent bg-selected text-accent-bright' : 'border-border bg-panel text-muted'}`}>
                {ENTITY_LABELS[et]}
              </button>
            );
          })}
        </div>
        {entityType === 'person' && (
          <label htmlFor="profile-gender">性别（可选）</label>
        )}
        {entityType === 'person' && (
          <select id="profile-gender" name="gender" value={gender} onChange={(e) => setGender(e.target.value as Gender)} className="min-h-[32px] px-3 rounded-[8px] border border-border-strong bg-panel text-secondary text-[13px]">
            <option value="unset">性别（可选，紫微需填写）</option>
            <option value="female">女</option>
            <option value="male">男</option>
          </select>
        )}
      </div>
      <label htmlFor="profile-city">出生城市 / 地点（搜索后选择，必填）</label>
      <div className="flex gap-2">
        <input id="profile-city" name="city" required placeholder="出生城市 / 地点" value={cityQuery} onChange={(e) => { ++searchRun.current; setSearchBusy(false); setCityQuery(e.target.value); setSelectedLoc(null); setCandidates([]); }} className="flex-1 min-w-0 min-h-[38px] px-3 rounded-[8px] border border-border-strong bg-panel text-primary text-[13px]" />
        <button type="button" disabled={searchBusy} onClick={() => void handleSearch()} className="min-h-[38px] px-4 rounded-[8px] border border-border-strong bg-panel-2 text-primary text-[13px] cursor-pointer shrink-0">{searchBusy ? '搜索中…' : '搜索城市'}</button>
      </div>
      {selectedLoc && <p role="status" className="m-0 rounded-[10px] border border-border bg-panel p-3 text-[13px] text-secondary">已选：{selectedLoc.displayName}<br />时区：{selectedLoc.timezone} · 纬度 {selectedLoc.latitude} / 经度 {selectedLoc.longitude}</p>}
      {candidates.length > 0 && (
        <div className="flex flex-col gap-1 max-h-[130px] overflow-y-auto">
          {candidates.map((c, idx) => (
            <button key={idx} type="button" onClick={() => { ++searchRun.current; setSearchBusy(false); setSelectedLoc(c); setCityQuery(c.displayName); setCandidates([]); }} className="text-left px-3 py-1.5 rounded-[8px] border border-border bg-panel-2 text-[13px] text-primary hover:border-accent cursor-pointer">
              {c.displayName}
            </button>
          ))}
        </div>
      )}
      {needsConsent && !editingId && (
        <label className="flex items-center gap-2 text-[13px] text-muted cursor-pointer">
          <input type="checkbox" checked={allowAnalytics} onChange={(e) => setAllowAnalytics(e.target.checked)} className="accent-accent" />
          <span>允许匿名使用统计以改善体验（可选）</span>
        </label>
      )}
      {err && <p role="alert" className="m-0 text-[13px] text-danger">{err}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={resetForm} className="min-h-[36px] px-4 rounded-[8px] border border-border-strong bg-transparent text-secondary text-[13px] cursor-pointer">取消</button>
        <button type="submit" disabled={busy} className="min-h-[36px] px-5 rounded-[8px] border-0 bg-accent text-on-accent text-[13px] font-bold cursor-pointer disabled:opacity-50">{busy ? '保存中…' : editingId ? '更新' : '保存'}</button>
      </div>
    </form>
  );

  return (
    <div data-testid="profile-manager" className="mx-auto w-full max-w-3xl flex flex-col gap-4 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-divider pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 font-serif-sc text-[18px] font-bold text-primary">出生档案管理</h2>
            <span data-testid="pm-quota" className="px-2.5 py-0.5 rounded-full border border-border bg-panel-2 font-mono-num text-[13px] text-accent-bright">{profiles.length}{plan ? ` / ${maxProfiles} 容量` : ' 个档案 · 套餐加载中'}</span>
            {(
              <button type="button" onClick={onOpenSubscription} className="px-2 py-0.5 rounded-full border border-accent/40 bg-selected text-[13px] text-accent-bright cursor-pointer hover:border-accent">
                查看套餐权益
              </button>
            )}
          </div>
          <p className="m-0 mt-1 text-[13px] text-muted">★ 星标设为主档案（当前看盘对象） · {!plan ? `已选 ${selectedProfileIds.length} 人 · 套餐加载中，提交时验证权益` : maxSelectable >= 2 ? `☑ 勾选合盘人（最多 ${maxSelectable} 人同盘）` : '查看支持合盘的套餐'}{!uid ? ' · 访客资料仅保留在当前会话' : ''}</p>
        </div>
        <button type="button" onClick={startAdd} disabled={atCapacity} data-testid="pm-add" className="flex items-center gap-1.5 min-h-[38px] px-4 rounded-[10px] border-0 bg-accent text-on-accent text-[13px] font-bold cursor-pointer hover:bg-accent-bright disabled:opacity-45 disabled:cursor-not-allowed">
          <IconPlus size={15} /><span>添加档案</span>
        </button>
      </div>

      {err && formMode === 'none' && <p role="alert" className="m-0 text-[13px] text-danger">{err}</p>}

      {profiles.length > 0 && (
        <div className="flex items-center gap-2 rounded-[10px] border border-border bg-panel px-3 py-2">
          <span className="text-muted flex items-center"><IconSearch size={15} /></span>
          <label htmlFor="profile-filter" className="sr-only">搜索档案姓名或出生地点</label>
          <input id="profile-filter" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索姓名或出生地点…" className="w-full bg-transparent border-0 text-[13px] text-primary placeholder-[#7f8da9] focus:outline-none" />
        </div>
      )}

      {formMode === 'add' && renderForm()}

      {ordered.length === 0 && formMode !== 'add' ? (
        <div className="rounded-[14px] border border-dashed border-border-strong bg-panel/50 p-8 text-center flex flex-col items-center gap-3">
          <p className="m-0 text-[13px] text-muted">{query.trim() ? '没有匹配的档案。' : '还没有出生档案，添加后即可开启本命盘画像与咨询。'}</p>
          {!query.trim() && (
            <button type="button" onClick={startAdd} className="min-h-[38px] px-4 rounded-[10px] border-0 bg-accent text-on-accent text-[13px] font-bold cursor-pointer">+ 添加首个出生档案</button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {ordered.map((c) => {
            const isPrimary = c.id === primaryId;
            const isPartner = !isPrimary && selectedProfileIds.includes(c.id);
            const et = c.entityType ?? 'person';
            const lockedEntity = et !== 'person' && plan?.allowsEntityCharts === false;
            return (
              <div key={c.id} data-testid="pm-item" className={`rounded-[14px] border p-4 flex flex-col gap-3 ${isPrimary ? 'border-accent/50 bg-[#151722]' : isPartner ? 'border-border-strong bg-panel' : 'border-divider bg-[#0b1020]'}`}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button type="button" disabled={lockedEntity} onClick={() => onSetPrimaryProfile(c.id)} data-testid="pm-set-primary" aria-pressed={isPrimary} title={isPrimary ? '当前主档案' : '设为主档案'} className="flex items-center gap-1.5 bg-transparent border-0 p-0 text-[14.5px] font-bold text-primary hover:text-accent-bright cursor-pointer disabled:opacity-45">
                    <span className="text-[16px] text-accent">{isPrimary ? '★' : '☆'}</span><span>{c.name}</span>
                  </button>
                  {isPrimary && <span className="px-2 py-0.5 rounded-full border border-accent/40 bg-selected text-[13px] font-semibold text-accent-bright">主档案</span>}
                  {et !== 'person' && <span className="px-2 py-0.5 rounded bg-bubble text-[13px] text-info">{ENTITY_LABELS[et]}</span>}
                  <button type="button" disabled={isPrimary || lockedEntity} aria-pressed={isPrimary || isPartner} onClick={() => onToggleSynastryProfile(c.id)} data-testid="pm-synastry-check" className={`flex items-center gap-1 px-2 py-0.5 rounded-[6px] border text-[13px] cursor-pointer disabled:opacity-60 disabled:cursor-default ${isPrimary || isPartner ? 'border-accent/40 bg-selected text-accent-bright' : 'border-border bg-panel text-muted hover:border-border-strong'}`}>
                    <span>{isPrimary || isPartner ? '☑' : '☐'}</span>
                    <span>{isPrimary ? '主盘固定参与' : isPartner ? '合盘人已选' : maxSelectable >= 2 ? '勾选合盘' : '合盘需升级'}</span>
                  </button>
                  <span className="text-[13px] text-muted font-mono-num">{c.locationName} · {c.birthDateTime.replace('T', ' ')}{c.gender && GENDER_LABELS[c.gender] ? ` · ${GENDER_LABELS[c.gender]}` : ''}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button type="button" onClick={() => startEdit(c)} className="px-2.5 py-1 rounded-[8px] border border-border bg-panel-2 text-[13px] text-secondary hover:text-primary cursor-pointer">编辑</button>
                    <button type="button" onClick={() => { void onDeleteProfile(c.id).catch(() => setErr('删除失败，请重试')); }} className="px-2.5 py-1 rounded-[8px] border border-border bg-transparent text-[13px] text-muted hover:border-danger/50 hover:text-danger cursor-pointer">删除</button>
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
