import { memo, useState } from 'react';
import type { ChartSnapshot } from '../lib/store';
import { NatalWheelSvg } from './NatalWheelSvg';

interface ChartFactCardProps {
  chart: ChartSnapshot;
  profileName: string;
  birthSummary?: string;
  defaultExpanded?: boolean;
}

function formatChartSummaryText(chart: ChartSnapshot, profileName: string): string {
  const lines: string[] = [`【${profileName} · 星盘事实】`];
  lines.push(`宫位制：${chart.natal.houseSystem}`);
  lines.push(`上升：${chart.natal.ascendant.formatted}｜天顶：${chart.natal.midheaven.formatted}`);
  for (const p of chart.natal.planets) {
    lines.push(`${p.nameZh}${p.retrograde ? ' (逆行)' : ''}：${p.formatted} · 第 ${p.house} 宫`);
  }
  if (chart.bazi) {
    lines.push('');
    lines.push(`【八字四柱】真太阳时 ${chart.bazi.trueSolarTime} · 日主 ${chart.bazi.dayMaster}`);
    lines.push(chart.bazi.pillars.map((p) => `${p.name} ${p.ganZhi}(${p.tenGod})`).join(' ｜ '));
  }
  if (chart.ziwei) {
    lines.push('');
    lines.push(`【紫微斗数】${chart.ziwei.fiveElementsClass} · 命主 ${chart.ziwei.soulStar} · 身主 ${chart.ziwei.bodyStar}`);
  }
  return lines.join('\n');
}

