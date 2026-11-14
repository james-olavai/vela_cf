import { z, type Genkit } from 'genkit';
import {
  baziPillars,
  natalWheel,
  synastryAspects,
  transitEvents,
  ziweiPalaces,
} from '@vela-cf/astrology';

const baseBirthSchema = z.object({
  birthDateTime: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
});

export function createAstrologyTools(ai: Genkit) {
  const natalWheelTool = ai.defineTool(
    {
      name: 'natalWheel',
      description: '计算西洋占星本命盘（行星星座度数、Placidus 宫位与主要相位）。',
      inputSchema: baseBirthSchema,
    },
    async (input) => natalWheel(input),
  );

  const transitEventsTool = ai.defineTool(
    {
      name: 'transitEvents',
      description: '计算未来 3/6/12 个月内的主要行运相位事件时间线。',
      inputSchema: baseBirthSchema.extend({
        windowMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]).default(6),
        startDate: z.string().optional(),
      }),
    },
    async (input) => transitEvents(input),
  );

  const baziPillarsTool = ai.defineTool(
    {
      name: 'baziPillars',
      description: '按真太阳时计算东方八字四柱、十神、五行分布与大运。',
      inputSchema: baseBirthSchema.extend({
        yearBoundary: z.enum(['lichun', 'civil_year']).default('lichun'),
        gender: z.enum(['male', 'female']).optional(),
      }),
    },
    async (input) => baziPillars(input),
  );

  const ziweiPalacesTool = ai.defineTool(
    {
      name: 'ziweiPalaces',
      description: '按真太阳时计算紫微斗数十二宫主星、四化与五行局。',
      inputSchema: baseBirthSchema.extend({
        gender: z.enum(['male', 'female']),
      }),
    },
    async (input) => ziweiPalaces(input),
  );

  const synastryAspectsTool = ai.defineTool(
    {
      name: 'synastryAspects',
      description: '计算 2 至 4 个档案（个人、公司或国家）之间的跨盘主要相位与核心配置对照。',
      inputSchema: z.object({
        charts: z
          .array(
            baseBirthSchema.extend({
              label: z.string(),
              entityType: z.enum(['person', 'company', 'country']).default('person'),
            }),
          )
          .min(2)
          .max(4),
      }),
    },
    async (input) => synastryAspects(input),
  );

  return {
    natalWheel: natalWheelTool,
    transitEvents: transitEventsTool,
    baziPillars: baziPillarsTool,
    ziweiPalaces: ziweiPalacesTool,
    synastryAspects: synastryAspectsTool,
  };
}
