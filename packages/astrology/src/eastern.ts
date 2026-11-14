/// <reference path="./types.d.ts" />
import { astro } from 'iztro';
import { Solar } from 'lunar-javascript';
import { z } from 'zod';
import { localToUtcParts } from './ephemeris.js';

export const BaziPillarsInputSchema = z.object({
  birthDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
  yearBoundary: z.enum(['lichun', 'civil_year']).default('lichun'),
  gender: z.enum(['male', 'female']).optional(),
});

export type BaziPillarsInput = z.infer<typeof BaziPillarsInputSchema>;

function equationOfTimeMinutes(dayOfYear: number): number {
  const b = (2 * Math.PI * (dayOfYear - 81)) / 365;
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
}

/**
 * `vela-eastern-lat-v1` True Solar Time adjustment.
 */
export function computeTrueSolarTime(
  birthDateTime: string,
  longitude: number,
  timezone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  formatted: string;
} {
  const utc = localToUtcParts(birthDateTime, timezone);
  const utcMs = Date.UTC(utc.year, utc.month - 1, utc.day, utc.hour, utc.minute, 0);
  const jan1Ms = Date.UTC(utc.year, 0, 1, 0, 0, 0);
  const dayOfYear = Math.floor((utcMs - jan1Ms) / 86400000) + 1;

  // True solar offset from UTC in minutes = longitude * 4 + EoT
  const solarOffsetMin = Math.round(longitude * 4 + equationOfTimeMinutes(dayOfYear));
  const trueSolarMs = utcMs + solarOffsetMin * 60000;
  const d = new Date(trueSolarMs);

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();

  return {
    year,
    month,
    day,
    hour,
    minute,
    formatted: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

export function baziPillars(rawInput: BaziPillarsInput) {
  const input = BaziPillarsInputSchema.parse(rawInput);
  const tst = computeTrueSolarTime(input.birthDateTime, input.longitude, input.timezone);
  const solar = Solar.fromYmdHms(tst.year, tst.month, tst.day, tst.hour, tst.minute, 0);
  const lunar = solar.getLunar();
  const ec = lunar.getEightChar();
  ec.setSect(1);

  const yearPillar =
    input.yearBoundary === 'civil_year' ? lunar.getYearInGanZhi() : ec.getYear();

  const pillars = [
    {
      name: '年柱',
      ganZhi: yearPillar,
      tenGod: ec.getYearShiShenGan(),
      wuXing: ec.getYearWuXing(),
      hiddenStems: ec.getYearHideGan(),
    },
    {
      name: '月柱',
      ganZhi: ec.getMonth(),
      tenGod: ec.getMonthShiShenGan(),
      wuXing: ec.getMonthWuXing(),
      hiddenStems: ec.getMonthHideGan(),
    },
    {
      name: '日柱',
      ganZhi: ec.getDay(),
      tenGod: '日主',
      wuXing: ec.getDayWuXing(),
      hiddenStems: ec.getDayHideGan(),
    },
    {
      name: '时柱',
      ganZhi: ec.getTime(),
      tenGod: ec.getTimeShiShenGan(),
      wuXing: ec.getTimeWuXing(),
      hiddenStems: ec.getTimeHideGan(),
    },
  ];

  const wxCounts: Record<string, number> = { 金: 0, 木: 0, 水: 0, 火: 0, 土: 0 };
  for (const p of pillars) {
    for (const ch of p.wuXing) {
      if (ch in wxCounts) wxCounts[ch] += 1;
    }
  }

  const genderNum = input.gender === 'female' ? 0 : 1;
  const daYun = ec
    .getYun(genderNum)
    .getDaYun(8)
    .slice(1, 7)
    .map((dy) => ({
      ganZhi: dy.getGanZhi(),
      startAge: dy.getStartAge(),
      startYear: dy.getStartYear(),
    }));

  return {
    method: 'vela-eastern-lat-v1' as const,
    trueSolarTime: tst.formatted,
    yearBoundary: input.yearBoundary,
    dayMaster: ec.getDayGan(),
    pillars,
    fiveElements: wxCounts,
    daYun,
  };
}

export const ZiweiPalacesInputSchema = z.object({
  birthDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
  gender: z.enum(['male', 'female']),
});

export type ZiweiPalacesInput = z.infer<typeof ZiweiPalacesInputSchema>;

function hourToIztroTimeIndex(hour: number): number {
  if (hour === 23) return 12;
  if (hour === 0) return 0;
  return Math.floor((hour + 1) / 2);
}

export function ziweiPalaces(rawInput: ZiweiPalacesInput) {
  const input = ZiweiPalacesInputSchema.parse(rawInput);
  const tst = computeTrueSolarTime(input.birthDateTime, input.longitude, input.timezone);
  const dateStr = `${tst.year}-${tst.month}-${tst.day}`;
  const timeIndex = hourToIztroTimeIndex(tst.hour);
  const genderZh = input.gender === 'female' ? '女' : '男';

  const astrolabe = astro.bySolar(dateStr, timeIndex, genderZh, true, 'zh-CN');

  return {
    method: 'vela-eastern-lat-v1' as const,
    trueSolarTime: tst.formatted,
    solarDate: astrolabe.solarDate,
    lunarDate: astrolabe.lunarDate,
    chineseDate: astrolabe.chineseDate,
    timeRange: astrolabe.timeRange,
    fiveElementsClass: astrolabe.fiveElementsClass,
    soulStar: astrolabe.soul,
    bodyStar: astrolabe.body,
    palaces: astrolabe.palaces.map((p) => ({
      name: p.name,
      isBodyPalace: p.isBodyPalace,
      heavenlyStem: p.heavenlyStem,
      earthlyBranch: p.earthlyBranch,
      majorStars: p.majorStars.map((s) => ({
        name: s.name,
        brightness: s.brightness || undefined,
        mutagen: s.mutagen || undefined,
      })),
      minorStars: p.minorStars.map((s) => s.name),
    })),
  };
}
