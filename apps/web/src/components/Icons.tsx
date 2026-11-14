interface IconProps {
  size?: number;
}

const baseProps = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
});

export function IconPlus({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconSearch({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function IconSparkles({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    </svg>
  );
}

export function IconChevronsLeft({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />
    </svg>
  );
}

export function IconArrowUp({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function IconStop({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
