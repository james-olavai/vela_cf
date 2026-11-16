import type { ProfileRecord, PortraitSummary } from '@vela-cf/shared';
export type { PortraitSummary } from '@vela-cf/shared';

const SIGN_EN: Record<string, string> = {
  白羊: 'aries', 金牛: 'taurus', 双子: 'gemini', 巨蟹: 'cancer',
  狮子: 'leo', 处女: 'virgo', 天秤: 'libra', 天蝎: 'scorpio',
  射手: 'sagittarius', 摩羯: 'capricorn', 水瓶: 'aquarius', 双鱼: 'pisces',
};
const normalizeSign = (sign: string) => sign.replace(/座$/, '').trim();

export function sunriseImageUrl(sunZh: string, ascZh: string, gender?: string): string {
  const sun = SIGN_EN[normalizeSign(sunZh)];
  const asc = SIGN_EN[normalizeSign(ascZh)];
  if (!sun || !asc) return '';
  return `/avatar_designs_v2/${sun}/${sun}-${asc}-${gender === 'male' ? 'masc' : 'fem'}.webp`;
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
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '22px sans-serif';
    ctx.fillText('本命元素分布', 84, y);
    const labels = ['火相', '土相', '风相', '水相'];
    keys.forEach((key, i) => {
      const x = 84 + i * 230;
      ctx.fillStyle = '#9aa8c7';
      ctx.font = '20px sans-serif';
      ctx.fillText(`${labels[i]} ${summary.elements[key]}%`, x, y + 34);
      ctx.fillStyle = '#1e2438'; ctx.fillRect(x, y + 50, 190, 12);
      ctx.fillStyle = '#e8b84d'; ctx.fillRect(x, y + 50, 190 * summary.elements[key] / 100, 12);
    });
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
