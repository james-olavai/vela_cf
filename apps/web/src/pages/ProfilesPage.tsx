import { useEffect, useState, type FormEvent } from 'react';
import {
  ProfileInputSchema,
  type Gender,
  type LocationCandidate,
  type ProfileRecord,
  type Tier,
} from '@vela-cf/shared';
import { AppFooter, AppHeader } from '../components/Layout';
import { navigate } from '../lib/router';
import { removeProfile, saveProfile, searchLocations } from '../lib/store';

interface ProfilesPageProps {
  uid: string;
  tier: Tier;
  used: number;
  profiles: ProfileRecord[];
}

export function ProfilesPage({ uid, tier, used, profiles }: ProfilesPageProps) {
  const [editingId, setEditingId] = useState<string | null>(() => profiles[0]?.id ?? null);
  const [name, setName] = useState('');
  const [birthDate, setBirthDate] = useState('1994-06-03');
  const [birthTime, setBirthTime] = useState('08:20');
  const [cityQuery, setCityQuery] = useState('');
  const [selectedLoc, setSelectedLoc] = useState<LocationCandidate | null>(null);
  const [candidates, setCandidates] = useState<LocationCandidate[]>([]);
  const [searchingCity, setSearchingCity] = useState(false);
  const [gender, setGender] = useState<Gender>('unset');
  const [consentedOther, setConsentedOther] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadIntoForm = (p: ProfileRecord | null) => {
    setFeedback(null);
    if (!p) {
      setEditingId(null);
      setName('');
      setBirthDate('1994-06-03');
      setBirthTime('08:20');
      setCityQuery('');
      setSelectedLoc(null);
      setCandidates([]);
      setGender('unset');
      setConsentedOther(false);
      return;
    }
    setEditingId(p.id);
    setName(p.name);
    const [d, t] = p.birthDateTime.split('T');
    setBirthDate(d || '1994-06-03');
    setBirthTime(t || '08:20');
    setCityQuery(p.locationName);
    setSelectedLoc({
      displayName: p.locationName,
      latitude: p.latitude,
      longitude: p.longitude,
      timezone: p.timezone,
    });
    setCandidates([]);
    setGender(p.gender ?? 'unset');
    setConsentedOther(Boolean(p.consentedOther));
  };

  useEffect(() => {
    if (editingId) {
      const found = profiles.find((p) => p.id === editingId);
      if (found) loadIntoForm(found);
    } else if (profiles.length > 0 && !name && !selectedLoc) {
      loadIntoForm(profiles[0]);
    }
  }, [profiles]);

  const handleCitySearch = async (value: string) => {
    setCityQuery(value);
    setSelectedLoc(null);
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setCandidates([]);
      return;
    }
    setSearchingCity(true);
    try {
      const res = await searchLocations(trimmed);
      setCandidates(res);
    } catch {
      setCandidates([]);
    } finally {
      setSearchingCity(false);
    }
  };

  const handlePickCandidate = (loc: LocationCandidate) => {
    setSelectedLoc(loc);
    setCityQuery(loc.displayName);
    setCandidates([]);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    if (!selectedLoc) {
      setFeedback({ type: 'err', text: '请从城市搜索结果中选择出生地点，以确定经纬度与时区。' });
      return;
    }

    const parsed = ProfileInputSchema.safeParse({
      name,
      birthDateTime: `${birthDate}T${birthTime}`,
      locationName: selectedLoc.displayName,
      latitude: selectedLoc.latitude,
      longitude: selectedLoc.longitude,
      timezone: selectedLoc.timezone,
      gender,
      consentedOther,
    });

    if (!parsed.success) {
      setFeedback({ type: 'err', text: parsed.error.issues[0]?.message ?? '请检查表单内容' });
      return;
    }

    setSaving(true);
    try {
      const savedId = await saveProfile(uid, editingId, parsed.data);
      setEditingId(savedId);
      setFeedback({ type: 'ok', text: '档案已保存。' });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : '保存失败，请重试',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await removeProfile(uid, editingId);
      const remaining = profiles.filter((p) => p.id !== editingId);
      loadIntoForm(remaining[0] ?? null);
      setFeedback({ type: 'ok', text: '档案已删除。' });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : '删除失败',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#070812] text-[#f8fafc] flex flex-col">
      <AppHeader current="profiles" tier={tier} used={used} />

      <main className="flex-1 max-w-[1200px] w-full mx-auto px-6 sm:px-10 py-12 flex flex-wrap items-start gap-x-12 gap-y-8">
        <section className="flex-[1_1_300px] min-w-0 flex flex-col gap-4">
          <h1 className="m-0 font-serif-sc font-bold text-[32px]">出生档案</h1>
          <p className="m-0 text-[15px] leading-[1.8] text-[#c3cde0]">
            排盘只需要出生时间与地点。可以为自己和亲友各建一份。
          </p>

          <nav className="flex flex-col gap-2.5 mt-2" aria-label="档案列表">
            {profiles.map((p) => {
              const active = editingId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => loadIntoForm(p)}
                  className={`flex flex-col gap-1 px-[18px] py-3.5 rounded-[12px] text-left cursor-pointer border-[1.5px] transition-colors ${
                    active
                      ? 'bg-[#1d1a0f] border-[#e0b64a] text-[#f8fafc]'
                      : 'bg-[#101527] border-[#26304d] text-[#f8fafc] hover:border-[#3a4668]'
                  }`}
                >
                  <span className="text-[16px] font-bold">{p.name}</span>
                  <span className="font-mono-num text-[13px] text-[#c3cde0]">
                    {p.birthDateTime.replace('T', ' ')} · {p.locationName.split('，')[0]}
                  </span>
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => loadIntoForm(null)}
              className="flex items-center justify-center gap-2 min-h-[52px] bg-transparent border-[1.5px] border-dashed border-[#3a4668] rounded-[12px] text-[#e0b64a] text-[15px] cursor-pointer hover:border-[#e0b64a]"
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              新建档案
            </button>
          </nav>

          {profiles.length > 0 && (
            <button
              type="button"
              onClick={() => navigate('/consult')}
              className="min-h-[44px] px-4 mt-2 border border-[#3a4668] rounded-[10px] bg-transparent text-[#c3cde0] text-[14px] cursor-pointer hover:text-[#f8fafc]"
            >
              前往选择咨询 →
            </button>
          )}
        </section>

        <form
          onSubmit={handleSubmit}
          className="flex-[999_1_520px] min-w-0 max-w-[680px] flex flex-col gap-6 p-8 bg-[#101527] border border-[#26304d] rounded-[16px]"
        >
          <h2 className="m-0 font-serif-sc text-[22px] font-bold">
            {editingId ? '编辑档案' : '新建档案'}
          </h2>

          <div className="flex flex-col gap-2">
            <label htmlFor="p-name" className="text-[14px] text-[#c3cde0]">
              称呼
            </label>
            <input
              id="p-name"
              type="text"
              required
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：本人、妈妈"
              className="min-h-[48px] px-3.5 bg-[#070812] border border-[#3a4668] rounded-[10px] text-[#f8fafc] text-[16px]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="p-date" className="text-[14px] text-[#c3cde0]">
                出生日期
              </label>
              <input
                id="p-date"
                type="date"
                required
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                className="min-h-[48px] px-3.5 bg-[#070812] border border-[#3a4668] rounded-[10px] text-[#f8fafc] font-mono-num text-[16px]"
              />
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="p-time" className="text-[14px] text-[#c3cde0]">
                出生时间（当地时间）
              </label>
              <input
                id="p-time"
                type="time"
                required
                value={birthTime}
                onChange={(e) => setBirthTime(e.target.value)}
                className="min-h-[48px] px-3.5 bg-[#070812] border border-[#3a4668] rounded-[10px] text-[#f8fafc] font-mono-num text-[16px]"
              />
            </div>
          </div>

          <p className="-mt-3 m-0 text-[13px] leading-[1.7] text-[#a3b0c5]">
            出生时间精确到分钟，上升点与宫位才可靠。不确定时可先填大致时间，对话中会提示哪些结论受影响。
          </p>

          <div className="flex flex-col gap-2">
            <label htmlFor="p-city" className="text-[14px] text-[#c3cde0]">
              出生城市
            </label>
            <input
              id="p-city"
              type="search"
              autoComplete="off"
              value={cityQuery}
              onChange={(e) => handleCitySearch(e.target.value)}
              placeholder="输入中文或英文城市名搜索（如 Toronto、上海、台北）"
              className={`min-h-[48px] px-3.5 bg-[#070812] rounded-[10px] text-[#f8fafc] text-[16px] ${
                selectedLoc ? 'border-[1.5px] border-[#e0b64a]' : 'border border-[#3a4668]'
              }`}
            />

            {searchingCity && (
              <p className="m-0 text-[13px] text-[#a3b0c5]">正在查询城市坐标与时区...</p>
            )}

            {candidates.length > 0 && (
              <ul className="m-0 p-1.5 list-none bg-[#161d33] border border-[#3a4668] rounded-[10px] flex flex-col gap-0.5">
                {candidates.map((c, idx) => (
                  <li key={`${c.displayName}-${idx}`}>
                    <button
                      type="button"
                      onClick={() => handlePickCandidate(c)}
                      className="w-full flex flex-wrap items-center justify-between gap-x-4 gap-y-1 min-h-[48px] px-3 py-1.5 bg-transparent hover:bg-[#1d2540] border-0 rounded-[8px] text-[#f8fafc] text-[15px] text-left cursor-pointer"
                    >
                      <span>{c.displayName}</span>
                      <span className="font-mono-num text-[12px] text-[#c3cde0]">
                        {Math.abs(c.latitude).toFixed(2)}°{c.latitude >= 0 ? 'N' : 'S'}{' '}
                        {Math.abs(c.longitude).toFixed(2)}°{c.longitude >= 0 ? 'E' : 'W'} ·{' '}
                        {c.timezone}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {selectedLoc ? (
              <p className="m-0 font-mono-num text-[13px] text-[#f7d57f]">
                已锁定：{Math.abs(selectedLoc.latitude).toFixed(2)}°
                {selectedLoc.latitude >= 0 ? 'N' : 'S'}{' '}
                {Math.abs(selectedLoc.longitude).toFixed(2)}°
                {selectedLoc.longitude >= 0 ? 'E' : 'W'} · {selectedLoc.timezone}
              </p>
            ) : (
              <p className="m-0 text-[13px] leading-[1.7] text-[#a3b0c5]">
                经纬度与时区由城市自动确定，无需手填。
              </p>
            )}
          </div>

          <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
            <legend className="p-0 mb-2 text-[14px] text-[#c3cde0]">
              性别（仅紫微斗数需要，可不填）
            </legend>
            <div className="flex flex-wrap gap-2.5">
              {(
                [
                  { value: 'female', label: '女' },
                  { value: 'male', label: '男' },
                  { value: 'unset', label: '不填' },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-2.5 min-h-[44px] px-4 border border-[#3a4668] rounded-[10px] text-[15px] cursor-pointer"
                >
                  <input
                    type="radio"
                    name="gender"
                    checked={gender === opt.value}
                    onChange={() => setGender(opt.value)}
                    className="w-[18px] h-[18px] m-0 accent-[#e0b64a]"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex items-start gap-3 text-[14px] leading-[1.7] text-[#c3cde0] cursor-pointer">
            <input
              type="checkbox"
              checked={consentedOther}
              onChange={(e) => setConsentedOther(e.target.checked)}
              className="w-5 h-5 mt-0.5 accent-[#e0b64a] shrink-0"
            />
            <span>这是他人的出生信息，我已获得对方同意。</span>
          </label>

          {feedback && (
            <p
              role={feedback.type === 'err' ? 'alert' : 'status'}
              className={`m-0 text-[14px] ${
                feedback.type === 'err' ? 'text-[#ff9d8a]' : 'text-[#f7d57f]'
              }`}
            >
              {feedback.text}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#26304d]">
            {editingId ? (
              <button
                type="button"
                disabled={saving}
                onClick={handleDelete}
                className="min-h-[48px] px-4 bg-transparent border-0 text-[#ff9d8a] text-[15px] cursor-pointer hover:underline"
              >
                删除此档案
              </button>
            ) : (
              <span />
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => navigate('/consult')}
                className="min-h-[48px] px-5 bg-transparent border border-[#3a4668] rounded-[10px] text-[#c3cde0] text-[15px] cursor-pointer hover:text-[#f8fafc]"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="min-h-[48px] px-7 bg-[#e0b64a] border-0 rounded-[10px] text-[#1a1405] text-[16px] font-bold cursor-pointer hover:bg-[#f7d57f] disabled:opacity-60"
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </form>
      </main>

      <AppFooter />
    </div>
  );
}
