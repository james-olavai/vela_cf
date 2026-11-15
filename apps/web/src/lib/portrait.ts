import type { ProfileRecord } from '@vela-cf/shared';
import type { ChartPlanet, ChartSnapshot } from './store';

export interface PortraitSummary {
  sunSign: string;
  moonSign: string;
  ascSign: string;
  epithet: string;
  archetype: string;
  insight: string;
  elementTraits: string[];
  elements: { fire: number; earth: number; air: number; water: number };
  modalities: { cardinal: number; fixed: number; mutable: number };
  signEnergy: Array<{ sign: string; pct: number }>;
  dominantPlanets: Array<{ name: string; sign: string; weight: number }>;
}

const SIGN_EN: Record<string, string> = {
  白羊: 'aries', 金牛: 'taurus', 双子: 'gemini', 巨蟹: 'cancer',
  狮子: 'leo', 处女: 'virgo', 天秤: 'libra', 天蝎: 'scorpio',
  射手: 'sagittarius', 摩羯: 'capricorn', 水瓶: 'aquarius', 双鱼: 'pisces',
};
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

export function sunriseImageUrl(sunZh: string, ascZh: string, gender?: string): string {
  const sun = SIGN_EN[normalizeSign(sunZh)];
  const asc = SIGN_EN[normalizeSign(ascZh)];
  if (!sun || !asc) return '';
  return `/avatar_designs_v2/${sun}/${sun}-${asc}-${gender === 'male' ? 'masc' : 'fem'}.webp`;
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

export async function renderVelaSharePoster(
  canvas: HTMLCanvasElement,
  profile: ProfileRecord | null,
  summary: PortraitSummary | null,
  shareUrl: string,
): Promise<void> {
  const W = 1080, H = 1660;
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
  ctx.lineWidth = 2.5;
  ctx.strokeRect(36, 36, W - 72, H - 72);

  ctx.fillStyle = '#f7d57f';
  ctx.font = 'bold 34px serif';
  ctx.textAlign = 'center';
  ctx.fillText('VELA 观星台 · 星盘能量画像', W / 2, 96);

  let y = 135;
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
        ctx.roundRect((W - 440) / 2, y, 440, 540, 26);
        ctx.clip();
        ctx.drawImage(img, (W - 440) / 2, y, 440, 540);
        ctx.restore();
        ctx.strokeStyle = 'rgba(224,182,74,0.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect((W - 440) / 2, y, 440, 540);
        y += 590;
      } catch {
        y += 24;
      }
    }
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 44px serif';
    ctx.fillText(`${profile.name} 的能量画像`, W / 2, y);
    ctx.fillStyle = '#f7d57f';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(`「${summary.epithet}」 · ${summary.archetype}`, W / 2, y + 48);
    y += 100;

    const trio = [
      { l: '太阳 · 内在', v: summary.sunSign },
      { l: '月亮 · 情感', v: summary.moonSign },
      { l: '上升 · 形象', v: summary.ascSign },
    ];
    trio.forEach((t, i) => {
      const cx = W / 2 + (i - 1) * 280;
      ctx.beginPath();
      ctx.arc(cx, y + 60, 62, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(224,182,74,0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(224,182,74,0.45)';
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 28px serif';
      ctx.fillText(t.v, cx, y + 68);
      ctx.fillStyle = '#9aa8c7';
      ctx.font = '20px sans-serif';
      ctx.fillText(t.l, cx, y + 146);
    });
    y += 185;

    const rCx = 270, rCy = y + 125, rRad = 82;
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
      const ry = y + 68 + i * 64;
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(`${s.sign}  ${s.pct}%`, 500, ry);
      ctx.fillStyle = '#1e2438';
      ctx.fillRect(500, ry + 12, 460, 12);
      ctx.fillStyle = '#e8b84d';
      ctx.fillRect(500, ry + 12, Math.round((460 * Math.min(100, s.pct * 2)) / 100), 12);
    });
    y += 268;


  }

  try {
    const { default: QRCode } = await import('qrcode');
    const qrDataUrl = await QRCode.toDataURL(shareUrl, { width: 160, margin: 1, color: { dark: '#0b1020', light: '#f8fafc' } });
    const qrImg = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = rej;
      el.src = qrDataUrl;
    });
    ctx.drawImage(qrImg, W - 244, H - 230, 160, 160);
  } catch { /* ignore qr fallback */ }

  ctx.textAlign = 'left';
  ctx.fillStyle = '#f7d57f';
  ctx.font = 'bold 26px serif';
  ctx.fillText('扫码生成你的专属星盘画像', 84, H - 155);
  ctx.fillStyle = '#9aa8c7';
  ctx.font = '20px sans-serif';
  ctx.fillText(shareUrl, 84, H - 115);
}
