import { PROMPT_TEXT } from "./prompt-resources.generated.js";
import { toJSONSchema } from "zod";
import { z, dynamicTool, type Genkit } from "genkit";
import * as astro from "@vela-cf/astrology";
import { SKILL_CATALOG, type SkillKey } from "./skills.js";

const baseBirthSchema = z.object({
  birthDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
});

const specs: Array<[string, string, any, (arg: any) => unknown]> = [
  [
    "natalWheel",
    PROMPT_TEXT.toolDescriptions.natalWheel,
    baseBirthSchema,
    astro.natalWheel,
  ],
  [
    "transitEvents",
    PROMPT_TEXT.toolDescriptions.transitEvents,
    astro.TransitEventsInputSchema,
    astro.transitEvents,
  ],
  [
    "baziPillars",
    PROMPT_TEXT.toolDescriptions.baziPillars,
    astro.BaziPillarsInputSchema,
    astro.baziPillars,
  ],
  [
    "ziweiPalaces",
    PROMPT_TEXT.toolDescriptions.ziweiPalaces,
    astro.ZiweiPalacesInputSchema,
    astro.ziweiPalaces,
  ],
  [
    "synastryAspects",
    PROMPT_TEXT.toolDescriptions.synastryAspects,
    astro.SynastryAspectsInputSchema,
    astro.synastryAspects,
  ],
  [
    "companyTenthHouse",
    PROMPT_TEXT.toolDescriptions.companyTenthHouse,
    astro.CompanyTenthHouseInputSchema,
    astro.companyTenthHouse,
  ],
  [
    "solarReturn",
    PROMPT_TEXT.toolDescriptions.solarReturn,
    astro.SolarReturnInputSchema,
    astro.solarReturn,
  ],
  [
    "lunarReturn",
    PROMPT_TEXT.toolDescriptions.lunarReturn,
    astro.LunarReturnInputSchema,
    astro.lunarReturn,
  ],
  [
    "secondaryProgression",
    PROMPT_TEXT.toolDescriptions.secondaryProgression,
    astro.DateTargetInputSchema,
    astro.secondaryProgression,
  ],
  [
    "solarArc",
    PROMPT_TEXT.toolDescriptions.solarArc,
    astro.DateTargetInputSchema,
    astro.solarArc,
  ],
  [
    "transitSnapshot",
    PROMPT_TEXT.toolDescriptions.transitSnapshot,
    astro.TransitSnapshotInputSchema,
    astro.transitSnapshot,
  ],
  [
    "compositeChart",
    PROMPT_TEXT.toolDescriptions.compositeChart,
    astro.DualWheelInputSchema,
    astro.compositeChart,
  ],
  [
    "davisonChart",
    PROMPT_TEXT.toolDescriptions.davisonChart,
    astro.DualWheelInputSchema,
    astro.davisonChart,
  ],
  [
    "relocationChart",
    PROMPT_TEXT.toolDescriptions.relocationChart,
    astro.RelocationInputSchema,
    astro.relocationChart,
  ],
  [
    "draconicChart",
    PROMPT_TEXT.toolDescriptions.draconicChart,
    baseBirthSchema,
    astro.draconicChart,
  ],
  [
    "tertiaryProgression",
    PROMPT_TEXT.toolDescriptions.tertiaryProgression,
    astro.DateTargetInputSchema,
    astro.tertiaryProgression,
  ],
  [
    "minorProgression",
    PROMPT_TEXT.toolDescriptions.minorProgression,
    astro.DateTargetInputSchema,
    astro.minorProgression,
  ],
  [
    "arabicLots",
    PROMPT_TEXT.toolDescriptions.arabicLots,
    baseBirthSchema,
    astro.arabicLots,
  ],
  [
    "planetaryReturn",
    PROMPT_TEXT.toolDescriptions.planetaryReturn,
    astro.PlanetaryReturnInputSchema,
    astro.planetaryReturn,
  ],
  [
    "harmonicChart",
    PROMPT_TEXT.toolDescriptions.harmonicChart,
    astro.HarmonicInputSchema,
    astro.harmonicChart,
  ],
  [
    "antisciaPoints",
    PROMPT_TEXT.toolDescriptions.antisciaPoints,
    astro.AntisciaInputSchema,
    astro.antisciaPoints,
  ],
  [
    "siderealChart",
    PROMPT_TEXT.toolDescriptions.siderealChart,
    astro.SiderealInputSchema,
    astro.siderealChart,
  ],
  [
    "heliocentricChart",
    PROMPT_TEXT.toolDescriptions.heliocentricChart,
    baseBirthSchema,
    astro.heliocentricChart,
  ],
  [
    "fixedStars",
    PROMPT_TEXT.toolDescriptions.fixedStars,
    astro.FixedStarsInputSchema,
    astro.fixedStars,
  ],
  [
    "midpointTree",
    PROMPT_TEXT.toolDescriptions.midpointTree,
    astro.MidpointTreeInputSchema,
    astro.midpointTree,
  ],
  [
    "localSpace",
    PROMPT_TEXT.toolDescriptions.localSpace,
    baseBirthSchema,
    astro.localSpace,
  ],
  [
    "baziDayun",
    PROMPT_TEXT.toolDescriptions.baziDayun,
    astro.BaziCycleInputSchema,
    astro.baziDayun,
  ],
  [
    "baziLiunian",
    PROMPT_TEXT.toolDescriptions.baziLiunian,
    astro.BaziCycleInputSchema,
    astro.baziLiunian,
  ],
  [
    "ziweiDaxian",
    PROMPT_TEXT.toolDescriptions.ziweiDaxian,
    astro.ZiweiCycleInputSchema,
    astro.ziweiDaxian,
  ],
  [
    "ziweiLiunian",
    PROMPT_TEXT.toolDescriptions.ziweiLiunian,
    astro.ZiweiCycleInputSchema,
    astro.ziweiLiunian,
  ],
  [
    "firdaria",
    PROMPT_TEXT.toolDescriptions.firdaria,
    astro.FirdariaInputSchema,
    astro.firdaria,
  ],
  [
    "profection",
    PROMPT_TEXT.toolDescriptions.profection,
    astro.ProfectionInputSchema,
    astro.profection,
  ],
  [
    "zodiacalReleasing",
    PROMPT_TEXT.toolDescriptions.zodiacalReleasing,
    astro.ZodiacalReleasingInputSchema,
    astro.zodiacalReleasing,
  ],
  [
    "energyCalendar",
    PROMPT_TEXT.toolDescriptions.energyCalendar,
    astro.EnergyCalendarInputSchema,
    astro.energyCalendar,
  ],
];

