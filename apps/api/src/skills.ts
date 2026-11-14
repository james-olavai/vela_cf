import type { AnalysisDepth, AstrologyToolName, Tier } from '@vela-cf/shared';

export type SkillKey =
  | 'western_natal'
  | 'western_transit'
  | 'western_synastry'
  | 'western_returns_progressions'
  | 'western_advanced_wheels'
  | 'eastern_bazi'
  | 'eastern_ziwei'
  | 'classical_time_lords'
  | 'synthesis_master';

export interface SkillDefinition {
  key: SkillKey;
  title: string;
  summary: string;
  requiredTools: AstrologyToolName[];
  reference: string;
}

export const SKILL_CATALOG: Record<SkillKey, SkillDefinition> = {
  western_natal: {
    key: 'western_natal',
    title: '西洋本命盘与能量日历',
    summary: '个人性格、核心驱力、宫位结构与月度能量日历',
    requiredTools: ['natalWheel', 'companyTenthHouse', 'energyCalendar'],
    reference:
      '【西洋本命盘 Reference】优先抓太阳/月亮/上升及命主星，结合 1/4/7/10 角宫与紧密相位（orb<=3°）；公司档案看 `companyTenthHouse` 十宫与二六十宫；月度节奏可辅以 `energyCalendar`。',
  },
  western_transit: {
    key: 'western_transit',
    title: '西洋行运与时刻天象',
    summary: '未来 3/6/12 个月流年行运窗口与精确时刻盘',
    requiredTools: ['transitEvents', 'transitSnapshot'],
    reference:
      '【西洋行运 Reference】先定本命底色再看外行星过境触发；给出明确月份区间与推进/蓄力节奏，严禁编造工具未返回的日期。',
  },
  western_synastry: {
    key: 'western_synastry',
    title: '双人/多方合盘与关系盘',
    summary: '比较盘相位、中点组合盘（Composite）与时空中点盘（Davison）',
    requiredTools: ['synastryAspects', 'compositeChart', 'davisonChart'],
    reference:
      '【合盘关系 Reference】`synastryAspects` 看双方主观吸引与触发（日月金火土），`compositeChart`/`davisonChart` 看关系本身作为一个独立实体的走势与课题。',
  },
  western_returns_progressions: {
    key: 'western_returns_progressions',
    title: '返照盘与推运体系',
    summary: '太阳/月亮/行星返照、次限、太阳弧、三限、小限推运与迁移盘',
    requiredTools: ['solarReturn', 'lunarReturn', 'secondaryProgression', 'solarArc', 'tertiaryProgression', 'minorProgression', 'planetaryReturn', 'relocationChart'],
    reference:
      '【返照与推运 Reference】年运主题看 `solarReturn` + `secondaryProgression` + `solarArc`；月度情绪看 `lunarReturn`；土星/木星回归等大节点看 `planetaryReturn`；换城市发展看 `relocationChart`。',
  },
  western_advanced_wheels: {
    key: 'western_advanced_wheels',
    title: '高阶特殊盘型与点位',
    summary: '龙首盘、谐波盘、映点、恒星黄道、日心盘、恒星、中点树、本地方位、希腊点',
    requiredTools: ['draconicChart', 'harmonicChart', 'antisciaPoints', 'siderealChart', 'heliocentricChart', 'fixedStars', 'midpointTree', 'localSpace', 'arabicLots'],
    reference:
      '【高阶盘型 Reference】灵魂底色看 `draconicChart`；潜能频率看 `harmonicChart`；隐秘呼应看 `antisciaPoints`；传统希腊点看 `arabicLots`；精确引动看 `midpointTree` 与 `fixedStars`。',
  },
  eastern_bazi: {
    key: 'eastern_bazi',
    title: '东方八字四柱与大运流年',
    summary: '四柱干支、十神五行、十年大运与流年干支',
    requiredTools: ['baziPillars', 'baziDayun', 'baziLiunian'],
    reference:
      '【八字命理 Reference】严格以真太阳时四柱与十神为准，先定日主强弱与月令，再结合 `baziDayun`（十年大运）与 `baziLiunian`（流年干支）判断岁运生克。',
  },
  eastern_ziwei: {
    key: 'eastern_ziwei',
    title: '东方紫微斗数与大限流年',
    summary: '十二宫主星四化、大限与流年宫位走势',
    requiredTools: ['ziweiPalaces', 'ziweiDaxian', 'ziweiLiunian'],
    reference:
      '【紫微斗数 Reference】以命身宫及三方四正为主，按问题聚焦官禄/财帛/夫妻宫，流年大限以 `ziweiDaxian` 与 `ziweiLiunian` 返回四化为准。',
  },
  classical_time_lords: {
    key: 'classical_time_lords',
    title: '古典时间主星体系',
    summary: '法达星限（Firdaria）、小限法（Profection）与黄道释放（ZR）',
    requiredTools: ['firdaria', 'profection', 'zodiacalReleasing'],
    reference:
      '【古典时间主星 Reference】`profection` 定当年主星与激活宫位，`firdaria` 看昼夜盘 75 年星限切换，`zodiacalReleasing` 看人生高峰与转向期。',
  },
  synthesis_master: {
    key: 'synthesis_master',
    title: '中西合参交叉印证',
    summary: '多体系交叉对照（Pro 全维模式）',
    requiredTools: ['natalWheel', 'baziPillars', 'solarReturn', 'baziLiunian'],
    reference:
      '【中西合参 Reference】先分别提取西占与东方命理结论，再提炼 1-2 条交叉印证的共同主题，严禁在同一句事实陈述中混写两套体系术语。',
  },
};

