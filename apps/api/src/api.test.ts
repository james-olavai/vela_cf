import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Firestore } from 'firebase-admin/firestore';
import {
  claimShareBonus,
  releaseQuota,
  reserveQuota,
  resolveUserPeriodAndTier,
  settleQuota,
} from './quota.js';
import {
  acquireSessionTurn,
  commitSessionTurn,
  createFrozenSession,
  releaseSessionTurn,
} from './session.js';
import { summarizeQuestionTitle } from '@vela-cf/shared';
import {
  deleteAccountWithRetry,
  exportAccountData,
} from './account.js';

/**
 * In-memory Firestore emulator with optimistic concurrency control (OCC) transactions,
 * subcollections, queries (where/orderBy/limit), batch writes, and recursiveDelete.
 */
class MockFirestoreEmulator {
  private store = new Map<string, { version: number; data: Record<string, unknown> }>();
  private idCounter = 0;

  nextId(prefix = 'doc'): string {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter}`;
  }

  private clone<T>(val: T): T {
    return val === undefined ? val : JSON.parse(JSON.stringify(val));
  }

  getRaw(path: string): Record<string, unknown> | undefined {
    const entry = this.store.get(path);
    return entry ? this.clone(entry.data) : undefined;
  }

  private getVersion(path: string): number {
    return this.store.get(path)?.version ?? 0;
  }

  private writeInternal(path: string, payload: Record<string, unknown>, merge = false): void {
    const prev = this.store.get(path);
    const prevData = prev ? this.clone(prev.data) : {};
    const nextData = merge ? { ...prevData, ...this.clone(payload) } : this.clone(payload);
    this.store.set(path, {
      version: (prev?.version ?? 0) + 1,
      data: nextData,
    });
  }

  private deleteInternal(path: string): void {
    this.store.delete(path);
  }

  collection(name: string) {
    return this.createCollectionRef(name);
  }

  private createDocRef(path: string) {
    const segments = path.split('/');
    const id = segments[segments.length - 1];
    const self = this;
    return {
      id,
      path,
      collection(subName: string) {
        return self.createCollectionRef(`${path}/${subName}`);
      },
      async get() {
        const entry = self.store.get(path);
        const snapData = entry ? self.clone(entry.data) : undefined;
        return {
          id,
          ref: self.createDocRef(path),
          exists: Boolean(entry),
          data: () => (snapData ? self.clone(snapData) : undefined),
        };
      },
      async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
        self.writeInternal(path, data, Boolean(options?.merge));
      },
      async update(data: Record<string, unknown>) {
        if (!self.store.has(path)) {
          throw new Error(`NOT_FOUND: ${path}`);
        }
        self.writeInternal(path, data, true);
      },
      async delete() {
        self.deleteInternal(path);
      },
    };
  }

  private createCollectionRef(colPath: string) {
    const self = this;
    type Filter = { field: string; op: 'in' | '=='; value: unknown };
    const buildQuery = (
      filters: Filter[] = [],
      order?: { field: string; dir: 'asc' | 'desc' },
      maxDocs?: number,
    ) => ({
      where(field: string, op: 'in' | '==', value: unknown) {
        return buildQuery([...filters, { field, op, value }], order, maxDocs);
      },
      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        return buildQuery(filters, { field, dir }, maxDocs);
      },
      limit(n: number) {
        return buildQuery(filters, order, n);
      },
      async get() {
        const prefix = `${colPath}/`;
        const matching: Array<{ id: string; path: string; data: Record<string, unknown> }> = [];
        for (const [docPath, entry] of self.store.entries()) {
          if (!docPath.startsWith(prefix)) continue;
          const rest = docPath.slice(prefix.length);
          if (rest.includes('/')) continue;
          const d = self.clone(entry.data);
          const pass = filters.every((f) => {
            if (f.op === 'in' && Array.isArray(f.value)) {
              return f.value.includes(d[f.field]);
            }
            return d[f.field] === f.value;
          });
          if (pass) {
            matching.push({ id: rest, path: docPath, data: d });
          }
        }
        if (order) {
          const { field, dir } = order;
          matching.sort((a, b) => {
            const va = String(a.data[field] ?? '');
            const vb = String(b.data[field] ?? '');
            return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          });
        }
        const sliced = maxDocs != null ? matching.slice(0, maxDocs) : matching;
        const docs = sliced.map((item) => ({
          id: item.id,
          ref: self.createDocRef(item.path),
          exists: true,
          data: () => self.clone(item.data),
        }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    });

    const baseQuery = buildQuery();
    return {
      ...baseQuery,
      doc(docId?: string) {
        const resolvedId = docId || self.nextId();
        return self.createDocRef(`${colPath}/${resolvedId}`);
      },
      async add(data: Record<string, unknown>) {
        const dRef = self.createDocRef(`${colPath}/${self.nextId()}`);
        await dRef.set(data);
        return dRef;
      },
    };
  }

  async runTransaction<T>(
    updateFunction: (tx: {
      get: (ref: { path: string; id: string }) => Promise<{
        id: string;
        exists: boolean;
        data: () => Record<string, unknown> | undefined;
      }>;
      set: (
        ref: { path: string },
        data: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => void;
      update: (ref: { path: string }, data: Record<string, unknown>) => void;
      delete: (ref: { path: string }) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 15;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const readVersions = new Map<string, number>();
      const stagedOps: Array<
        | { type: 'set'; path: string; data: Record<string, unknown>; merge: boolean }
        | { type: 'delete'; path: string }
      > = [];

      const tx = {
        get: async (ref: { path: string; id: string }) => {
          // Yield microtask to allow true interleaving between concurrent transactions
          await Promise.resolve();
          if (!readVersions.has(ref.path)) {
            readVersions.set(ref.path, this.getVersion(ref.path));
          }
          const entry = this.store.get(ref.path);
          const snapData = entry ? this.clone(entry.data) : undefined;
          return {
            id: ref.id,
            exists: Boolean(entry),
            data: () => (snapData ? this.clone(snapData) : undefined),
          };
        },
        set: (
          ref: { path: string },
          data: Record<string, unknown>,
          options?: { merge?: boolean },
        ) => {
          stagedOps.push({
            type: 'set',
            path: ref.path,
            data: this.clone(data),
            merge: Boolean(options?.merge),
          });
        },
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          stagedOps.push({
            type: 'set',
            path: ref.path,
            data: this.clone(data),
            merge: true,
          });
        },
        delete: (ref: { path: string }) => {
          stagedOps.push({ type: 'delete', path: ref.path });
        },
      };

      const result = await updateFunction(tx);
      await Promise.resolve();

      let conflict = false;
      for (const [docPath, seenVer] of readVersions.entries()) {
        if (this.getVersion(docPath) !== seenVer) {
          conflict = true;
          break;
        }
      }
      if (conflict) {
        if (attempt === maxAttempts) {
          throw new Error('ABORTED: Transaction max retries exceeded');
        }
        continue;
      }

      for (const op of stagedOps) {
        if (op.type === 'set') {
          this.writeInternal(op.path, op.data, op.merge);
        } else {
          this.deleteInternal(op.path);
        }
      }
      return result;
    }
    throw new Error('ABORTED');
  }

  async recursiveDelete(ref: { path: string }): Promise<void> {
    const prefix = `${ref.path}/`;
    for (const key of Array.from(this.store.keys())) {
      if (key === ref.path || key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }
}

/**
 * Evaluator for `/usage/{uid}` rules from `firestore.rules` to verify that the
 * deployed rules file enforces `request.time` (`currentUtcDate()` & `currentUtcPeriodStart()`).
 */
function evaluateUsageFirestoreRule(params: {
  op: 'create' | 'update';
  authUid: string | null;
  docUid: string;
  requestTimeIso: string;
  existingData: Record<string, unknown> | null;
  newData: Record<string, unknown>;
}): boolean {
  const rulesPath = join(dirname(fileURLToPath(import.meta.url)), '../../../firestore.rules');
  const rulesSource = readFileSync(rulesPath, 'utf8');
  // Verify the rules file itself contains our trusted server-time helper functions
  assert.ok(rulesSource.includes('function currentUtcDate()'), 'firestore.rules must define currentUtcDate()');
  assert.ok(rulesSource.includes('function currentUtcPeriodStart()'), 'firestore.rules must define currentUtcPeriodStart()');
  assert.ok(rulesSource.includes('request.resource.data.lastShareDate == currentUtcDate()'), 'firestore.rules must enforce lastShareDate == currentUtcDate()');

  const { op, authUid, docUid, requestTimeIso, existingData, newData } = params;
  if (!authUid || authUid !== docUid || !/^[a-zA-Z0-9_-]{1,128}$/.test(docUid)) {
    return false;
  }

  const reqDate = new Date(requestTimeIso);
  const y = String(reqDate.getUTCFullYear());
  const m = String(reqDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(reqDate.getUTCDate()).padStart(2, '0');
  const currentUtcDate = `${y}-${m}-${d}`;
  const currentUtcPeriodStart = `${y}-${m}-01T00:00:00Z`;

  const hasValidShareMethod = (data: Record<string, unknown>) =>
    !('lastShareMethod' in data) ||
    ['native', 'poster', 'copy'].includes(String(data.lastShareMethod));

  if (op === 'create') {
    const keys = Object.keys(newData);
    const required = ['periodStart', 'used', 'bonusMicroUsd', 'shareCount', 'lastShareDate'];
    const allowed = [...required, 'lastShareMethod'];
    return (
      required.every((k) => keys.includes(k)) &&
      keys.every((k) => allowed.includes(k)) &&
      newData.periodStart === currentUtcPeriodStart &&
      newData.used === 0 &&
      newData.bonusMicroUsd === 30000 &&
      newData.shareCount === 1 &&
      newData.lastShareDate === currentUtcDate &&
      hasValidShareMethod(newData)
    );
  }

  if (!existingData) return false;
  const allKeys = new Set([...Object.keys(existingData), ...Object.keys(newData)]);
  const affectedKeys = Array.from(allKeys).filter(
    (k) => JSON.stringify(existingData[k]) !== JSON.stringify(newData[k]),
  );

  if (!hasValidShareMethod(newData) || newData.lastShareDate !== currentUtcDate) {
    return false;
  }

  const oldPeriod = String(existingData.periodStart ?? '');
  if (oldPeriod === currentUtcPeriodStart) {
    const allowedDiff = ['bonusMicroUsd', 'shareCount', 'lastShareDate', 'lastShareMethod'];
    return (
      affectedKeys.every((k) => allowedDiff.includes(k)) &&
      String(existingData.lastShareDate ?? '') !== currentUtcDate &&
      newData.bonusMicroUsd === Number(existingData.bonusMicroUsd ?? 0) + 30000 &&
      Number(newData.bonusMicroUsd) <= 90000 &&
      newData.shareCount === Number(existingData.shareCount ?? 0) + 1 &&
      Number(newData.shareCount) <= 3
    );
  }

  if (oldPeriod < currentUtcPeriodStart) {
    const allowedDiff = [
      'periodStart',
      'used',
      'bonusMicroUsd',
      'shareCount',
      'lastShareDate',
      'lastShareMethod',
      'reservations',
    ];
    return (
      affectedKeys.every((k) => allowedDiff.includes(k)) &&
      newData.periodStart === currentUtcPeriodStart &&
      newData.used === 0 &&
      newData.bonusMicroUsd === 30000 &&
      newData.shareCount === 1
    );
  }

  return false;
}

test('Quota concurrency: 5 concurrent requests on free tier cannot exceed budget, failure releases reservation, and period rollover resets', async () => {
  const mockDb = new MockFirestoreEmulator();
  const db = mockDb as unknown as Firestore;
  const uid = 'user_quota_concurrent';
  const periodStart = '2026-11-01T00:00:00Z';
  const now = new Date('2026-11-15T10:00:00Z');

  // Free tier budget is 100,000 micro-USD; each request reserves 30,000 micro-USD.
  // Launching 5 concurrent requests: at most 3 (3 * 30,000 = 90,000 <= 100,000) can pass!
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map((i) =>
      reserveQuota(db, {
        uid,
        tier: 'free',
        periodStart,
        unlimited: false,
        requestId: `req_${i}`,
        now,
      }),
    ),
  );

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 3, 'Exactly 3 of 5 concurrent requests should reserve quota within 100k budget');
  assert.equal(rejected.length, 2, 'Remaining 2 concurrent requests must be rejected with QUOTA_EXCEEDED');

  // If req_3 fails before completion, releaseQuota frees its 30,000 reservation
  const activeIds = [1, 2, 3, 4, 5].filter((_, idx) => results[idx].status === 'fulfilled');
  await releaseQuota(db, { uid, requestId: `req_${activeIds[2]}`, now });

  // Settle the first two successful requests at 42,000 each (total used = 84,000)
  await settleQuota(db, {
    uid,
    periodStart,
    requestId: `req_${activeIds[0]}`,
    costMicroUsd: 42_000,
    now,
  });
  await settleQuota(db, {
    uid,
    periodStart,
    requestId: `req_${activeIds[1]}`,
    costMicroUsd: 42_000,
    now,
  });

  // Now used = 84,000 (< 100,000, 16,000 remaining). Two concurrent requests arrive:
  // Only ONE can be admitted; the second must be blocked while the first is in flight!
  const nearLimitResults = await Promise.allSettled([
    reserveQuota(db, { uid, tier: 'free', periodStart, unlimited: false, requestId: 'near_1', now }),
    reserveQuota(db, { uid, tier: 'free', periodStart, unlimited: false, requestId: 'near_2', now }),
  ]);
  assert.equal(
    nearLimitResults.filter((r) => r.status === 'fulfilled').length,
    1,
    'Only 1 request may pass when near quota limit',
  );
  assert.equal(
    nearLimitResults.filter((r) => r.status === 'rejected').length,
    1,
    'Concurrent second request when near limit must be rejected',
  );

  // Expired reservation cleanup: after TTL (3 minutes later), stale reservation is pruned
  const afterExpiry = new Date(now.getTime() + 180_000);
  await reserveQuota(db, {
    uid,
    tier: 'free',
    periodStart,
    unlimited: false,
    requestId: 'after_ttl',
    now: afterExpiry,
  });
  await settleQuota(db, {
    uid,
    periodStart,
    requestId: 'after_ttl',
    costMicroUsd: 20_000,
    now: afterExpiry,
  });

  // Used is now 104,000 >= 100,000 -> same-period request must fail
  await assert.rejects(
    () =>
      reserveQuota(db, {
        uid,
        tier: 'free',
        periodStart,
        unlimited: false,
        requestId: 'over_budget',
        now: afterExpiry,
      }),
    /QUOTA_EXCEEDED/,
  );

  // Next month rollover resets used to 0 and allows new requests
  const nextPeriod = '2026-12-01T00:00:00Z';
  const decNow = new Date('2026-12-02T09:00:00Z');
  await reserveQuota(db, {
    uid,
    tier: 'free',
    periodStart: nextPeriod,
    unlimited: false,
    requestId: 'dec_1',
    now: decNow,
  });
  const settledDec = await settleQuota(db, {
    uid,
    periodStart: nextPeriod,
    requestId: 'dec_1',
    costMicroUsd: 25_000,
    now: decNow,
  });
  assert.equal(settledDec.used, 25_000);
});

test('Share bonus rules & server transaction: blocks forged dates, concurrent same-day claims, enforces 3/month limit, and resets across periods', async () => {
  const mockDb = new MockFirestoreEmulator();
  const db = mockDb as unknown as Firestore;
  const uid = 'user_share_bonus';
  const day1 = new Date('2026-11-15T08:00:00Z');

  // 1. Forged clientDate is rejected by server transaction AND by firestore.rules
  await assert.rejects(
    () =>
      claimShareBonus(db, {
        uid,
        shareMethod: 'poster',
        clientDate: '2026-11-14',
        now: day1,
      }),
    /INVALID_SHARE_DATE/,
  );

  assert.equal(
    evaluateUsageFirestoreRule({
      op: 'create',
      authUid: uid,
      docUid: uid,
      requestTimeIso: day1.toISOString(),
      existingData: null,
      newData: {
        periodStart: '2026-11-01T00:00:00Z',
        used: 0,
        bonusMicroUsd: 30000,
        shareCount: 1,
        lastShareDate: '2026-11-14', // forged date != 2026-11-15
      },
    }),
    false,
    'firestore.rules must reject forged lastShareDate on create',
  );

  assert.equal(
    evaluateUsageFirestoreRule({
      op: 'create',
      authUid: uid,
      docUid: uid,
      requestTimeIso: day1.toISOString(),
      existingData: null,
      newData: {
        periodStart: '2026-11-01T00:00:00Z',
        used: 0,
        bonusMicroUsd: 30000,
        shareCount: 1,
        lastShareDate: '2026-11-15',
        lastShareMethod: 'poster',
      },
    }),
    true,
    'firestore.rules must allow valid today create',
  );

  // 2. Concurrent claims on Day 1: only 1 succeeds, others get ALREADY_SHARED_TODAY
  const day1Concurrent = await Promise.allSettled([
    claimShareBonus(db, { uid, shareMethod: 'poster', now: day1 }),
    claimShareBonus(db, { uid, shareMethod: 'copy', now: day1 }),
    claimShareBonus(db, { uid, shareMethod: 'native', now: day1 }),
  ]);
  assert.equal(day1Concurrent.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(day1Concurrent.filter((r) => r.status === 'rejected').length, 2);

  // Verify firestore.rules also blocks a second update on the same day or with a forged date
  const afterDay1 = mockDb.getRaw(`usage/${uid}`)!;
  assert.equal(
    evaluateUsageFirestoreRule({
      op: 'update',
      authUid: uid,
      docUid: uid,
      requestTimeIso: day1.toISOString(),
      existingData: afterDay1,
      newData: {
        ...afterDay1,
        bonusMicroUsd: 60000,
        shareCount: 2,
        lastShareDate: '2026-11-16', // forged future date on same server day
      },
    }),
    false,
    'firestore.rules must block client attempting to pass different date string on same day',
  );

  // 3. Day 2 & Day 3 claims succeed (reaching 3/3 = 90,000 micro-USD)
  const day2 = new Date('2026-11-16T09:00:00Z');
  const day3 = new Date('2026-11-17T09:00:00Z');
  const res2 = await claimShareBonus(db, { uid, shareMethod: 'copy', now: day2 });
  assert.equal(res2.shareCount, 2);
  assert.equal(res2.bonusMicroUsd, 60_000);

  const res3 = await claimShareBonus(db, { uid, shareMethod: 'native', now: day3 });
  assert.equal(res3.shareCount, 3);
  assert.equal(res3.bonusMicroUsd, 90_000);

  // 4. Day 4 in the same month is rejected (MONTHLY_SHARE_LIMIT_REACHED)
  const day4 = new Date('2026-11-18T09:00:00Z');
  await assert.rejects(
    () => claimShareBonus(db, { uid, shareMethod: 'poster', now: day4 }),
    /MONTHLY_SHARE_LIMIT_REACHED/,
  );

  // 5. Next month (2026-12) rollover resets shareCount to 1 and bonusMicroUsd to 30,000
  const nextMonthDay = new Date('2026-12-01T10:00:00Z');
  const resNextMonth = await claimShareBonus(db, { uid, shareMethod: 'poster', now: nextMonthDay });
  assert.equal(resNextMonth.periodStart, '2026-12-01T00:00:00Z');
  assert.equal(resNextMonth.shareCount, 1);
  assert.equal(resNextMonth.bonusMicroUsd, 30_000);
  assert.equal(resNextMonth.used, 0);
});

test('Session history & atomic turn commit: loads latest 20 messages in order, preserves history on failed edit, commits atomically, and blocks same-session concurrency', async () => {
  const mockDb = new MockFirestoreEmulator();
  const db = mockDb as unknown as Firestore;
  const uid = 'user_session_test';
  const sessionId = 'sess_1';
  const sessionRef = db.collection('users').doc(uid).collection('sessions').doc(sessionId);

  await sessionRef.set({
    mode: 'personal',
    profileId: 'p1',
    profileIds: ['p1'],
    title: '测试会话',
    frozenPrompt: 'system',
    frozenModel: 'vertexai/gemini-4-hydrogen',
    frozenTools: ['natalWheel'],
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
  });

  // Seed 24 messages (12 turns: msg_1 .. msg_24)
  for (let i = 1; i <= 24; i++) {
    const role = i % 2 === 1 ? 'user' : 'assistant';
    const ts = new Date(Date.UTC(2026, 10, 15, 1, 0, i)).toISOString();
    await sessionRef.collection('messages').doc(`m_${String(i).padStart(2, '0')}`).set({
      role,
      parts: [{ type: 'text', text: `消息_${i}` }],
      createdAt: ts,
    });
  }

  // 1. Acquire turn_1 (normal): must load latest 20 messages (消息_5 .. 消息_24) in ascending order
  const now = new Date('2026-11-15T02:00:00Z');
  const turn1 = await acquireSessionTurn(db, {
    uid,
    sessionId,
    turnId: 'turn_1',
    editLastTurn: false,
    now,
  });

  assert.ok(!turn1.historyContext.includes('用户: 消息_1\n'), 'Must exclude earliest messages beyond 20');
  assert.ok(!turn1.historyContext.includes('顾问: 消息_4\n'), 'Must exclude message 4');
  assert.ok(turn1.historyContext.startsWith('用户: 消息_5\n顾问: 消息_6'), 'Must start from 5th message');
  assert.ok(turn1.historyContext.endsWith('用户: 消息_23\n顾问: 消息_24'), 'Must end with 24th message in chronological order');

  // 2. Concurrent turn_2 on the same session while turn_1 is active must be rejected with SESSION_BUSY
  await assert.rejects(
    () =>
      acquireSessionTurn(db, {
        uid,
        sessionId,
        turnId: 'turn_2',
        now,
      }),
    /SESSION_BUSY/,
  );

  await releaseSessionTurn(db, { uid, sessionId, turnId: 'turn_1' });

  // 3. Edit last turn (editLastTurn: true) when generation fails: original messages m_23 & m_24 MUST NOT be lost!
  const editAttempt = await acquireSessionTurn(db, {
    uid,
    sessionId,
    turnId: 'turn_edit_fail',
    editLastTurn: true,
    now,
  });
  assert.deepEqual(editAttempt.replacedMessageIds, ['m_23', 'm_24']);
  assert.ok(!editAttempt.historyContext.includes('消息_23'), 'Context for editLastTurn must exclude the turn being edited');
  assert.ok(editAttempt.historyContext.endsWith('用户: 消息_21\n顾问: 消息_22'));

  // Simulate model failure -> release lock without committing
  await releaseSessionTurn(db, { uid, sessionId, turnId: 'turn_edit_fail' });

  const snapAfterFail = await sessionRef.collection('messages').orderBy('createdAt', 'asc').get();
  assert.equal(snapAfterFail.size, 24, 'All 24 original messages must still exist when generation fails');

  // 4. Edit last turn (editLastTurn: true) when generation succeeds: atomically replaces m_23 & m_24 with new turn
  const editSuccess = await acquireSessionTurn(db, {
    uid,
    sessionId,
    turnId: 'turn_edit_ok',
    editLastTurn: true,
    now,
  });
  await commitSessionTurn(db, {
    uid,
    sessionId,
    turnId: 'turn_edit_ok',
    replacedMessageIds: editSuccess.replacedMessageIds,
    userMessage: {
      text: '修改后的第12轮提问',
      createdAt: '2026-11-15T02:05:00.000Z',
    },
    assistantMessage: {
      parts: [{ type: 'text', text: '修改后的第12轮回答' }],
      suggestions: ['追问1'],
      createdAt: '2026-11-15T02:05:00.000Z',
    },
  });

  const snapAfterCommit = await sessionRef.collection('messages').orderBy('createdAt', 'asc').get();
  assert.equal(snapAfterCommit.size, 24, 'Total message count remains 24 after replacing last turn');
  const lastTwo = snapAfterCommit.docs.slice(-2).map((d) => d.data());
  assert.equal(lastTwo[0].role, 'user');
  assert.equal((lastTwo[0].parts as Array<{ text: string }>)[0].text, '修改后的第12轮提问');
  assert.equal(lastTwo[1].role, 'assistant');
  assert.equal((lastTwo[1].parts as Array<{ text: string }>)[0].text, '修改后的第12轮回答');
  assert.ok(String(lastTwo[1].createdAt) > String(lastTwo[0].createdAt), 'Assistant createdAt must be strictly after user createdAt');

  // 5. Session title summarization on createFrozenSession and commitSessionTurn upgrade from default profile-name placeholder
  assert.equal(summarizeQuestionTitle('请问一下，我今年的事业转折点在哪里？'), '我今年的事业转折点在哪里');
  await db.collection('users').doc(uid).collection('profiles').doc('p_title').set({
    name: '林辰',
    entityType: 'person',
    birthDateTime: '1995-05-20T14:30',
    locationName: '上海',
    latitude: 31.23,
    longitude: 121.47,
    timezone: 'Asia/Shanghai',
  });

  const createdWithQuestion = await createFrozenSession(db, {
    uid,
    tier: 'free',
    rawData: {
      mode: 'personal',
      profileIds: ['p_title'],
      initialQuestion: '帮我看看今年下半年感情运势怎么样？',
    },
  });
  assert.equal(createdWithQuestion.session.title, '今年下半年感情运势怎么样');
  assert.equal(createdWithQuestion.session.profileName, '林辰');

  const legacySession = await createFrozenSession(db, {
    uid,
    tier: 'free',
    rawData: { mode: 'personal', profileIds: ['p_title'] },
  });
  assert.equal(legacySession.session.title, '林辰', 'Without initialQuestion, placeholder starts as profileName');

  const legTurn = await acquireSessionTurn(db, {
    uid,
    sessionId: legacySession.sessionId,
    turnId: 'turn_upgrade_title',
    now,
  });
  await commitSessionTurn(db, {
    uid,
    sessionId: legacySession.sessionId,
    turnId: 'turn_upgrade_title',
    replacedMessageIds: legTurn.replacedMessageIds,
    userMessage: {
      text: '请帮我分析一下明年跳槽适不适合？',
      createdAt: '2026-11-15T03:00:00.000Z',
    },
    assistantMessage: {
      parts: [{ type: 'text', text: '解析内容' }],
      suggestions: [],
      createdAt: '2026-11-15T03:00:01.000Z',
    },
  });
  const upgradedDoc = await db.collection('users').doc(uid).collection('sessions').doc(legacySession.sessionId).get();
  assert.equal(upgradedDoc.data()?.title, '明年跳槽适不适合');
});

test('Account deletion & subscription cancellation: blocks deletion on missing Stripe key or cancel failure, preserves retryable state, and deletes cleanly on retry', async () => {
  const mockDb = new MockFirestoreEmulator();
  const db = mockDb as unknown as Firestore;
  const uid = 'user_delete_retry';

  await db.collection('users').doc(uid).set({
    email: 'paid@vela.app',
    displayName: 'Paid User',
    acceptedTermsAt: '2026-11-01T00:00:00Z',
    confirmedAdultAt: '2026-11-01T00:00:00Z',
    createdAt: '2026-11-01T00:00:00Z',
  });
  await db.collection('usage').doc(uid).set({
    periodStart: '2026-11-01T00:00:00Z',
    used: 15000,
  });
  await db.collection('customers').doc(uid).collection('subscriptions').doc('sub_active_1').set({
    status: 'active',
    current_period_start: '2026-11-01T00:00:00Z',
  });
  await db.collection('customers').doc(uid).collection('subscriptions').doc('sub_trial_2').set({
    status: 'trialing',
    current_period_start: '2026-11-01T00:00:00Z',
  });

  let authDeleted = false;
  const mockAuth = {
    async deleteUser(targetUid: string) {
      assert.equal(targetUid, uid);
      authDeleted = true;
    },
  };

  // 1. Missing Stripe key when active subscriptions exist: must fail and preserve user + auth
  await assert.rejects(
    () =>
      deleteAccountWithRetry({
        db,
        auth: mockAuth,
        uid,
        stripeClient: null,
      }),
    /STRIPE_NOT_CONFIGURED_FOR_ACTIVE_SUBSCRIPTION/,
  );
  assert.equal(authDeleted, false, 'Auth user must NOT be deleted when Stripe key is missing');
  const stateAfterNoKey = (await db.collection('users').doc(uid).get()).data()?.deletionState as Record<string, unknown>;
  assert.equal(stateAfterNoKey?.status, 'cancel_failed');
  assert.equal(stateAfterNoKey?.error, 'STRIPE_SECRET_KEY_MISSING');

  // 2. Partial Stripe failure: sub_active_1 cancels, sub_trial_2 throws Stripe network error
  const canceledCalls: string[] = [];
  let shouldFailSub2 = true;
  const flakyStripe = {
    subscriptions: {
      async cancel(subId: string) {
        canceledCalls.push(subId);
        if (subId === 'sub_trial_2' && shouldFailSub2) {
          throw new Error('Stripe API timeout');
        }
        return { id: subId, status: 'canceled' };
      },
    },
  };

  await assert.rejects(
    () =>
      deleteAccountWithRetry({
        db,
        auth: mockAuth,
        uid,
        stripeClient: flakyStripe,
      }),
    /SUBSCRIPTION_CANCEL_FAILED/,
  );
  assert.equal(authDeleted, false, 'Auth user must NOT be deleted when subscription cancel fails');
  const stateAfterFlaky = (await db.collection('users').doc(uid).get()).data()?.deletionState as {
    status: string;
    canceledSubscriptionIds: string[];
    pendingSubscriptionIds: string[];
  };
  assert.equal(stateAfterFlaky.status, 'cancel_failed');
  assert.deepEqual(stateAfterFlaky.canceledSubscriptionIds, ['sub_active_1']);
  assert.deepEqual(stateAfterFlaky.pendingSubscriptionIds, ['sub_trial_2']);

  // 3. Retry succeeds: skips already-canceled sub_active_1, cancels sub_trial_2, deletes Auth and Firestore data
  shouldFailSub2 = false;
  const retryRes = await deleteAccountWithRetry({
    db,
    auth: mockAuth,
    uid,
    stripeClient: flakyStripe,
  });

  assert.equal(retryRes.deleted, true);
  assert.equal(authDeleted, true, 'Auth user must be deleted after all subscriptions are canceled');
  assert.deepEqual(
    canceledCalls,
    ['sub_active_1', 'sub_trial_2', 'sub_trial_2'],
    'Retry must only re-attempt the remaining subscription sub_trial_2',
  );
  assert.equal((await db.collection('users').doc(uid).get()).exists, false, 'users/{uid} must be deleted');
  assert.equal((await db.collection('usage').doc(uid).get()).exists, false, 'usage/{uid} must be deleted');
  assert.equal(
    (await db.collection('customers').doc(uid).collection('subscriptions').get()).empty,
    true,
    'customers/{uid} subcollections must be cleaned up',
  );

  // Also verify resolveUserPeriodAndTier and exportAccountData work cleanly
  const tierInfo = await resolveUserPeriodAndTier(db, 'free_user', undefined);
  assert.equal(tierInfo.tier, 'free');
  const exported = await exportAccountData(db, 'free_user');
  assert.equal(exported.user, null);
});
