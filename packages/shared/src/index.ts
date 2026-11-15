import { z } from 'zod';

export const TierSchema = z.enum(['free', 'go', 'pro']);
export type Tier = z.infer<typeof TierSchema>;

/**
 * Monthly LLM cost budget in micro-USD (1 USD = 1_000_000 micro-USD)
 * calibrated to Gemini 4 Hydrogen (asia-southeast1: $1.65/1M in, $8.25/1M out)
 * preserving ~75% gross margin on paid tiers.
 */
export const QUOTA_BUDGET_MICRO_USD: Record<Tier, number> = {
  free: 100_000, // $0.10 (~3 standard readings)
  go: 2_300_000, // $2.30 (~55-70 readings on $9.9/mo)
  pro: 6_500_000, // $6.50 (~100-120 readings incl. heavy synastry on $24.9/mo)
};

export const QUOTA_LIMIT = QUOTA_BUDGET_MICRO_USD;
export const SHARE_BONUS_MICRO_USD = 30_000;
export const MAX_MONTHLY_SHARE_BONUSES = 3;
export const MAX_MONTHLY_SHARE_BONUS_MICRO_USD = SHARE_BONUS_MICRO_USD * MAX_MONTHLY_SHARE_BONUSES;

export const MAX_OUTPUT_TOKENS_BY_TIER: Record<Tier, number> = {
  free: 4096,
  go: 4096,
  pro: 8192,
};

export function computeTokenCostMicroUsd(inputTokens: number, outputTokens: number): number {
  const cost = Math.round((inputTokens * 1_650_000 + outputTokens * 8_250_000) / 1_000_000);
  return Math.max(1_000, cost);
}

export function computeEffectiveBudget(tier: Tier, bonusMicroUsd = 0): number {
  const cappedBonus = Math.max(0, Math.min(MAX_MONTHLY_SHARE_BONUS_MICRO_USD, bonusMicroUsd));
  return QUOTA_BUDGET_MICRO_USD[tier] + cappedBonus;
}

export function computeUsagePercent(usedMicroUsd: number, tier: Tier, bonusMicroUsd = 0): number {
  const budget = computeEffectiveBudget(tier, bonusMicroUsd);
  if (budget <= 0) return 100;
  return Math.min(100, Math.round((usedMicroUsd / budget) * 100));
}

export const TIER_META: Record<
  Tier,
  {
    label: string;
    priceLabel: string;
    monthlyBudgetMicroUsd: number;
    maxProfiles: number;
    maxSynastryProfiles: number;
    allowsEntityCharts: boolean;
    highlights: string[];
  }
> = {
  free: {
    label: '免费档',
    priceLabel: '$0',
    monthlyBudgetMicroUsd: QUOTA_BUDGET_MICRO_USD.free,
    maxProfiles: 1,
    maxSynastryProfiles: 0,
    allowsEntityCharts: false,
    highlights: ['每月约 3 次免费体验', '可保存 1 个个人出生档案 · 西洋本命盘基础解读'],
  },
  go: {
    label: 'Go',
    priceLabel: '$9.9',
    monthlyBudgetMicroUsd: QUOTA_BUDGET_MICRO_USD.go,
    maxProfiles: 5,
    maxSynastryProfiles: 2,
    allowsEntityCharts: false,
    highlights: [
      '每月约 55–70 次常规对话额度',
      '默认可存放 5 个档案 · 支持双人合盘勾选',
      '西洋占星常见盘面（本命、行运、日月返照、次限/太阳弧、组合盘、迁移盘）',
    ],
  },
  pro: {
    label: 'Pro',
    priceLabel: '$24.9',
    monthlyBudgetMicroUsd: QUOTA_BUDGET_MICRO_USD.pro,
    maxProfiles: 50,
    maxSynastryProfiles: 4,
    allowsEntityCharts: true,
    highlights: [
      '每月约 100–120 次多维推演额度',
      '升级可存放 50 个档案（含个人 / 公司 / 国家）· 最多 4 档案合盘',
      '解锁全部 34 项中西占星与命理工具 + 专属「推演深度」切换（速览 / 均衡 / 全维）',
    ],
  },
};

