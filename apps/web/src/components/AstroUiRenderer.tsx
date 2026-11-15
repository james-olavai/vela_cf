import type { AstroUiBlock } from '@vela-cf/shared';

interface AstroUiRendererProps {
  blocks: AstroUiBlock[];
  disabled?: boolean;
  onQuickAsk: (prompt: string) => void;
}

const TONE_DOT: Record<'harmony' | 'tension' | 'focus', string> = {
  harmony: 'bg-emerald-400',
  tension: 'bg-amber-400',
  focus: 'bg-accent',
};

export function AstroUiRenderer({ blocks, disabled, onQuickAsk }: AstroUiRendererProps) {
  if (blocks.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, bIdx) => {
        if (block.component === 'aspect-highlight') {
          return (
            <section
              key={`${block.component}-${bIdx}`}
              className="rounded-[14px] border border-border bg-panel/90 p-3.5 flex flex-col gap-2.5"
            >
              <div className="text-[13px] font-semibold tracking-wide text-accent-bright">
                {block.title}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {block.items.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    disabled={disabled}
                    onClick={() => onQuickAsk(item.prompt)}
                    className="text-left p-2.5 rounded-[10px] border border-border bg-panel-2 hover:border-accent/60 hover:bg-[#1a223b] disabled:opacity-50 cursor-pointer transition-colors flex flex-col gap-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-primary">
                        <span className={`w-2 h-2 rounded-full ${TONE_DOT[item.tone]}`} />
                        {item.pair}
                      </span>
                      {item.orb && (
                        <span className="font-mono-num text-[13px] text-muted">{item.orb}</span>
                      )}
                    </div>
                    <span className="text-[13px] text-secondary leading-snug">{item.note}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        }

        if (block.component === 'transit-timeline') {
          return (
            <section
              key={`${block.component}-${bIdx}`}
              className="rounded-[14px] border border-border bg-panel/90 p-3.5 flex flex-col gap-2.5"
            >
              <div className="text-[13px] font-semibold tracking-wide text-accent-bright">
                {block.title}
              </div>
              <div className="flex flex-col gap-2">
                {block.windows.map((win, idx) => (
                  <button
                    key={idx}
                    type="button"
                    disabled={disabled}
                    onClick={() => onQuickAsk(win.prompt)}
                    className="text-left px-3 py-2 rounded-[10px] border border-border bg-panel-2 hover:border-accent/60 hover:bg-[#1a223b] disabled:opacity-50 cursor-pointer transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex flex-col gap-0.5">
                      <span className="font-mono-num text-[13px] text-accent-bright">{win.range}</span>
                      <span className="text-[13px] text-primary truncate">{win.theme}</span>
                    </div>
                    <span className="shrink-0 flex items-center gap-1" aria-label={`能量强度 ${win.intensity}`}>
                      {[1, 2, 3].map((lvl) => (
                        <span
                          key={lvl}
                          className={`w-1.5 h-1.5 rounded-full ${
                            lvl <= win.intensity ? 'bg-accent' : 'bg-border'
                          }`}
                        />
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        }

        return (
          <section
            key={`${block.component}-${bIdx}`}
            className="rounded-[14px] border border-border bg-panel/90 p-3.5 flex flex-col gap-2.5"
          >
            <div className="text-[13px] font-semibold tracking-wide text-accent-bright">
              {block.title}
            </div>
            <div className="flex flex-col gap-2.5">
              {block.dimensions.map((dim, idx) => (
                <div key={idx} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-primary font-medium">{dim.label}</span>
                    <span className="font-mono-num text-accent-bright">{dim.score}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-bubble overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[#b88928] to-accent-bright"
                      style={{ width: `${Math.max(0, Math.min(100, dim.score))}%` }}
                    />
                  </div>
                  <span className="text-[13px] text-muted">{dim.summary}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
