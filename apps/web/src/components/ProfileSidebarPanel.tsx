import { useState, type FormEvent } from 'react';
import {
  TIER_META,
  type ConsultationMode,
  type EntityType,
  type Gender,
  type LocationCandidate,
  type ProfileInput,
  type ProfileRecord,
  type Tier,
} from '@vela-cf/shared';
import { searchLocations } from '../lib/store';

interface ProfileSidebarPanelProps {
  tier: Tier;
  mode: ConsultationMode;
  profiles: ProfileRecord[];
  selectedProfileIds: string[];
  onToggleProfile: (id: string) => void;
  onSaveProfile: (input: ProfileInput, editId?: string) => Promise<void>;
  onDeleteProfile: (id: string) => Promise<void>;
  onOpenUpgrade: () => void;
}

const ENTITY_LABELS: Record<EntityType, string> = {
  person: '个人',
  company: '公司',
  country: '国家',
};

export function ProfileSidebarPanel({
  tier,
  mode,
  profiles,
  selectedProfileIds,
  onToggleProfile,
  onSaveProfile,
  onDeleteProfile,
  onOpenUpgrade,
}: ProfileSidebarPanelProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('person');
  const [birthDateTime, setBirthDateTime] = useState('1994-06-03T08:20');
  const [cityQuery, setCityQuery] = useState('');
  const [candidates, setCandidates] = useState<LocationCandidate[]>([]);
  const [selectedLoc, setSelectedLoc] = useState<LocationCandidate | null>(null);
  const [gender, setGender] = useState<Gender>('unset');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tierMeta = TIER_META[tier];

  const resetForm = () => {
    setFormOpen(false);
    setEditingId(undefined);
    setName('');
    setEntityType('person');
    setBirthDateTime('1994-06-03T08:20');
    setCityQuery('');
    setCandidates([]);
    setSelectedLoc(null);
    setGender('unset');
    setErr(null);
  };

  const startEdit = (p: ProfileRecord) => {
    setFormOpen(true);
    setEditingId(p.id);
    setName(p.name);
    setEntityType(p.entityType ?? 'person');
    setBirthDateTime(p.birthDateTime);
    setCityQuery(p.locationName);
    setSelectedLoc({
      displayName: p.locationName,
      latitude: p.latitude,
      longitude: p.longitude,
      timezone: p.timezone,
    });
    setGender(p.gender ?? 'unset');
    setCandidates([]);
    setErr(null);
  };

  const handleSearch = async () => {
    if (!cityQuery.trim()) return;
    setErr(null);
    try {
      const list = await searchLocations(cityQuery);
      setCandidates(list);
      if (list.length === 0) setErr('未找到城市，请尝试英文或拼音');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '搜索失败');
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedLoc) {
      setErr('请先搜索并选中城市');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSaveProfile(
        {
          name: name.trim(),
          entityType,
          birthDateTime,
          locationName: selectedLoc.displayName,
          latitude: selectedLoc.latitude,
          longitude: selectedLoc.longitude,
          timezone: selectedLoc.timezone,
          gender: entityType === 'person' ? gender : 'unset',
        },
        editingId,
      );
      resetForm();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 py-2 flex flex-col gap-2 border-b border-[#1e2740]">
      <div className="flex items-center justify-between px-1">
        <span className="text-[12px] font-medium text-[#a3b0c5]">
          {mode === 'synastry'
            ? `合盘档案 (${selectedProfileIds.length}/${tierMeta.maxSynastryProfiles || 2})`
            : '出生档案'}
        </span>
        <button
          type="button"
          onClick={() => (formOpen ? resetForm() : setFormOpen(true))}
          className="px-2 py-1 rounded-[6px] border-0 bg-transparent text-[12px] text-[#e0b64a] hover:bg-[#161d33] cursor-pointer"
        >
          {formOpen ? '收起' : '+ 添加'}
        </button>
      </div>

      {mode === 'synastry' && tierMeta.maxSynastryProfiles < 2 && (
        <button
          type="button"
          onClick={onOpenUpgrade}
          className="text-left px-2.5 py-2 rounded-[8px] border border-[#e0b64a]/40 bg-[#1d1a0f] text-[12px] text-[#f7d57f] cursor-pointer"
        >
          多人合盘需 Go（双人）或 Pro（最多 4 个）→ 点击升级
        </button>
      )}

      {profiles.length === 0 && !formOpen ? (
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="w-full min-h-[40px] px-3 py-2 rounded-[10px] border border-dashed border-[#3a4668] bg-transparent text-[13px] text-[#c3cde0] hover:border-[#e0b64a] hover:text-[#f8fafc] cursor-pointer text-left"
        >
          + 点击添加出生信息
        </button>
      ) : (
        <div className="flex flex-col gap-1 max-h-[168px] overflow-y-auto">
          {profiles.map((p) => {
            const active = selectedProfileIds.includes(p.id);
            const et = p.entityType ?? 'person';
            const lockedEntity = et !== 'person' && !tierMeta.allowsEntityCharts;
            return (
              <div
                key={p.id}
                className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-[8px] border text-[13px] ${
                  active
                    ? 'border-[#e0b64a]/60 bg-[#1d1a0f] text-[#f8fafc]'
                    : 'border-transparent hover:bg-[#161d33] text-[#c3cde0]'
                }`}
              >
                <button
                  type="button"
                  disabled={lockedEntity}
                  onClick={() => onToggleProfile(p.id)}
                  className="flex-1 min-w-0 flex items-center gap-1.5 bg-transparent border-0 text-left text-inherit cursor-pointer disabled:opacity-45 p-0"
                >
                  <span className="text-[#e0b64a] shrink-0 text-[12px]">
                    {mode === 'synastry' ? (active ? '☑' : '☐') : active ? '★' : '☆'}
                  </span>
                  <span className="truncate font-medium">{p.name}</span>
                  {et !== 'person' && (
                    <span className="px-1 py-0.5 rounded bg-[#1d2540] text-[10px] text-[#a8c0f0] shrink-0">
                      {ENTITY_LABELS[et]}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(p)}
                  aria-label={`编辑 ${p.name}`}
                  className="opacity-70 hover:opacity-100 bg-transparent border-0 text-[11px] text-[#a3b0c5] hover:text-[#f8fafc] cursor-pointer px-1"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={() => void onDeleteProfile(p.id)}
                  aria-label={`删除 ${p.name}`}
                  className="opacity-70 hover:opacity-100 bg-transparent border-0 text-[11px] text-[#a3b0c5] hover:text-[#ff9d8a] cursor-pointer px-1"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {formOpen && (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="p-2.5 rounded-[10px] border border-[#26304d] bg-[#070812] flex flex-col gap-2"
        >
          <input
            required
            placeholder={entityType === 'person' ? '称呼（如：本人）' : '名称（如：Apple / 日本）'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full min-h-[34px] px-2.5 rounded-[6px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[12px]"
          />
          <div className="flex gap-1">
            {(['person', 'company', 'country'] as const).map((et) => {
              const disabled = et !== 'person' && !tierMeta.allowsEntityCharts;
              return (
                <button
                  key={et}
                  type="button"
                  disabled={disabled}
                  onClick={() => setEntityType(et)}
                  title={disabled ? 'Pro 订阅支持公司/国家盘' : undefined}
                  className={`flex-1 min-h-[28px] rounded-[6px] border text-[11px] cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                    entityType === et
                      ? 'border-[#e0b64a] bg-[#1d1a0f] text-[#f7d57f]'
                      : 'border-[#26304d] bg-[#101527] text-[#a3b0c5]'
                  }`}
                >
                  {ENTITY_LABELS[et]}
                </button>
              );
            })}
          </div>
          <input
            required
            type="datetime-local"
            value={birthDateTime}
            onChange={(e) => setBirthDateTime(e.target.value)}
            className="w-full min-h-[34px] px-2 rounded-[6px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[12px]"
          />
          <div className="flex gap-1">
            <input
              placeholder="出生城市 / 地点"
              value={cityQuery}
              onChange={(e) => setCityQuery(e.target.value)}
              className="flex-1 min-w-0 min-h-[34px] px-2.5 rounded-[6px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[12px]"
            />
            <button
              type="button"
              onClick={() => void handleSearch()}
              className="min-h-[34px] px-2.5 rounded-[6px] border border-[#3a4668] bg-[#161d33] text-[#f8fafc] text-[12px] cursor-pointer shrink-0"
            >
              搜
            </button>
          </div>
          {candidates.length > 0 && (
            <div className="flex flex-col gap-1 max-h-[110px] overflow-y-auto">
              {candidates.map((c, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setSelectedLoc(c);
                    setCityQuery(c.displayName);
                    setCandidates([]);
                  }}
                  className="text-left px-2 py-1.5 rounded-[6px] border border-[#26304d] bg-[#161d33] text-[11px] text-[#f8fafc] hover:border-[#e0b64a] cursor-pointer"
                >
                  {c.displayName}
                </button>
              ))}
            </div>
          )}
          {entityType === 'person' && (
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value as Gender)}
              className="w-full min-h-[32px] px-2 rounded-[6px] border border-[#3a4668] bg-[#101527] text-[#c3cde0] text-[12px]"
            >
              <option value="unset">性别（可选，紫微需填写）</option>
              <option value="female">女</option>
              <option value="male">男</option>
            </select>
          )}
          {err && <p className="m-0 text-[11px] text-[#ff9d8a]">{err}</p>}
          <div className="flex gap-1.5">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 min-h-[34px] rounded-[6px] border-0 bg-[#e0b64a] text-[#1a1405] text-[12px] font-bold cursor-pointer disabled:opacity-50"
            >
              {busy ? '保存中…' : editingId ? '更新' : '保存'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="min-h-[34px] px-2.5 rounded-[6px] border border-[#3a4668] bg-transparent text-[#c3cde0] text-[12px] cursor-pointer"
            >
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
