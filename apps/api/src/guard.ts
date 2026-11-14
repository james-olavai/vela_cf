import type { NatalWheelResult } from '@vela-cf/astrology';
import type { AstroUiBlock } from '@vela-cf/shared';

const ZODIAC_NAMES = [
  '白羊', '金牛', '双子', '巨蟹', '狮子', '处女',
  '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼',
] as const;

export function buildNatalFactSummary(natal: NatalWheelResult): string {
  const planets = natal.planets
    .map((p) => `${p.nameZh}:${p.signZh}${p.house}宫`)
    .join('，');
  const aspects = natal.aspects
    .slice(0, 10)
    .map((a) => `${a.pointA}${a.aspect}${a.pointB}(${a.orb}°)`)
    .join('，');
  return (
    `[已验证本命盘事实帧（Placidus，严禁违背）] ` +
    `上升:${natal.ascendant.signZh}，天顶:${natal.midheaven.signZh}；` +
    `行星:${planets}` +
    (aspects ? `；核心相位:${aspects}` : '')
  );
}

export function filterHallucinatedUiBlocks(
  uiBlocks: AstroUiBlock[],
  natal: NatalWheelResult | null,
  isSynastry: boolean,
): { blocks: AstroUiBlock[]; droppedCount: number } {
  if (!natal || isSynastry || natal.aspects.length === 0) {
    return { blocks: uiBlocks, droppedCount: 0 };
  }

  let droppedCount = 0;
  const blocks: AstroUiBlock[] = [];
  const planetNames = natal.planets.map((p) => p.nameZh).concat(['上升', '天顶']);

  for (const block of uiBlocks) {
    if (block.component !== 'aspect-highlight') {
      blocks.push(block);
      continue;
    }
    const validItems = block.items.filter((item) => {
      const mentioned = planetNames.filter((name) => item.pair.includes(name));
      if (mentioned.length < 2) return true;
      const [a, b] = mentioned;
      const exists = natal.aspects.some(
        (asp) =>
          (asp.pointA === a && asp.pointB === b) ||
          (asp.pointA === b && asp.pointB === a),
      );
      if (!exists) droppedCount += 1;
      return exists;
    });
    if (validItems.length > 0) {
      blocks.push({ ...block, items: validItems });
    }
  }
  return { blocks, droppedCount };
}

export function verifyKeySignClaims(
  text: string,
  natal: NatalWheelResult | null,
): { text: string; mismatches: string[] } {
  if (!natal || !text) return { text, mismatches: [] };

  const sun = natal.planets.find((p) => p.key === 'Sun')?.signZh;
  const moon = natal.planets.find((p) => p.key === 'Moon')?.signZh;
  const asc = natal.ascendant.signZh;

  const checks: Array<{ label: string; expected?: string }> = [
    { label: '太阳', expected: sun },
    { label: '月亮', expected: moon },
    { label: '上升', expected: asc },
  ];

  const mismatches: string[] = [];
  const signPattern = ZODIAC_NAMES.join('|');
  for (const { label, expected } of checks) {
    if (!expected) continue;
    const expectedBase = expected.replace(/座$/, '');
    const re = new RegExp(`${label}(?:落座?|位于|在|星座为)?[:：\\s]?(${signPattern})座?`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1] !== expectedBase) {
        mismatches.push(`${label}误作${m[1]}座(实为${expected})`);
        break;
      }
    }
  }

  if (mismatches.length === 0) return { text, mismatches };

  const note = `\n\n> 盘面事实核验提示：本命盘真实落座为 太阳${sun ?? '未知'}、月亮${moon ?? '未知'}、上升${asc}，请以此排盘数据为准。`;
  return { text: `${text}${note}`, mismatches };
}
