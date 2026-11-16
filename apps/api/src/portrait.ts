import type { PortraitSummary } from '@vela-cf/shared';
import type { natalWheel } from '@vela-cf/astrology';

const FIRE = new Set(['白羊', '狮子', '射手']);
const EARTH = new Set(['金牛', '处女', '摩羯']);
const AIR = new Set(['双子', '天秤', '水瓶']);
const CARDINAL = new Set(['白羊', '巨蟹', '天秤', '摩羯']);
const FIXED = new Set(['金牛', '狮子', '天蝎', '水瓶']);

const normalizeSign = (sign: string) => sign.replace(/座$/, '').trim();

const ELEMENT_TRAITS: Record<string, string> = {
  fire: '行动派 · 直觉爆发的开拓者',
  earth: '实干家 · 慢热却稳定的建设者',
  air: '思想者 · 心智灵活的社交引导者',
  water: '感知者 · 共情细腻的情绪调频者',
};

const ARCHETYPES: Record<string, [string, string, string]> = {
  白羊: ['破晓先驱', '赤焰行者', '直觉与行动力同步点燃，擅长在混沌中率先破局。'],
  金牛: ['大地筑梦', '静水流深', '以笃定节奏沉淀价值，在真实质感中长出长期主义。'],
  双子: ['星辰信使', '多维共鸣者', '思维灵动如风，善于把零散线索编织成清晰洞察。'],
  巨蟹: ['潮汐守望', '温柔铠甲', '拥有极深的情感雷达，在守护与共情中凝聚内在力量。'],
  狮子: ['曜石恒星', '炽光创造者', '天生带着舞台感与热忱，用真诚照亮身边人的坐标。'],
  处女: ['精密织星', '秩序炼金师', '于细微处见真章，擅长把复杂现实打磨成优雅解法。'],
  天秤: ['风雅衡器', '关系诗人', '敏锐捕捉美与分寸，在共振与平衡中建立深度连接。'],
  天蝎: ['深渊潜行', '蜕变炼魂者', '目光穿透表象，越是关键转折越能展现破茧定力。'],
  射手: ['远方旅人', '真理追光者', '心向辽阔边界，用探索与信念把当下活成旷野。'],
  摩羯: ['山巅行者', '时间雕塑家', '冷静而坚韧，懂得把宏大愿景拆解成步步兑现的阶梯。'],
  水瓶: ['星际观测者', '未来解码人', '不被常规框架束缚，总能以独立视角看见下一程风向。'],
  双鱼: ['梦境潮汐', '灵性共鸣体', '想像力与直觉无界流动，在感知万象中沉淀温柔智慧。'],
};

export function computePortraitSummary(natal: ReturnType<typeof natalWheel>): PortraitSummary {
  const planets = natal.planets;
  const sun = planets.find((p) => p.key === 'Sun');
  const moon = planets.find((p) => p.key === 'Moon');
  const sunSign = sun?.signZh ?? '—';
  const moonSign = moon?.signZh ?? '—';
  const ascSign = natal.ascendant?.signZh ?? '—';

  const el = { fire: 0, earth: 0, air: 0, water: 0 };
  const mod = { cardinal: 0, fixed: 0, mutable: 0 };
  const signWeights: Record<string, number> = {};
  const planetWeights: Array<{ name: string; sign: string; weight: number }> = [];

  planets.forEach((p) => {
    const signKey = normalizeSign(p.signZh);
    const w = ['Sun', 'Moon'].includes(p.key) ? 3 : ['Mercury', 'Venus', 'Mars'].includes(p.key) ? 2 : 1;
    signWeights[p.signZh] = (signWeights[p.signZh] ?? 0) + w;
    planetWeights.push({ name: p.nameZh, sign: p.signZh, weight: Number((w + (p.house === 1 || p.house === 10 ? 0.5 : 0)).toFixed(1)) });
    if (FIRE.has(signKey)) el.fire += 1;
    else if (EARTH.has(signKey)) el.earth += 1;
    else if (AIR.has(signKey)) el.air += 1;
    else el.water += 1;
    if (CARDINAL.has(signKey)) mod.cardinal += 1;
    else if (FIXED.has(signKey)) mod.fixed += 1;
    else mod.mutable += 1;
  });

  const totalP = Math.max(1, planets.length);
  const totalW = Object.values(signWeights).reduce((a, b) => a + b, 0) || 1;
  const pct = (n: number) => Math.round((n / totalP) * 100);
  const elements = { fire: pct(el.fire), earth: pct(el.earth), air: pct(el.air), water: pct(el.water) };
  const elementTraits = Object.entries(elements)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => ELEMENT_TRAITS[k]);
  const signEnergy = Object.entries(signWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([sign, w]) => ({ sign, pct: Math.round((w / totalW) * 100) }));
  const dominantPlanets = planetWeights.sort((a, b) => b.weight - a.weight).slice(0, 3);

  const [epithet, archetype, insight] = ARCHETYPES[normalizeSign(sunSign)] ?? ['观星行者', '本命星图', '每一颗星体落点都在讲述你独特的节奏与天赋坐标。'];

  return {
    sunSign, moonSign, ascSign, epithet, archetype, insight, elementTraits, elements,
    modalities: { cardinal: pct(mod.cardinal), fixed: pct(mod.fixed), mutable: pct(mod.mutable) },
    signEnergy, dominantPlanets,
  };
}