export const WESTERN_COMMON_TOOLS: AstrologyToolName[] = [
  'natalWheel', 'transitEvents', 'synastryAspects', 'solarReturn', 'lunarReturn',
  'secondaryProgression', 'solarArc', 'compositeChart', 'relocationChart', 'companyTenthHouse',
];

const PRO_QUICK_TOOLS: AstrologyToolName[] = [
  'natalWheel', 'transitEvents', 'synastryAspects', 'baziPillars', 'ziweiPalaces',
];

const PRO_BALANCED_TOOLS: AstrologyToolName[] = [
  ...PRO_QUICK_TOOLS,
  'solarReturn', 'lunarReturn', 'secondaryProgression', 'solarArc', 'compositeChart',
  'relocationChart', 'companyTenthHouse', 'baziDayun', 'baziLiunian', 'ziweiDaxian', 'ziweiLiunian',
  'firdaria', 'profection', 'energyCalendar',
];

export const ALL_34_TOOLS: AstrologyToolName[] = [
  ...PRO_BALANCED_TOOLS,
  'transitSnapshot', 'davisonChart', 'draconicChart', 'tertiaryProgression', 'minorProgression',
  'arabicLots', 'planetaryReturn', 'harmonicChart', 'antisciaPoints', 'siderealChart',
  'heliocentricChart', 'fixedStars', 'midpointTree', 'localSpace', 'zodiacalReleasing',
];

export interface RoutedCapabilities {
  routedTools: AstrologyToolName[];
  enableSkillLoader: boolean;
  maxTurns: number;
  skillIndexPrompt: string;
}

