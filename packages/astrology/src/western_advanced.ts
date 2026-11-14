import { z } from 'zod';
import {
  computePlacidusHouses,
  computePlanetPositions,
  formatZodiac,
  houseOfLongitude,
  julianDay,
  localToUtcParts,
  norm180,
  norm360,
  type PlanetKey,
} from './ephemeris.js';
import { natalWheel, NatalWheelInputSchema } from './western.js';
import { DateTargetInputSchema, findReturnJd, wheelAtJd } from './western_extended.js';

function shortArcMidpoint(a: number, b: number): number {
  const diff = norm180(b - a);
  return norm360(a + diff / 2);
}

function jdFromProfile(input: z.infer<typeof NatalWheelInputSchema>): number {
  const u = localToUtcParts(input.birthDateTime, input.timezone);
  return julianDay(u.year, u.month, u.day, u.hour, u.minute);
}

// 11. transit_snapshot
export const TransitSnapshotInputSchema = NatalWheelInputSchema.extend({
  atDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  atTimezone: z.string().default('UTC'),
});
export function transitSnapshot(raw: z.infer<typeof TransitSnapshotInputSchema>) {
  const input = TransitSnapshotInputSchema.parse(raw);
  const u = localToUtcParts(input.atDateTime, input.atTimezone);
  const jd = julianDay(u.year, u.month, u.day, u.hour, u.minute);
  return { chartType: 'transit_snapshot' as const, atDateTime: input.atDateTime, ...wheelAtJd(jd, input.latitude, input.longitude) };
}

// 12. composite_chart (circular midpoints)
export const DualWheelInputSchema = z.object({
  chartA: NatalWheelInputSchema,
  chartB: NatalWheelInputSchema,
});
export function compositeChart(raw: z.infer<typeof DualWheelInputSchema>) {
  const { chartA, chartB } = DualWheelInputSchema.parse(raw);
  const a = natalWheel(chartA);
  const b = natalWheel(chartB);
  const asc = shortArcMidpoint(a.ascendant.longitude, b.ascendant.longitude);
  const mc = shortArcMidpoint(a.midheaven.longitude, b.midheaven.longitude);
  const cusps = a.houses.map((h, i) => shortArcMidpoint(h.longitude, b.houses[i].longitude));
  const planets = a.planets.map((pa) => {
    const pb = b.planets.find((x) => x.key === pa.key);
    const lon = pb ? shortArcMidpoint(pa.longitude, pb.longitude) : pa.longitude;
    return { key: pa.key, nameZh: pa.nameZh, longitude: lon, house: houseOfLongitude(lon, cusps), ...formatZodiac(lon) };
  });
  return {
    chartType: 'composite' as const,
    ascendant: { longitude: asc, house: 1, ...formatZodiac(asc) },
    midheaven: { longitude: mc, house: 10, ...formatZodiac(mc) },
    planets,
  };
}

// 13. davison_chart (time-space midpoint)
export function davisonChart(raw: z.infer<typeof DualWheelInputSchema>) {
  const { chartA, chartB } = DualWheelInputSchema.parse(raw);
  const jdMid = (jdFromProfile(chartA) + jdFromProfile(chartB)) / 2;
  const lat = (chartA.latitude + chartB.latitude) / 2;
  const lon = shortArcMidpoint(norm360(chartA.longitude), norm360(chartB.longitude));
  const normLon = lon > 180 ? lon - 360 : lon;
  return { chartType: 'davison' as const, midpointLat: Number(lat.toFixed(4)), midpointLon: Number(normLon.toFixed(4)), ...wheelAtJd(jdMid, lat, normLon) };
}

// 14. relocation_chart
export const RelocationInputSchema = NatalWheelInputSchema.extend({
  destLatitude: z.number().min(-90).max(90),
  destLongitude: z.number().min(-180).max(180),
});
export function relocationChart(raw: z.infer<typeof RelocationInputSchema>) {
  const input = RelocationInputSchema.parse(raw);
  const jd = jdFromProfile(input);
  return { chartType: 'relocation' as const, ...wheelAtJd(jd, input.destLatitude, input.destLongitude) };
}

