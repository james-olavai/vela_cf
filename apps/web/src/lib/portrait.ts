import type { ProfileRecord } from '@vela-cf/shared';
import type { ChartPlanet, ChartSnapshot } from './store';

export interface PortraitSummary {
  sunSign: string;
  moonSign: string;
  ascSign: string;
  archetype: string;
  insight: string;
  elements: { fire: number; earth: number; air: number; water: number };
  modalities: { cardinal: number; fixed: number; mutable: number };
}

const FIRE = new Set(['白羊座', '狮子座', '射手座']);
const EARTH = new Set(['金牛座', '处女座', '摩羯座']);
const AIR = new Set(['双子座', '天秤座', '水瓶座']);
const CARDINAL = new Set(['白羊座', '巨蟹座', '天秤座', '摩羯座']);
const FIXED = new Set(['金牛座', '狮子座', '天蝎座', '水瓶座']);

const ARCHETYPES: Record<string, { archetype: string; insight: string }> = {
  白羊座: { archetype: '破晓先驱 · 赤焰行者', insight: '直觉与行动力同步点燃，擅长在混沌中率先破局。' },
  金牛座: { archetype: '大地筑梦 · 静水流深', insight: '以笃定节奏沉淀价值，在真实质感中长出长期主义。' },
  双子座: { archetype: '星辰信使 · 多维共鸣者', insight: '思维灵动如风，善于把零散线索编织成清晰洞察。' },
  巨蟹座: { archetype: '潮汐守望 · 温柔铠甲', insight: '拥有极深的情感雷达，在守护与共情中凝聚内在力量。' },
  狮子座: { archetype: '曜石恒星 · 炽光创造者', insight: '天生带着舞台感与热忱，用真诚照亮身边人的坐标。' },
  处女座: { archetype: '精密织星 · 秩序炼金师', insight: '于细微处见真章，擅长把复杂现实打磨成优雅解法。' },
  天秤座: { archetype: '风雅衡器 · 关系诗人', insight: '敏锐捕捉美与分寸，在共振与平衡中建立深度连接。' },
  天蝎座: { archetype: '深渊潜行 · 蜕变炼魂者', insight: '目光穿透表象，越是关键转折越能展现破茧定力。' },
  射手座: { archetype: '远方旅人 · 真理追光者', insight: '心向辽阔边界，用探索与信念把当下活成旷野。' },
  摩羯座: { archetype: '山巅行者 · 时间雕塑家', insight: '冷静而坚韧，懂得把宏大愿景拆解成步步兑现的阶梯。' },
  水瓶座: { archetype: '星际观测者 · 未来解码人', insight: '不被常规框架束缚，总能以独立视角看见下一程风向。' },
  双鱼座: { archetype: '梦境潮汐 · 灵性共鸣体', insight: '想像力与直觉无界流动，在感知万象中沉淀温柔智慧。' },
};

export function computePortraitSummary(natal: NonNullable<ChartSnapshot['natal']>): PortraitSummary {
  const planets = natal.planets as ChartPlanet[];
  const sunSign = planets.find((p) => p.key === 'Sun')?.signZh ?? '—';
  const moonSign = planets.find((p) => p.key === 'Moon')?.signZh ?? '—';
  const ascSign = natal.ascendant?.signZh ?? '—';

  const counts = { fire: 0, earth: 0, air: 0, water: 0, cardinal: 0, fixed: 0, mutable: 0 };
  for (const p of planets) {
    if (FIRE.has(p.signZh)) counts.fire += 1;
    else if (EARTH.has(p.signZh)) counts.earth += 1;
    else if (AIR.has(p.signZh)) counts.air += 1;
    else counts.water += 1;

    if (CARDINAL.has(p.signZh)) counts.cardinal += 1;
    else if (FIXED.has(p.signZh)) counts.fixed += 1;
    else counts.mutable += 1;
  }
  const total = Math.max(1, planets.length);
  const pct = (n: number) => Math.round((n / total) * 100);
  const meta = ARCHETYPES[sunSign] ?? {
    archetype: '观星行者 · 本命星图',
    insight: '每一颗星体落点都在讲述你独特的节奏与天赋坐标。',
  };

  return {
    sunSign,
    moonSign,
    ascSign,
    archetype: meta.archetype,
    insight: meta.insight,
    elements: { fire: pct(counts.fire), earth: pct(counts.earth), air: pct(counts.air), water: pct(counts.water) },
    modalities: { cardinal: pct(counts.cardinal), fixed: pct(counts.fixed), mutable: pct(counts.mutable) },
  };
}

