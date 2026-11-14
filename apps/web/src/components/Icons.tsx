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

export function IconSquarePen({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z" />
    </svg>
  );
}

export function IconNotebook({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <rect x="5" y="3" width="15" height="18" rx="2" />
      <path d="M3 7h4M3 12h4M3 17h4M10 8h6M10 12h4" />
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
