import { z } from 'zod';
import { natalWheel, NatalWheelInputSchema } from './western.js';
import { norm180 } from './ephemeris.js';

export const SynastryChartEntrySchema = NatalWheelInputSchema.extend({
  label: z.string().min(1).max(60),
  entityType: z.enum(['person', 'company', 'country']).default('person'),
});

export const SynastryAspectsInputSchema = z.object({
  charts: z.array(SynastryChartEntrySchema).min(2).max(4),
});

export type SynastryAspectsInput = z.infer<typeof SynastryAspectsInputSchema>;

const SYNASTRY_ASPECTS = [
  { name: '合相', angle: 0, orb: 6 },
  { name: '六分相', angle: 60, orb: 4 },
  { name: '四分相', angle: 90, orb: 6 },
  { name: '三分相', angle: 120, orb: 6 },
  { name: '对分相', angle: 180, orb: 6 },
] as const;

export function synastryAspects(rawInput: SynastryAspectsInput) {
  const input = SynastryAspectsInputSchema.parse(rawInput);

  const computed = input.charts.map((entry) => {
    const wheel = natalWheel(entry);
    const points = [
      ...wheel.planets.map((p) => ({
        nameZh: p.nameZh,
        longitude: p.longitude,
        signZh: p.signZh,
        degreeInSign: p.degreeInSign,
      })),
      {
        nameZh: '上升',
        longitude: wheel.ascendant.longitude,
        signZh: wheel.ascendant.signZh,
        degreeInSign: wheel.ascendant.degreeInSign,
      },
      {
        nameZh: '天顶',
        longitude: wheel.midheaven.longitude,
        signZh: wheel.midheaven.signZh,
        degreeInSign: wheel.midheaven.degreeInSign,
      },
    ];
    return {
      label: entry.label,
      entityType: entry.entityType,
      ascendant: wheel.ascendant,
      mc: wheel.midheaven,
      sun: wheel.planets.find((p) => p.key === 'Sun'),
      moon: wheel.planets.find((p) => p.key === 'Moon'),
      points,
    };
  });

  const pairs: Array<{
    chartA: string;
    chartB: string;
    aspects: Array<{
      pointA: string;
      pointB: string;
      aspect: string;
      orb: number;
    }>;
  }> = [];

  for (let i = 0; i < computed.length; i++) {
    for (let j = i + 1; j < computed.length; j++) {
      const a = computed[i];
      const b = computed[j];
      const pairAspects: Array<{
        pointA: string;
        pointB: string;
        aspect: string;
        orb: number;
      }> = [];

      for (const ptA of a.points) {
        for (const ptB of b.points) {
          const diff = Math.abs(norm180(ptA.longitude - ptB.longitude));
          for (const def of SYNASTRY_ASPECTS) {
            const orb = Math.abs(diff - def.angle);
            if (orb <= def.orb) {
              pairAspects.push({
                pointA: `${a.label}·${ptA.nameZh}`,
                pointB: `${b.label}·${ptB.nameZh}`,
                aspect: def.name,
                orb: Math.round(orb * 100) / 100,
              });
              break;
            }
          }
        }
      }

      pairAspects.sort((x, y) => x.orb - y.orb);
      pairs.push({
        chartA: a.label,
        chartB: b.label,
        aspects: pairAspects.slice(0, 18),
      });
    }
  }

  return {
    chartCount: computed.length,
    charts: computed.map((c) => ({
      label: c.label,
      entityType: c.entityType,
      sun: c.sun ? `${c.sun.signZh} ${c.sun.degreeInSign.toFixed(1)}°` : '',
      moon: c.moon ? `${c.moon.signZh} ${c.moon.degreeInSign.toFixed(1)}°` : '',
      ascendant: `${c.ascendant.signZh} ${c.ascendant.degreeInSign.toFixed(1)}°`,
      mc: `${c.mc.signZh} ${c.mc.degreeInSign.toFixed(1)}°`,
    })),
    pairs,
  };
}

export type SynastryAspectsResult = ReturnType<typeof synastryAspects>;
