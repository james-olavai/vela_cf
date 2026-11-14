import { useState } from 'react';
import type { ProfileRecord } from '@vela-cf/shared';
import { computePortraitSummary, scoreColor, sunriseImageUrl, type CalendarDay } from '../lib/portrait';
import type { ChartSnapshot } from '../lib/store';
import { ElementRadar } from './ElementRadar';
import { IconGift, IconSparkles } from './Icons';
import { TransitChartCard } from './TransitChartCard';

interface NatalPortraitModalProps {
  open: boolean;
  profile: ProfileRecord | null;
  chart: ChartSnapshot | null;
  onClose: () => void;
  onOpenShare: () => void;
}

const ELEM_META = [
  { key: 'fire' as const, label: '火相', color: '#f87171' },
  { key: 'earth' as const, label: '土相', color: '#34d399' },
  { key: 'air' as const, label: '风相', color: '#60a5fa' },
  { key: 'water' as const, label: '水相', color: '#a78bfa' },
];

export function NatalPortraitModal({ open, profile, chart, onClose, onOpenShare }: NatalPortraitModalProps) {
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null);
  if (!open || !profile) return null;

  const summary = chart?.natal ? computePortraitSummary(chart.natal) : null;
  const imgUrl = summary ? sunriseImageUrl(summary.sunSign, summary.ascSign, profile.gender) : '';
  const activeDay = selectedDay ?? summary?.calendar.days[new Date().getUTCDate() - 1] ?? null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="natal-portrait-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-[780px] max-h-[90dvh] rounded-[18px] border border-amber-500/20 bg-gradient-to-b from-[#0f1424] via-[#0b0e1b] to-[#070913] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 flex items-center"><IconSparkles size={18} /></span>
            <h2 id="natal-portrait-title" className="m-0 font-serif-sc text-[17px] font-bold text-[#f8fafc]">
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
                <div className="font-serif-sc text-[26px] sm:text-[30px] font-black tracking-wider text-[#f7d57f]">
                  「{summary.epithet}」
                </div>
                <div className="mt-1 flex items-center justify-center gap-2 text-[11.5px] text-[#9aa8c7]">
                  <span>✦</span><span>核心原型：{summary.archetype}</span><span>✦</span>
                </div>
              </div>

              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-5">
                <div className="flex flex-col-reverse md:flex-row items-center justify-center gap-7">
                  {imgUrl && (
                    <div className="relative shrink-0">
                      <img
                        src={imgUrl}
                        alt={`${summary.sunSign}日升${summary.ascSign}`}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        className="h-[300px] w-[186px] sm:h-[340px] sm:w-[210px] object-cover rounded-2xl border border-amber-500/35 shadow-[0_8px_32px_rgba(232,184,77,0.18)]"
                      />
                      <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-amber-500/35 bg-[#070812]/90 px-3 py-0.5 text-[11px] font-semibold text-amber-200">
                        ☀️ {summary.sunSign} · ⬆️ {summary.ascSign}
                      </div>
                    </div>
                  )}

                  <div className="flex-1 min-w-0 w-full flex flex-col items-center gap-3">
                    <ElementRadar elements={summary.elements} size={154} />
                    <div className="grid w-full max-w-[290px] grid-cols-2 gap-2 text-[11px]">
                      {ELEM_META.map((m) => (
                        <div key={m.key} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5 flex flex-col gap-1">
                          <div className="flex justify-between">
                            <span style={{ color: m.color }}>{m.label}</span>
                            <span className="font-mono-num text-[#cbd5e1]">{summary.elements[m.key]}%</span>
                          </div>
                          <div className="h-1 rounded-full bg-white/10 overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${Math.max(6, summary.elements[m.key])}%`, background: m.color }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="text-[10.5px] text-[#9aa8c7]">
                      形态分布：基本 {summary.modalities.cardinal}% · 固定 {summary.modalities.fixed}% · 变动 {summary.modalities.mutable}%
                    </div>
                  </div>
                </div>
                <div className="mt-3.5 border-t border-white/[0.06] pt-2.5 text-center text-[11.5px] text-[#cbd5e1]">
                  {summary.elementTraits.join('  ·  ')}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                {[
                  { label: '☀️ 太阳 · 内在核心', val: summary.sunSign, desc: '本我意志 · 核心追求', color: 'text-amber-300' },
                  { label: '🌙 月亮 · 情感内核', val: summary.moonSign, desc: '潜意识 · 心灵归宿', color: 'text-indigo-200' },
                  { label: '⬆️ 上升 · 外在形象', val: summary.ascSign, desc: '人格面具 · 处世之道', color: 'text-purple-200' },
                ].map((x) => (
                  <div key={x.label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-center">
                    <div className="text-[10.5px] text-[#9aa8c7]">{x.label}</div>
                    <div className={`my-1 font-serif-sc text-[18px] font-bold ${x.color}`}>{x.val}</div>
                    <div className="text-[10px] text-slate-500">{x.desc}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3.5 flex flex-col gap-2">
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

                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3.5 flex flex-col gap-2">
                  <div className="text-[11.5px] font-semibold text-[#e2e8f0]">✦ 主导行星影响力</div>
                  {summary.dominantPlanets.map((p) => (
                    <div key={p.name} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[12px]">
                      <span className="text-[#f8fafc]">{p.name} · <span className="text-[#9aa8c7]">{p.sign}</span></span>
                      <span className="font-mono-num text-amber-300">{p.weight}× 权重</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border-l-2 border-amber-400/80 border-y border-r border-white/[0.08] bg-gradient-to-r from-amber-500/[0.08] via-purple-500/[0.03] to-transparent p-3.5">
                <div className="text-[11.5px] font-semibold text-amber-300 mb-1">✨ 能量格局深度洞察</div>
                <p className="m-0 text-[12px] leading-relaxed text-[#cbd5e1]">{summary.insight}</p>
              </div>

              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-[#f8fafc]">✦ 本月能量日历 ({summary.calendar.month})</span>
                    <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[10.5px] text-amber-300">
                      月均 {summary.calendar.average} 分
                    </span>
                  </div>
                  <span className="text-[10.5px] text-[#9aa8c7]">点击日期查看即时天象盘</span>
                </div>

                <div className="flex flex-col lg:flex-row items-center justify-center gap-6">
                  <div className="flex flex-col items-center">
                    <div className="grid grid-cols-7 gap-1.5">
                      {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
                        <div key={w} className="h-5 w-7 text-center text-[10px] text-slate-500">{w}</div>
                      ))}
                      {summary.calendar.days.map((d) => (
                        <button key={d.day} type="button" onClick={() => setSelectedDay(d)} style={{ background: scoreColor(d.score) }} className={`relative h-7 w-7 rounded-lg text-[10px] font-bold text-black/85 cursor-pointer border-0 ${activeDay?.day === d.day ? 'ring-2 ring-amber-400' : ''}`}>
                          <span>{d.day}</span>
                          {d.events.length > 0 && <span className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white" />}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2.5 flex items-center gap-2 text-[10px] text-slate-500">
                      <span>沉潜蓄力</span>
                      <div className="h-2 w-16 rounded-full bg-gradient-to-r from-[#4a3b5a] via-[#3b5080] via-[#8b7bd8] to-[#e8b84d]" />
                      <span className="text-amber-300">高能峰值</span>
                    </div>
                  </div>
                  <TransitChartCard dateISO={activeDay ? `${summary.calendar.month}-${String(activeDay.day).padStart(2, '0')}` : null} profile={profile} />
                </div>

                {activeDay && (
                  <div className="mx-auto rounded-full border border-amber-500/25 bg-[#070812]/85 px-4 py-1 text-center text-[11.5px] text-[#cbd5e1]">
                    <span className="font-bold text-amber-300">{summary.calendar.month}-{String(activeDay.day).padStart(2, '0')}</span>
                    {' · '}{activeDay.score} 分{' · '}{activeDay.phase}
                    {activeDay.events.length > 0 && <span className="text-purple-300"> 【{activeDay.events.join('/')}】</span>}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-3 text-[11.5px] leading-relaxed text-[#cbd5e1] flex items-start gap-2.5">
                <span className="text-base shrink-0">🌞</span>
                <div>
                  你的太阳年度能量窗口在 <span className="font-bold text-amber-300">{summary.sunSign.slice(0, 2)}季</span>（{summary.sunSign}生日后 30 天）—— 这是你一年中能量最充沛、最适合开启新计划与重大决策的黄金周期。
                </div>
              </div>

              <button type="button" onClick={() => { onClose(); onOpenShare(); }} className="w-full min-h-[44px] rounded-xl border-0 bg-gradient-to-r from-[#f5d77f] via-[#e8b84d] to-[#d19a28] text-[#0d111d] text-[14px] font-bold flex items-center justify-center gap-2 cursor-pointer">
                <IconGift size={16} />
                <span>一键生成能量分享海报（含雷达与日历）</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
