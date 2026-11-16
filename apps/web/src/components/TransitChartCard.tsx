import { useEffect, useState } from 'react';
import type { ProfileRecord } from '@vela-cf/shared';
import { fetchTransitChart, type ChartSnapshot } from '../lib/store';
import { NatalWheelSvg } from './NatalWheelSvg';

interface TransitChartCardProps {
  dateISO: string | null;
  profile: ProfileRecord | null;
}

export function TransitChartCard({ dateISO, profile }: TransitChartCardProps) {
  const [transitChart, setTransitChart] = useState<ChartSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setTransitChart(null); setError(false);
    if (!dateISO || !profile) return;
    let alive = true;
    setLoading(true);
    void fetchTransitChart(profile, dateISO)
      .then((res) => { if (alive) setTransitChart(res); })
      .catch(() => { if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [dateISO, profile?.id, profile?.latitude, profile?.longitude, profile?.timezone, retry]);

  if (!dateISO) {
    return (
      <div className="w-full min-w-0 aspect-square rounded-2xl border border-white/10 bg-white/[0.02] flex flex-col items-center justify-center p-4 text-center text-[13px] text-muted">
        选择日期，查看当地 12:00 的天象盘
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 rounded-2xl border border-border bg-base p-3 flex flex-col items-center gap-1.5">
      <div className="text-[13px] font-semibold text-accent-bright">
        {dateISO} 即时天象{loading ? '（排盘中…）' : ''}
      </div>
      {error && <p role="alert">天象加载失败 <button type="button" onClick={() => setRetry((n) => n + 1)}>重试</button></p>}
      <NatalWheelSvg chart={loading || error ? null : transitChart} className="w-full aspect-square" />
    </div>
  );
}
