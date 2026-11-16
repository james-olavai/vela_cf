import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { firebaseConfig } from './runtimeConfig';

const app = initializeApp(firebaseConfig);

const recaptchaKey =
  import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY || firebaseConfig.recaptchaSiteKey;
export let appCheck: AppCheck | undefined;
if (typeof window !== 'undefined' && recaptchaKey) {
  appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(recaptchaKey),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

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
