import { useEffect, useState } from 'react';
import type { ProfileRecord } from '@vela-cf/shared';
import { fetchNatalChart, type ChartSnapshot } from '../lib/store';
import { NatalWheelSvg } from './NatalWheelSvg';

interface TransitChartCardProps {
  dateISO: string | null;
  profile: ProfileRecord | null;
}

export function TransitChartCard({ dateISO, profile }: TransitChartCardProps) {
  const [transitChart, setTransitChart] = useState<ChartSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!dateISO || !profile) return;
    let alive = true;
    setLoading(true);
    void fetchNatalChart(null, { ...profile, birthDateTime: `${dateISO}T12:00` })
      .then((res) => { if (alive) setTransitChart(res); })
      .catch(() => { if (alive) setTransitChart(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [dateISO, profile?.id, profile?.latitude, profile?.longitude, profile?.timezone]);

  if (!dateISO) {
    return (
      <div className="w-full max-w-[230px] aspect-square rounded-2xl border border-white/10 bg-white/[0.02] flex flex-col items-center justify-center p-4 text-center text-[11.5px] text-[#9aa8c7]">
        点击左侧任意日期，查看当日 12:00 即时天象盘
      </div>
    );
  }

  return (
    <div className="w-full max-w-[230px] rounded-2xl border border-white/10 bg-[#0b0f1f]/80 p-3 flex flex-col items-center gap-1.5">
      <div className="text-[11px] font-semibold text-amber-300">
        {dateISO} 即时天象{loading ? '（排盘中…）' : ''}
      </div>
      <NatalWheelSvg chart={transitChart} className="w-full max-w-[190px]" />
    </div>
  );
}
