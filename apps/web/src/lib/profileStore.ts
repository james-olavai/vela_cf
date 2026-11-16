import {
  ProfileInputSchema,
  type LocationCandidate,
  type ProfileInput,
  type ProfileRecord,
  type PortraitSummary,
} from '@vela-cf/shared';
import { businessApi, apiList, subscribeApi } from './apiClient';

export interface ChartPlanet {
  key: string;
  nameZh: string;
  longitude: number;
  retrograde: boolean;
  signZh: string;
  formatted: string;
  house: number;
}

export interface ChartSnapshot {
  portrait?: PortraitSummary;
  natal: {
    houseSystem: string;
    ascendant: { longitude: number; house: number; signZh: string; formatted: string };
    midheaven: { longitude: number; house: number; signZh: string; formatted: string };
    houses: Array<{ house: number; longitude: number; signZh: string; formatted: string }>;
    planets: ChartPlanet[];
    aspects: Array<{ pointA: string; pointB: string; aspect: string; orb: number }>;
  };
  transits?: {
    windowMonths: number;
    events: Array<{
      date: string;
      transitPlanet: string;
      aspect: string;
      natalPoint: string;
      orb: number;
    }>;
  } | null;
  bazi?: {
    trueSolarTime: string;
    dayMaster: string;
    pillars: Array<{ name: string; ganZhi: string; tenGod: string }>;
  } | null;
  ziwei?: {
    fiveElementsClass: string;
    soulStar: string;
    bodyStar: string;
    palaces: Array<{ name: string; earthlyBranch: string; majorStars: Array<{ name: string }> }>;
  } | null;
}

const chartKey = (uid: string, profile: ProfileRecord) =>
  `vela_chart_v3_${uid}_${JSON.stringify([profile.id, profile.birthDateTime, profile.latitude, profile.longitude, profile.timezone, profile.gender])}`;

export function loadCachedChart(uid: string, profile: ProfileRecord): ChartSnapshot | null {
  try {
    const raw = sessionStorage.getItem(chartKey(uid, profile));
    const chart = raw ? JSON.parse(raw) as ChartSnapshot : null;
    return chart?.natal?.planets?.length && chart.portrait ? chart : null;
  } catch { return null; }
}

export function saveCachedChart(uid: string, profile: ProfileRecord, chart: ChartSnapshot): void {
  try { sessionStorage.setItem(chartKey(uid, profile), JSON.stringify(chart)); } catch { /* Cache is optional. */ }
}

const E2E_PROFILES_KEY = 'vela_e2e_profiles_v1';
const E2E_PROFILES_EVENT = 'vela-e2e-profiles-updated';

function readE2eProfiles(): ProfileRecord[] {
  try {
    const raw = localStorage.getItem(E2E_PROFILES_KEY);
    return raw ? (JSON.parse(raw) as ProfileRecord[]) : [];
  } catch {
    return [];
  }
}

function writeE2eProfiles(list: ProfileRecord[]): void {
  localStorage.setItem(E2E_PROFILES_KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(E2E_PROFILES_EVENT));
}

export function subscribeProfiles(
  uid: string,
  onData: (profiles: ProfileRecord[]) => void,
  onError: (error: unknown) => void = console.error,
): () => void {
  if (import.meta.env.DEV && uid === 'e2e_test_user') {
    const emit = () => onData(readE2eProfiles());
    emit();
    window.addEventListener(E2E_PROFILES_EVENT, emit);
    return () => window.removeEventListener(E2E_PROFILES_EVENT, emit);
  }
  return subscribeApi(signal => apiList<ProfileRecord>(uid, '/v1/profiles', signal).then(list => list.sort((a,b)=>(a.createdAt ?? '').localeCompare(b.createdAt ?? ''))), onData, onError);
}

