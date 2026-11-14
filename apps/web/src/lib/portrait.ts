import type { ProfileRecord } from '@vela-cf/shared';
import type { ChartPlanet, ChartSnapshot } from './store';

export interface CalendarDay {
  day: number;
  score: number;
  phase: string;
  events: string[];
}

export interface PortraitSummary {
  sunSign: string;
  moonSign: string;
  ascSign: string;
  archetype: string;
  insight: string;
  elements: { fire: number; earth: number; air: number; water: number };
  modalities: { cardinal: number; fixed: number; mutable: number };
  signEnergy: Array<{ sign: string; pct: number }>;
  dominantPlanets: Array<{ name: string; sign: string; weight: number }>;
  calendar: { month: string; days: CalendarDay[]; average: number };
}

const SIGN_EN: Record<string, string> = {
  白羊座: 'aries', 金牛座: 'taurus', 双子座: 'gemini', 巨蟹座: 'cancer',
  狮子座: 'leo', 处女座: 'virgo', 天秤座: 'libra', 天蝎座: 'scorpio',
  射手座: 'sagittarius', 摩羯座: 'capricorn', 水瓶座: 'aquarius', 双鱼座: 'pisces',
};
const FIRE = new Set(['白羊座', '狮子座', '射手座']);
const EARTH = new Set(['金牛座', '处女座', '摩羯座']);
const AIR = new Set(['双子座', '天秤座', '水瓶座']);
const CARDINAL = new Set(['白羊座', '巨蟹座', '天秤座', '摩羯座']);
const FIXED = new Set(['金牛座', '狮子座', '天蝎座', '水瓶座']);

const ARCHETYPES: Record<string, [string, string]> = {
  白羊座: ['破晓先驱 · 赤焰行者', '直觉与行动力同步点燃，擅长在混沌中率先破局。'],
  金牛座: ['大地筑梦 · 静水流深', '以笃定节奏沉淀价值，在真实质感中长出长期主义。'],
  双子座: ['星辰信使 · 多维共鸣者', '思维灵动如风，善于把零散线索编织成清晰洞察。'],
  巨蟹座: ['潮汐守望 · 温柔铠甲', '拥有极深的情感雷达，在守护与共情中凝聚内在力量。'],
  狮子座: ['曜石恒星 · 炽光创造者', '天生带着舞台感与热忱，用真诚照亮身边人的坐标。'],
  处女座: ['精密织星 · 秩序炼金师', '于细微处见真章，擅长把复杂现实打磨成优雅解法。'],
  天秤座: ['风雅衡器 · 关系诗人', '敏锐捕捉美与分寸，在共振与平衡中建立深度连接。'],
  天蝎座: ['深渊潜行 · 蜕变炼魂者', '目光穿透表象，越是关键转折越能展现破茧定力。'],
  射手座: ['远方旅人 · 真理追光者', '心向辽阔边界，用探索与信念把当下活成旷野。'],
  摩羯座: ['山巅行者 · 时间雕塑家', '冷静而坚韧，懂得把宏大愿景拆解成步步兑现的阶梯。'],
  水瓶座: ['星际观测者 · 未来解码人', '不被常规框架束缚，总能以独立视角看见下一程风向。'],
  双鱼座: ['梦境潮汐 · 灵性共鸣体', '想像力与直觉无界流动，在感知万象中沉淀温柔智慧。'],
};

export function sunriseImageUrl(sunZh: string, ascZh: string, gender?: string): string {
  const sun = SIGN_EN[sunZh];
  const asc = SIGN_EN[ascZh];
  if (!sun || !asc) return '';
  return `/avatar_designs_v2/${sun}/${sun}-${asc}-${gender === 'male' ? 'masc' : 'fem'}.webp`;
}

export function scoreColor(score: number): string {
  if (score >= 80) return '#e8b84d';
  if (score >= 65) return '#8b7bd8';
  if (score >= 50) return '#3b5080';
  if (score >= 35) return '#475569';
  return '#4a3b5a';
}

export function computePortraitSummary(natal: NonNullable<ChartSnapshot['natal']>): PortraitSummary {
  const planets = natal.planets as ChartPlanet[];
  const sun = planets.find((p) => p.key === 'Sun');
  const moon = planets.find((p) => p.key === 'Moon');
  const sunSign = sun?.signZh ?? '—';
  const moonSign = moon?.signZh ?? '—';
  const ascSign = natal.ascendant?.signZh ?? '—';

  const el = { fire: 0, earth: 0, air: 0, water: 0 };
  const mod = { cardinal: 0, fixed: 0, mutable: 0 };
  const signWeights: Record<string, number> = {};
  const planetWeights: Array<{ name: string; sign: string; weight: number }> = [];

  planets.forEach((p, idx) => {
    const w = idx <= 1 ? 3 : idx <= 4 ? 2 : 1;
    signWeights[p.signZh] = (signWeights[p.signZh] ?? 0) + w;
    planetWeights.push({ name: p.nameZh, sign: p.signZh, weight: Number((w + (p.house === 1 || p.house === 10 ? 0.5 : 0)).toFixed(1)) });
    if (FIRE.has(p.signZh)) el.fire += 1;
    else if (EARTH.has(p.signZh)) el.earth += 1;
    else if (AIR.has(p.signZh)) el.air += 1;
    else el.water += 1;
    if (CARDINAL.has(p.signZh)) mod.cardinal += 1;
    else if (FIXED.has(p.signZh)) mod.fixed += 1;
    else mod.mutable += 1;
  });

  const totalP = Math.max(1, planets.length);
  const totalW = Object.values(signWeights).reduce((a, b) => a + b, 0) || 1;
  const pct = (n: number) => Math.round((n / totalP) * 100);
  const signEnergy = Object.entries(signWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([sign, w]) => ({ sign, pct: Math.round((w / totalW) * 100) }));
  const dominantPlanets = planetWeights.sort((a, b) => b.weight - a.weight).slice(0, 3);

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const baseLon = sun?.longitude ?? 0;
  const phases = ['新月蓄力', '上弦推进', '满月峰值', '下弦沉淀'];
  const days: CalendarDay[] = Array.from({ length: dim }, (_, i) => {
    const day = i + 1;
    const wave = Math.sin((day / dim) * Math.PI * 2 + (baseLon * Math.PI) / 180);
    const moonWave = Math.cos(((day * 12.2 + (moon?.longitude ?? 0)) * Math.PI) / 180);
    const score = Math.max(28, Math.min(96, Math.round(64 + wave * 18 + moonWave * 12)));
    const phase = phases[Math.floor(((day - 1) / dim) * 4) % 4];
    const events = score >= 84 ? ['顺行高能窗口'] : score <= 38 ? ['静修沉淀日'] : [];
    return { day, score, phase, events };
  });
  const average = Math.round(days.reduce((s, d) => s + d.score, 0) / days.length);
  const [archetype, insight] = ARCHETYPES[sunSign] ?? ['观星行者 · 本命星图', '每一颗星体落点都在讲述你独特的节奏与天赋坐标。'];
  return { sunSign, moonSign, ascSign, archetype, insight, elements: { fire: pct(el.fire), earth: pct(el.earth), air: pct(el.air), water: pct(el.water) }, modalities: { cardinal: pct(mod.cardinal), fixed: pct(mod.fixed), mutable: pct(mod.mutable) }, signEnergy, dominantPlanets, calendar: { month: `${y}-${String(m).padStart(2, '0')}`, days, average } };
}

