import {
  MAX_MONTHLY_SHARE_BONUSES,
  SHARE_BONUS_MICRO_USD,
  utcMonthPeriodStart,
  type UsageRecord,
  type Tier,
} from '@vela-cf/shared';
import { businessApi, subscribeApi } from './apiClient';

export type ShareClaimMethod = 'native' | 'poster' | 'copy';

export function subscribeUsage(
  uid: string,
  onData: (usage: UsageRecord) => void,
  onError: (error: unknown) => void = console.error,
): () => void {
  return subscribeApi(signal => businessApi<UsageRecord & {tier:Tier}>(uid, '/v1/me/usage', 'GET', undefined, signal).then(value=>({...value,overrideTier:value.tier})), onData, onError);
}

export async function claimDailyShareBonus(
  uid: string,
  shareMethod: ShareClaimMethod = 'poster',
): Promise<UsageRecord> {
  const today = new Date().toISOString().slice(0, 10);
  const currentStart = utcMonthPeriodStart();

  if (import.meta.env.DEV && uid === 'e2e_test_user') {
    const raw = localStorage.getItem('vela_e2e_usage');
    const prev: UsageRecord = raw
      ? (JSON.parse(raw) as UsageRecord)
      : { periodStart: currentStart, used: 0, bonusMicroUsd: 0, shareCount: 0, lastShareDate: '' };
    const reset = String(prev.periodStart ?? '') < currentStart;
    const count = reset ? 0 : (prev.shareCount ?? 0);
    const bonus = reset ? 0 : (prev.bonusMicroUsd ?? 0);
    const lastDate = reset ? '' : (prev.lastShareDate ?? '');
    if (lastDate === today) throw new Error('ALREADY_SHARED_TODAY');
    if (count >= MAX_MONTHLY_SHARE_BONUSES) throw new Error('MONTHLY_SHARE_LIMIT_REACHED');
    const next: UsageRecord = {
      periodStart: currentStart,
      used: reset ? 0 : (prev.used ?? 0),
      bonusMicroUsd: bonus + SHARE_BONUS_MICRO_USD,
      shareCount: count + 1,
      lastShareDate: today,
    };
    localStorage.setItem('vela_e2e_usage', JSON.stringify(next));
    return next;
  }

  return (await businessApi<{usage:UsageRecord}>(uid, '/v1/me/share-claims', 'POST', {shareMethod})).usage;
}