export function tierRank(tier: Tier): number {
  return tier === 'pro' ? 2 : tier === 'go' ? 1 : 0;
}

export function hasTierAccess(userTier: Tier, minTier: Tier): boolean {
  return tierRank(userTier) >= tierRank(minTier);
}

export const GenderSchema = z.enum(['male', 'female', 'unset']);
export type Gender = z.infer<typeof GenderSchema>;

export const EntityTypeSchema = z.enum(['person', 'company', 'country']);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const ConsultationModeSchema = z.enum(['personal', 'synastry']);
export type ConsultationMode = z.infer<typeof ConsultationModeSchema>;

export const AstrologyToolNameSchema = z.enum([
  'natalWheel', 'transitEvents', 'baziPillars', 'ziweiPalaces', 'synastryAspects',
  'companyTenthHouse', 'solarReturn', 'lunarReturn', 'secondaryProgression', 'solarArc',
  'transitSnapshot', 'compositeChart', 'davisonChart', 'relocationChart', 'draconicChart',
  'tertiaryProgression', 'minorProgression', 'arabicLots', 'planetaryReturn', 'harmonicChart',
  'antisciaPoints', 'siderealChart', 'heliocentricChart', 'fixedStars', 'midpointTree',
  'localSpace', 'baziDayun', 'baziLiunian', 'ziweiDaxian', 'ziweiLiunian',
  'firdaria', 'profection', 'zodiacalReleasing', 'energyCalendar',
]);
export type AstrologyToolName = z.infer<typeof AstrologyToolNameSchema>;

export interface CatalogProduct {
  slug: string;
  title: string;
  description: string;
  minTier: Tier;
  isPublished: boolean;
  sortOrder: number;
  tools: AstrologyToolName[];
  toolLabels: string[];
  requiresGender: boolean;
}

export const DEFAULT_PRODUCTS: CatalogProduct[] = [
  {
    slug: 'free-natal',
    title: '免费本命盘',
    description: '基于本命盘事实，做清晰温和的整体解读。适合第一次了解自己的星盘。',
    minTier: 'free',
    isPublished: true,
    sortOrder: 1,
    tools: ['natalWheel'],
    toolLabels: ['西洋本命盘'],
    requiresGender: false,
  },
  {
    slug: 'go-quick-read',
    title: '解忧速读',
    description: '带着一个具体的困扰来，结合本命盘与近期行运，给出聚焦的回应。',
    minTier: 'go',
    isPublished: true,
    sortOrder: 2,
    tools: ['natalWheel', 'transitEvents'],
    toolLabels: ['西洋本命盘', '行运时间线'],
    requiresGender: false,
  },
  {
    slug: 'pro-life-coach',
    title: '人生教练',
    description: '结合星盘事实与你的处境，做结构化的问诊与引导。中西合参，可持续多轮深入。',
    minTier: 'pro',
    isPublished: true,
    sortOrder: 3,
    tools: ['natalWheel', 'transitEvents', 'baziPillars', 'ziweiPalaces'],
    toolLabels: ['西洋本命盘', '行运时间线', '八字四柱', '紫微斗数'],
    requiresGender: true,
  },
];

export const ProfileInputSchema = z.object({
  name: z.string().trim().min(1, '请填写称呼').max(64, '称呼最多 64 个字'),
  entityType: EntityTypeSchema.default('person'),
  birthDateTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, '请选择完整的日期与时间'),
  locationName: z.string().trim().min(1, '请选择地点').max(200),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().trim().min(1).max(80),
  gender: GenderSchema.default('unset'),
  consentedOther: z.boolean().optional(),
});

