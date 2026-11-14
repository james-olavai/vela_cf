import test from 'node:test';
import assert from 'node:assert/strict';
import * as astro from './index.ts';
import { createAstrologyTools } from '../../../apps/api/src/tools.ts';
import { ALL_34_TOOLS, routeTurnCapabilities, SKILL_CATALOG, type SkillKey } from '../../../apps/api/src/skills.ts';
import { extractVelaUiBlocks } from '../../shared/src/index.ts';

const SAMPLE_TORONTO = {
  birthDateTime: '1994-06-03T08:20',
  latitude: 43.6532,
  longitude: -79.3832,
  timezone: 'America/Toronto',
};

const SAMPLE_SHANGHAI = {
  birthDateTime: '1996-09-12T14:30',
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
};

test('Core 5 tools: natalWheel, transitEvents, baziPillars, ziweiPalaces, synastryAspects', () => {
  const chart = astro.natalWheel(SAMPLE_TORONTO);
  assert.equal(chart.houseSystem, 'Placidus');
  assert.equal(chart.houses.length, 12);
  assert.equal(chart.planets.length, 12);
  const sun = chart.planets.find((p) => p.key === 'Sun');
  assert.ok(sun);
  assert.equal(sun.signZh, '双子');

  const transits = astro.transitEvents({ ...SAMPLE_TORONTO, windowMonths: 3, startDate: '2026-01-01' });
  assert.equal(transits.windowMonths, 3);
  assert.ok(Array.isArray(transits.events));

  const bazi = astro.baziPillars({ ...SAMPLE_TORONTO, yearBoundary: 'lichun', gender: 'female' });
  assert.equal(bazi.pillars.length, 4);
  assert.equal(bazi.method, 'vela-eastern-lat-v1');
  assert.ok(bazi.dayMaster.length > 0);

  const zw = astro.ziweiPalaces({ ...SAMPLE_TORONTO, gender: 'female' });
  assert.equal(zw.palaces.length, 12);
  assert.ok(zw.fiveElementsClass.length > 0);

  const syn = astro.synastryAspects({
    charts: [
      { ...SAMPLE_TORONTO, label: 'A', entityType: 'person' },
      { ...SAMPLE_SHANGHAI, label: 'B', entityType: 'person' },
    ],
  });
  assert.equal(syn.chartCount, 2);
  assert.ok(Array.isArray(syn.pairs) && syn.pairs.length === 1);
});

test('Western Extended (5 tools): companyTenthHouse, solarReturn, lunarReturn, secondaryProgression, solarArc', () => {
  const comp = astro.companyTenthHouse(SAMPLE_TORONTO);
  assert.equal(comp.chartType, 'company_tenth_house');
  assert.ok(comp.midheaven);

  const sr = astro.solarReturn({ ...SAMPLE_TORONTO, targetYear: 2026 });
  assert.equal(sr.chartType, 'solar_return');
  assert.equal(sr.targetYear, 2026);
  assert.equal(sr.planets.length, 12);

  const lr = astro.lunarReturn({ ...SAMPLE_TORONTO, asOfDate: '2026-11-15' });
  assert.equal(lr.chartType, 'lunar_return');
  assert.equal(lr.planets.length, 12);

  const sp = astro.secondaryProgression({ ...SAMPLE_TORONTO, targetDate: '2026-11-15' });
  assert.equal(sp.chartType, 'secondary_progression');
  assert.ok(sp.ageYears > 30);

  const sa = astro.solarArc({ ...SAMPLE_TORONTO, targetDate: '2026-11-15' });
  assert.equal(sa.chartType, 'solar_arc');
  assert.ok(typeof sa.solarArcDegrees === 'number');
});

