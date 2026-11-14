import type { ProfileRecord } from '@vela-cf/shared';
import { computePortraitSummary } from '../lib/portrait';
import type { ChartSnapshot } from '../lib/store';
import { IconGift, IconSparkles } from './Icons';

interface NatalPortraitModalProps {
  open: boolean;
  profile: ProfileRecord | null;
  chart: ChartSnapshot | null;
  onClose: () => void;
  onOpenShare: () => void;
  onAskAboutPortrait: (prompt: string) => void;
}

export function NatalPortraitModal({
  open,
  profile,
  chart,
  onClose,
  onOpenShare,
  onAskAboutPortrait,
}: NatalPortraitModalProps) {
  if (!open || !profile) return null;

  const summary = chart?.natal ? computePortraitSummary(chart.natal) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="natal-portrait-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-[520px] max-h-[88dvh] rounded-[16px] border border-[#26304d] bg-[#101527] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e2740]">
          <div className="flex items-center gap-2.5">
            <span className="text-[#e0b64a] flex items-center">
              <IconSparkles size={19} />
            </span>
            <h2 id="natal-portrait-title" className="m-0 font-serif-sc text-[19px] font-bold text-[#f8fafc]">
              个人星盘画像 · {profile.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭个人星盘画像"
            className="min-h-[34px] min-w-[34px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
          {!summary ? (
            <div className="py-10 text-center text-[14px] text-[#c3cde0]">
              正在根据出生档案自动生成星盘画像…
            </div>
          ) : (
            <>
              <div className="p-4 rounded-[14px] border border-[#e0b64a]/35 bg-gradient-to-br from-[#161d33] to-[#0d1222] flex flex-col gap-2">
                <span className="text-[12px] text-[#f7d57f] font-semibold tracking-wide">
                  {summary.archetype}
                </span>
                <p className="m-0 text-[14px] text-[#f8fafc] leading-relaxed">
                  {summary.insight}
                </p>
                <div className="grid grid-cols-3 gap-2 pt-2">
                  {[
                    { label: '太阳', value: summary.sunSign },
                    { label: '月亮', value: summary.moonSign },
                    { label: '上升', value: summary.ascSign },
                  ].map((item) => (
                    <div key={item.label} className="p-2.5 rounded-[10px] border border-[#26304d] bg-[#0b1020]">
                      <div className="text-[11px] text-[#9aa8c7]">{item.label}</div>
                      <div className="font-serif-sc text-[15px] font-bold text-[#f7d57f]">{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 rounded-[12px] border border-[#26304d] bg-[#161d33] flex flex-col gap-3">
                <div className="text-[13px] font-semibold text-[#f8fafc]">四元素能量分布</div>
                {[
                  { label: '火象（行动力）', val: summary.elements.fire },
                  { label: '土象（落地感）', val: summary.elements.earth },
                  { label: '风象（思辨力）', val: summary.elements.air },
                  { label: '水象（共情力）', val: summary.elements.water },
                ].map((el) => (
                  <div key={el.label} className="flex flex-col gap-1">
                    <div className="flex justify-between text-[12px] text-[#c3cde0]">
                      <span>{el.label}</span>
                      <span className="font-mono-num text-[#f7d57f]">{el.val}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[#0b1020] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#b88928] to-[#f7d57f]"
                        style={{ width: `${el.val}%` }}
                      />
                    </div>
                  </div>
                ))}
                <div className="pt-1 text-[12px] text-[#9aa8c7]">
                  行为模式：开创 {summary.modalities.cardinal}% · 固定 {summary.modalities.fixed}% · 变动 {summary.modalities.mutable}%
                </div>
              </div>
            </>
          )}

          <div className="flex flex-col sm:flex-row gap-2.5">
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenShare();
              }}
              className="flex-1 min-h-[42px] px-4 rounded-[10px] border border-[#e0b64a]/60 bg-[#1d1a0f] text-[#f7d57f] text-[13.5px] font-semibold hover:bg-[#2a2413] flex items-center justify-center gap-2 cursor-pointer"
            >
              <IconGift size={16} />
              <span>分享我的星盘卡片</span>
            </button>
            <button
              type="button"
              disabled={!summary}
              onClick={() => {
                onClose();
                onAskAboutPortrait(
                  `请结合我「太阳${summary?.sunSign}、月亮${summary?.moonSign}、上升${summary?.ascSign}」的个人星盘画像，聊聊我现在最值得发挥的天赋与需要注意的盲区。`,
                );
              }}
              className="flex-1 min-h-[42px] px-4 rounded-[10px] border-0 bg-[#e0b64a] text-[#0d111d] text-[13.5px] font-bold hover:bg-[#f7d57f] disabled:opacity-50 cursor-pointer"
            >
              基于画像开启咨询
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