export const TOOL_DESCRIPTIONS: Record<string, string> = { ...PROMPT_TEXT.toolDescriptions };

export function createAstrologyTools(
  ai: Genkit,
  runtime?: {
    descriptions?: Record<string, string>;
    skills?: Record<
      string,
      { title: string; summary: string; reference: string }
    >;
    revision?: string;
    execute?: (name: string, input: unknown, fn: () => unknown) => unknown;
  },
) {
  const def = (
    name: string,
    description: string,
    inputSchema: any,
    fn: (arg: any) => unknown,
  ) =>
    (runtime ? dynamicTool : ai.defineTool.bind(ai))(
      {
        name,
        description: runtime?.descriptions?.[name] || description,
        ...(inputSchema._zod
          ? {
              inputJsonSchema: toJSONSchema(inputSchema, {
                target: "draft-7",
              }) as any,
            }
          : { inputSchema }),
      },
      async (raw: any) => {
        const input = inputSchema.parse(raw);
        return runtime?.execute
          ? runtime.execute(name, input, () => fn(input))
          : fn(input);
      },
    );

  const tools = Object.fromEntries(
    specs.map(([n, d, s, fn]) => [n, def(n, d, s, fn)]),
  ) as Record<string, ReturnType<typeof ai.defineTool>>;

  tools.loadSkillReference = (runtime ? dynamicTool : ai.defineTool.bind(ai))(
    {
      name: "loadSkillReference",
      description:
        runtime?.descriptions?.loadSkillReference ||
        TOOL_DESCRIPTIONS.loadSkillReference,
      inputSchema: z.object({
        skillKey: z.enum([
          "western_natal",
          "western_transit",
          "western_synastry",
          "western_returns_progressions",
          "western_advanced_wheels",
          "eastern_bazi",
          "eastern_ziwei",
          "classical_time_lords",
          "synthesis_master",
        ]),
      }),
    },
    async ({ skillKey }) => {
      const skill =
        runtime?.skills?.[skillKey] || SKILL_CATALOG[skillKey as SkillKey];
      const result = {
        skillKey,
        title: skill.title,
        reference: skill.reference,
        revision: runtime?.revision,
      };
      return runtime?.execute
        ? runtime.execute("loadSkillReference", { skillKey }, () => result)
        : result;
    },
  );

  return tools;
}
