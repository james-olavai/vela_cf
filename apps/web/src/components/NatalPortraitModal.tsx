import { useState } from 'react';
import type { ProfileRecord } from '@vela-cf/shared';
import { computePortraitSummary, scoreColor, sunriseImageUrl, type CalendarDay } from '../lib/portrait';
import type { ChartSnapshot } from '../lib/store';
import { ElementRadar } from './ElementRadar';
import { IconGift, IconSparkles } from './Icons';

interface NatalPortraitModalProps {
  open: boolean;
  profile: ProfileRecord | null;
  chart: ChartSnapshot | null;
  onClose: () => void;
  onOpenShare: () => void;
}

const ELEM_META = [
  { key: 'fire' as const, label: '火相 · 直觉爆发', color: '#f87171' },
  { key: 'earth' as const, label: '土相 · 务实构建', color: '#34d399' },
  { key: 'air' as const, label: '风相 · 心智洞察', color: '#60a5fa' },
  { key: 'water' as const, label: '水相 · 情感共鸣', color: '#a78bfa' },
];

export function NatalPortraitModal({ open, profile, chart, onClose, onOpenShare }: NatalPortraitModalProps) {
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null);
  if (!open || !profile) return null;

  const summary = chart?.natal ? computePortraitSummary(chart.natal) : null;
  const imgUrl = summary ? sunriseImageUrl(summary.sunSign, summary.ascSign, profile.gender) : '';

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="natal-portrait-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-[740px] max-h-[90dvh] rounded-[18px] border border-[#26304d] bg-gradient-to-b from-[#0f1424] via-[#0b0e1b] to-[#070913] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <span className="text-[#e0b64a] flex items-center"><IconSparkles size={18} /></span>
            <h2 id="natal-portrait-title" className="m-0 font-serif-sc text-[18px] font-bold text-[#f8fafc]">
              {profile.name} 的星盘能量画像
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭个人星盘画像" className="min-h-[34px] min-w-[34px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 sm:p-6 flex flex-col gap-5">
          {!summary ? (
            <div className="py-12 text-center text-[14px] text-[#c3cde0]">正在根据出生档案自动生成星盘画像…</div>
          ) : (
            <>
              <div className="text-center">
                <div className="font-serif-sc text-[24px] sm:text-[28px] font-black text-[#f7d57f]">「{summary.archetype}」</div>
                <p className="m-0 mt-1.5 text-[13px] text-[#c3cde0]">{summary.insight}</p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 flex flex-col md:flex-row items-center gap-6">
                {imgUrl && (
                  <div className="relative shrink-0">
                    <img
                      src={imgUrl}
                      alt={`${summary.sunSign}日升${summary.ascSign}`}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      className="h-[280px] w-[176px] sm:h-[320px] sm:w-[200px] object-cover rounded-2xl border border-amber-500/35 shadow-[0_8px_28px_rgba(232,184,77,0.18)]"
                    />
                    <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-amber-500/35 bg-[#070812]/90 px-3 py-0.5 text-[11px] font-semibold text-amber-200">
                      ☀️ {summary.sunSign} · ⬆️ {summary.ascSign}
                    </div>
                  </div>
                )}

                <div className="flex-1 min-w-0 w-full flex flex-col items-center gap-3">
                  <ElementRadar elements={summary.elements} size={156} />
                  <div className="grid w-full max-w-[300px] grid-cols-2 gap-2 text-[11px]">
                    {ELEM_META.map((m) => (
                      <div key={m.key} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5 flex flex-col gap-1">
                        <div className="flex justify-between">
                          <span style={{ color: m.color }}>{m.label.slice(0, 2)}</span>
                          <span className="font-mono-num text-[#cbd5e1]">{summary.elements[m.key]}%</span>
                        </div>
                        <div className="h-1 rounded-full bg-white/10 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${Math.max(6, summary.elements[m.key])}%`, background: m.color }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="text-[11px] text-[#9aa8c7]">
                    形态分布：基本 {summary.modalities.cardinal}% · 固定 {summary.modalities.fixed}% · 变动 {summary.modalities.mutable}%
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                {[
                  { label: '☀️ 太阳 · 内在核心', val: summary.sunSign, color: 'text-amber-300' },
                  { label: '🌙 月亮 · 情感内核', val: summary.moonSign, color: 'text-indigo-200' },
                  { label: '⬆️ 上升 · 外在形象', val: summary.ascSign, color: 'text-purple-200' },
                ].map((x) => (
                  <div key={x.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
                    <div className="text-[10.5px] text-[#9aa8c7]">{x.label}</div>
                    <div className={`mt-1 font-serif-sc text-[17px] font-bold ${x.color}`}>{x.val}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5 flex flex-col gap-2">
                  <div className="text-[11.5px] font-semibold text-[#e2e8f0]">✦ 能量最盛的星座</div>
                  {summary.signEnergy.map((s, i) => (
                    <div key={s.sign} className="flex items-center gap-2 text-[12px]">
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[10px] font-bold">
                        {i === 0 ? '领军' : i === 1 ? '次席' : '辅佐'}
                      </span>
                      <span className="w-12 font-semibold text-[#f8fafc]">{s.sign}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div className="h-full rounded-full bg-[#e8b84d]" style={{ width: `${Math.min(100, s.pct * 2.5)}%` }} />
                      </div>
                      <span className="font-mono-num text-amber-300">{s.pct}%</span>
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5 flex flex-col gap-2">
                  <div className="text-[11.5px] font-semibold text-[#e2e8f0]">✦ 主导行星影响力</div>
                  {summary.dominantPlanets.map((p) => (
                    <div key={p.name} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[12px]">
                      <span className="text-[#f8fafc]">{p.name} · <span className="text-[#9aa8c7]">{p.sign}</span></span>
                      <span className="font-mono-num text-amber-300">{p.weight}× 权重</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-[#f8fafc]">✦ 本月运势能量日历 ({summary.calendar.month})</span>
                  <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] text-amber-300">
                    月均 {summary.calendar.average} 分
                  </span>
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {summary.calendar.days.map((d) => (
                    <button key={d.day} type="button" onClick={() => setSelectedDay(d)} style={{ background: scoreColor(d.score) }} className={`h-7 rounded-md text-[10.5px] font-bold text-black/85 cursor-pointer border-0 ${selectedDay?.day === d.day ? 'ring-2 ring-[#f7d57f]' : ''}`} title={`${summary.calendar.month}-${String(d.day).padStart(2, '0')} (${d.score}分)`}>
                      {d.day}
                    </button>
                  ))}
                </div>
                {selectedDay && (
                  <div className="text-center text-[12px] text-[#c3cde0]">
                    <span className="text-amber-300 font-semibold">{summary.calendar.month}-{String(selectedDay.day).padStart(2, '0')}</span>
                    {' · '}{selectedDay.score} 分{' · '}{selectedDay.phase}
                    {selectedDay.events.length > 0 && <span className="text-purple-300"> 【{selectedDay.events.join('/')}】</span>}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => { onClose(); onOpenShare(); }}
                className="w-full min-h-[44px] rounded-xl border-0 bg-gradient-to-r from-[#f5d77f] via-[#e8b84d] to-[#d19a28] text-[#0d111d] text-[14px] font-bold flex items-center justify-center gap-2 cursor-pointer"
              >
                <IconGift size={16} />
                <span>一键生成能量分享海报（含画像、雷达与运势）</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
