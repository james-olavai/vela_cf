import { useMemo, useState } from 'react';
import type { ProfileRecord } from '@vela-cf/shared';
import { computePortraitSummary, sunriseImageUrl } from '../lib/portrait';
import type { ChartSnapshot } from '../lib/store';
import { Modal } from './Modal';
import { ElementRadar } from './ElementRadar';
import { IconGift } from './Icons';
import { TransitChartCard } from './TransitChartCard';

interface NatalPortraitModalProps {
  open: boolean;
  profile: ProfileRecord | null;
  chart: ChartSnapshot | null;
  onClose: () => void;
  onOpenShare: () => void;
}

const ELEMENTS = { fire: '火相', earth: '土相', air: '风相', water: '水相' } as const;

export function NatalPortraitModal({ open, profile, chart, onClose, onOpenShare }: NatalPortraitModalProps) {
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [transitOpen, setTransitOpen] = useState(false);
  const summary = useMemo(() => chart?.natal ? computePortraitSummary(chart.natal) : null, [chart?.natal]);
  if (!profile) return null;
  const imgUrl = summary ? sunriseImageUrl(summary.sunSign, summary.ascSign, profile.gender) : '';
  return (
    <Modal open={open} onClose={onClose} labelledBy="natal-portrait-title" className="w-[calc(100%_-_2rem)] max-w-[680px]">
      <div className="max-h-[90dvh] rounded-[16px] border border-border bg-panel flex flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-divider">
          <h2 id="natal-portrait-title" className="m-0 min-w-0 text-[17px] font-semibold text-primary [overflow-wrap:anywhere]">{profile.name} 的星盘能量画像</h2>
          <button type="button" onClick={onClose} aria-label="关闭个人星盘画像" className="shrink-0 rounded-[10px] px-3 text-secondary hover:bg-panel-2">✕</button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4 sm:p-6 flex flex-col gap-4 text-[14px] text-secondary">
          {!summary ? <p role="status">正在根据出生档案生成画像…</p> : <>
            <section className="flex items-center gap-4">
              {imgUrl && <img src={imgUrl} width={96} height={128} alt={`${summary.sunSign}日升${summary.ascSign}主题插画`}
                onError={(e) => { e.currentTarget.style.display = 'none'; }} className="w-24 h-32 object-cover rounded-[12px] shrink-0" />}
              <div className="min-w-0">
                <h3 className="m-0 text-[20px] sm:text-[24px] font-serif-sc text-accent-bright">「{summary.epithet}」</h3>
                <p className="my-2 text-[14px]">{summary.archetype}</p>
                <p className="m-0 text-[13px] text-muted">{summary.elementTraits.join(' · ')}</p>
              </div>
            </section>
            <dl className="m-0 grid grid-cols-3 gap-2">
              {[['太阳', summary.sunSign], ['月亮', summary.moonSign], ['上升', summary.ascSign]].map(([label, sign]) => (
                <div key={label} className="rounded-[12px] border border-border bg-base p-3 text-center">
                  <dt className="text-[13px] text-muted">{label}</dt><dd className="m-0 mt-1 font-serif-sc text-[18px] text-primary">{sign}</dd>
                </div>
              ))}
            </dl>
            <p className="m-0 leading-relaxed">{summary.insight}</p>
            <p className="m-0 text-[13px] text-muted">以上为星座象征性描述，展开下方查看分布与计算口径。</p>
            <details className="rounded-[12px] border border-border px-4">
              <summary className="min-h-11 py-3 cursor-pointer font-medium text-primary">元素与模式分布</summary>
              <div className="pb-4 flex flex-col sm:flex-row items-center gap-4">
                <ElementRadar elements={summary.elements} size={180} />
                <dl className="m-0 grid grid-cols-2 gap-x-5 gap-y-2">
                  {Object.entries(ELEMENTS).map(([key, label]) => <div key={key}><dt>{label}</dt><dd className="m-0 font-mono-num text-primary">{summary.elements[key as keyof typeof ELEMENTS]}%</dd></div>)}
                </dl>
              </div>
              <p className="mt-0 text-[13px] text-muted">按盘中各星体等权计数并四舍五入；基本 {summary.modalities.cardinal}% · 固定 {summary.modalities.fixed}% · 变动 {summary.modalities.mutable}%。</p>
            </details>
            <details className="rounded-[12px] border border-border px-4">
              <summary className="min-h-11 py-3 cursor-pointer font-medium text-primary">星座与行星权重</summary>
              <dl className="m-0 flex flex-col gap-2">
                {summary.signEnergy.map((s) => <div key={s.sign} className="flex justify-between gap-3"><dt>{s.sign}</dt><dd className="m-0 font-mono-num text-primary">{s.pct}%</dd></div>)}
              </dl>
              <p className="text-[13px] text-muted">星座占比以太阳、月亮各 3 份，水星、金星、火星各 2 份，其余各 1 份计算；此处显示前三位。</p>
              <dl className="m-0 flex flex-col gap-2">
                {summary.dominantPlanets.map((p) => <div key={p.name} className="flex justify-between gap-3"><dt>{p.name} · {p.sign}</dt><dd className="m-0 font-mono-num text-primary">{p.weight}×</dd></div>)}
              </dl>
              <p className="text-[13px] text-muted">行星权重在上述基础上，第 1 或第 10 宫加 0.5；这是展示排序规则，不是预测准确率或运势评分。</p>
            </details>
            <details className="rounded-[12px] border border-border px-4" onToggle={(e) => setTransitOpen(e.currentTarget.open)}>
              <summary className="min-h-11 py-3 cursor-pointer font-medium text-primary">指定日期天象盘</summary>
              <div className="pb-4 flex flex-col items-center gap-3">
                <label htmlFor="transit-date">日期（出生地时区，当地 12:00）</label>
                <input id="transit-date" type="date" required value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="w-full min-w-0 rounded-[10px] border border-border-strong bg-base px-3" />
                {open && transitOpen && <TransitChartCard dateISO={selectedDate || null} profile={profile} />}
              </div>
            </details>
            <button type="button" onClick={() => { onClose(); onOpenShare(); }} className="w-full rounded-[12px] border-0 bg-accent py-3 text-[14px] font-semibold text-on-accent flex items-center justify-center gap-2 hover:bg-accent-bright">
              <IconGift size={16} />生成星盘画像分享海报
            </button>
          </>}
        </div>
      </div>
    </Modal>
  );
}