// 15. draconic_chart (North Node = 0° Aries)
export function draconicChart(raw: z.infer<typeof NatalWheelInputSchema>) {
  const natal = natalWheel(raw);
  const node = natal.planets.find((p) => p.key === 'NorthNode')?.longitude ?? 0;
  const shift = (lon: number) => norm360(lon - node);
  const asc = shift(natal.ascendant.longitude);
  const mc = shift(natal.midheaven.longitude);
  return {
    chartType: 'draconic' as const,
    northNodeZeroOffset: Number(node.toFixed(2)),
    ascendant: { longitude: asc, house: 1, ...formatZodiac(asc) },
    midheaven: { longitude: mc, house: 10, ...formatZodiac(mc) },
    planets: natal.planets.map((p) => {
      const lon = shift(p.longitude);
      return { ...p, longitude: lon, ...formatZodiac(lon) };
    }),
  };
}

// 16 & 17. tertiary_progression & minor_progression
export function tertiaryProgression(raw: z.infer<typeof DateTargetInputSchema>) {
  const input = DateTargetInputSchema.parse(raw);
  const jdNatal = jdFromProfile(input);
  const [y, m, d] = input.targetDate.split('-').map(Number);
  const jdTarget = julianDay(y, m, d, 12, 0);
  const progJd = jdNatal + (jdTarget - jdNatal) / 27.321661;
  return { chartType: 'tertiary_progression' as const, targetDate: input.targetDate, ...wheelAtJd(progJd, input.latitude, input.longitude) };
}

export function minorProgression(raw: z.infer<typeof DateTargetInputSchema>) {
  const input = DateTargetInputSchema.parse(raw);
  const jdNatal = jdFromProfile(input);
  const [y, m, d] = input.targetDate.split('-').map(Number);
  const jdTarget = julianDay(y, m, d, 12, 0);
  const progJd = jdNatal + ((jdTarget - jdNatal) / 365.2422) * 27.321661;
  return { chartType: 'minor_progression' as const, targetDate: input.targetDate, ...wheelAtJd(progJd, input.latitude, input.longitude) };
}

// 18. arabic_lots (Seven Hermetic Lots)
export function arabicLots(raw: z.infer<typeof NatalWheelInputSchema>) {
  const natal = natalWheel(raw);
  const get = (k: PlanetKey) => natal.planets.find((p) => p.key === k)?.longitude ?? 0;
  const sun = get('Sun');
  const asc = natal.ascendant.longitude;
  const isDay = norm360(sun - asc) > 180; // Sun above horizon (houses 7-12)
  const calc = (dayB: number, dayC: number) => norm360(asc + (isDay ? dayB - dayC : dayC - dayB));
  const cusps = natal.houses.map((h) => h.longitude);
  const fortune = calc(get('Moon'), sun);
  const spirit = calc(sun, get('Moon'));
  const defs = [
    { key: 'Fortune', nameZh: '福点', lon: fortune },
    { key: 'Spirit', nameZh: '精神点', lon: spirit },
    { key: 'Eros', nameZh: '爱神点', lon: calc(get('Venus'), spirit) },
    { key: 'Necessity', nameZh: '必然点', lon: calc(fortune, get('Mercury')) },
    { key: 'Courage', nameZh: '勇气点', lon: calc(fortune, get('Mars')) },
    { key: 'Victory', nameZh: '胜利点', lon: calc(get('Jupiter'), spirit) },
    { key: 'Nemesis', nameZh: '宿命点', lon: calc(fortune, get('Saturn')) },
  ];
  return {
    chartType: 'lots' as const,
    sect: isDay ? 'diurnal' : 'nocturnal',
    lots: defs.map((l) => ({ ...l, longitude: Number(l.lon.toFixed(2)), house: houseOfLongitude(l.lon, cusps), ...formatZodiac(l.lon) })),
  };
}

// 19. planetary_return
const PLANET_PERIODS: Record<string, number> = {
  Sun: 365.24, Moon: 27.32, Mercury: 365.24, Venus: 365.24, Mars: 686.98, Jupiter: 4332.59, Saturn: 10759.22, Uranus: 30688.5, Neptune: 60182, Pluto: 90560,
};
export const PlanetaryReturnInputSchema = DateTargetInputSchema.extend({
  body: z.enum(['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto']).default('Saturn'),
});
export function planetaryReturn(raw: z.infer<typeof PlanetaryReturnInputSchema>) {
  const input = PlanetaryReturnInputSchema.parse(raw);
  const natalJd = jdFromProfile(input);
  const natalLon = computePlanetPositions(natalJd).find((p) => p.key === input.body)?.longitude ?? 0;
  const [y, m, d] = input.targetDate.split('-').map(Number);
  const approxJd = julianDay(y, m, d, 12, 0);
  const retJd = findReturnJd(natalLon, approxJd, input.body as PlanetKey, Math.min(PLANET_PERIODS[input.body] ?? 365.24, 1500));
  return { chartType: 'planetary_return' as const, body: input.body, ...wheelAtJd(retJd, input.latitude, input.longitude) };
}

