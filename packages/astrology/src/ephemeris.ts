const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function norm360(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

export function norm180(deg: number): number {
  let d = norm360(deg);
  if (d > 180) d -= 360;
  return d;
}

export interface UtcParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  offsetMinutes: number;
}

/**
 * Convert a local wall-clock timestamp `YYYY-MM-DDTHH:mm` in an IANA timezone to UTC parts.
 */
export function localToUtcParts(birthDateTime: string, timezone: string): UtcParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(birthDateTime);
  if (!m) {
    throw new Error(`Invalid birthDateTime format: ${birthDateTime}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);

  const targetAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const formatPartsMs = (utcMs: number): number => {
    const parts = fmt.formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  };

  let guessUtcMs = targetAsUtcMs;
  for (let i = 0; i < 3; i++) {
    const shownLocalMs = formatPartsMs(guessUtcMs);
    const diff = targetAsUtcMs - shownLocalMs;
    if (diff === 0) break;
    guessUtcMs += diff;
  }

  const utcDate = new Date(guessUtcMs);
  const offsetMinutes = Math.round((targetAsUtcMs - guessUtcMs) / 60000);
  return {
    year: utcDate.getUTCFullYear(),
    month: utcDate.getUTCMonth() + 1,
    day: utcDate.getUTCDate(),
    hour: utcDate.getUTCHours(),
    minute: utcDate.getUTCMinutes(),
    offsetMinutes,
  };
}

/**
 * Julian Day with seconds truncated per LLD §2 (`hour + minute / 60`).
 */
export function julianDay(year: number, month: number, day: number, hour: number, minute: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const dayFraction = (hour + minute / 60) / 24;
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + dayFraction + b - 1524.5;
}

export const SIGNS_ZH = [
  '白羊',
  '金牛',
  '双子',
  '巨蟹',
  '狮子',
  '处女',
  '天秤',
  '天蝎',
  '射手',
  '摩羯',
  '水瓶',
  '双鱼',
] as const;

export const SIGNS_EN = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
] as const;

export function formatZodiac(lon: number): {
  signZh: string;
  signEn: string;
  degreeInSign: number;
  formatted: string;
} {
  const n = norm360(lon);
  const idx = Math.floor(n / 30) % 12;
  const degFloat = n - idx * 30;
  let deg = Math.floor(degFloat);
  let min = Math.round((degFloat - deg) * 60);
  if (min === 60) {
    deg += 1;
    min = 0;
  }
  const dd = String(deg).padStart(2, '0');
  const mm = String(min).padStart(2, '0');
  return {
    signZh: SIGNS_ZH[idx],
    signEn: SIGNS_EN[idx],
    degreeInSign: Number(degFloat.toFixed(4)),
    formatted: `${SIGNS_ZH[idx]} ${dd}°${mm}′`,
  };
}

interface OrbitalElements {
  N0: number;
  Nd: number;
  i0: number;
  id: number;
  w0: number;
  wd: number;
  a: number;
  e0: number;
  ed: number;
  M0: number;
  Md: number;
}

// Osculating / mean J2000 elements relative to d = JD - 2451543.5 (Schlyter / Meeus)
const PLANET_ELEMENTS: Record<
  'Mercury' | 'Venus' | 'Mars' | 'Jupiter' | 'Saturn' | 'Uranus' | 'Neptune' | 'Pluto' | 'Chiron',
  OrbitalElements
> = {
  Mercury: { N0: 48.3313, Nd: 3.24587e-5, i0: 7.0047, id: 5.0e-8, w0: 29.1241, wd: 1.01444e-5, a: 0.387098, e0: 0.205635, ed: 5.59e-10, M0: 168.6562, Md: 4.0923344368 },
  Venus: { N0: 76.6799, Nd: 2.4659e-5, i0: 3.3946, id: 2.75e-8, w0: 54.891, wd: 1.38374e-5, a: 0.72333, e0: 0.006773, ed: -1.302e-9, M0: 48.0052, Md: 1.6021302244 },
  Mars: { N0: 49.5574, Nd: 2.11081e-5, i0: 1.8497, id: -1.78e-8, w0: 286.5016, wd: 2.92961e-5, a: 1.523688, e0: 0.093405, ed: 2.516e-9, M0: 18.6021, Md: 0.5240207766 },
  Jupiter: { N0: 100.4542, Nd: 2.76854e-5, i0: 1.303, id: -1.557e-7, w0: 273.8777, wd: 1.64505e-5, a: 5.20256, e0: 0.048498, ed: 4.469e-9, M0: 19.895, Md: 0.0830853001 },
  Saturn: { N0: 113.6634, Nd: 2.3898e-5, i0: 2.4886, id: -1.081e-7, w0: 339.3939, wd: 2.97661e-5, a: 9.55475, e0: 0.055546, ed: -9.499e-9, M0: 316.967, Md: 0.0334442282 },
  Uranus: { N0: 74.0005, Nd: 1.3978e-5, i0: 0.7733, id: 1.9e-8, w0: 96.6612, wd: 3.0565e-5, a: 19.18171, e0: 0.047318, ed: 7.45e-9, M0: 142.5905, Md: 0.011725806 },
  Neptune: { N0: 131.7806, Nd: 3.0173e-5, i0: 1.77, id: -2.55e-7, w0: 272.8461, wd: -6.027e-6, a: 30.05826, e0: 0.008606, ed: 2.15e-9, M0: 260.2471, Md: 0.005995147 },
  Pluto: { N0: 110.30347, Nd: 0, i0: 17.14175, id: 0, w0: 113.76329, wd: 0, a: 39.48169, e0: 0.248808, ed: 0, M0: 14.86205, Md: 0.00397897 },
  Chiron: { N0: 209.391, Nd: 0, i0: 6.931, id: 0, w0: 339.091, wd: 0, a: 13.709, e0: 0.3788, ed: 0, M0: 28.45, Md: 0.0194885 },
};

function solveKepler(Mdeg: number, e: number): number {
  const M = norm360(Mdeg) * DEG2RAD;
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let i = 0; i < 6; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  return E;
}

function sunGeocentricEcliptic(d: number): { lon: number; x: number; y: number } {
  const w = 282.9404 + 4.70935e-5 * d;
  const e = 0.016709 - 1.151e-9 * d;
  const M = norm360(356.047 + 0.9856002585 * d);
  const E = solveKepler(M, e);
  const xv = Math.cos(E) - e;
  const yv = Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv) * RAD2DEG;
  const r = Math.hypot(xv, yv);
  const lon = norm360(v + w);
  return {
    lon,
    x: r * Math.cos(lon * DEG2RAD),
    y: r * Math.sin(lon * DEG2RAD),
  };
}

function moonGeocentricLon(d: number): number {
  const N = norm360(125.1228 - 0.0529538083 * d);
  const i = 5.1454;
  const w = norm360(318.0634 + 0.1643573223 * d);
  const a = 60.2666;
  const e = 0.0549;
  const M = norm360(115.3654 + 13.0649929509 * d);
  const E = solveKepler(M, e);
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv) * RAD2DEG;
  const r = Math.hypot(xv, yv);

  const Nr = N * DEG2RAD;
  const ir = i * DEG2RAD;
  const vwr = (v + w) * DEG2RAD;
  const xh = r * (Math.cos(Nr) * Math.cos(vwr) - Math.sin(Nr) * Math.sin(vwr) * Math.cos(ir));
  const yh = r * (Math.sin(Nr) * Math.cos(vwr) + Math.cos(Nr) * Math.sin(vwr) * Math.cos(ir));
  let lon = norm360(Math.atan2(yh, xh) * RAD2DEG);

  // Main lunar perturbations
  const Ms = norm360(356.047 + 0.9856002585 * d);
  const Ls = norm360(282.9404 + 4.70935e-5 * d + Ms);
  const Lm = norm360(N + w + M);
  const D = Lm - Ls;
  const F = Lm - N;

  lon +=
    -1.274 * Math.sin((M - 2 * D) * DEG2RAD) +
    0.658 * Math.sin(2 * D * DEG2RAD) -
    0.186 * Math.sin(Ms * DEG2RAD) -
    0.059 * Math.sin((2 * M - 2 * D) * DEG2RAD) -
    0.057 * Math.sin((M - 2 * D + Ms) * DEG2RAD) +
    0.053 * Math.sin((M + 2 * D) * DEG2RAD) +
    0.046 * Math.sin((2 * D - Ms) * DEG2RAD) +
    0.041 * Math.sin((M - Ms) * DEG2RAD) -
    0.035 * Math.sin(D * DEG2RAD) -
    0.031 * Math.sin((M + Ms) * DEG2RAD) -
    0.015 * Math.sin((2 * F - 2 * D) * DEG2RAD) +
    0.011 * Math.sin((M - 4 * D) * DEG2RAD);

  return norm360(lon);
}

function planetLonAtD(
  name: keyof typeof PLANET_ELEMENTS,
  d: number,
  sun: { x: number; y: number },
): number {
  const el = PLANET_ELEMENTS[name];
  const N = (el.N0 + el.Nd * d) * DEG2RAD;
  const inc = (el.i0 + el.id * d) * DEG2RAD;
  const w = el.w0 + el.wd * d;
  const e = el.e0 + el.ed * d;
  const M = norm360(el.M0 + el.Md * d);
  const E = solveKepler(M, e);
  const xv = el.a * (Math.cos(E) - e);
  const yv = el.a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv) * RAD2DEG;
  const r = Math.hypot(xv, yv);

  const vw = (v + w) * DEG2RAD;
  const xh = r * (Math.cos(N) * Math.cos(vw) - Math.sin(N) * Math.sin(vw) * Math.cos(inc));
  const yh = r * (Math.sin(N) * Math.cos(vw) + Math.cos(N) * Math.sin(vw) * Math.cos(inc));
  const zh = r * Math.sin(vw) * Math.sin(inc);

  let lon = Math.atan2(yh, xh) * RAD2DEG;
  // Great inequality perturbations for Jupiter & Saturn
  if (name === 'Jupiter') {
    const Mj = norm360(19.895 + 0.0830853001 * d) * DEG2RAD;
    const Ms = norm360(316.967 + 0.0334442282 * d) * DEG2RAD;
    lon += -0.332 * Math.sin(2 * Mj - 5 * Ms - 67.6 * DEG2RAD) - 0.056 * Math.sin(2 * Mj - 2 * Ms + 21 * DEG2RAD) + 0.042 * Math.sin(3 * Mj - 5 * Ms + 21 * DEG2RAD);
  } else if (name === 'Saturn') {
    const Mj = norm360(19.895 + 0.0830853001 * d) * DEG2RAD;
    const Ms = norm360(316.967 + 0.0334442282 * d) * DEG2RAD;
    lon += 0.812 * Math.sin(2 * Mj - 5 * Ms - 67.6 * DEG2RAD) - 0.229 * Math.cos(2 * Mj - 4 * Ms - 2 * DEG2RAD) + 0.119 * Math.sin(Mj - 2 * Ms - 3 * DEG2RAD);
  }

  const xhAdj = r * Math.cos(Math.atan2(zh, Math.hypot(xh, yh))) * Math.cos(lon * DEG2RAD);
  const yhAdj = r * Math.cos(Math.atan2(zh, Math.hypot(xh, yh))) * Math.sin(lon * DEG2RAD);
  const xg = xhAdj + sun.x;
  const yg = yhAdj + sun.y;
  return norm360(Math.atan2(yg, xg) * RAD2DEG);
}

export type PlanetKey =
  | 'Sun'
  | 'Moon'
  | 'Mercury'
  | 'Venus'
  | 'Mars'
  | 'Jupiter'
  | 'Saturn'
  | 'Uranus'
  | 'Neptune'
  | 'Pluto'
  | 'NorthNode'
  | 'Chiron';

export const PLANET_NAMES_ZH: Record<PlanetKey, string> = {
  Sun: '太阳',
  Moon: '月亮',
  Mercury: '水星',
  Venus: '金星',
  Mars: '火星',
  Jupiter: '木星',
  Saturn: '土星',
  Uranus: '天王星',
  Neptune: '海王星',
  Pluto: '冥王星',
  NorthNode: '北交点',
  Chiron: '凯龙星',
};

export interface PlanetPosition {
  key: PlanetKey;
  nameZh: string;
  longitude: number;
  speed: number;
  retrograde: boolean;
  signZh: string;
  signEn: string;
  degreeInSign: number;
  formatted: string;
}

function longitudesSnapshot(jd: number): Record<PlanetKey, number> {
  const d = jd - 2451543.5;
  const sun = sunGeocentricEcliptic(d);
  const T = (jd - 2451545.0) / 36525;
  const node = norm360(125.04452 - 1934.136261 * T);

  return {
    Sun: sun.lon,
    Moon: moonGeocentricLon(d),
    Mercury: planetLonAtD('Mercury', d, sun),
    Venus: planetLonAtD('Venus', d, sun),
    Mars: planetLonAtD('Mars', d, sun),
    Jupiter: planetLonAtD('Jupiter', d, sun),
    Saturn: planetLonAtD('Saturn', d, sun),
    Uranus: planetLonAtD('Uranus', d, sun),
    Neptune: planetLonAtD('Neptune', d, sun),
    Pluto: planetLonAtD('Pluto', d, sun),
    NorthNode: node,
    Chiron: planetLonAtD('Chiron', d, sun),
  };
}

export function computePlanetPositions(jd: number): PlanetPosition[] {
  const now = longitudesSnapshot(jd);
  const prev = longitudesSnapshot(jd - 0.5);
  const next = longitudesSnapshot(jd + 0.5);

  const keys: PlanetKey[] = [
    'Sun',
    'Moon',
    'Mercury',
    'Venus',
    'Mars',
    'Jupiter',
    'Saturn',
    'Uranus',
    'Neptune',
    'Pluto',
    'NorthNode',
    'Chiron',
  ];

  return keys.map((key) => {
    const lon = now[key];
    const speed = norm180(next[key] - prev[key]);
    const fmt = formatZodiac(lon);
    return {
      key,
      nameZh: PLANET_NAMES_ZH[key],
      longitude: Number(lon.toFixed(4)),
      speed: Number(speed.toFixed(4)),
      retrograde: key !== 'Sun' && key !== 'Moon' && speed < 0,
      ...fmt,
    };
  });
}

export function computePlacidusHouses(
  jd: number,
  latitude: number,
  longitude: number,
): { ascendant: number; mc: number; cusps: number[] } {
  const T = (jd - 2451545.0) / 36525;
  const gmst = norm360(
    280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000,
  );
  const ramc = norm360(gmst + longitude);
  const eps = (23.4392911 - 0.0130042 * T) * DEG2RAD;
  const latR = latitude * DEG2RAD;
  const ramcR = ramc * DEG2RAD;

  const mc = norm360(Math.atan2(Math.sin(ramcR), Math.cos(ramcR) * Math.cos(eps)) * RAD2DEG);
  const asc = norm360(
    Math.atan2(Math.cos(ramcR), -(Math.sin(ramcR) * Math.cos(eps) + Math.tan(latR) * Math.sin(eps))) * RAD2DEG,
  );

  // Polar fallback to Porphyry
  if (Math.abs(latitude) >= 66.5) {
    const ic = norm360(mc + 180);
    const dsc = norm360(asc + 180);
    const q1 = norm360(ic - asc) / 3;
    const q2 = norm360(dsc - ic) / 3;
    const cusps = [
      asc,
      norm360(asc + q1),
      norm360(asc + 2 * q1),
      ic,
      norm360(ic + q2),
      norm360(ic + 2 * q2),
      dsc,
      norm360(dsc + q1),
      norm360(dsc + 2 * q1),
      mc,
      norm360(mc + q2),
      norm360(mc + 2 * q2),
    ];
    return { ascendant: asc, mc, cusps };
  }

  const placidusCusp = (f: number, isUpper: boolean): number => {
    const targetRa = isUpper ? ramc + f * 90 : ramc + 180 - f * 90;
    let ra = targetRa * DEG2RAD;
    for (let iter = 0; iter < 15; iter++) {
      const sinD = Math.sin(eps) * Math.sin(Math.atan2(Math.sin(ra), Math.cos(ra) * Math.cos(eps)));
      const tanD = sinD / Math.sqrt(Math.max(1e-12, 1 - sinD * sinD));
      const ad = Math.asin(Math.max(-0.999999, Math.min(0.999999, Math.tan(latR) * tanD))) * RAD2DEG;
      const nextRa = isUpper ? norm360(ramc + f * (90 + ad)) : norm360(ramc + 180 - f * (90 + ad));
      ra = nextRa * DEG2RAD;
    }
    return norm360(Math.atan2(Math.sin(ra), Math.cos(ra) * Math.cos(eps)) * RAD2DEG);
  };

  const c11 = placidusCusp(1 / 3, true);
  const c12 = placidusCusp(2 / 3, true);
  const c2 = placidusCusp(2 / 3, false);
  const c3 = placidusCusp(1 / 3, false);

  const cusps = [
    asc,
    c2,
    c3,
    norm360(mc + 180),
    norm360(c11 + 180),
    norm360(c12 + 180),
    norm360(asc + 180),
    norm360(c2 + 180),
    norm360(c3 + 180),
    mc,
    c11,
    c12,
  ].map((c) => Number(c.toFixed(4)));

  return {
    ascendant: Number(asc.toFixed(4)),
    mc: Number(mc.toFixed(4)),
    cusps,
  };
}

export function houseOfLongitude(lon: number, cusps: number[]): number {
  const x = norm360(lon);
  for (let i = 0; i < 12; i++) {
    const start = cusps[i];
    const end = cusps[(i + 1) % 12];
    const span = norm360(end - start);
    const delta = norm360(x - start);
    if (delta < span) return i + 1;
  }
  return 1;
}
