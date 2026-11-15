import { doc, onSnapshot, runTransaction } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  MAX_MONTHLY_SHARE_BONUSES,
  SHARE_BONUS_MICRO_USD,
  TierSchema,
  utcMonthPeriodStart,
  type UsageRecord,
} from '@vela-cf/shared';
import { db, functions, handleFirestoreError, OperationType } from './firebase';

export type ShareClaimMethod = 'native' | 'poster' | 'copy';

export function subscribeUsage(
  uid: string,
  onData: (usage: UsageRecord) => void,
): () => void {
  const path = `usage/${uid}`;
  return onSnapshot(
    doc(db, 'usage', uid),
    (snap) => {
      const currentStart = utcMonthPeriodStart();
      if (!snap.exists()) {
        onData({ periodStart: currentStart, used: 0, bonusMicroUsd: 0, shareCount: 0, lastShareDate: '' });
        return;
      }
      const raw = snap.data() as Partial<UsageRecord>;
      const periodStart = String(raw.periodStart ?? currentStart);
      const unlimited = raw.unlimited === true;
      const parsedOverride = TierSchema.safeParse(raw.overrideTier);
      const overrideFields: Partial<UsageRecord> = {
        ...(unlimited ? { unlimited: true } : {}),
        ...(parsedOverride.success ? { overrideTier: parsedOverride.data } : {}),
      };
      if (periodStart < currentStart) {
        onData({
          periodStart: currentStart,
          used: 0,
          bonusMicroUsd: 0,
          shareCount: 0,
          lastShareDate: '',
          ...overrideFields,
        });
        return;
      }
      onData({
        periodStart,
        used: Number(raw.used ?? 0),
        bonusMicroUsd: Number(raw.bonusMicroUsd ?? 0),
        shareCount: Number(raw.shareCount ?? 0),
        lastShareDate: String(raw.lastShareDate ?? ''),
        ...overrideFields,
      });
    },
    (err) => handleFirestoreError(err, OperationType.GET, path),
  );
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

  try {
    const fn = httpsCallable<
      { action: 'claimShareBonus'; shareMethod: ShareClaimMethod },
      { usage: UsageRecord }
    >(functions, 'exportUserData');
    const res = await fn({ action: 'claimShareBonus', shareMethod });
    if (res.data?.usage) return res.data.usage;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (msg.includes('ALREADY_SHARED_TODAY')) throw new Error('ALREADY_SHARED_TODAY');
    if (msg.includes('MONTHLY_SHARE_LIMIT_REACHED')) throw new Error('MONTHLY_SHARE_LIMIT_REACHED');
  }

  const ref = doc(db, 'usage', uid);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      const next: UsageRecord = {
        periodStart: currentStart,
        used: 0,
        bonusMicroUsd: SHARE_BONUS_MICRO_USD,
        shareCount: 1,
        lastShareDate: today,
      };
      tx.set(ref, { ...next, lastShareMethod: shareMethod });
      return next;
    }
    const data = snap.data() as Partial<UsageRecord>;
    const isNewPeriod = String(data.periodStart ?? '') < currentStart;
    const count = isNewPeriod ? 0 : Number(data.shareCount ?? 0);
    const bonus = isNewPeriod ? 0 : Number(data.bonusMicroUsd ?? 0);
    const used = isNewPeriod ? 0 : Number(data.used ?? 0);
    const lastDate = isNewPeriod ? '' : String(data.lastShareDate ?? '');
    if (lastDate === today) throw new Error('ALREADY_SHARED_TODAY');
    if (count >= MAX_MONTHLY_SHARE_BONUSES) throw new Error('MONTHLY_SHARE_LIMIT_REACHED');

    const nextBonus = bonus + SHARE_BONUS_MICRO_USD;
    const nextCount = count + 1;
    if (isNewPeriod) {
      tx.update(ref, {
        periodStart: currentStart,
        used: 0,
        bonusMicroUsd: nextBonus,
        shareCount: nextCount,
        lastShareDate: today,
        lastShareMethod: shareMethod,
      });
    } else {
      tx.update(ref, {
        bonusMicroUsd: nextBonus,
        shareCount: nextCount,
        lastShareDate: today,
        lastShareMethod: shareMethod,
      });
    }
    return {
      periodStart: currentStart,
      used,
      bonusMicroUsd: nextBonus,
      shareCount: nextCount,
      lastShareDate: today,
    };
  });
}
