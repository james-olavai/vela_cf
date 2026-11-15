interface ElementRadarProps {
  elements: { fire: number; earth: number; air: number; water: number };
  size?: number;
}

const KEYS = ['fire', 'earth', 'air', 'water'] as const;
const LABELS: Record<(typeof KEYS)[number], { zh: string; color: string }> = {
  fire: { zh: '火', color: '#f87171' },
  earth: { zh: '土', color: '#34d399' },
  air: { zh: '风', color: '#60a5fa' },
  water: { zh: '水', color: '#a78bfa' },
};
const RINGS = [0.382, 0.618, 1];

const polar = (pct: number, r: number, cx: number, cy: number, i: number) => {
  const rad = (i / 4) * 2 * Math.PI - Math.PI / 2;
  return { x: cx + r * (pct / 100) * Math.cos(rad), y: cy + r * (pct / 100) * Math.sin(rad) };
};

export function ElementRadar({ elements, size = 154 }: ElementRadarProps) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 34;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      data-testid="element-radar" role="img"
      aria-label={`元素分布：火 ${elements.fire}%，土 ${elements.earth}%，风 ${elements.air}%，水 ${elements.water}%`}
      className="mx-auto block h-auto w-full select-none overflow-visible"
      style={{ maxWidth: `${size}px`, aspectRatio: '1 / 1' }}
    >
      {RINGS.map((f, idx) => (
        <polygon key={f} points={KEYS.map((_, i) => { const p = polar(100 * f, r, cx, cy, i); return `${p.x},${p.y}`; }).join(' ')} fill="none" stroke={idx === 2 ? 'rgba(224,182,74,0.35)' : 'rgba(148,163,184,0.18)'} strokeWidth={idx === 2 ? 1.2 : 0.8} strokeDasharray={idx === 1 ? '3 3' : undefined} />
      ))}
      {KEYS.map((k, i) => { const o = polar(100, r, cx, cy, i); return <line key={k} x1={cx} y1={cy} x2={o.x} y2={o.y} stroke="rgba(148,163,184,0.2)" strokeWidth="1" />; })}
      <polygon points={KEYS.map((k, i) => { const p = polar((elements[k] ?? 0), r, cx, cy, i); return `${p.x},${p.y}`; }).join(' ')} fill="rgba(224,182,74,0.15)" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      {KEYS.map((k, i) => {
        const val = elements[k] ?? 0;
        const p = polar(val, r, cx, cy, i);
        const outer = polar(100, r, cx, cy, i);
        const meta = LABELS[k];
        const tx = i === 1 ? outer.x + 10 : i === 3 ? outer.x - 10 : outer.x;
        const ty = i === 0 ? outer.y - 10 : i === 2 ? outer.y + 15 : outer.y + 3;
        const anchor = i === 1 ? 'start' : i === 3 ? 'end' : 'middle';
        return (
          <g key={k}>
            <circle cx={p.x} cy={p.y} r="4.5" fill={meta.color} opacity="0.28" />
            <circle cx={p.x} cy={p.y} r="2.5" fill={meta.color} stroke="#fff" strokeWidth="0.8" />
            <text x={tx} y={ty} textAnchor={anchor} dominantBaseline="middle" className="text-[13px] font-bold">
              <tspan fill={meta.color}>{meta.zh}</tspan>
              <tspan fill="#cbd5e1" dx="3" fontSize="13px" fontWeight="normal">{val}%</tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