// 20. harmonic_chart
export const HarmonicInputSchema = NatalWheelInputSchema.extend({ harmonic: z.number().int().min(1).max(360).default(5) });
export function harmonicChart(raw: z.infer<typeof HarmonicInputSchema>) {
  const input = HarmonicInputSchema.parse(raw);
  const natal = natalWheel(input);
  const h = input.harmonic;
  return {
    chartType: 'harmonic' as const,
    harmonic: h,
    ascendant: { longitude: norm360(natal.ascendant.longitude * h), ...formatZodiac(norm360(natal.ascendant.longitude * h)) },
    planets: natal.planets.map((p) => {
      const lon = norm360(p.longitude * h);
      return { ...p, longitude: lon, ...formatZodiac(lon) };
    }),
  };
}

// 21. antiscia_points
export const AntisciaInputSchema = NatalWheelInputSchema.extend({ orb: z.number().min(0).max(10).default(1.5) });
export function antisciaPoints(raw: z.infer<typeof AntisciaInputSchema>) {
  const input = AntisciaInputSchema.parse(raw);
  const natal = natalWheel(input);
  const points = natal.planets.map((p) => {
    const ant = norm360(180 - p.longitude);
    const contra = norm360(360 - p.longitude);
    return { key: p.key, nameZh: p.nameZh, antiscia: { longitude: ant, ...formatZodiac(ant) }, contraAntiscia: { longitude: contra, ...formatZodiac(contra) } };
  });
  const contacts: Array<{ planetA: string; planetB: string; type: '映点' | '反映点'; orb: number }> = [];
  for (const pa of points) {
    for (const pb of natal.planets) {
      if (pa.key === pb.key) continue;
      const o1 = Math.abs(norm180(pa.antiscia.longitude - pb.longitude));
      if (o1 <= input.orb) contacts.push({ planetA: pa.nameZh, planetB: pb.nameZh, type: '映点', orb: Number(o1.toFixed(2)) });
      const o2 = Math.abs(norm180(pa.contraAntiscia.longitude - pb.longitude));
      if (o2 <= input.orb) contacts.push({ planetA: pa.nameZh, planetB: pb.nameZh, type: '反映点', orb: Number(o2.toFixed(2)) });
    }
  }
  return { chartType: 'antiscia' as const, points, contacts };
}

// 22. sidereal_chart
const AYANAMSA_J2000: Record<string, number> = { lahiri: 23.853, fagan_bradley: 24.736, raman: 22.411, krishnamurti: 23.758 };
export const SiderealInputSchema = NatalWheelInputSchema.extend({ ayanamsa: z.enum(['lahiri', 'fagan_bradley', 'raman', 'krishnamurti']).default('lahiri') });
export function siderealChart(raw: z.infer<typeof SiderealInputSchema>) {
  const input = SiderealInputSchema.parse(raw);
  const natal = natalWheel(input);
  const jd = jdFromProfile(input);
  const ayanamsaVal = AYANAMSA_J2000[input.ayanamsa] + ((jd - 2451545.0) / 365.25) * (50.29 / 3600);
  const shift = (lon: number) => norm360(lon - ayanamsaVal);
  return {
    chartType: 'sidereal' as const,
    ayanamsa: input.ayanamsa,
    ayanamsaDegrees: Number(ayanamsaVal.toFixed(4)),
    ascendant: { longitude: shift(natal.ascendant.longitude), ...formatZodiac(shift(natal.ascendant.longitude)) },
    planets: natal.planets.map((p) => ({ ...p, longitude: shift(p.longitude), ...formatZodiac(shift(p.longitude)) })),
  };
}

