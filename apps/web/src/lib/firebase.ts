import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';
import firebaseConfig from '../../../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

const recaptchaKey =
  import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY || firebaseConfig.recaptchaSiteKey;
if (typeof window !== 'undefined' && recaptchaKey) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(recaptchaKey),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const functions = getFunctions(app, 'asia-southeast1');
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export function handleFirestoreError(error: unknown, operation: OperationType, path: string | null): never {
  console.error('Firestore request failed', operation, path, (error as { code?: string })?.code);
  const code = (error as { code?: string })?.code;
  throw new Error(code === 'permission-denied' ? '暂无权限，请重新登录后重试' : '数据暂时无法读写，请检查网络后重试');
}

let analyticsConsent: typeof import('firebase/analytics')['setConsent'] | undefined;
export async function initAnalyticsConsent(): Promise<void> {
  if (!firebaseConfig.measurementId) return;
  try {
    const { getAnalytics, isSupported, setConsent } = await import('firebase/analytics');
    if (!(await isSupported())) return;
    const saved = localStorage.getItem('vela_consent_analytics');
    setConsent({
      analytics_storage: saved === 'granted' ? 'granted' : 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
    getAnalytics(app);
    analyticsConsent = setConsent;
  } catch {
    // Analytics unavailable
  }
}

export function updateAnalyticsConsent(granted: boolean): void {
  localStorage.setItem('vela_consent_analytics', granted ? 'granted' : 'denied');
  if (!analyticsConsent) return;
  analyticsConsent({
    analytics_storage: granted ? 'granted' : 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
}
