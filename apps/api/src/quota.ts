import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  computeEffectiveBudget,
  MAX_MONTHLY_SHARE_BONUSES,
  SHARE_BONUS_MICRO_USD,
  TierSchema,
  utcMonthPeriodStart,
  type Tier,
  type UsageRecord,
} from '@vela-cf/shared';

export const DEFAULT_RESERVE_MICRO_USD = 30_000;
export const DEFAULT_RESERVATION_TTL_MS = 120_000;
export type ShareMethod = 'native' | 'poster' | 'copy';

export interface QuotaReservationEntry {
  amount: number;
  expiresAt: number;
}

export async function resolveUserPeriodAndTier(
  db: Firestore,
  uid: string,
  tokenRole?: unknown,
  now = new Date(),
): Promise<{
  tier: Tier;
  periodStart: string;
  unlimited: boolean;
}> {
  const parsed = TierSchema.safeParse(tokenRole);
  let tier: Tier = parsed.success ? parsed.data : 'free';
  let periodStart = utcMonthPeriodStart(now);

  const usageSnap = await db.collection('usage').doc(uid).get();
  const usageData = usageSnap.data();
  const override = TierSchema.safeParse(usageData?.overrideTier);
  if (override.success) tier = override.data;
  const unlimited = usageData?.unlimited === true;

  if (tier !== 'free' && !override.success) {
    const subs = await db
      .collection('customers')
      .doc(uid)
      .collection('subscriptions')
      .where('status', 'in', ['active', 'trialing'])
      .limit(1)
      .get();
    const doc = subs.docs[0]?.data();
    if (doc?.current_period_start) {
      periodStart =
        typeof doc.current_period_start === 'string'
          ? doc.current_period_start
          : new Date(doc.current_period_start.seconds * 1000).toISOString();
    }
  }
  return { tier, periodStart, unlimited };
}

function pruneReservations(
  raw: unknown,
  nowMs: number,
  excludeRequestId?: string,
): Record<string, QuotaReservationEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const next: Record<string, QuotaReservationEntry> = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (id === excludeRequestId) continue;
    const entry = val as Partial<QuotaReservationEntry> | undefined;
    const amount = Number(entry?.amount ?? 0);
    const expiresAt = Number(entry?.expiresAt ?? 0);
    if (amount > 0 && expiresAt > nowMs) {
      next[id] = { amount, expiresAt };
    }
  }
  return next;
}

export async function reserveQuota(
  db: Firestore,
  params: {
    uid: string;
    tier: Tier;
    periodStart: string;
    unlimited: boolean;
    requestId: string;
    reserveMicroUsd?: number;
    now?: Date;
    ttlMs?: number;
  },
): Promise<{ reservedMicroUsd: number; budgetMicroUsd: number }> {
  const {
    uid,
    tier,
    periodStart,
    unlimited,
    requestId,
    reserveMicroUsd = DEFAULT_RESERVE_MICRO_USD,
    now = new Date(),
    ttlMs = DEFAULT_RESERVATION_TTL_MS,
  } = params;
  const nowMs = now.getTime();
  const usageRef = db.collection('usage').doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const data = snap.data();
    const isNewPeriod = !data || String(data.periodStart ?? '') < periodStart;
    const used = isNewPeriod ? 0 : Number(data?.used ?? 0);
    const bonusMicroUsd = isNewPeriod ? 0 : Number(data?.bonusMicroUsd ?? 0);
    const activeReservations = isNewPeriod
      ? {}
      : pruneReservations(data?.reservations, nowMs, requestId);

    const activeReserved = Object.values(activeReservations).reduce((sum, r) => sum + r.amount, 0);
    const inFlightCount = Object.keys(activeReservations).length;
    const budget = computeEffectiveBudget(tier, bonusMicroUsd);

    if (!unlimited) {
      if (
        used >= budget ||
        used + activeReserved >= budget ||
        (inFlightCount > 0 && used + activeReserved + reserveMicroUsd > budget)
      ) {
        throw new HttpsError('resource-exhausted', 'QUOTA_EXCEEDED');
      }
    }

    const nextReservations: Record<string, QuotaReservationEntry> = {
      ...activeReservations,
      [requestId]: {
        amount: reserveMicroUsd,
        expiresAt: nowMs + ttlMs,
      },
    };

    const nextPayload: Record<string, unknown> = {
      periodStart,
      used,
      reservations: nextReservations,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (isNewPeriod) {
      nextPayload.bonusMicroUsd = 0;
      nextPayload.shareCount = 0;
      nextPayload.lastShareDate = '';
    }
    // Replace the reservation map atomically; recursive merge retains removed keys.
    if (snap.exists) tx.update(usageRef, nextPayload);
    else tx.set(usageRef, nextPayload);
    return { reservedMicroUsd: reserveMicroUsd, budgetMicroUsd: budget };
  });
}