export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export interface ProfileRecord extends ProfileInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocationCandidate {
  displayName: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export const AstroUiBlockSchema = z.discriminatedUnion('component', [
  z.object({
    component: z.literal('aspect-highlight'),
    title: z.string().max(40),
    items: z.array(z.object({ pair: z.string().max(32), orb: z.string().max(12).optional(), tone: z.enum(['harmony', 'tension', 'focus']).default('focus'), note: z.string().max(60), prompt: z.string().max(80) })).min(1).max(4),
  }),
  z.object({
    component: z.literal('transit-timeline'),
    title: z.string().max(40),
    windows: z.array(z.object({ range: z.string().max(32), theme: z.string().max(50), intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2), prompt: z.string().max(80) })).min(1).max(4),
  }),
  z.object({
    component: z.literal('synastry-meter'),
    title: z.string().max(40),
    dimensions: z.array(z.object({ label: z.string().max(24), score: z.number().min(0).max(100), summary: z.string().max(60) })).min(1).max(4),
  }),
]);
export type AstroUiBlock = z.infer<typeof AstroUiBlockSchema> & { type: 'ui-block' };

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: AstrologyToolName; label: string }
  | { type: 'tool-result'; toolName: AstrologyToolName; label: string; data: unknown }
  | AstroUiBlock;

export interface MessageRecord {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  parts: MessagePart[];
  suggestions?: string[];
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  mode: ConsultationMode;
  productSlug?: string;
  productTitle?: string;
  profileId: string;
  profileIds: string[];
  profileName: string;
  title: string;
  frozenPrompt: string;
  frozenModel: string;
  frozenTools: AstrologyToolName[];
  createdAt: string;
  updatedAt: string;
}

export interface UsageRecord {
  periodStart: string;
  used: number;
  bonusMicroUsd?: number;
  shareCount?: number;
  lastShareDate?: string;
  unlimited?: boolean;
  overrideTier?: Tier;
}

export interface UserRecord {
  email: string;
  displayName: string;
  acceptedTermsAt: string;
  confirmedAdultAt: string;
  createdAt: string;
}

export const CreateSessionRequestSchema = z.object({
  mode: ConsultationModeSchema.default('personal'),
  profileIds: z.array(z.string().min(1).max(128)).min(1).max(4),
});

export const AnalysisDepthSchema = z.enum(['quick', 'balanced', 'deep']);
export type AnalysisDepth = z.infer<typeof AnalysisDepthSchema>;
export const ChatRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  message: z.string().trim().min(1).max(2000),
  editLastTurn: z.boolean().optional(),
  depth: AnalysisDepthSchema.optional(),
});

export const ResolveLocationRequestSchema = z.object({
  query: z.string().trim().min(1).max(120),
});

export function utcMonthPeriodStart(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01T00:00:00Z`;
}

export function nextUtcMonthResetLabel(now = new Date()): string {
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return `${nextMonth.getUTCMonth() + 1} 月 1 日`;
}

export function extractVelaUiBlocks(raw: string): { cleanText: string; uiBlocks: AstroUiBlock[]; suggestions: string[] } {
  const sugMatch = raw.match(/\n?SUGGESTIONS:\s*(.+)$/s);
  const suggestions = sugMatch ? sugMatch[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 3) : [];
  let text = raw.replace(/\n?SUGGESTIONS:\s*.+$/s, '');
  const uiBlocks: AstroUiBlock[] = [];
  text = text.replace(/:::vela-ui\s*([\s\S]*?)\s*:::/g, (_m, body: string) => {
    try {
      const parsed = JSON.parse(body.trim()) as unknown;
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const res = AstroUiBlockSchema.safeParse(item);
        if (res.success) uiBlocks.push({ type: 'ui-block', ...res.data });
      }
    } catch { /* ignore malformed block */ }
    return '';
  });
  text = text.replace(/:::vela-ui[\s\S]*$/g, '').trim();
  return { cleanText: text, uiBlocks, suggestions };
}
