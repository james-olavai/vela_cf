import { z, type Genkit } from 'genkit';
import * as astro from '@vela-cf/astrology';
import { SKILL_CATALOG, type SkillKey } from './skills.js';

const baseBirthSchema = z.object({
  birthDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
});

export function createAstrologyTools(ai: Genkit) {
  const def = (name: string, description: string, inputSchema: any, fn: (arg: any) => unknown) =>
    ai.defineTool({ name, description, inputSchema }, async (input) => fn(input));

  const specs: Array<[string, string, any, (arg: any) => unknown]> = [
    ['natalWheel', '计算个人/公司/事件西洋本命盘（Placidus 宫位与主要相位）。', baseBirthSchema, astro.natalWheel],
    ['transitEvents', '计算未来 3/6/12 个月外行星过境本命盘的重要行运窗口。', astro.TransitEventsInputSchema, astro.transitEvents],
    ['baziPillars', '基于真太阳时计算东方八字四柱、十神、五行与藏干。', astro.BaziPillarsInputSchema, astro.baziPillars],
    ['ziweiPalaces', '计算东方紫微斗数命盘十二宫、主星、辅星与四化（需性别 male/female）。', astro.ZiweiPalacesInputSchema, astro.ziweiPalaces],
    ['synastryAspects', '计算 2 至 4 个档案之间的跨盘合盘主要相位对照。', astro.SynastryAspectsInputSchema, astro.synastryAspects],
    ['companyTenthHouse', '计算公司/组织十宫事业盘、天顶与 1/2/6/10 宫资源落点。', astro.CompanyTenthHouseInputSchema, astro.companyTenthHouse],
    ['solarReturn', '计算指定公历年份的太阳返照盘。', astro.SolarReturnInputSchema, astro.solarReturn],
    ['lunarReturn', '计算指定参考日期附近的月亮返照盘。', astro.LunarReturnInputSchema, astro.lunarReturn],
    ['secondaryProgression', '计算指定日期的次限推运盘（一日一年法）。', astro.DateTargetInputSchema, astro.secondaryProgression],
    ['solarArc', '计算指定日期的太阳弧推运盘。', astro.DateTargetInputSchema, astro.solarArc],
    ['transitSnapshot', '计算指定精确时刻的行运天象时刻盘。', astro.TransitSnapshotInputSchema, astro.transitSnapshot],
    ['compositeChart', '计算双人中点组合盘（Composite Chart）。', astro.DualWheelInputSchema, astro.compositeChart],
    ['davisonChart', '计算双人时空中点盘（Davison Chart）。', astro.DualWheelInputSchema, astro.davisonChart],
    ['relocationChart', '计算迁移盘（指定目的地的宫位重排）。', astro.RelocationInputSchema, astro.relocationChart],
    ['draconicChart', '计算龙首盘（北交点归零基准）。', baseBirthSchema, astro.draconicChart],
    ['tertiaryProgression', '计算三限推运盘（一日一太阴月）。', astro.DateTargetInputSchema, astro.tertiaryProgression],
    ['minorProgression', '计算小限推运盘（一太阴月一年）。', astro.DateTargetInputSchema, astro.minorProgression],
    ['arabicLots', '计算七大希腊点（福点、精神点、爱神点等）。', baseBirthSchema, astro.arabicLots],
    ['planetaryReturn', '计算指定行星的返照盘（如土星回归、木星回归）。', astro.PlanetaryReturnInputSchema, astro.planetaryReturn],
    ['harmonicChart', '计算指定阶数（1-360）的谐波盘。', astro.HarmonicInputSchema, astro.harmonicChart],
    ['antisciaPoints', '计算映点（Antiscia）与反映点及紧密接触。', astro.AntisciaInputSchema, astro.antisciaPoints],
    ['siderealChart', '计算恒星黄道盘（支持 Lahiri 等岁差基准）。', astro.SiderealInputSchema, astro.siderealChart],
    ['heliocentricChart', '计算日心盘行星黄经位置。', baseBirthSchema, astro.heliocentricChart],
    ['fixedStars', '计算主要恒星与本命星体/四角的合相。', astro.FixedStarsInputSchema, astro.fixedStars],
    ['midpointTree', '计算 45° 盘中点树接触相位。', astro.MidpointTreeInputSchema, astro.midpointTree],
    ['localSpace', '计算本地方位盘行星方位角与罗盘方向。', baseBirthSchema, astro.localSpace],
    ['baziDayun', '计算八字大运列表与当前所在大运。', astro.BaziCycleInputSchema, astro.baziDayun],
    ['baziLiunian', '计算八字当前大运下的流年干支列表。', astro.BaziCycleInputSchema, astro.baziLiunian],
    ['ziweiDaxian', '计算指定日期的紫微斗数大限宫位与四化。', astro.ZiweiCycleInputSchema, astro.ziweiDaxian],
    ['ziweiLiunian', '计算指定日期的紫微斗数流年宫位与四化。', astro.ZiweiCycleInputSchema, astro.ziweiLiunian],
    ['firdaria', '计算古典占星 75 年法达星限主星周期。', astro.FirdariaInputSchema, astro.firdaria],
    ['profection', '计算古典小限法（Annual Profection）流年宫位与年主星。', astro.ProfectionInputSchema, astro.profection],
    ['zodiacalReleasing', '计算古典黄道释放（精神点/福点 L1 周期）。', astro.ZodiacalReleasingInputSchema, astro.zodiacalReleasing],
    ['energyCalendar', '计算指定月份（YYYY-MM）每日行运能量评分日历。', astro.EnergyCalendarInputSchema, astro.energyCalendar],
  ];

  const tools = Object.fromEntries(specs.map(([n, d, s, fn]) => [n, def(n, d, s, fn)])) as Record<string, ReturnType<typeof ai.defineTool>>;

  tools.loadSkillReference = ai.defineTool(
    {
      name: 'loadSkillReference',
      description: '渐进式披露工具：按需加载指定占星/命理技法的详细 Reference 解读框架与规范。',
      inputSchema: z.object({
        skillKey: z.enum([
          'western_natal',
          'western_transit',
          'western_synastry',
          'western_returns_progressions',
          'western_advanced_wheels',
          'eastern_bazi',
          'eastern_ziwei',
          'classical_time_lords',
          'synthesis_master',
        ]),
      }),
    },
    async ({ skillKey }) => {
      const skill = SKILL_CATALOG[skillKey as SkillKey];
      return { skillKey, title: skill.title, reference: skill.reference };
    },
  );

  return tools;
}