export function downloadVelaSharePoster(
  profile: ProfileRecord | null,
  summary: PortraitSummary | null,
  shareUrl: string,
): void {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1440;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const grad = ctx.createLinearGradient(0, 0, 1080, 1440);
  grad.addColorStop(0, '#090d1a');
  grad.addColorStop(0.55, '#121933');
  grad.addColorStop(1, '#0b1020');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1440);

  ctx.strokeStyle = 'rgba(224, 182, 74, 0.45)';
  ctx.lineWidth = 3;
  ctx.strokeRect(48, 48, 984, 1344);

  ctx.fillStyle = '#f7d57f';
  ctx.font = 'bold 42px serif';
  ctx.fillText('VELA 观星台', 100, 140);
  ctx.fillStyle = '#9aa8c7';
  ctx.font = '26px sans-serif';
  ctx.fillText('个人星盘能量画像', 100, 188);

  if (profile && summary) {
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 64px serif';
    ctx.fillText(profile.name, 100, 310);

    ctx.fillStyle = '#f7d57f';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(summary.archetype, 100, 375);

    ctx.fillStyle = '#c3cde0';
    ctx.font = '28px sans-serif';
    ctx.fillText(summary.insight.slice(0, 32), 100, 440);
    if (summary.insight.length > 32) {
      ctx.fillText(summary.insight.slice(32), 100, 484);
    }

    const bigThree = [
      { label: '太阳', val: summary.sunSign },
      { label: '月亮', val: summary.moonSign },
      { label: '上升', val: summary.ascSign },
    ];
    bigThree.forEach((b, i) => {
      const x = 100 + i * 305;
      ctx.fillStyle = 'rgba(22, 29, 51, 0.9)';
      ctx.fillRect(x, 560, 270, 150);
      ctx.strokeStyle = '#26304d';
      ctx.strokeRect(x, 560, 270, 150);
      ctx.fillStyle = '#9aa8c7';
      ctx.font = '24px sans-serif';
      ctx.fillText(b.label, x + 28, 615);
      ctx.fillStyle = '#f7d57f';
      ctx.font = 'bold 36px serif';
      ctx.fillText(b.val, x + 28, 672);
    });

    const elems = [
      { label: '火象行动力', val: summary.elements.fire },
      { label: '土象沉淀力', val: summary.elements.earth },
      { label: '风象思维力', val: summary.elements.air },
      { label: '水象共情力', val: summary.elements.water },
    ];
    elems.forEach((el, i) => {
      const y = 800 + i * 95;
      ctx.fillStyle = '#c3cde0';
      ctx.font = '26px sans-serif';
      ctx.fillText(`${el.label}  ${el.val}%`, 100, y);
      ctx.fillStyle = '#1d2540';
      ctx.fillRect(100, y + 20, 880, 16);
      ctx.fillStyle = '#e0b64a';
      ctx.fillRect(100, y + 20, Math.round((880 * el.val) / 100), 16);
    });
  } else {
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 54px serif';
    ctx.fillText('此刻最在意什么？', 100, 480);
    ctx.fillStyle = '#c3cde0';
    ctx.font = '30px sans-serif';
    ctx.fillText('排盘即刻开启 1 对 1 深度星象推演', 100, 560);
  }

  ctx.fillStyle = '#9aa8c7';
  ctx.font = '24px sans-serif';
  ctx.fillText(`扫码或访问开启你的星盘推演：${shareUrl}`, 100, 1320);

  const link = document.createElement('a');
  link.download = `vela-card-${profile?.name || 'invite'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
