import type { ChartSnapshot } from '../lib/store';

interface NatalWheelSvgProps {
  chart?: ChartSnapshot | null;
  className?: string;
  decorative?: boolean;
}

export function NatalWheelSvg({
  chart,
  className = 'w-full max-w-[280px] self-center',
  decorative = false,
}: NatalWheelSvgProps) {
  const asc = chart?.natal.ascendant.longitude ?? 180;
  const toXY = (lon: number, r: number) => {
    // Place Ascendant at 180deg (left horizon), increasing counter-clockwise
    const angleDeg = 180 - (lon - asc);
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: 200 + r * Math.cos(rad),
      y: 200 + r * Math.sin(rad),
    };
  };

  const houses = chart?.natal.houses ?? Array.from({ length: 12 }, (_, i) => ({ longitude: i * 30 }));
  const planets = chart?.natal.planets.slice(0, 10) ?? [
    { key: 'Sun', longitude: 72 },
    { key: 'Moon', longitude: 213 },
    { key: 'Mercury', longitude: 91 },
    { key: 'Venus', longitude: 45 },
    { key: 'Mars', longitude: 125 },
    { key: 'Saturn', longitude: 341 },
  ];

  const planetCoords = planets.map((p, idx) => ({
    key: p.key,
    r: idx === 0 ? 7 : idx < 4 ? 6 : 5,
    ...toXY(p.longitude, 124),
  }));

  return (
    <svg
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : '本命盘星图示意'}
      viewBox="0 0 400 400"
      className={className}
      fill="none"
      stroke="#e0b64a"
      strokeWidth="1.5"
    >
      <circle cx="200" cy="200" r="190" />
      <circle cx="200" cy="200" r="150" />
      <circle cx="200" cy="200" r="100" stroke="#3a4668" />

      {houses.map((h, i) => {
        const inner = toXY(h.longitude, 150);
        const outer = toXY(h.longitude, 190);
        return (
          <line
            key={i}
            x1={inner.x.toFixed(1)}
            y1={inner.y.toFixed(1)}
            x2={outer.x.toFixed(1)}
            y2={outer.y.toFixed(1)}
          />
        );
      })}

      <g stroke="#6f7fa8" strokeWidth="1">
        {planetCoords.slice(0, 5).map((pt, idx) => {
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

      <g fill="#f7d57f" stroke="none">
        {planetCoords.map((pt) => (
          <circle
            key={pt.key}
            cx={pt.x.toFixed(1)}
            cy={pt.y.toFixed(1)}
            r={pt.r}
          />
        ))}
      </g>
    </svg>
  );
}
