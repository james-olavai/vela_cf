import type { ChartSnapshot } from '../lib/store';

interface NatalWheelSvgProps {
  chart?: ChartSnapshot | null;
  className?: string;
  decorative?: boolean;
}

const SIGNS_ZH = [
  '白羊',
  '金牛',
  '双子',
  '巨蟹',
  '狮子',
  '处女',
  '天秤',
  '天蝎',
  '射手',
  '摩羯',
  '水瓶',
  '双鱼',
];

function position(angle: number, radius: number): { x: number; y: number } {
  const radians = ((angle - 90) * Math.PI) / 180;
  return { x: 160 + Math.cos(radians) * radius, y: 160 + Math.sin(radians) * radius };
}

export function NatalWheelSvg({
  chart,
  className = 'h-auto w-full max-w-[320px] self-center',
  decorative = false,
}: NatalWheelSvgProps) {
  const houses =
    chart?.natal.houses ?? Array.from({ length: 12 }, (_, i) => ({ number: i + 1, longitude: i * 30 }));
  const planets = chart?.natal.planets ?? [
    { key: 'Sun', nameZh: '太阳', longitude: 72, formatted: '双子 12°', house: 10 },
    { key: 'Moon', nameZh: '月亮', longitude: 213, formatted: '天蝎 3°', house: 3 },
    { key: 'Mercury', nameZh: '水星', longitude: 91, formatted: '巨蟹 1°', house: 11 },
    { key: 'Venus', nameZh: '金星', longitude: 45, formatted: '金牛 15°', house: 9 },
    { key: 'Mars', nameZh: '火星', longitude: 125, formatted: '狮子 5°', house: 12 },
    { key: 'Saturn', nameZh: '土星', longitude: 341, formatted: '双鱼 11°', house: 7 },
  ];

  const planetCoords = planets.map((p) => ({
    ...p,
    ...position(p.longitude, 110),
  }));

  const ascCoord = chart ? position(chart.natal.ascendant.longitude, 96) : null;
  const mcCoord = chart ? position(chart.natal.midheaven.longitude, 96) : null;

  return (
    <svg
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={
        decorative
          ? undefined
          : `本命盘圆盘，显示 ${planets.length} 个天体及十二星座、十二宫宫头`
      }
      viewBox="0 0 320 320"
      className={className}
    >
      <circle cx="160" cy="160" r="148" fill="#111827" stroke="#8d7342" strokeWidth="1.5" />
      <circle cx="160" cy="160" r="124" fill="none" stroke="#64748b" strokeWidth="0.8" />
      <circle cx="160" cy="160" r="96" fill="none" stroke="#64748b" strokeWidth="0.8" />
      <circle cx="160" cy="160" r="48" fill="#171f32" stroke="#8d7342" strokeWidth="0.8" />

      {SIGNS_ZH.map((sign, index) => {
        const boundary = position(index * 30, 148);
        const inner = position(index * 30, 124);
        const label = position(index * 30 + 15, 136);
        return (
          <g key={sign}>
            <line
              x1={inner.x.toFixed(1)}
              y1={inner.y.toFixed(1)}
              x2={boundary.x.toFixed(1)}
              y2={boundary.y.toFixed(1)}
              stroke="#64748b"
              strokeWidth="0.8"
            />
            <text
              x={label.x.toFixed(1)}
              y={label.y.toFixed(1)}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#e2e8f0"
              fontSize="9"
            >
              {sign}
            </text>
          </g>
        );
      })}

      {houses.map((house, idx) => {
        const start = position(house.longitude, 48);
        const end = position(house.longitude, 96);
        return (
          <line
            key={idx}
            x1={start.x.toFixed(1)}
            y1={start.y.toFixed(1)}
            x2={end.x.toFixed(1)}
            y2={end.y.toFixed(1)}
            stroke="#e0b64a"
            strokeOpacity="0.55"
            strokeWidth="0.8"
          />
        );
      })}

      <g stroke="#6f7fa8" strokeOpacity="0.45" strokeWidth="0.8">
        {planetCoords.slice(0, 6).map((pt, idx) => {
          const next = planetCoords[(idx + 2) % planetCoords.length];
          return (
            <line
              key={`${pt.key}-${idx}`}
              x1={pt.x.toFixed(1)}
              y1={pt.y.toFixed(1)}
              x2={next.x.toFixed(1)}
              y2={next.y.toFixed(1)}
            />
          );
        })}
      </g>

      {planetCoords.map((pt) => (
        <circle key={pt.key} cx={pt.x.toFixed(1)} cy={pt.y.toFixed(1)} r="3.5" fill="#f7d57f">
          <title>{`${pt.nameZh}，${pt.formatted} · 第${pt.house}宫`}</title>
        </circle>
      ))}

      {ascCoord && chart && (
        <circle cx={ascCoord.x.toFixed(1)} cy={ascCoord.y.toFixed(1)} r="3" fill="#a5b4fc">
          <title>{`上升点，${chart.natal.ascendant.formatted}`}</title>
        </circle>
      )}
      {mcCoord && chart && (
        <circle cx={mcCoord.x.toFixed(1)} cy={mcCoord.y.toFixed(1)} r="3" fill="#a5b4fc">
          <title>{`天顶，${chart.natal.midheaven.formatted}`}</title>
        </circle>
      )}

      <text x="160" y="157" textAnchor="middle" fill="#f7d57f" fontSize="12">
        本命盘
      </text>
      <text x="160" y="174" textAnchor="middle" fill="#94a3b8" fontSize="9">
        黄道经度
      </text>
    </svg>
  );
}
