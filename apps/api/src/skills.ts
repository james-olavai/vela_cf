import { PROMPT_TEXT } from "./prompt-resources.generated.js";
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

const SKILL_TOOLS: Record<SkillKey, AstrologyToolName[]> = {
  "western_natal": [
    "natalWheel",
    "companyTenthHouse",
    "energyCalendar"
  ],
  "western_transit": [
    "transitEvents",
    "transitSnapshot"
  ],
  "western_synastry": [
    "synastryAspects",
    "compositeChart",
    "davisonChart"
  ],
  "western_returns_progressions": [
    "solarReturn",
    "lunarReturn",
    "secondaryProgression",
    "solarArc",
    "tertiaryProgression",
    "minorProgression",
    "planetaryReturn",
    "relocationChart"
  ],
  "western_advanced_wheels": [
    "draconicChart",
    "harmonicChart",
    "antisciaPoints",
    "siderealChart",
    "heliocentricChart",
    "fixedStars",
    "midpointTree",
    "localSpace",
    "arabicLots"
  ],
  "eastern_bazi": [
    "baziPillars",
    "baziDayun",
    "baziLiunian"
  ],
  "eastern_ziwei": [
    "ziweiPalaces",
    "ziweiDaxian",
    "ziweiLiunian"
  ],
  "classical_time_lords": [
    "firdaria",
    "profection",
    "zodiacalReleasing"
  ],
  "synthesis_master": [
    "natalWheel",
    "baziPillars",
    "solarReturn",
    "baziLiunian"
  ]
};
export const SKILL_CATALOG = Object.fromEntries(
  Object.entries(PROMPT_TEXT.skills).map(([key, text]) => [key, {
    key, ...text, requiredTools: SKILL_TOOLS[key as SkillKey],
  }]),
) as Record<SkillKey, SkillDefinition>;

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
  routingText?: {header:string;load:string;direct:string};
  skillTexts?: Record<string,{title:string;summary:string}>;
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
  const wantsTransit = /运势|行运|流年|未来|本月|下月|今年|明年|时间窗口|什么时候|桃花|日历|返照|推运|回归/.test(msg);
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
  const indexLines = relevantSkills.map((s) => `- \`${s.key}\` (${params.skillTexts?.[s.key]?.title || s.title}): ${params.skillTexts?.[s.key]?.summary || s.summary}`).join('\n');
  const skillIndexPrompt =
    (params.routingText || PROMPT_TEXT.routing).header.replace('{{tier}}', tier).replace('{{depth}}', tier === 'pro' ? `/推演深度(${depth})` : '').replace('{{tools}}', routedTools.join(', ')) + '\n' +
    (indexLines ? `${indexLines}\n` : '') +
    (enableSkillLoader
      ? (params.routingText || PROMPT_TEXT.routing).load
      : (params.routingText || PROMPT_TEXT.routing).direct);

  return { routedTools, enableSkillLoader, maxTurns, skillIndexPrompt };
}