export async function renderVelaSharePoster(
  canvas: HTMLCanvasElement,
  profile: ProfileRecord | null,
  summary: PortraitSummary | null,
  shareUrl: string,
): Promise<void> {
  const W = 900, H = 1320;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#070a14');
  grad.addColorStop(0.5, '#101730');
  grad.addColorStop(1, '#090d1b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(224,182,74,0.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 28, W - 56, H - 56);

  ctx.fillStyle = '#f7d57f';
  ctx.font = 'bold 28px serif';
  ctx.textAlign = 'center';
  ctx.fillText('VELA 观星台 · 星盘能量画像', W / 2, 82);

  let y = 115;
  if (profile && summary) {
    const imgUrl = sunriseImageUrl(summary.sunSign, summary.ascSign, profile.gender);
    if (imgUrl) {
      try {
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const el = new Image();
          el.onload = () => res(el);
          el.onerror = rej;
          el.src = imgUrl;
        });
        ctx.save();
        ctx.beginPath();
        ctx.roundRect((W - 360) / 2, y, 360, 440, 22);
        ctx.clip();
        ctx.drawImage(img, (W - 360) / 2, y, 360, 440);
        ctx.restore();
        ctx.strokeStyle = 'rgba(224,182,74,0.5)';
        ctx.strokeRect((W - 360) / 2, y, 360, 440);
        y += 480;
      } catch {
        y += 20;
      }
    }
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 36px serif';
    ctx.fillText(`${profile.name} 的能量画像`, W / 2, y);
    ctx.fillStyle = '#f7d57f';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(`「${summary.archetype}」`, W / 2, y + 40);
    y += 88;

    const trio = [
      { l: '太阳', v: summary.sunSign },
      { l: '月亮', v: summary.moonSign },
      { l: '上升', v: summary.ascSign },
    ];
    trio.forEach((t, i) => {
      const cx = W / 2 + (i - 1) * 230;
      ctx.beginPath();
      ctx.arc(cx, y + 52, 50, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(224,182,74,0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(224,182,74,0.45)';
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 22px serif';
      ctx.fillText(t.v, cx, y + 58);
      ctx.fillStyle = '#9aa8c7';
      ctx.font = '16px sans-serif';
      ctx.fillText(t.l, cx, y + 122);
    });
    y += 155;

    // 雷达 + 星座榜
    const rCx = 240, rCy = y + 105, rRad = 68;
    const keys = ['fire', 'earth', 'air', 'water'] as const;
    ctx.beginPath();
    keys.forEach((k, i) => {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      const rad = rRad * (Math.max(15, summary.elements[k]) / 100);
      const px = rCx + rad * Math.cos(a), py = rCy + rad * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(245,215,127,0.28)';
    ctx.fill();
    ctx.strokeStyle = '#f5d77f';
    ctx.stroke();

    ctx.textAlign = 'left';
    summary.signEnergy.forEach((s, i) => {
      const ry = y + 55 + i * 54;
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(`${s.sign}  ${s.pct}%`, 430, ry);
      ctx.fillStyle = '#1e2438';
      ctx.fillRect(430, ry + 10, 360, 10);
      ctx.fillStyle = '#e8b84d';
      ctx.fillRect(430, ry + 10, Math.round((360 * Math.min(100, s.pct * 2)) / 100), 10);
    });
    y += 235;

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '18px sans-serif';
    ctx.fillText(`本月运势趋势 · 月均 ${summary.calendar.average} 分`, 80, y);
    const bw = Math.floor((W - 160) / summary.calendar.days.length);
    summary.calendar.days.forEach((d, i) => {
      ctx.fillStyle = scoreColor(d.score);
      const bh = Math.round((d.score / 100) * 44);
      ctx.fillRect(80 + i * bw, y + 60 - bh, Math.max(4, bw - 3), bh);
    });
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#9aa8c7';
  ctx.font = '18px sans-serif';
  ctx.fillText(`开启你的专属星盘推演 · ${shareUrl}`, W / 2, H - 56);
}
