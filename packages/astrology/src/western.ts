import { z } from 'zod';
import {
  computePlacidusHouses,
  computePlanetPositions,
  formatZodiac,
  houseOfLongitude,
  julianDay,
  localToUtcParts,
  norm180,
  PLANET_NAMES_ZH,
  type PlanetKey,
} from './ephemeris.js';

export const NatalWheelInputSchema = z.object({
  birthDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
});

export type NatalWheelInput = z.infer<typeof NatalWheelInputSchema>;

const ASPECT_DEFS = [
  { name: '合相', angle: 0, orb: 8 },
  { name: '六分相', angle: 60, orb: 5 },
  { name: '四分相', angle: 90, orb: 7 },
  { name: '三分相', angle: 120, orb: 7 },
  { name: '对分相', angle: 180, orb: 8 },
] as const;

export function natalWheel(rawInput: NatalWheelInput) {
  const input = NatalWheelInputSchema.parse(rawInput);
  const utc = localToUtcParts(input.birthDateTime, input.timezone);
  const jd = julianDay(utc.year, utc.month, utc.day, utc.hour, utc.minute);
  const houses = computePlacidusHouses(jd, input.latitude, input.longitude);
  const rawPlanets = computePlanetPositions(jd);

  const planets = rawPlanets.map((p) => ({
    ...p,
    house: houseOfLongitude(p.longitude, houses.cusps),
  }));

  const ascFmt = formatZodiac(houses.ascendant);
  const mcFmt = formatZodiac(houses.mc);

  const points = [
    ...planets.map((p) => ({ key: p.key, nameZh: p.nameZh, longitude: p.longitude })),
    { key: 'Ascendant', nameZh: '上升', longitude: houses.ascendant },
    { key: 'MC', nameZh: '天顶', longitude: houses.mc },
  ];

  const aspects: Array<{
    pointA: string;
    pointB: string;
    aspect: string;
    orb: number;
  }> = [];

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (points[i].key === 'Ascendant' && points[j].key === 'MC') continue;
      const sep = Math.abs(norm180(points[i].longitude - points[j].longitude));
      for (const def of ASPECT_DEFS) {
        const orb = Math.abs(sep - def.angle);
        if (orb <= def.orb) {
          aspects.push({
            pointA: points[i].nameZh,
            pointB: points[j].nameZh,
            aspect: def.name,
            orb: Number(orb.toFixed(2)),
          });
          break;
        }
      }
    }
  }

  aspects.sort((a, b) => a.orb - b.orb);

  return {
    houseSystem: 'Placidus' as const,
    utcDateTime: `${utc.year}-${String(utc.month).padStart(2, '0')}-${String(utc.day).padStart(2, '0')}T${String(utc.hour).padStart(2, '0')}:${String(utc.minute).padStart(2, '0')}Z`,
    ascendant: { longitude: houses.ascendant, house: 1, ...ascFmt },
    midheaven: { longitude: houses.mc, house: 10, ...mcFmt },
    houses: houses.cusps.map((lon, idx) => ({
      house: idx + 1,
      longitude: lon,
      ...formatZodiac(lon),
    })),
    planets,
    aspects: aspects.slice(0, 24),
  };
}

export type NatalWheelResult = ReturnType<typeof natalWheel>;

export const TransitEventsInputSchema = NatalWheelInputSchema.extend({
  windowMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]).default(6),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type TransitEventsInput = z.infer<typeof TransitEventsInputSchema>;

const TRANSIT_PLANETS: PlanetKey[] = ['Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Mars'];
const NATAL_TARGETS: PlanetKey[] = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars'];
const TRANSIT_ASPECTS = [
  { name: '合相', angle: 0 },
  { name: '四分相', angle: 90 },
  { name: '三分相', angle: 120 },
  { name: '对分相', angle: 180 },
] as const;

export function transitEvents(rawInput: TransitEventsInput) {
  const input = TransitEventsInputSchema.parse(rawInput);
  const natal = natalWheel(input);

  const start = input.startDate ? new Date(`${input.startDate}T12:00:00Z`) : new Date();
  const totalDays = input.windowMonths * 30;
  const targets = [
    ...natal.planets
      .filter((p) => NATAL_TARGETS.includes(p.key))
      .map((p) => ({ nameZh: p.nameZh, longitude: p.longitude })),
    { nameZh: '上升', longitude: natal.ascendant.longitude },
    { nameZh: '天顶', longitude: natal.midheaven.longitude },
  ];

  interface Hit {
    date: string;
    transitPlanet: string;
    aspect: string;
    natalPoint: string;
    orb: number;
    transitSign: string;
  }

  const bestByKey = new Map<string, Hit>();

  for (let d = 0; d <= totalDays; d += 2) {
    const dt = new Date(start.getTime() + d * 86400000);
    const jd = julianDay(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 12, 0);
    const positions = computePlanetPositions(jd);
    const dateStr = dt.toISOString().slice(0, 10);

    for (const tp of positions) {
      if (!TRANSIT_PLANETS.includes(tp.key)) continue;
      for (const target of targets) {
        const sep = Math.abs(norm180(tp.longitude - target.longitude));
        for (const asp of TRANSIT_ASPECTS) {
          const orb = Math.abs(sep - asp.angle);
          if (orb <= 1.6) {
            const key = `${tp.key}:${asp.name}:${target.nameZh}:${Math.floor(d / 45)}`;
            const prev = bestByKey.get(key);
            if (!prev || orb < prev.orb) {
              bestByKey.set(key, {
                date: dateStr,
                transitPlanet: PLANET_NAMES_ZH[tp.key],
                aspect: asp.name,
                natalPoint: target.nameZh,
                orb: Number(orb.toFixed(2)),
                transitSign: tp.formatted,
              });
            }
          }
        }
      }
    }
  }

  const events = Array.from(bestByKey.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 20);

  return {
    windowMonths: input.windowMonths,
    startDate: start.toISOString().slice(0, 10),
    events,
  };
}