export async function saveProfile(
  uid: string,
  profileId: string | null,
  rawInput: ProfileInput,
): Promise<string> {
  const validated = ProfileInputSchema.parse(rawInput);
  const now = new Date().toISOString();
  const payload = {
    name: validated.name,
    entityType: validated.entityType,
    birthDateTime: validated.birthDateTime,
    locationName: validated.locationName,
    latitude: validated.latitude,
    longitude: validated.longitude,
    timezone: validated.timezone,
    gender: validated.gender,
    consentedOther: Boolean(validated.consentedOther),
    updatedAt: now,
  };

  if (import.meta.env.DEV && uid === 'e2e_test_user') {
    const list = readE2eProfiles();
    const id = profileId ?? `e2e_p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const nextRecord: ProfileRecord = {
      id,
      ...payload,
      createdAt: profileId ? list.find((p) => p.id === profileId)?.createdAt ?? now : now,
    };
    const nextList = profileId
      ? list.map((p) => (p.id === profileId ? nextRecord : p))
      : [...list, nextRecord];
    writeE2eProfiles(nextList);
    return id;
  }

  const record = await businessApi<ProfileRecord>(uid, profileId ? `/v1/profiles/${encodeURIComponent(profileId)}` : '/v1/profiles', profileId ? 'PATCH' : 'POST', validated);
  return record.id;
}

export async function removeProfile(uid: string, profileId: string): Promise<void> {
  if (import.meta.env.DEV && uid === 'e2e_test_user') {
    writeE2eProfiles(readE2eProfiles().filter((p) => p.id !== profileId));
    return;
  }
  await businessApi(uid, `/v1/profiles/${encodeURIComponent(profileId)}`, 'DELETE');
}

export async function searchLocations(queryText: string): Promise<LocationCandidate[]> {
  const q = queryText.trim();
  if (!q) return [];
  try {
    const data = await businessApi<{results:LocationCandidate[]}>(null, `/v1/locations?query=${encodeURIComponent(q)}`);
    return data.results;
  } catch (error) {
    if (!import.meta.env.DEV) throw error;
    const resp = await fetch(`/api/locations?q=${encodeURIComponent(q)}`);
    if (!resp.ok) throw new Error('城市搜索服务暂时不可用');
    const data = (await resp.json()) as { results?: LocationCandidate[] };
    return data.results ?? [];
  }
}

export async function fetchNatalChart(
  uid: string | null,
  profile: ProfileRecord,
): Promise<ChartSnapshot> {
  let result: Pick<ChartSnapshot,'natal'|'portrait'>;
  try {
    const data = await businessApi<Pick<ChartSnapshot,'natal'|'portrait'>>(null, '/v1/charts/natal', 'POST', {birthDateTime:profile.birthDateTime,latitude:profile.latitude,longitude:profile.longitude,timezone:profile.timezone});
    result = data;
  } catch (error) {
    if (!import.meta.env.DEV) throw error;
    const resp = await fetch('/api/astrology', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    if (!resp.ok) throw new Error('排盘计算失败');
    const data = (await resp.json()) as Pick<ChartSnapshot,'natal'|'portrait'>;
    result = data;
  }
  const prev = uid ? loadCachedChart(uid, profile) : null;
  if(!result.portrait)throw new Error('星盘画像数据不完整，请重试');
  const next: ChartSnapshot = { ...prev, ...result };
  if (uid) {
    saveCachedChart(uid, profile, next);
  }
  return next;
}

export async function fetchTransitChart(profile:ProfileRecord,dateISO:string):Promise<ChartSnapshot>{
  try {
    const {transit}=await businessApi<{transit:ChartSnapshot['natal']}>(null,'/v1/charts/transits','POST',{birthDateTime:profile.birthDateTime,latitude:profile.latitude,longitude:profile.longitude,timezone:profile.timezone,atDateTime:`${dateISO}T12:00`,atTimezone:profile.timezone});
    return {natal:transit};
  } catch(error) {
    if(!import.meta.env.DEV)throw error;
    return fetchNatalChart(null,{...profile,birthDateTime:`${dateISO}T12:00`});
  }
}
