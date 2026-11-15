import { useMemo, useState } from 'react';
import type { ProfileRecord } from '@vela-cf/shared';
import { computePortraitSummary, sunriseImageUrl } from '../lib/portrait';
import type { ChartSnapshot } from '../lib/store';
import { Modal } from './Modal';
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
  const [selectedDate, setSelectedDate] = useState('');
  const summary = useMemo(() => chart?.natal ? computePortraitSummary(chart.natal) : null, [chart?.natal]);
  if (!profile) return null;
  const imgUrl = summary ? sunriseImageUrl(summary.sunSign, summary.ascSign, profile.gender) : '';
  const month = (selectedDate || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const firstWeekday = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();

  return (
    <Modal open={open} onClose={onClose} labelledBy="natal-portrait-title" className="w-[calc(100%_-_2rem)] max-w-[780px]">
      <div className="w-full max-w-[780px] max-h-[90dvh] rounded-[18px] border border-amber-500/20 bg-gradient-to-b from-[#0f1424] via-[#0b0e1b] to-[#070913] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 sm:px-6 py-4 border-b border-white/10">
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-amber-400 flex items-center"><IconSparkles size={18} /></span>
            <h2 id="natal-portrait-title" className="m-0 min-w-0 [overflow-wrap:anywhere] font-serif-sc text-[17px] font-bold text-[#f8fafc]">
              {profile.name} 的星盘能量画像
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭个人星盘画像" className="shrink-0 min-h-[44px] min-w-[44px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer">
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-6 flex flex-col gap-5">
          {!summary ? (
            <div className="py-12 text-center text-[14px] text-[#c3cde0]">正在根据出生档案自动生成星盘画像…</div>
          ) : (
            <>
              <div className="text-center">
                <h3 className="m-0 font-serif-sc leading-tight text-[26px] sm:text-[30px] font-black tracking-wider text-[#f7d57f]">
                  「{summary.epithet}」
                </h3>
                <div className="mt-1 flex items-center justify-center gap-2 text-[13px] text-[#9aa8c7]">
                  <span>✦</span><span>核心原型：{summary.archetype}</span><span>✦</span>
                </div>
              </div>

              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-5">
                <div className="flex flex-col-reverse md:flex-row items-center justify-center gap-7">
                  {imgUrl && (
                    <div className="relative shrink-0">
                      <img
                        src={imgUrl} width={210} height={340}
                        alt={`${summary.sunSign}日升${summary.ascSign}`}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        className="h-[300px] w-[186px] sm:h-[340px] sm:w-[210px] object-cover rounded-2xl border border-amber-500/35 shadow-[0_8px_32px_rgba(232,184,77,0.18)]"
                      />
                      <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-amber-500/35 bg-[#070812]/90 px-3 py-0.5 text-[13px] font-semibold text-amber-200">
                        ☀️ {summary.sunSign} · ⬆️ {summary.ascSign}
                      </div>
                    </div>
                  )}

                  <div className="flex-1 min-w-0 w-full flex flex-col items-center gap-3">
                    <ElementRadar elements={summary.elements} size={154} />
                    <div className="grid w-full max-w-[290px] grid-cols-2 gap-2 text-[13px]">
                      {ELEM_META.map((m) => (
                        <div key={m.key} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5 flex flex-col gap-1">
                          <div className="flex justify-between">
                            <span style={{ color: m.color }}>{m.label}</span>
                            <span className="font-mono-num text-[#cbd5e1]">{summary.elements[m.key]}%</span>
                          </div>
                          <div className="h-1 rounded-full bg-white/10 overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${summary.elements[m.key]}%`, background: m.color }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="text-[13px] text-[#9aa8c7]">
                      形态分布：基本 {summary.modalities.cardinal}% · 固定 {summary.modalities.fixed}% · 变动 {summary.modalities.mutable}%
                    </div>
                  </div>
                </div>
                <div className="mt-3.5 border-t border-white/[0.06] pt-2.5 text-center text-[13px] text-[#cbd5e1]">
                  {summary.elementTraits.join('  ·  ')}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {[
                  { label: '☀️ 太阳 · 内在核心', val: summary.sunSign, desc: '本我意志 · 核心追求', color: 'text-amber-300' },
                  { label: '🌙 月亮 · 情感内核', val: summary.moonSign, desc: '潜意识 · 心灵归宿', color: 'text-indigo-200' },
                  { label: '⬆️ 上升 · 外在形象', val: summary.ascSign, desc: '人格面具 · 处世之道', color: 'text-purple-200' },
                ].map((x) => (
                  <div key={x.label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-center">
                    <div className="text-[13px] text-[#9aa8c7]">{x.label}</div>
                    <div className={`my-1 font-serif-sc text-[18px] font-bold ${x.color}`}>{x.val}</div>
                    <div className="text-[13px] text-slate-500">{x.desc}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3.5 flex flex-col gap-2">
                  <div className="text-[13px] font-semibold text-[#e2e8f0]">✦ 能量最盛的星座</div>
                  {summary.signEnergy.map((s, i) => (
                    <div key={s.sign} className="flex items-center gap-2 text-[13px]">
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[13px] font-bold">
                        {i === 0 ? '领军' : i === 1 ? '次席' : '辅佐'}
                      </span>
                      <span className="w-12 font-semibold text-[#f8fafc]">{s.sign}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div className="h-full rounded-full bg-[#e8b84d]" style={{ width: `${s.pct}%` }} />
                      </div>
                      <span className="font-mono-num text-amber-300">{s.pct}%</span>
                    </div>
                  ))}
                </div>

                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3.5 flex flex-col gap-2">
                  <div className="text-[13px] font-semibold text-[#e2e8f0]">✦ 主导行星影响力</div>
                  {summary.dominantPlanets.map((p) => (
                    <div key={p.name} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[13px]">
                      <span className="text-[#f8fafc]">{p.name} · <span className="text-[#9aa8c7]">{p.sign}</span></span>
                      <span className="font-mono-num text-amber-300">{p.weight}× 权重</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border-l-2 border-amber-400/80 border-y border-r border-white/[0.08] bg-gradient-to-r from-amber-500/[0.08] via-purple-500/[0.03] to-transparent p-3.5">
                <div className="text-[13px] font-semibold text-amber-300 mb-1">✨ 能量格局深度洞察</div>
                <p className="m-0 text-[13px] leading-relaxed text-[#cbd5e1]">{summary.insight}</p>
              </div>

              <section className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3 sm:p-4 flex flex-col gap-3">
                <h3 className="m-0 text-[14px] text-[#f8fafc]">✦ 指定日期天象盘 · {month}</h3>
                <div className="flex flex-col md:flex-row items-center justify-center gap-6">
                  <div className="w-full max-w-[320px] min-w-0 flex flex-col gap-3">
                    <label htmlFor="transit-date" className="text-[13px] text-[#c3cde0]">日期（出生地时区，当地 12:00）</label>
                    <input id="transit-date" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="w-full min-w-0 rounded-[10px] border border-border-strong bg-base px-2 text-primary" />
                    <div className="grid grid-cols-7 gap-1">
                      {['一', '二', '三', '四', '五', '六', '日'].map((w) => <span key={w} className="text-center text-[13px] text-muted">{w}</span>)}
                      {Array.from({ length: firstWeekday }, (_, i) => <span key={`blank-${i}`} />)}
                      {Array.from({ length: days }, (_, i) => {
                        const date = `${month}-${String(i + 1).padStart(2, '0')}`;
                        return <button key={date} type="button" aria-label={`查看 ${date} 天象`} aria-pressed={selectedDate === date} onClick={() => setSelectedDate(date)} className={`min-w-0 rounded-lg border-0 text-[13px] cursor-pointer ${selectedDate === date ? 'bg-accent text-on-accent' : 'bg-panel-2 text-primary hover:bg-selected'}`}>{i + 1}</button>;
                      })}
                    </div>
                  </div>
                  {open && selectedDate ? <TransitChartCard dateISO={selectedDate} profile={profile} /> : <p className="max-w-[240px] text-[13px] text-muted">选择日期查看当天真实天象盘</p>}
                </div>
              </section>
              <p className="m-0 text-[13px] text-[#9aa8c7]">以上为星座象征性描述。元素与模式按星体等权统计；星座权重为日月各 3、金水火各 2、其余各 1，第 1 或第 10 宫行星另加 0.5。这是展示排序规则，不是运势评分。</p>

              <button type="button" onClick={() => { onClose(); onOpenShare(); }} className="w-full min-h-[44px] rounded-xl border-0 bg-gradient-to-r from-[#f5d77f] via-[#e8b84d] to-[#d19a28] text-[#0d111d] text-[14px] font-bold flex items-center justify-center gap-2 cursor-pointer">
                <IconGift size={16} />
                <span>一键生成能量分享海报（含插画与雷达）</span>
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
