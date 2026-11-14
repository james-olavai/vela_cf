import { useEffect, useState, type FormEvent } from 'react';
import {
  computeUsagePercent,
  nextUtcMonthResetLabel,
  TIER_META,
  type EntityType,
  type Gender,
  type LocationCandidate,
  type ProfileInput,
  type ProfileRecord,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';
import { updateAnalyticsConsent } from '../lib/firebase';
import {
  createStripeCheckout,
  deleteUserAccount,
  exportUserDataJson,
  removeProfile,
  saveProfile,
  searchLocations,
} from '../lib/store';

export type SettingsTab = 'subscription' | 'profiles' | 'account';

interface SettingsModalProps {
  open: boolean;
  initialTab: SettingsTab;
  uid: string | null;
  email: string;
  tier: Tier;
  usage: UsageRecord;
  profiles: ProfileRecord[];
  onClose: () => void;
  onSignOut: () => void;
  onRequireLogin: () => void;
}

export function SettingsModal({
  open,
  initialTab,
  uid,
  email,
  tier,
  usage,
  profiles,
  onClose,
  onSignOut,
  onRequireLogin,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [checkoutBusy, setCheckoutBusy] = useState<'go' | 'pro' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setNotice(null);
    }
  }, [open, initialTab]);

  // Profile form state
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('person');
  const [birthDateTime, setBirthDateTime] = useState('1994-06-03T08:20');
  const [cityQuery, setCityQuery] = useState('');
  const [candidates, setCandidates] = useState<LocationCandidate[]>([]);
  const [selectedLoc, setSelectedLoc] = useState<LocationCandidate | null>(null);
  const [gender, setGender] = useState<Gender>('unset');
  const [profileBusy, setProfileBusy] = useState(false);

  // Delete confirm
  const [deleteText, setDeleteText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('vela_consent_choice') === 'granted',
  );

  if (!open) return null;

  const pct = computeUsagePercent(usage.used, tier);

  const handleUpgrade = async (target: 'go' | 'pro') => {
    if (!uid) {
      onClose();
      onRequireLogin();
      return;
    }
    setNotice(null);
    setCheckoutBusy(target);
    try {
      const url = await createStripeCheckout(uid, target);
      if (url) window.location.assign(url);
      else setNotice('当前环境尚未接入 Stripe 生产密钥，升级流程将在配置完成后开放。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '发起结账失败');
    } finally {
      setCheckoutBusy(null);
    }
  };

  const handleSearchCity = async () => {
    if (!cityQuery.trim()) return;
    setNotice(null);
    try {
      const list = await searchLocations(cityQuery);
      setCandidates(list);
      if (list.length === 0) setNotice('未找到匹配城市，请尝试英文或拼音。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '城市搜索失败');
    }
  };

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!uid) {
      onClose();
      onRequireLogin();
      return;
    }
    if (!selectedLoc) {
      setNotice('请先搜索并选中出生城市。');
      return;
    }
    setProfileBusy(true);
    setNotice(null);
    try {
      const payload: ProfileInput = {
        name: name.trim(),
        entityType,
        birthDateTime,
        locationName: selectedLoc.displayName,
        latitude: selectedLoc.latitude,
        longitude: selectedLoc.longitude,
        timezone: selectedLoc.timezone,
        gender: entityType === 'person' ? gender : 'unset',
      };
      await saveProfile(uid, editingId ?? null, payload);
      setEditingId(undefined);
      setName('');
      setEntityType('person');
      setCityQuery('');
      setSelectedLoc(null);
      setCandidates([]);
      setNotice('档案已保存。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '保存档案失败');
    } finally {
      setProfileBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-[680px] max-h-[88dvh] rounded-[16px] border border-[#26304d] bg-[#101527] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e2740]">
          <h2 id="settings-title" className="m-0 font-serif-sc text-[20px] font-bold text-[#f8fafc]">
            设置与订阅
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
            className="min-h-[36px] min-w-[36px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="flex gap-2 px-6 pt-3 border-b border-[#1e2740]">
          {(
            [
              { id: 'subscription', label: '订阅与额度' },
              { id: 'account', label: '账号与合规' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setTab(item.id);
                setNotice(null);
              }}
              className={`min-h-[42px] px-4 bg-transparent border-0 border-b-2 text-[14px] font-medium cursor-pointer ${
                tab === item.id
                  ? 'border-[#e0b64a] text-[#f8fafc]'
                  : 'border-transparent text-[#c3cde0] hover:text-[#f8fafc]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
          {notice && (
            <div role="status" className="px-4 py-2.5 rounded-[10px] border border-[#e0b64a]/40 bg-[#1d1a0f] text-[13px] text-[#f7d57f]">
              {notice}
            </div>
          )}

          {tab === 'subscription' && (
            <div className="flex flex-col gap-5">
              <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#161d33] flex flex-col gap-2">
                <div className="flex items-center justify-between text-[14px]">
                  <span className="font-bold text-[#f8fafc]">
                    当前方案：{TIER_META[tier].label}
                  </span>
                  <span className="font-mono-num text-[#f7d57f]">
                    已用 {pct}%
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-[#070812] overflow-hidden">
                  <div className="h-full bg-[#e0b64a] transition-[width]" style={{ width: `${pct}%` }} />
                </div>
                <p className="m-0 text-[12px] text-[#a3b0c5]">
                  按 Gemini 4 Hydrogen 实际对话与推理 Token 用量实时折算，{nextUtcMonthResetLabel()}（UTC）重置。
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(['go', 'pro'] as const).map((plan) => {
                  const meta = TIER_META[plan];
                  const isCurrent = tier === plan;
                  return (
                    <div
                      key={plan}
                      className={`p-5 rounded-[14px] border flex flex-col gap-3 ${
                        plan === 'pro' ? 'border-[#e0b64a]/60 bg-[#1d1a0f]/50' : 'border-[#26304d] bg-[#070812]'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-serif-sc text-[18px] font-bold text-[#f8fafc]">
                          {meta.label}
                        </span>
                        <span className="font-mono-num text-[14px] text-[#f7d57f]">{meta.priceLabel}</span>
                      </div>
                      <p className="m-0 text-[13px] text-[#c3cde0] leading-[1.6]">
                        {meta.highlights.join(' · ')}
                      </p>
                      <button
                        type="button"
                        disabled={isCurrent || checkoutBusy !== null}
                        onClick={() => void handleUpgrade(plan)}
                        className="mt-auto min-h-[42px] rounded-[10px] bg-[#e0b64a] text-[#1a1405] text-[14px] font-bold border-0 cursor-pointer hover:bg-[#f7d57f] disabled:opacity-45"
                      >
                        {isCurrent ? '当前方案' : checkoutBusy === plan ? '正在跳转…' : `升级到 ${meta.label}`}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'profiles' && (
            <div className="flex flex-col gap-5">
              {profiles.length > 0 && (
                <div className="flex flex-col gap-2">
                  {profiles.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-3 px-4 py-3 rounded-[10px] border border-[#26304d] bg-[#161d33]"
                    >
                      <div className="min-w-0">
                        <p className="m-0 text-[14px] font-bold text-[#f8fafc]">{p.name}</p>
                        <p className="m-0 font-mono-num text-[12px] text-[#a3b0c5] truncate">
                          {p.birthDateTime.replace('T', ' ')} · {p.locationName}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
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
                            setGender(p.gender);
                          }}
                          className="min-h-[34px] px-3 rounded-[8px] border border-[#3a4668] bg-transparent text-[12px] text-[#c3cde0] cursor-pointer"
                        >
                          编辑
                        </button>
                        {uid && (
                          <button
                            type="button"
                            onClick={() => void removeProfile(uid, p.id)}
                            className="min-h-[34px] px-3 rounded-[8px] border border-[#3a4668] bg-transparent text-[12px] text-[#ff9d8a] cursor-pointer"
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={(e) => void handleSaveProfile(e)} className="p-4 rounded-[12px] border border-[#26304d] bg-[#070812] flex flex-col gap-3">
                <h3 className="m-0 text-[15px] font-bold text-[#f8fafc]">
                  {editingId ? '编辑出生档案' : '新建出生档案'}
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    required
                    placeholder="称呼（如：本人）"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="min-h-[42px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[14px]"
                  />
                  <input
                    required
                    type="datetime-local"
                    value={birthDateTime}
                    onChange={(e) => setBirthDateTime(e.target.value)}
                    className="min-h-[42px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[14px]"
                  />
                </div>
                <div className="flex gap-2">
                  {(
                    [
                      { id: 'person', label: '个人' },
                      { id: 'company', label: '公司 (Pro)' },
                      { id: 'country', label: '国家 (Pro)' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      disabled={opt.id !== 'person' && !TIER_META[tier].allowsEntityCharts}
                      onClick={() => setEntityType(opt.id)}
                      className={`min-h-[34px] px-3 rounded-[8px] border text-[12px] cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                        entityType === opt.id
                          ? 'border-[#e0b64a] bg-[#1d1a0f] text-[#f7d57f]'
                          : 'border-[#26304d] bg-[#101527] text-[#c3cde0]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    placeholder="输入出生城市搜索"
                    value={cityQuery}
                    onChange={(e) => setCityQuery(e.target.value)}
                    className="flex-1 min-h-[42px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[14px]"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSearchCity()}
                    className="min-h-[42px] px-4 rounded-[8px] border border-[#3a4668] bg-[#161d33] text-[#f8fafc] text-[13px] cursor-pointer"
                  >
                    搜索城市
                  </button>
                </div>
                {candidates.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {candidates.map((c, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setSelectedLoc(c);
                          setCityQuery(c.displayName);
                          setCandidates([]);
                        }}
                        className="text-left px-3 py-2 rounded-[8px] border border-[#26304d] bg-[#161d33] text-[13px] text-[#f8fafc] hover:border-[#e0b64a] cursor-pointer"
                      >
                        {c.displayName} ({c.timezone})
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <select
                    value={gender}
                    onChange={(e) => setGender(e.target.value as Gender)}
                    aria-label="性别（紫微斗数需要）"
                    className="min-h-[42px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[14px]"
                  >
                    <option value="unset">性别：暂不填写</option>
                    <option value="female">女</option>
                    <option value="male">男</option>
                  </select>
                  <button
                    type="submit"
                    disabled={profileBusy}
                    className="min-h-[42px] px-5 rounded-[8px] bg-[#e0b64a] text-[#1a1405] text-[14px] font-bold border-0 cursor-pointer"
                  >
                    {profileBusy ? '保存中…' : '保存档案'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {tab === 'account' && (
            <div className="flex flex-col gap-5">
              <label className="p-4 rounded-[12px] border border-[#26304d] bg-[#070812] flex items-center justify-between gap-4 cursor-pointer">
                <div>
                  <p className="m-0 text-[14px] font-bold text-[#f8fafc]">匿名使用统计</p>
                  <p className="m-0 text-[12px] text-[#a3b0c5]">允许使用匿名统计改善产品体验（默认仅必要存储）。</p>
                </div>
                <input
                  type="checkbox"
                  checked={analyticsEnabled}
                  onChange={(e) => {
                    const granted = e.target.checked;
                    setAnalyticsEnabled(granted);
                    window.localStorage.setItem('vela_consent_choice', granted ? 'granted' : 'denied');
                    void updateAnalyticsConsent(granted);
                  }}
                  className="w-4 h-4 accent-[#e0b64a]"
                />
              </label>

              {!uid ? (
                <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#161d33] flex items-center justify-between">
                  <span className="text-[14px] text-[#c3cde0]">当前为访客预览模式</span>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onRequireLogin();
                    }}
                    className="min-h-[40px] px-4 rounded-[8px] bg-[#e0b64a] text-[#1a1405] text-[13px] font-bold border-0 cursor-pointer"
                  >
                    登录账号
                  </button>
                </div>
              ) : (
                <>
                  <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#161d33] flex items-center justify-between gap-4">
                    <div>
                      <p className="m-0 text-[14px] font-bold text-[#f8fafc]">{email}</p>
                      <p className="m-0 text-[12px] text-[#a3b0c5]">Google 账号登录</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onSignOut();
                      }}
                      className="min-h-[40px] px-4 rounded-[8px] border border-[#3a4668] bg-transparent text-[13px] text-[#f8fafc] cursor-pointer"
                    >
                      退出登录
                    </button>
                  </div>

                  <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#070812] flex items-center justify-between gap-4">
                    <div>
                      <p className="m-0 text-[14px] font-bold text-[#f8fafc]">导出个人数据</p>
                      <p className="m-0 text-[12px] text-[#a3b0c5]">导出本人全部出生档案、咨询会话与消息为 JSON。</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void exportUserDataJson(uid)}
                      className="min-h-[40px] px-4 rounded-[8px] border border-[#3a4668] bg-[#161d33] text-[13px] text-[#f8fafc] cursor-pointer shrink-0"
                    >
                      导出 JSON
                    </button>
                  </div>

                  <div className="p-4 rounded-[12px] border border-[#ff9d8a]/40 bg-[#070812] flex flex-col gap-3">
                    <p className="m-0 text-[14px] font-bold text-[#ff9d8a]">删除账号（不可恢复）</p>
                    <p className="m-0 text-[12px] text-[#c3cde0]">
                      输入「删除」二字确认注销账号、取消订阅并永久清除所有档案与对话。
                    </p>
                    <div className="flex gap-2">
                      <input
                        placeholder="请输入：删除"
                        value={deleteText}
                        onChange={(e) => setDeleteText(e.target.value)}
                        className="flex-1 min-h-[40px] px-3 rounded-[8px] border border-[#3a4668] bg-[#101527] text-[#f8fafc] text-[13px]"
                      />
                      <button
                        type="button"
                        disabled={deleteText !== '删除' || deleteBusy}
                        onClick={async () => {
                          setDeleteBusy(true);
                          try {
                            await deleteUserAccount(uid);
                            onClose();
                          } catch (err) {
                            setNotice(err instanceof Error ? err.message : '删除失败，请重新登录后重试');
                          } finally {
                            setDeleteBusy(false);
                          }
                        }}
                        className="min-h-[40px] px-4 rounded-[8px] border border-[#ff9d8a] bg-transparent text-[13px] font-bold text-[#ff9d8a] cursor-pointer disabled:opacity-40"
                      >
                        {deleteBusy ? '删除中…' : '确认删除'}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
