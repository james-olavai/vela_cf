import { withBillingLock } from './stripe-payments.js';
import { deleteUserPats } from './pat.js';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import Stripe from 'stripe';

export interface StripeSubscriptionCanceler {
  subscriptions: {
    cancel: (subscriptionId: string) => Promise<unknown>;
  };
}

export interface AuthUserDeleter {
  deleteUser: (uid: string) => Promise<unknown>;
}

export interface AccountDeletionState {
  status: 'in_progress' | 'cancel_failed' | 'subscriptions_canceled' | 'auth_delete_failed';
  error?: string;
  pendingSubscriptionIds: string[];
  canceledSubscriptionIds: string[];
  updatedAt: string;
}

export async function exportAccountData(
  db: Firestore,
  uid: string,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const userDoc = await db.collection('users').doc(uid).get();
  const profilesSnap = await db.collection('users').doc(uid).collection('profiles').get();
  const sessionsSnap = await db.collection('users').doc(uid).collection('sessions').get();

  const sessions = await Promise.all(
    sessionsSnap.docs.map(async (s) => {
      const msgsSnap = await s.ref.collection('messages').orderBy('createdAt', 'asc').get();
      return {
        id: s.id,
        ...s.data(),
        messages: msgsSnap.docs.map((m) => ({ id: m.id, ...m.data() })),
      };
    }),
  );

  return {
    exportedAt: now.toISOString(),
    user: userDoc.data() ?? null,
    profiles: profilesSnap.docs.map((p) => ({ id: p.id, ...p.data() })),
    sessions,
  };
}

export async function deleteAccountWithRetry(params: {
  db: Firestore;
  auth: Auth | AuthUserDeleter;
  uid: string;
  stripeKey?: string;
  stripeClient?: StripeSubscriptionCanceler | null;
  now?: Date;
}): Promise<{ deleted: true; canceledSubscriptionIds: string[] }> {
  const {
    db,
    auth,
    uid,
    stripeKey = process.env.STRIPE_SECRET_KEY,
    stripeClient,
    now = new Date(),
  } = params;
  return withBillingLock(db,uid,async()=>{
  const nowIso = now.toISOString();
  const userRef = db.collection('users').doc(uid);
  const customerRef = db.collection('customers').doc(uid);

  const userSnap = await userRef.get();
  const existingState = userSnap.data()?.deletionState as Partial<AccountDeletionState> | undefined;
  const canceledSet = new Set<string>(
    Array.isArray(existingState?.canceledSubscriptionIds)
      ? existingState.canceledSubscriptionIds.map(String)
      : [],
  );

  await userRef.set({deletionState:{status:'in_progress',pendingSubscriptionIds:existingState?.pendingSubscriptionIds || [],canceledSubscriptionIds:Array.from(canceledSet),updatedAt:nowIso} satisfies AccountDeletionState},{merge:true});
  const subsSnap = await customerRef
    .collection('subscriptions')
    .where('status', 'in', ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'])
    .get();

  const pendingDocs = subsSnap.docs.filter((doc) => !canceledSet.has(doc.id));

  if (pendingDocs.length > 0) {
    const resolvedStripe: StripeSubscriptionCanceler | null =
      stripeClient !== undefined
        ? stripeClient
        : stripeKey
          ? new Stripe(stripeKey)
          : null;

    if (!resolvedStripe) {
      const state: AccountDeletionState = {
        status: 'cancel_failed',
        error: 'STRIPE_SECRET_KEY_MISSING',
        pendingSubscriptionIds: pendingDocs.map((d) => d.id),
        canceledSubscriptionIds: Array.from(canceledSet),
        updatedAt: nowIso,
      };
      await userRef.set({ deletionState: state }, { merge: true });
      throw new HttpsError(
        'failed-precondition',
        'STRIPE_NOT_CONFIGURED_FOR_ACTIVE_SUBSCRIPTION',
      );
    }

    for (const subDoc of pendingDocs) {
      try {
        await resolvedStripe.subscriptions.cancel(subDoc.id);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code !== 'resource_missing') {
          const remaining = pendingDocs
            .map((d) => d.id)
            .filter((id) => !canceledSet.has(id));
          const state: AccountDeletionState = {
            status: 'cancel_failed',
            error: err instanceof Error ? err.message : String(err),
            pendingSubscriptionIds: remaining,
            canceledSubscriptionIds: Array.from(canceledSet),
            updatedAt: nowIso,
          };
          await userRef.set({ deletionState: state }, { merge: true });
          throw new HttpsError('unavailable', 'SUBSCRIPTION_CANCEL_FAILED');
        }
      }

      canceledSet.add(subDoc.id);
      await subDoc.ref.set(
        {
          status: 'canceled',
          canceledAt: nowIso,
        },
        { merge: true },
      );
    }
  }

  await userRef.set(
    {
      deletionState: {
        status: 'subscriptions_canceled',
        pendingSubscriptionIds: [],
        canceledSubscriptionIds: Array.from(canceledSet),
        updatedAt: nowIso,
      } satisfies AccountDeletionState,
    },
    { merge: true },
  );

  await deleteUserPats(db,uid);
  try {
    await auth.deleteUser(uid);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== 'auth/user-not-found') {
      await userRef.set(
        {
          deletionState: {
            status: 'auth_delete_failed',
            error: err instanceof Error ? err.message : String(err),
            pendingSubscriptionIds: [],
            canceledSubscriptionIds: Array.from(canceledSet),
            updatedAt: nowIso,
          } satisfies AccountDeletionState,
        },
        { merge: true },
      );
      throw err;
    }
  }

  await db.recursiveDelete(userRef);
  await db.collection('usage').doc(uid).delete().catch(() => undefined);
  await db.recursiveDelete(customerRef);

  return {
    deleted: true,
    canceledSubscriptionIds: Array.from(canceledSet),
  };
  });
}
