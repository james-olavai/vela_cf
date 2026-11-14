/// <reference path="./types.d.ts" />
import { astro } from 'iztro';
import { Solar } from 'lunar-javascript';
import { z } from 'zod';
import { BaziPillarsInputSchema, computeTrueSolarTime, ZiweiPalacesInputSchema } from './eastern.js';

export const BaziCycleInputSchema = BaziPillarsInputSchema.extend({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function baziDayun(rawInput: z.infer<typeof BaziCycleInputSchema>) {
  const input = BaziCycleInputSchema.parse(rawInput);
  const tst = computeTrueSolarTime(input.birthDateTime, input.longitude, input.timezone);
  const ec = Solar.fromYmdHms(tst.year, tst.month, tst.day, tst.hour, tst.minute, 0).getLunar().getEightChar();
  ec.setSect(1);
  const yun = ec.getYun(input.gender === 'female' ? 0 : 1);
  const asOfYear = Number(input.asOfDate.slice(0, 4));
  const dayunList = yun.getDaYun().slice(1, 9).map((d) => ({
    ganZhi: d.getGanZhi(),
    startAge: d.getStartAge(),
    startYear: d.getStartYear(),
    endYear: d.getEndYear(),
    isCurrent: asOfYear >= d.getStartYear() && asOfYear <= d.getEndYear(),
  }));
  return {
    chartType: 'bazi_dayun' as const,
    asOfDate: input.asOfDate,
    currentDayun: dayunList.find((d) => d.isCurrent) ?? dayunList[0] ?? null,
    dayunList,
  };
}

export function baziLiunian(rawInput: z.infer<typeof BaziCycleInputSchema>) {
  const input = BaziCycleInputSchema.parse(rawInput);
  const tst = computeTrueSolarTime(input.birthDateTime, input.longitude, input.timezone);
  const ec = Solar.fromYmdHms(tst.year, tst.month, tst.day, tst.hour, tst.minute, 0).getLunar().getEightChar();
  ec.setSect(1);
  const yun = ec.getYun(input.gender === 'female' ? 0 : 1);
  const asOfYear = Number(input.asOfDate.slice(0, 4));
  const allDy = yun.getDaYun().slice(1, 9);
  const targetDy = allDy.find((d) => asOfYear >= d.getStartYear() && asOfYear <= d.getEndYear()) ?? allDy[0];
  const liunianRows = targetDy
    ? targetDy.getLiuNian().map((l) => ({
        year: l.getYear(),
        age: l.getAge(),
        ganZhi: l.getGanZhi(),
        isCurrent: l.getYear() === asOfYear,
      }))
    : [];
  return {
    chartType: 'bazi_liunian' as const,
    asOfDate: input.asOfDate,
    yearBoundary: input.yearBoundary,
    dayun: targetDy?.getGanZhi() ?? '',
    liunianRows,
  };
}

export const ZiweiCycleInputSchema = ZiweiPalacesInputSchema.extend({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function buildAstrolabe(input: z.infer<typeof ZiweiCycleInputSchema>) {
  const tst = computeTrueSolarTime(input.birthDateTime, input.longitude, input.timezone);
  const solarDate = `${tst.year}-${tst.month}-${tst.day}`;
  const timeIndex = tst.hour === 23 ? 0 : Math.floor((tst.hour + 1) / 2);
  return astro.bySolar(solarDate, timeIndex, input.gender === 'male' ? '男' : '女', true, 'zh-CN');
}

export function ziweiDaxian(rawInput: z.infer<typeof ZiweiCycleInputSchema>) {
  const input = ZiweiCycleInputSchema.parse(rawInput);
  const ast = buildAstrolabe(input);
  const h = ast.horoscope(input.asOfDate) as {
    decadal?: { name?: string; heavenlyStem?: string; earthlyBranch?: string; palaceNames?: string[]; mutagen?: string[] };
  };
  return {
    chartType: 'ziwei_daxian' as const,
    asOfDate: input.asOfDate,
    decadal: h.decadal
      ? {
          name: h.decadal.name ?? '大限',
          ganZhi: `${h.decadal.heavenlyStem ?? ''}${h.decadal.earthlyBranch ?? ''}`,
          palaceNames: h.decadal.palaceNames ?? [],
          mutagen: h.decadal.mutagen ?? [],
        }
      : null,
  };
}

export function ziweiLiunian(rawInput: z.infer<typeof ZiweiCycleInputSchema>) {
  const input = ZiweiCycleInputSchema.parse(rawInput);
  const ast = buildAstrolabe(input);
  const h = ast.horoscope(input.asOfDate) as {
    yearly?: { name?: string; heavenlyStem?: string; earthlyBranch?: string; palaceNames?: string[]; mutagen?: string[] };
  };
  return {
    chartType: 'ziwei_liunian' as const,
    asOfDate: input.asOfDate,
    yearly: h.yearly
      ? {
          name: h.yearly.name ?? '流年',
          ganZhi: `${h.yearly.heavenlyStem ?? ''}${h.yearly.earthlyBranch ?? ''}`,
          palaceNames: h.yearly.palaceNames ?? [],
          mutagen: h.yearly.mutagen ?? [],
        }
      : null,
  };
}