test('Western Advanced (16 tools): snapshot, composite, davison, relocation, draconic, progressions, lots, returns, harmonic, antiscia, sidereal, helio, fixedStars, midpoint, localSpace', () => {
  const ts = astro.transitSnapshot({ ...SAMPLE_TORONTO, atDateTime: '2026-11-15T12:00', atTimezone: 'UTC' });
  assert.equal(ts.chartType, 'transit_snapshot');

  const composite = astro.compositeChart({ chartA: SAMPLE_TORONTO, chartB: SAMPLE_SHANGHAI });
  assert.equal(composite.chartType, 'composite');
  assert.equal(composite.planets.length, 12);

  const davison = astro.davisonChart({ chartA: SAMPLE_TORONTO, chartB: SAMPLE_SHANGHAI });
  assert.equal(davison.chartType, 'davison');

  const reloc = astro.relocationChart({ ...SAMPLE_TORONTO, destLatitude: 35.6762, destLongitude: 139.6503 });
  assert.equal(reloc.chartType, 'relocation');

  const drac = astro.draconicChart(SAMPLE_TORONTO);
  assert.equal(drac.chartType, 'draconic');

  const tp = astro.tertiaryProgression({ ...SAMPLE_TORONTO, targetDate: '2026-11-15' });
  assert.equal(tp.chartType, 'tertiary_progression');

  const mp = astro.minorProgression({ ...SAMPLE_TORONTO, targetDate: '2026-11-15' });
  assert.equal(mp.chartType, 'minor_progression');

  const lots = astro.arabicLots(SAMPLE_TORONTO);
  assert.equal(lots.chartType, 'lots');
  assert.equal(lots.lots.length, 7);

  const pr = astro.planetaryReturn({ ...SAMPLE_TORONTO, targetDate: '2023-06-01', body: 'Saturn' });
  assert.equal(pr.chartType, 'planetary_return');
  assert.equal(pr.body, 'Saturn');

  const harm = astro.harmonicChart({ ...SAMPLE_TORONTO, harmonic: 7 });
  assert.equal(harm.chartType, 'harmonic');
  assert.equal(harm.harmonic, 7);

  const ant = astro.antisciaPoints({ ...SAMPLE_TORONTO, orb: 2 });
  assert.equal(ant.chartType, 'antiscia');
  assert.equal(ant.points.length, 12);

  const sid = astro.siderealChart({ ...SAMPLE_TORONTO, ayanamsa: 'lahiri' });
  assert.equal(sid.chartType, 'sidereal');
  assert.equal(sid.ayanamsa, 'lahiri');

  const helio = astro.heliocentricChart(SAMPLE_TORONTO);
  assert.equal(helio.chartType, 'heliocentric');
  assert.equal(helio.earth.key, 'Earth');

  const stars = astro.fixedStars({ ...SAMPLE_TORONTO, orb: 2 });
  assert.equal(stars.chartType, 'fixed_stars');
  assert.ok(Array.isArray(stars.conjunctions));

  const mid = astro.midpointTree({ ...SAMPLE_TORONTO, orb: 1.5 });
  assert.equal(mid.chartType, 'midpoint_tree');
  assert.ok(Array.isArray(mid.hits));

  const ls = astro.localSpace(SAMPLE_TORONTO);
  assert.equal(ls.chartType, 'local_space');
  assert.equal(ls.bearings.length, 12);
});