export async function settleQuota(
  db: Firestore,
  params: {
    uid: string;
    periodStart: string;
    requestId: string;
    costMicroUsd: number;
    now?: Date;
  },
): Promise<{ used: number }> {
  return db.runTransaction(tx => settleQuotaInTransaction(db, tx, params));
}
export async function settleQuotaInTransaction(db: Firestore, tx: Transaction, params: {
  uid:string;periodStart:string;requestId:string;costMicroUsd:number;now?:Date;
}):Promise<{used:number}> {
  const { uid, periodStart, requestId, costMicroUsd, now = new Date() } = params;
  const nowMs = now.getTime();
  const usageRef = db.collection('usage').doc(uid);

    const snap = await tx.get(usageRef);
    const data = snap.data();
    const reset = !data || String(data.periodStart ?? '') < periodStart;
    const baseUsed = reset ? 0 : Number(data?.used ?? 0);
    const nextReservations = reset ? {} : pruneReservations(data?.reservations, nowMs, requestId);
    const nextUsed = baseUsed + Math.max(0, costMicroUsd);

    const nextPayload: Record<string, unknown> = {
      periodStart,
      used: nextUsed,
      reservations: nextReservations,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (reset) {
      nextPayload.bonusMicroUsd = 0;
      nextPayload.shareCount = 0;
      nextPayload.lastShareDate = '';
    }
    // Replace the reservation map atomically; recursive merge retains removed keys.
    if (snap.exists) tx.update(usageRef, nextPayload);
    else tx.set(usageRef, nextPayload);
    return { used: nextUsed };
}

export async function releaseQuota(
  db: Firestore,
  params: {
    uid: string;
    requestId: string;
    now?: Date;
  },
): Promise<void> {
  const { uid, requestId, now = new Date() } = params;
  const nowMs = now.getTime();
  const usageRef = db.collection('usage').doc(uid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    if (!snap.exists) return;
    const data = snap.data();
    const nextReservations = pruneReservations(data?.reservations, nowMs, requestId);
    tx.update(usageRef, { reservations: nextReservations, updatedAt: FieldValue.serverTimestamp() });
  });
}

export async function claimShareBonus(
  db: Firestore,
  params: {
    uid: string;
    shareMethod?: ShareMethod;
    clientDate?: string;
    now?: Date;
  },
): Promise<UsageRecord> {
  const { uid, shareMethod = 'poster', clientDate, now = new Date() } = params;
  if (!['native', 'poster', 'copy'].includes(shareMethod)) {
    throw new HttpsError('invalid-argument', 'INVALID_SHARE_METHOD');
  }

  const today = now.toISOString().slice(0, 10);
  const currentStart = utcMonthPeriodStart(now);
  if (clientDate !== undefined && clientDate !== today) {
    throw new HttpsError('invalid-argument', 'INVALID_SHARE_DATE');
  }

  const usageRef = db.collection('usage').doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const data = snap.data();
    const isNewPeriod = !snap.exists || !data || String(data.periodStart ?? '') < currentStart;

    const used = isNewPeriod ? 0 : Number(data?.used ?? 0);
    const count = isNewPeriod ? 0 : Number(data?.shareCount ?? 0);
    const bonus = isNewPeriod ? 0 : Number(data?.bonusMicroUsd ?? 0);
    const lastDate = isNewPeriod ? '' : String(data?.lastShareDate ?? '');

    if (lastDate === today) {
      throw new HttpsError('failed-precondition', 'ALREADY_SHARED_TODAY');
    }
    if (count >= MAX_MONTHLY_SHARE_BONUSES) {
      throw new HttpsError('resource-exhausted', 'MONTHLY_SHARE_LIMIT_REACHED');
    }

    const nextBonus = bonus + SHARE_BONUS_MICRO_USD;
    const nextCount = count + 1;
    const nextRecord: UsageRecord = {
      periodStart: currentStart,
      used,
      bonusMicroUsd: nextBonus,
      shareCount: nextCount,
      lastShareDate: today,
    };

    tx.set(
      usageRef,
      {
        ...nextRecord,
        lastShareMethod: shareMethod,
        ...(isNewPeriod ? { reservations: {} } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return nextRecord;
  });
}
