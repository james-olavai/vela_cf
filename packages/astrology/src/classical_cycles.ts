import { z } from 'zod';
import {
  computePlanetPositions,
  julianDay,
  localToUtcParts,
  norm180,
  norm360,
  SIGNS_ZH,
} from './ephemeris.js';
import { natalWheel, NatalWheelInputSchema } from './western.js';
import { DateTargetInputSchema } from './western_extended.js';

const DIURNAL_FIRDARIA: Array<[string, number]> = [
  ['Sun (太阳)', 10], ['Venus (金星)', 8], ['Mercury (水星)', 13], ['Moon (月亮)', 9],
  ['Saturn (土星)', 11], ['Jupiter (木星)', 12], ['Mars (火星)', 7], ['North Node (北交点)', 3], ['South Node (南交点)', 2],
];
const NOCTURNAL_FIRDARIA: Array<[string, number]> = [
  ['Moon (月亮)', 9], ['Saturn (土星)', 11], ['Jupiter (木星)', 12], ['Mars (火星)', 7],
  ['Sun (太阳)', 10], ['Venus (金星)', 8], ['Mercury (水星)', 13], ['North Node (北交点)', 3], ['South Node (南交点)', 2],
];

// 31. firdaria (75-year cycle)
export const FirdariaInputSchema = NatalWheelInputSchema.extend({
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export function firdaria(raw: z.infer<typeof FirdariaInputSchema>) {
  const input = FirdariaInputSchema.parse(raw);
  const natal = natalWheel(input);
  const sunLon = natal.planets.find((p) => p.key === 'Sun')?.longitude ?? 0;
  const isDiurnal = norm360(sunLon - natal.ascendant.longitude) > 180;
  const seq = isDiurnal ? DIURNAL_FIRDARIA : NOCTURNAL_FIRDARIA;
  const birthYear = Number(input.birthDateTime.slice(0, 4));
  const targetYear = input.targetDate ? Number(input.targetDate.slice(0, 4)) : new Date().getUTCFullYear();
  const age = Math.max(0, targetYear - birthYear);

  let cursor = 0;
  const periods = seq.map(([lord, years]) => {
    const startAge = cursor;
    const endAge = cursor + years;
    cursor = endAge;
    return { lord, years, startAge, endAge, isCurrent: (age % 75) >= startAge && (age % 75) < endAge };
  });
  return {
    chartType: 'firdaria' as const,
    sect: isDiurnal ? 'diurnal' : 'nocturnal',
    age,
    currentPeriod: periods.find((p) => p.isCurrent) ?? periods[0],
    periods,
  };
}

// 32. profection (whole-sign annual profections)
const SIGN_RULERS = ['火星', '金星', '水星', '月亮', '太阳', '水星', '金星', '火星', '木星', '土星', '土星', '木星'];
export const ProfectionInputSchema = DateTargetInputSchema.extend({
  scope: z.enum(['annual', 'annual_monthly_daily']).default('annual'),
});
export function profection(raw: z.infer<typeof ProfectionInputSchema>) {
  const input = ProfectionInputSchema.parse(raw);
  const natal = natalWheel(input);
  const ascIdx = Math.floor(natal.ascendant.longitude / 30);
  const utc = localToUtcParts(input.birthDateTime, input.timezone);
  const jdBirth = julianDay(utc.year, utc.month, utc.day, utc.hour, utc.minute);
  const [y, m, d] = input.targetDate.split('-').map(Number);
  const jdTarget = julianDay(y, m, d, 12, 0);
  const age = Math.max(0, Math.floor((jdTarget - jdBirth) / 365.2422));
  const house = (age % 12) + 1;
  const signIdx = (ascIdx + age) % 12;
  return {
    chartType: 'profection' as const,
    targetDate: input.targetDate,
    scope: input.scope,
    age,
    profectedHouse: house,
    profectedSign: SIGNS_ZH[signIdx],
    lordOfTheYear: SIGN_RULERS[signIdx],
  };
}

// 33. zodiacal_releasing
const SIGN_YEARS = [15, 8, 20, 25, 19, 20, 8, 15, 12, 27, 30, 12];
export const ZodiacalReleasingInputSchema = NatalWheelInputSchema.extend({
  releasedFrom: z.enum(['Spirit', 'Fortune']).default('Spirit'),
  maxAge: z.number().int().min(1).max(100).default(85),
});
export function zodiacalReleasing(raw: z.infer<typeof ZodiacalReleasingInputSchema>) {
  const input = ZodiacalReleasingInputSchema.parse(raw);
  const natal = natalWheel(input);
  const get = (k: string) => natal.planets.find((p) => p.key === k)?.longitude ?? 0;
  const sun = get('Sun');
  const moon = get('Moon');
  const asc = natal.ascendant.longitude;
  const isDay = norm360(sun - asc) > 180;
  const lotLon =
    input.releasedFrom === 'Fortune'
      ? norm360(asc + (isDay ? moon - sun : sun - moon))
      : norm360(asc + (isDay ? sun - moon : moon - sun));
  const startSign = Math.floor(lotLon / 30);
  const l1Periods: Array<{ sign: string; ruler: string; years: number; startAge: number; endAge: number }> = [];
  let age = 0;
  let idx = startSign;
  while (age < input.maxAge) {
    const years = SIGN_YEARS[idx % 12];
    l1Periods.push({ sign: SIGNS_ZH[idx % 12], ruler: SIGN_RULERS[idx % 12], years, startAge: age, endAge: age + years });
    age += years;
    idx += 1;
  }
  return { chartType: 'zodiacal_releasing' as const, releasedFrom: input.releasedFrom, startSign: SIGNS_ZH[startSign], l1Periods };
}

// 34. energy_calendar
export const EnergyCalendarInputSchema = NatalWheelInputSchema.extend({
  month: z.string().regex(/^\d{4}-\d{2}$/),
});
export function energyCalendar(raw: z.infer<typeof EnergyCalendarInputSchema>) {
  const input = EnergyCalendarInputSchema.parse(raw);
  const natal = natalWheel(input);
  const [y, m] = input.month.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = Array.from({ length: dim }, (_, i) => {
    const day = i + 1;
    const jd = julianDay(y, m, day, 12, 0);
    const transits = computePlanetPositions(jd);
    let delta = 0;
    for (const t of transits.slice(0, 7)) {
      for (const n of natal.planets.slice(0, 5)) {
        const sep = Math.abs(norm180(t.longitude - n.longitude));
        if (Math.abs(sep - 120) <= 3 || Math.abs(sep - 60) <= 2.5) delta += 5;
        else if (Math.abs(sep - 90) <= 3 || Math.abs(sep - 180) <= 3) delta -= 4;
      }
    }
    const score = Math.max(25, Math.min(98, 65 + delta));
    return { day, date: `${input.month}-${String(day).padStart(2, '0')}`, score };
  });
  return {
    chartType: 'energy_calendar' as const,
    month: input.month,
    average: Math.round(days.reduce((s, d) => s + d.score, 0) / days.length),
    days,
  };
}