export function routeTurnCapabilities(params: {
  tier: Tier;
  depth?: AnalysisDepth;
  message: string;
  profileCount: number;
  sessionAllowedTools: AstrologyToolName[];
}): RoutedCapabilities {
  const { tier, depth = 'balanced', message, profileCount, sessionAllowedTools } = params;
  const sessionSet = new Set<AstrologyToolName>(sessionAllowedTools);

  let pool: AstrologyToolName[];
  if (tier === 'free') pool = ['natalWheel'];
  else if (tier === 'go') pool = WESTERN_COMMON_TOOLS;
  else pool = depth === 'quick' ? PRO_QUICK_TOOLS : depth === 'deep' ? ALL_34_TOOLS : PRO_BALANCED_TOOLS;

  const availSet = new Set<AstrologyToolName>(pool.filter((t) => sessionSet.has(t)));
  if (availSet.size === 0) availSet.add('natalWheel');

  const msg = message.toLowerCase();
  const wantsSynastry = profileCount >= 2 || /合盘|关系|伴侣|恋人|结婚|合作|配对|他|她|对方/.test(msg);
  const wantsCompany = /公司|创业|商业|事业盘|组织|企业/.test(msg);
  const wantsTransit = /运势|流年|近期|最近|今年|明年|几个月|半年|窗口|机会|趋势|什么时候|桃花|日历|返照|推运|回归/.test(msg);
  const wantsEastern = /八字|四柱|十神|五行|喜用|紫微|命宫|四化|东方|大运|大限|流年/.test(msg);
  const wantsClassical = /法达|小限|黄道释放|希腊点|福点|精神点|古典/.test(msg);
  const wantsAdvanced = /龙首|谐波|映点|恒星|日心|中点|方位|迁移|换城市|搬家|时空/.test(msg);

  const pick = (list: AstrologyToolName[], target: Set<AstrologyToolName>) => {
    for (const t of list) if (availSet.has(t)) target.add(t);
  };

  const selected = new Set<AstrologyToolName>();
  if (wantsSynastry) pick(['synastryAspects', 'compositeChart', 'davisonChart'], selected);
  if (wantsCompany) pick(['companyTenthHouse', 'natalWheel'], selected);
  if (wantsClassical) pick(['firdaria', 'profection', 'zodiacalReleasing', 'arabicLots'], selected);
  if (wantsAdvanced) pick(['draconicChart', 'relocationChart', 'harmonicChart', 'antisciaPoints', 'siderealChart', 'heliocentricChart', 'fixedStars', 'midpointTree', 'localSpace', 'tertiaryProgression', 'minorProgression'], selected);
  if (wantsEastern) pick(['baziPillars', 'baziDayun', 'baziLiunian', 'ziweiPalaces', 'ziweiDaxian', 'ziweiLiunian'], selected);
  if (wantsTransit) pick(['transitEvents', 'solarReturn', 'lunarReturn', 'secondaryProgression', 'solarArc', 'energyCalendar', 'transitSnapshot', 'planetaryReturn'], selected);

  if (selected.size === 0 || (tier === 'pro' && depth === 'deep' && profileCount === 1)) {
    pick(['natalWheel'], selected);
  }
  if (tier === 'pro' && depth === 'deep' && selected.size <= 2) {
    pick(['baziPillars', 'transitEvents'], selected);
  }

  const routedTools = Array.from(selected).slice(0, depth === 'deep' ? 10 : 6);
  const enableSkillLoader = tier === 'pro' && depth === 'deep';
  const maxTurns = enableSkillLoader ? 5 : 3;

  const relevantSkills = (Object.values(SKILL_CATALOG) as SkillDefinition[]).filter((s) =>
    s.requiredTools.some((t) => routedTools.includes(t)),
  );
  const indexLines = relevantSkills.map((s) => `- \`${s.key}\` (${s.title}): ${s.summary}`).join('\n');
  const skillIndexPrompt =
    `【智能路由与技法目录】本轮已按档位(${tier})${tier === 'pro' ? `/推演深度(${depth})` : ''}路由工具：${routedTools.join(', ')}。\n` +
    (indexLines ? `${indexLines}\n` : '') +
    (enableSkillLoader
      ? '【渐进式披露】若需深入展开某技法框架，可先调用 `loadSkillReference` 按需加载对应 `skillKey` 的 Reference 指南，再调用排盘工具。'
      : '请直接调用上述已路由的排盘工具获取真实数据后作答。');

  return { routedTools, enableSkillLoader, maxTurns, skillIndexPrompt };
}