test('Eastern Cycles (4 tools) & Classical Cycles (4 tools): baziDayun, baziLiunian, ziweiDaxian, ziweiLiunian, firdaria, profection, zodiacalReleasing, energyCalendar', () => {
  const bdy = astro.baziDayun({ ...SAMPLE_TORONTO, yearBoundary: 'lichun', gender: 'female', asOfDate: '2026-11-15' });
  assert.equal(bdy.chartType, 'bazi_dayun');
  assert.ok(bdy.dayunList.length > 0);

  const bln = astro.baziLiunian({ ...SAMPLE_TORONTO, yearBoundary: 'lichun', gender: 'female', asOfDate: '2026-11-15' });
  assert.equal(bln.chartType, 'bazi_liunian');
  assert.ok(bln.liunianRows.length > 0);

  const zdx = astro.ziweiDaxian({ ...SAMPLE_TORONTO, gender: 'female', asOfDate: '2026-11-15' });
  assert.equal(zdx.chartType, 'ziwei_daxian');
  assert.ok(zdx.decadal);

  const zln = astro.ziweiLiunian({ ...SAMPLE_TORONTO, gender: 'female', asOfDate: '2026-11-15' });
  assert.equal(zln.chartType, 'ziwei_liunian');
  assert.ok(zln.yearly);

  const fir = astro.firdaria({ ...SAMPLE_TORONTO, targetDate: '2026-11-15' });
  assert.equal(fir.chartType, 'firdaria');
  assert.equal(fir.periods.length, 9);

  const prof = astro.profection({ ...SAMPLE_TORONTO, targetDate: '2026-11-15', scope: 'annual' });
  assert.equal(prof.chartType, 'profection');
  assert.ok(prof.profectedHouse >= 1 && prof.profectedHouse <= 12);

  const zr = astro.zodiacalReleasing({ ...SAMPLE_TORONTO, releasedFrom: 'Spirit', maxAge: 60 });
  assert.equal(zr.chartType, 'zodiacal_releasing');
  assert.ok(zr.l1Periods.length > 0);

  const cal = astro.energyCalendar({ ...SAMPLE_TORONTO, month: '2026-11' });
  assert.equal(cal.chartType, 'energy_calendar');
  assert.equal(cal.days.length, 30);
});

test('All 35 Genkit/MCP tools registration & progressive disclosure loadSkillReference + smart routing + UI blocks', async () => {
  const registered: Record<string, { config: any; fn: (arg: any) => Promise<any> }> = {};
  const mockAi = {
    defineTool(config: any, fn: (arg: any) => Promise<any>) {
      registered[config.name] = { config, fn };
      return { name: config.name, config, fn };
    },
  } as any;

  const tools = createAstrologyTools(mockAi);
  const toolNames = Object.keys(tools);
  assert.equal(toolNames.length, 35, 'Must register all 34 astrology tools + loadSkillReference (35 total)');
  for (const name of ALL_34_TOOLS) {
    assert.ok(registered[name], `Missing tool registration: ${name}`);
  }
  assert.ok(registered.loadSkillReference, 'Missing loadSkillReference tool');

  for (const skillKey of Object.keys(SKILL_CATALOG) as SkillKey[]) {
    const res = await registered.loadSkillReference.fn({ skillKey });
    assert.equal(res.skillKey, skillKey);
    assert.ok(res.reference.length > 10);
  }

  const freeRoute = routeTurnCapabilities({
    tier: 'free',
    message: '看下八字与法达星限',
    profileCount: 1,
    sessionAllowedTools: ALL_34_TOOLS,
  });
  assert.deepEqual(freeRoute.routedTools, ['natalWheel']);
  assert.equal(freeRoute.enableSkillLoader, false);

  const proDeepRoute = routeTurnCapabilities({
    tier: 'pro',
    depth: 'deep',
    message: '请结合法达星限、黄道释放与龙首盘看下人生周期',
    profileCount: 1,
    sessionAllowedTools: ALL_34_TOOLS,
  });
  assert.equal(proDeepRoute.enableSkillLoader, true);
  assert.equal(proDeepRoute.maxTurns, 5);
  assert.ok(proDeepRoute.routedTools.includes('firdaria'));
  assert.ok(proDeepRoute.routedTools.includes('draconicChart'));

  const sampleReply = [
    '这里是正文分析。',
    ':::vela-ui',
    JSON.stringify({
      component: 'synastry-meter',
      title: '能量维度',
      dimensions: [{ label: '事业推进', score: 86, summary: '十宫木星顺行加持' }],
    }),
    ':::',
  ].join('\n');
  const parsed = extractVelaUiBlocks(sampleReply);
  assert.equal(parsed.cleanText, '这里是正文分析。');
  assert.equal(parsed.uiBlocks.length, 1);
  assert.equal(parsed.uiBlocks[0].component, 'synastry-meter');
});