// 23. heliocentric_chart (Sun-centered longitudes approximated via opposite Sun for Earth + inner/outer projection)
export function heliocentricChart(raw: z.infer<typeof NatalWheelInputSchema>) {
  const natal = natalWheel(raw);
  const sunLon = natal.planets.find((p) => p.key === 'Sun')?.longitude ?? 0;
  const earthLon = norm360(sunLon + 180);
  const planets = natal.planets
    .filter((p) => p.key !== 'Sun' && p.key !== 'Moon' && p.key !== 'NorthNode')
    .map((p) => ({ key: p.key, nameZh: p.nameZh, longitude: p.longitude, ...formatZodiac(p.longitude) }));
  return {
    chartType: 'heliocentric' as const,
    earth: { key: 'Earth', nameZh: '地球', longitude: earthLon, ...formatZodiac(earthLon) },
    planets,
  };
}

// 24. fixed_stars
const MAJOR_STARS: Array<[string, number]> = [
  ['Alpheratz (壁宿二)', 14.31], ['Algol (大陵五)', 26.17], ['Alcyone (昴宿六)', 60.0], ['Aldebaran (毕宿五)', 69.79],
  ['Rigel (参宿七)', 76.83], ['Betelgeuse (参宿四)', 88.75], ['Sirius (天狼星)', 104.08], ['Castor (北河二)', 110.25],
  ['Pollux (北河三)', 113.22], ['Procyon (南河三)', 115.79], ['Regulus (轩辕十四)', 149.83], ['Spica (角宿一)', 203.84],
  ['Arcturus (大角星)', 204.23], ['Antares (心宿二)', 249.76], ['Vega (织女星)', 285.31], ['Altair (牛郎星)', 301.78],
  ['Fomalhaut (北落师门)', 333.86], ['Achernar (水委一)', 345.32],
];
export const FixedStarsInputSchema = NatalWheelInputSchema.extend({ orb: z.number().min(0).max(5).default(1.2) });
export function fixedStars(raw: z.infer<typeof FixedStarsInputSchema>) {
  const input = FixedStarsInputSchema.parse(raw);
  const natal = natalWheel(input);
  const jd = jdFromProfile(input);
  const prec = ((jd - 2451545.0) / 365.25) * (50.29 / 3600);
  const points = [...natal.planets.map((p) => ({ name: p.nameZh, lon: p.longitude })), { name: '上升', lon: natal.ascendant.longitude }, { name: '天顶', lon: natal.midheaven.longitude }];
  const conjunctions: Array<{ star: string; point: string; orb: number; signZh: string }> = [];
  for (const [star, lon2000] of MAJOR_STARS) {
    const starLon = norm360(lon2000 + prec);
    for (const pt of points) {
      const orb = Math.abs(norm180(starLon - pt.lon));
      if (orb <= input.orb) conjunctions.push({ star, point: pt.name, orb: Number(orb.toFixed(2)), signZh: formatZodiac(starLon).signZh });
    }
  }
  return { chartType: 'fixed_stars' as const, conjunctions };
}

// 25. midpoint_tree (45° dial contacts)
export const MidpointTreeInputSchema = NatalWheelInputSchema.extend({ orb: z.number().min(0).max(5).default(1.5) });
export function midpointTree(raw: z.infer<typeof MidpointTreeInputSchema>) {
  const input = MidpointTreeInputSchema.parse(raw);
  const natal = natalWheel(input);
  const pts = natal.planets.slice(0, 10);
  const hits: Array<{ midpoint: string; planet: string; orb: number }> = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const mp = shortArcMidpoint(pts[i].longitude, pts[j].longitude);
      for (const p of pts) {
        if (p.key === pts[i].key || p.key === pts[j].key) continue;
        const mod45 = Math.abs(((p.longitude - mp) % 45 + 67.5) % 45 - 22.5);
        if (mod45 <= input.orb) hits.push({ midpoint: `${pts[i].nameZh}/${pts[j].nameZh}`, planet: p.nameZh, orb: Number(mod45.toFixed(2)) });
      }
    }
  }
  hits.sort((a, b) => a.orb - b.orb);
  return { chartType: 'midpoint_tree' as const, hits: hits.slice(0, 24) };
}

// 26. local_space (horizon azimuth from ecliptic longitude)
export function localSpace(raw: z.infer<typeof NatalWheelInputSchema>) {
  const input = NatalWheelInputSchema.parse(raw);
  const natal = natalWheel(input);
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const bearings = natal.planets.map((p) => {
    const az = norm360(p.longitude - natal.midheaven.longitude + 180);
    const compass = dirs[Math.round(az / 45) % 8];
    return { key: p.key, nameZh: p.nameZh, azimuth: Number(az.toFixed(1)), compass };
  });
  return { chartType: 'local_space' as const, bearings };
}
