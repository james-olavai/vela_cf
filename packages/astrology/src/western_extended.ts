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

function jdToIso(jd: number): string {
  const ms = (jd - 2440587.5) * 86400000;
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

function planetLonAtJd(jd: number, key: PlanetKey): number {
  const found = computePlanetPositions(jd).find((p) => p.key === key);
  return found ? found.longitude : 0;
}

export function findReturnJd(
  targetLon: number,
  approxJd: number,
  key: PlanetKey,
  periodDays: number,
): number {
  // Scan around approxJd within +/- periodDays/2 to bracket the crossing, then bisect
  const step = Math.max(0.25, periodDays / 40);
  let bestJd = approxJd;
  let bestDiff = 360;
  for (let d = approxJd - periodDays * 0.55; d <= approxJd + periodDays * 0.55; d += step) {
    const diff = Math.abs(norm180(planetLonAtJd(d, key) - targetLon));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestJd = d;
    }
  }
  let lo = bestJd - step;
  let hi = bestJd + step;
  for (let i = 0; i < 36; i++) {
    const mid = (lo + hi) / 2;
    const dLo = norm180(planetLonAtJd(lo, key) - targetLon);
    const dMid = norm180(planetLonAtJd(mid, key) - targetLon);
    if (dLo * dMid <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export function wheelAtJd(jd: number, latitude: number, longitude: number) {
  const houses = computePlacidusHouses(jd, latitude, longitude);
  const planets = computePlanetPositions(jd).map((p) => ({
    ...p,
    house: houseOfLongitude(p.longitude, houses.cusps),
  }));
  return {
    utcDateTime: jdToIso(jd),
    ascendant: { longitude: houses.ascendant, house: 1, ...formatZodiac(houses.ascendant) },
    midheaven: { longitude: houses.mc, house: 10, ...formatZodiac(houses.mc) },
    houses: houses.cusps.map((lon, idx) => ({ house: idx + 1, longitude: lon, ...formatZodiac(lon) })),
    planets,
  };
}

export const CompanyTenthHouseInputSchema = NatalWheelInputSchema;
export function companyTenthHouse(rawInput: z.infer<typeof CompanyTenthHouseInputSchema>) {
  const natal = natalWheel(rawInput);
  const mc = natal.midheaven;
  const house10 = natal.houses.find((h) => h.house === 10);
  const careerPlanets = natal.planets.filter((p) => [1, 2, 6, 10].includes(p.house));
  return {
    chartType: 'company_tenth_house' as const,
    midheaven: mc,
    tenthHouseCusp: house10,
    careerPlanets,
    ascendant: natal.ascendant,
    planets: natal.planets,
  };
}

export const SolarReturnInputSchema = NatalWheelInputSchema.extend({
  targetYear: z.number().int().min(1901).max(2099),
  relocatedLat: z.number().min(-90).max(90).optional(),
  relocatedLon: z.number().min(-180).max(180).optional(),
});
export function solarReturn(rawInput: z.infer<typeof SolarReturnInputSchema>) {
  const input = SolarReturnInputSchema.parse(rawInput);
  const utc = localToUtcParts(input.birthDateTime, input.timezone);
  const natalJd = julianDay(utc.year, utc.month, utc.day, utc.hour, utc.minute);
  const natalSunLon = planetLonAtJd(natalJd, 'Sun');
  const approxJd = julianDay(input.targetYear, utc.month, utc.day, utc.hour, utc.minute);
  const returnJd = findReturnJd(natalSunLon, approxJd, 'Sun', 365.2422);
  const lat = input.relocatedLat ?? input.latitude;
  const lon = input.relocatedLon ?? input.longitude;
  return { chartType: 'solar_return' as const, targetYear: input.targetYear, ...wheelAtJd(returnJd, lat, lon) };
}

export const LunarReturnInputSchema = NatalWheelInputSchema.extend({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  relocatedLat: z.number().min(-90).max(90).optional(),
  relocatedLon: z.number().min(-180).max(180).optional(),
});
export function lunarReturn(rawInput: z.infer<typeof LunarReturnInputSchema>) {
  const input = LunarReturnInputSchema.parse(rawInput);
  const utc = localToUtcParts(input.birthDateTime, input.timezone);
  const natalJd = julianDay(utc.year, utc.month, utc.day, utc.hour, utc.minute);
  const natalMoonLon = planetLonAtJd(natalJd, 'Moon');
  const [y, m, d] = input.asOfDate.split('-').map(Number);
  const asOfJd = julianDay(y, m, d, 12, 0);
  const returnJd = findReturnJd(natalMoonLon, asOfJd, 'Moon', 27.321661);
  const lat = input.relocatedLat ?? input.latitude;
  const lon = input.relocatedLon ?? input.longitude;
  return { chartType: 'lunar_return' as const, asOfDate: input.asOfDate, ...wheelAtJd(returnJd, lat, lon) };
}

export const DateTargetInputSchema = NatalWheelInputSchema.extend({
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function secondaryProgression(rawInput: z.infer<typeof DateTargetInputSchema>) {
  const input = DateTargetInputSchema.parse(rawInput);
  const utc = localToUtcParts(input.birthDateTime, input.timezone);
  const natalJd = julianDay(utc.year, utc.month, utc.day, utc.hour, utc.minute);
  const [y, m, d] = input.targetDate.split('-').map(Number);
  const targetJd = julianDay(y, m, d, 12, 0);
  const ageYears = (targetJd - natalJd) / 365.2422;
  const progJd = natalJd + ageYears;
  return {
    chartType: 'secondary_progression' as const,
    targetDate: input.targetDate,
    ageYears: Number(ageYears.toFixed(2)),
    ...wheelAtJd(progJd, input.latitude, input.longitude),
  };
}

export function solarArc(rawInput: z.infer<typeof DateTargetInputSchema>) {
  const input = DateTargetInputSchema.parse(rawInput);
  const natal = natalWheel(input);
  const utc = localToUtcParts(input.birthDateTime, input.timezone);
  const natalJd = julianDay(utc.year, utc.month, utc.day, utc.hour, utc.minute);
  const [y, m, d] = input.targetDate.split('-').map(Number);
  const targetJd = julianDay(y, m, d, 12, 0);
  const progJd = natalJd + (targetJd - natalJd) / 365.2422;
  const natalSun = natal.planets.find((p) => p.key === 'Sun')?.longitude ?? 0;
  const progSun = planetLonAtJd(progJd, 'Sun');
  const arc = norm360(progSun - natalSun);

  const ascLon = norm360(natal.ascendant.longitude + arc);
  const mcLon = norm360(natal.midheaven.longitude + arc);
  const planets = natal.planets.map((p) => {
    const lon = norm360(p.longitude + arc);
    return { ...p, longitude: lon, ...formatZodiac(lon) };
  });
  return {
    chartType: 'solar_arc' as const,
    targetDate: input.targetDate,
    solarArcDegrees: Number(arc.toFixed(2)),
    ascendant: { longitude: ascLon, house: 1, ...formatZodiac(ascLon) },
    midheaven: { longitude: mcLon, house: 10, ...formatZodiac(mcLon) },
    planets,
  };
}