export const ChartFactCard = memo(function ChartFactCard({
  chart,
  profileName,
  birthSummary,
  defaultExpanded = false,
}: ChartFactCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [activeTab, setActiveTab] = useState<'natal' | 'transits' | 'eastern'>('natal');
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasTransits = Boolean(chart.transits && chart.transits.events.length > 0);
  const hasEastern = Boolean(chart.bazi || chart.ziwei);

  const sun = chart.natal.planets.find((p) => p.key === 'Sun');
  const moon = chart.natal.planets.find((p) => p.key === 'Moon');
  const visiblePlanets = showAll ? chart.natal.planets : chart.natal.planets.slice(0, 6);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatChartSummaryText(chart, profileName));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="print-only-clean rounded-[14px] border border-border bg-panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-divider">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-selected border border-accent/60 text-[13px] text-accent-bright">
            ✓
          </span>
          <div className="min-w-0">
            <p className="m-0 text-[14px] font-bold text-primary truncate">
              星盘事实 · {profileName}
            </p>
            <p className="m-0 font-mono-num text-[13px] text-muted truncate">
              {birthSummary ? `${birthSummary} · ` : ''}
              {sun ? `太阳${sun.signZh}` : ''}
              {moon ? ` · 月亮${moon.signZh}` : ''}
              {` · 上升${chart.natal.ascendant.signZh}`}
            </p>
          </div>
        </div>

        <div className="no-print flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="min-h-[34px] px-2.5 rounded-[8px] border border-border bg-transparent text-[13px] text-secondary hover:border-border-strong hover:text-primary cursor-pointer"
          >
            {copied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-[34px] px-2.5 rounded-[8px] border border-border bg-transparent text-[13px] text-secondary hover:border-border-strong hover:text-primary cursor-pointer"
          >
            打印
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="min-h-[34px] px-3 rounded-[8px] border border-accent/50 bg-selected text-[13px] font-medium text-accent-bright hover:border-accent cursor-pointer"
          >
            {expanded ? '收起盘面' : '展开盘面'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="p-4 flex flex-col gap-4">
          {(hasTransits || hasEastern) && (
            <div className="no-print flex flex-wrap gap-1.5 border-b border-divider pb-2.5">
              {(
                [
                  { id: 'natal', label: '西洋本命', show: true },
                  { id: 'transits', label: '行运时间线', show: hasTransits },
                  { id: 'eastern', label: '八字与紫微', show: hasEastern },
                ] as const
              )
                .filter((t) => t.show)
                .map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={`min-h-[30px] px-3 rounded-[15px] border text-[13px] font-medium cursor-pointer ${
                      activeTab === t.id
                        ? 'border-accent bg-selected text-accent-bright'
                        : 'border-border bg-transparent text-secondary'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
            </div>
          )}

          {activeTab === 'natal' && (
            <>
              <div className="flex flex-col sm:flex-row items-center gap-5">
                <div className="w-[210px] shrink-0">
                  <NatalWheelSvg chart={chart} />
                </div>

                <div className="flex-1 w-full min-w-0">
                  <div className="flex items-center justify-between text-[13px] text-muted mb-2">
                    <span>{chart.natal.houseSystem} 宫位制</span>
                    <span className="font-mono-num text-accent-bright">
                      ASC {chart.natal.ascendant.formatted} · MC {chart.natal.midheaven.formatted}
                    </span>
                  </div>

                  <table className="w-full border-collapse text-[13px]">
                    <tbody>
                      {visiblePlanets.map((p) => (
                        <tr key={p.key} className="border-b border-divider/70">
                          <td className="py-1.5 text-primary font-medium">
                            {p.nameZh}
                            {p.retrograde && (
                              <span className="ml-1 font-mono-num text-[13px] text-danger">R</span>
                            )}
                          </td>
                          <td className="py-1.5 font-mono-num text-accent-bright">{p.formatted}</td>
                          <td className="py-1.5 text-right text-muted">第 {p.house} 宫</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {chart.natal.planets.length > 6 && (
                    <button
                      type="button"
                      onClick={() => setShowAll((v) => !v)}
                      className="no-print mt-2 bg-transparent border-0 p-0 text-[13px] text-accent hover:text-accent-bright cursor-pointer"
                    >
                      {showAll ? '收起部分星体' : `查看全部 ${chart.natal.planets.length} 颗星体与相位`}
                    </button>
                  )}
                </div>
              </div>

              {showAll && chart.natal.aspects.length > 0 && (
                <div className="pt-3 border-t border-divider">
                  <p className="m-0 mb-2 text-[13px] font-medium text-muted">主要相位</p>
                  <div className="flex flex-wrap gap-1.5">
                    {chart.natal.aspects.slice(0, 10).map((asp, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-1 rounded-[6px] border border-border bg-panel-2 font-mono-num text-[13px] text-secondary"
                      >
                        {asp.pointA} {asp.aspect} {asp.pointB} ({asp.orb}°)
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === 'transits' && chart.transits && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-[13px] text-muted">
                未来 {chart.transits.windowMonths} 个月主要行运相位事件
              </p>
              <div className="flex flex-col gap-1.5">
                {chart.transits.events.slice(0, 10).map((ev, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-[8px] border border-border bg-panel-2 text-[13px]"
                  >
                    <span className="font-mono-num text-accent-bright shrink-0">{ev.date}</span>
                    <span className="text-primary truncate">
                      {ev.transitPlanet} {ev.aspect} {ev.natalPoint}
                    </span>
                    <span className="font-mono-num text-muted shrink-0">{ev.orb}°</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'eastern' && (
            <div className="flex flex-col gap-4">
              {chart.bazi && (
                <div>
                  <p className="m-0 mb-2 text-[13px] font-medium text-muted">
                    八字四柱 · 真太阳时 {chart.bazi.trueSolarTime} · 日主 {chart.bazi.dayMaster}
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {chart.bazi.pillars.map((pil) => (
                      <div
                        key={pil.name}
                        className="p-2 rounded-[8px] border border-border bg-panel-2 text-center"
                      >
                        <div className="text-[13px] text-muted">{pil.name}</div>
                        <div className="font-serif-sc text-[15px] font-bold text-accent-bright">
                          {pil.ganZhi}
                        </div>
                        <div className="text-[13px] text-secondary">{pil.tenGod}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {chart.ziwei && (
                <div className="pt-2 border-t border-divider">
                  <p className="m-0 mb-2 text-[13px] font-medium text-muted">
                    紫微斗数 · {chart.ziwei.fiveElementsClass} · 命主 {chart.ziwei.soulStar} · 身主 {chart.ziwei.bodyStar}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {chart.ziwei.palaces.slice(0, 6).map((pal) => (
                      <div
                        key={pal.name}
                        className="p-2 rounded-[8px] border border-border bg-panel-2 text-[13px]"
                      >
                        <div className="font-bold text-primary">
                          {pal.name}（{pal.earthlyBranch}）
                        </div>
                        <div className="text-accent-bright truncate">
                          {pal.majorStars.map((s) => s.name).join('、') || '空宫'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
