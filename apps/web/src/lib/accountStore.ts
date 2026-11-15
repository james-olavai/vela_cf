import { addDoc, collection, doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { UserRecord } from '@vela-cf/shared';
import { auth, db, functions, handleFirestoreError, OperationType } from './firebase';

export async function ensureUserRecord(
  uid: string,
  email: string,
  displayName: string,
): Promise<UserRecord> {
  const path = `users/${uid}`;
  const ref = doc(db, 'users', uid);
  try {
    const snap = await getDoc(ref);
    const now = new Date().toISOString();
    if (snap.exists()) {
      return snap.data() as UserRecord;
    }
    const payload: UserRecord = {
      email,
      displayName: displayName || email.split('@')[0] || '用户',
      acceptedTermsAt: now,
      confirmedAdultAt: now,
      createdAt: now,
    };
    await setDoc(ref, payload);
    return payload;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function exportUserDataJson(_uid: string): Promise<void> {
  const fn = httpsCallable<void, Record<string, unknown>>(functions, 'exportUserData');
  const res = await fn();
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vela-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function deleteUserAccount(_uid: string): Promise<void> {
  const fn = httpsCallable<void, { deleted: boolean }>(functions, 'deleteAccount');
  const res = await fn();
  if (!res.data?.deleted) {
    throw new Error('ACCOUNT_DELETE_INCOMPLETE');
  }
  await auth.signOut().catch(() => undefined);
}

export async function createStripeCheckout(uid: string, tier: 'go' | 'pro'): Promise<string | null> {
  const priceId =
    tier === 'go'
      ? import.meta.env.VITE_STRIPE_PRICE_GO
      : import.meta.env.VITE_STRIPE_PRICE_PRO;

  if (!priceId) {
    return null;
  }

  const ref = await addDoc(collection(db, 'customers', uid, 'checkout_sessions'), {
    price: priceId,
    success_url: `${window.location.origin}/account?checkout=success`,
    cancel_url: `${window.location.origin}/account?checkout=cancel`,
  });

  return await new Promise<string | null>((resolve) => {
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.data();
      if (data?.url) {
        unsub();
        resolve(String(data.url));
      } else if (data?.error) {
        unsub();
        resolve(null);
      }
    });
    setTimeout(() => {
      unsub();
      resolve(null);
    }, 6000);
  });
}

export async function createStripePortal(): Promise<string | null> {
  try {
    const fn = httpsCallable<{ returnUrl: string }, { url?: string }>(
      functions,
      'ext-firestore-stripe-payments-createPortalLink',
    );
    const res = await fn({ returnUrl: window.location.href });
    return res.data?.url ?? null;
  } catch {
    return null;
  }
}

export function formatAppError(err: unknown, fallback: string): string {
  const code = (err as { code?: string })?.code ?? '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return '邮箱或密码错误，若尚未注册请切换至「注册账号」';
  }
  if (code === 'auth/email-already-in-use') {
    return '该邮箱已注册，请直接切换至「邮箱登录」';
  }
  if (code === 'auth/weak-password') {
    return '密码强度不足，请设置至少 6 位字符';
  }
  if (code === 'auth/invalid-email') {
    return '邮箱格式不正确，请检查后重试';
  }
  if (code === 'auth/operation-not-allowed') {
    return '当前未在 Firebase 控制台开启邮箱登录，请前往 Authentication → Sign-in method 启用 Email/Password';
  }
  if (code === 'auth/too-many-requests') {
    return '尝试次数过多，请稍后再试或重置密码';
  }
  if (code === 'functions/unauthenticated' || msg.includes('AUTH_REQUIRED')) {
    return '登录状态已失效，请重新登录后重试';
  }
  if (msg.includes('SESSION_BUSY')) {
    return '当前会话正在生成回复，请等待上一条消息完成后再试';
  }
  if (msg.includes('SUBSCRIPTION_CANCEL_FAILED') || msg.includes('STRIPE_NOT_CONFIGURED_FOR_ACTIVE_SUBSCRIPTION')) {
    return '取消活跃订阅未完成，为避免继续扣费已保留账号状态，请稍后重试或先在订阅管理中取消订阅';
  }
  if (code === 'functions/permission-denied') {
    return `权限或套餐受限：${msg}`;
  }
  if (msg === 'QUOTA_EXCEEDED') return '本月额度已用完，可分享领额度或升级套餐';
  if (code === 'functions/resource-exhausted') {
    return '模型服务暂时繁忙或请求受限，请稍后重试；本次错误不代表你的月度额度已用完';
  }
  if (code === 'functions/not-found') {
    return `未找到目标记录或模型：${msg}`;
  }
  if (code === 'functions/invalid-argument') {
    return `参数有误：${msg}`;
  }
  if (code === 'functions/internal' || msg === 'INTERNAL') {
    return msg && msg !== 'INTERNAL'
      ? `云端函数异常：${msg}`
      : '云端函数返回 INTERNAL（请确认已部署最新 functions，并检查 Vertex AI 权限/模型配置）';
  }
  return msg || fallback;
}
