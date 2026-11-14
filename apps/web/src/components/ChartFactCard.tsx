import { useState } from 'react';
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

export function ChartFactCard({
  chart,
  profileName,
  birthSummary,
  defaultExpanded = false,
}: ChartFactCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);

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
    <div className="print-only-clean rounded-[14px] border border-[#26304d] bg-[#101527] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#1e2740]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1d1a0f] border border-[#e0b64a]/60 text-[11px] text-[#f7d57f]">
            ✓
          </span>
          <div className="min-w-0">
            <p className="m-0 text-[14px] font-bold text-[#f8fafc] truncate">
              星盘事实 · {profileName}
            </p>
            <p className="m-0 font-mono-num text-[12px] text-[#a3b0c5] truncate">
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
            className="min-h-[34px] px-2.5 rounded-[8px] border border-[#26304d] bg-transparent text-[12px] text-[#c3cde0] hover:border-[#3a4668] hover:text-[#f8fafc] cursor-pointer"
          >
            {copied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-[34px] px-2.5 rounded-[8px] border border-[#26304d] bg-transparent text-[12px] text-[#c3cde0] hover:border-[#3a4668] hover:text-[#f8fafc] cursor-pointer"
          >
            打印
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="min-h-[34px] px-3 rounded-[8px] border border-[#e0b64a]/50 bg-[#1d1a0f] text-[12px] font-medium text-[#f7d57f] hover:border-[#e0b64a] cursor-pointer"
          >
            {expanded ? '收起盘面' : '展开盘面'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="p-4 flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row items-center gap-5">
            <div className="w-[210px] shrink-0">
              <NatalWheelSvg chart={chart} />
            </div>

            <div className="flex-1 w-full min-w-0">
              <div className="flex items-center justify-between text-[12px] text-[#a3b0c5] mb-2">
                <span>{chart.natal.houseSystem} 宫位制</span>
                <span className="font-mono-num text-[#f7d57f]">
                  ASC {chart.natal.ascendant.formatted} · MC {chart.natal.midheaven.formatted}
                </span>
              </div>

              <table className="w-full border-collapse text-[13px]">
                <tbody>
                  {visiblePlanets.map((p) => (
                    <tr key={p.key} className="border-b border-[#1e2740]/70">
                      <td className="py-1.5 text-[#f8fafc] font-medium">
                        {p.nameZh}
                        {p.retrograde && (
                          <span className="ml-1 font-mono-num text-[11px] text-[#ff9d8a]">R</span>
                        )}
                      </td>
                      <td className="py-1.5 font-mono-num text-[#f7d57f]">{p.formatted}</td>
                      <td className="py-1.5 text-right text-[#a3b0c5]">第 {p.house} 宫</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {chart.natal.planets.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="no-print mt-2 bg-transparent border-0 p-0 text-[12px] text-[#e0b64a] hover:text-[#f7d57f] cursor-pointer"
                >
                  {showAll ? '收起部分星体' : `查看全部 ${chart.natal.planets.length} 颗星体与相位`}
                </button>
              )}
            </div>
          </div>

          {showAll && chart.natal.aspects.length > 0 && (
            <div className="pt-3 border-t border-[#1e2740]">
              <p className="m-0 mb-2 text-[12px] font-medium text-[#a3b0c5]">主要相位</p>
              <div className="flex flex-wrap gap-1.5">
                {chart.natal.aspects.slice(0, 10).map((asp, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-1 rounded-[6px] border border-[#26304d] bg-[#161d33] font-mono-num text-[12px] text-[#c3cde0]"
                  >
                    {asp.pointA} {asp.aspect} {asp.pointB} ({asp.orb}°)
                  </span>
                ))}
              </div>
            </div>
          )}

          {chart.bazi && (
            <div className="pt-3 border-t border-[#1e2740]">
              <p className="m-0 mb-2 text-[12px] font-medium text-[#a3b0c5]">
                八字四柱 · 日主 {chart.bazi.dayMaster}
              </p>
              <div className="grid grid-cols-4 gap-2">
                {chart.bazi.pillars.map((pil) => (
                  <div
                    key={pil.name}
                    className="p-2 rounded-[8px] border border-[#26304d] bg-[#161d33] text-center"
                  >
                    <div className="text-[11px] text-[#a3b0c5]">{pil.name}</div>
                    <div className="font-serif-sc text-[15px] font-bold text-[#f7d57f]">
                      {pil.ganZhi}
                    </div>
                    <div className="text-[11px] text-[#c3cde0]">{pil.tenGod}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
