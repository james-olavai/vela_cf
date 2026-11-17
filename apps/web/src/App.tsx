import type { CountryChoice } from './lib/geoStore';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  isSignInWithEmailLink,
  onIdTokenChanged,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  TierSchema,
  type ConsultationMode,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
  type UsageRecord,
  utcMonthPeriodStart,
} from '@vela-cf/shared';
import type { EmailAuthMode } from './components/SettingsModal';
import { auth, googleProvider, initAnalyticsConsent } from './lib/firebase';
import { navigate, usePathname } from './lib/router';
import {
  createConsultationSession,
  ensureUserRecord,
  formatAppError,
  saveCachedChart,
  saveProfile,
  subscribeProfiles,
  subscribeSessions,
  subscribeUsage,
} from './lib/store';
import { LegalPage } from './pages/LegalPage';
import { WorkbenchPage, type PendingHandoff } from './pages/WorkbenchPage';

const SettingsModal = lazy(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })));

const MAGIC_EMAIL_KEY = 'vela_magic_link_email';
const MAGIC_HANDOFF_KEY = 'vela_magic_link_handoff';

export function App() {
  const pathname = usePathname();
  const [dataError, setDataError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [consentUser, setConsentUser] = useState<User | null>(null);
  const consentedUid = useRef<string | null>(null);
  const uidRef = useRef(user?.uid);
  uidRef.current = user?.uid;
  const [tier, setTier] = useState<Tier>('free');
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [usage, setUsage] = useState<UsageRecord>(() => ({
    periodStart: utcMonthPeriodStart(),
    used: 0,
  }));

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [pendingHandoff, setPendingHandoff] = useState<PendingHandoff | null>(null);

  const finalizePostLogin = async (loggedUser: User, handoff: PendingHandoff | null, consentGiven=false) => {
    const uid = loggedUser.uid;
    try { await ensureUserRecord(uid, loggedUser.email ?? '', loggedUser.displayName ?? '', consentGiven); }
    catch (error) {
      if (auth.currentUser?.uid !== uid) return;
      if ((error as {code?:string}).code !== 'CONSENT_REQUIRED') throw error;
      if (consentedUid.current !== uid) { setConsentUser(loggedUser); setSettingsOpen(true); }
      return;
    }
    if (auth.currentUser?.uid !== uid) return;
    consentedUid.current = uid;
    setConsentUser(null);
    setUser(loggedUser);
    setRetry((n) => n + 1);

    if (handoff) {
      const now = new Date().toISOString();
      const savedProfiles: ProfileRecord[] = [];
      for (const dp of handoff.draftProfiles) {
        const savedId = await saveProfile(uid, null, dp);
        savedProfiles.push({
          ...dp,
          id: savedId,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (handoff.chart && savedProfiles[0]) {
        saveCachedChart(uid, savedProfiles[handoff.selectedIndices[0] ?? 0] ?? savedProfiles[0], handoff.chart);
      }
      if (handoff.question && savedProfiles.length > 0) {
        const chosen = handoff.selectedIndices
          .map((idx) => savedProfiles[idx])
          .filter(Boolean);
        const session = await createConsultationSession(
          handoff.mode,
          chosen.length > 0 ? chosen : [savedProfiles[0]],
          handoff.question,
        );
        setSessions((prev) => (prev.some((s) => s.id === session.id) ? prev : [session, ...prev]));
        navigate(`/consult/${session.id}`);
      } else {
        setPendingHandoff(null);
      }
    }
    setSettingsOpen(false);
  };

  useEffect(() => {
    void initAnalyticsConsent();
    if (typeof window !== 'undefined' && isSignInWithEmailLink(auth, window.location.href)) {
      const savedEmail = window.localStorage.getItem(MAGIC_EMAIL_KEY);
      if (savedEmail) {
        void signInWithEmailLink(auth, savedEmail, window.location.href)
          .then(async (cred) => {
            window.localStorage.removeItem(MAGIC_EMAIL_KEY);
            const rawHandoff = window.localStorage.getItem(MAGIC_HANDOFF_KEY);
            window.localStorage.removeItem(MAGIC_HANDOFF_KEY);
            const restored = rawHandoff ? (JSON.parse(rawHandoff) as PendingHandoff) : null;
            if (restored) setPendingHandoff(restored);
            window.history.replaceState({}, '', window.location.pathname);
            await finalizePostLogin(cred.user, restored);
          })
          .catch(() => undefined);
      }
    }
  }, []);

  useEffect(() => {
    let generation = 0;
    let lastUid: string | null = null;
    let unsubProfiles: (() => void) | undefined;
    let unsubSessions: (() => void) | undefined;
    let unsubUsage: (() => void) | undefined;

    const cleanupSubs = () => {
      if (unsubProfiles) {
        unsubProfiles();
        unsubProfiles = undefined;
      }
      if (unsubSessions) {
        unsubSessions();
        unsubSessions = undefined;
      }
      if (unsubUsage) {
        unsubUsage();
        unsubUsage = undefined;
      }
    };

    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('e2e') === '1') {
      const qs = new URLSearchParams(window.location.search);
      const parsedTier = TierSchema.safeParse(qs.get('tier'));
      const e2eTier: Tier = parsedTier.success ? parsedTier.data : 'pro';
      const e2eUsed = Number(qs.get('used') ?? 0) || 0;
      setUser({
        uid: 'e2e_test_user',
        email: 'e2e@vela.local',
        displayName: 'E2E 测试用户',
        photoURL: null,
      } as unknown as User);
      setTier(e2eTier);
      setUsage({ periodStart: utcMonthPeriodStart(), used: e2eUsed, unlimited: qs.get('unlimited') === '1' });
      unsubProfiles = subscribeProfiles('e2e_test_user', setProfiles);
      setAuthReady(true);
      return cleanupSubs;
    }

    const unsubAuth = onIdTokenChanged(auth, async (nextUser) => {
      const run = ++generation;
      cleanupSubs();
      setDataError(null);
      if (lastUid !== (nextUser?.uid ?? null)) { setProfiles([]); setSessions([]); setUsage({ periodStart: utcMonthPeriodStart(), used: 0 }); }
      lastUid = nextUser?.uid ?? null;
      if (!nextUser) {
        setUser(null);
        setConsentUser(null);
        consentedUid.current = null;
        setTier('free');
        setProfiles([]);
        setSessions([]);
        setUsage({ periodStart: utcMonthPeriodStart(), used: 0 });
        setAuthReady(true);
        return;
      }

      try {
        if (consentedUid.current !== nextUser.uid) await ensureUserRecord(nextUser.uid, nextUser.email ?? '', nextUser.displayName ?? '');
      } catch (error) {
        if (run !== generation) return;
        if ((error as {code?:string}).code === 'CONSENT_REQUIRED') {
          if (consentedUid.current !== nextUser.uid) {
            setUser(null); setConsentUser(nextUser); setSettingsOpen(true); setAuthReady(true); return;
          }
        } else { setDataError('账号信息加载失败，请检查网络后重试'); setAuthReady(true); return; }
      }
      if (run !== generation) return;
      consentedUid.current = nextUser.uid;
      setConsentUser(null);
      setUser(nextUser);

      try {
        const tokenRes = await nextUser.getIdTokenResult();
        const parsedTier = TierSchema.safeParse(tokenRes.claims.stripeRole);
        if (run !== generation) return;
        setTier(parsedTier.success ? parsedTier.data : 'free');
      } catch {
        if (run !== generation) return;
        setTier('free');
      }

      if (run !== generation) return;
      const failed = () => { if (run === generation) setDataError('档案、历史或额度加载失败，请检查网络后重试'); };
      unsubProfiles = subscribeProfiles(nextUser.uid, (next) => { if (run === generation) setProfiles(next); }, failed);
      unsubSessions = subscribeSessions(nextUser.uid, (next) => { if (run === generation) setSessions(next); }, failed);
      unsubUsage = subscribeUsage(nextUser.uid, (next) => { if (run === generation) setUsage(next); }, failed);
      setAuthReady(true);
    });

    return () => {
      ++generation;
      unsubAuth();
      cleanupSubs();
    };
  }, [retry]);

  const handleConfirmGoogleLogin = async () => {
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      await finalizePostLogin(cred.user, pendingHandoff);
    } catch (err) {
      setAuthError(formatAppError(err, 'Google 登录失败，请重试'));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleEmailAuth = async (mode: EmailAuthMode, email: string, password: string) => {
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      if (mode === 'magic') {
        window.localStorage.setItem(MAGIC_EMAIL_KEY, email);
        if (pendingHandoff) {
          window.localStorage.setItem(MAGIC_HANDOFF_KEY, JSON.stringify(pendingHandoff));
        }
        await sendSignInLinkToEmail(auth, email, {
          url: window.location.origin,
          handleCodeInApp: true,
        });
        setAuthNotice(`免密登录链接已发送至 ${email}，请查收邮件点击链接完成登录。`);
        return;
      }
      const cred =
        mode === 'register'
          ? await createUserWithEmailAndPassword(auth, email, password)
          : await signInWithEmailAndPassword(auth, email, password);
      await finalizePostLogin(cred.user, pendingHandoff);
    } catch (err) {
      setAuthError(formatAppError(err, '邮箱认证失败，请重试'));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleResetPassword = async (email: string) => {
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      await sendPasswordResetEmail(auth, email);
      setAuthNotice(`密码重置邮件已发送至 ${email}，请查收并重置密码。`);
    } catch (err) {
      setAuthError(formatAppError(err, '发送重置邮件失败，请检查邮箱地址'));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const handleStartSession = async (
    mode: ConsultationMode,
    selectedProfiles: ProfileRecord[],
    initialQuestion?: string,
    country?: CountryChoice,
  ): Promise<SessionRecord> => {
    const session = await createConsultationSession(mode, selectedProfiles, initialQuestion, country);
    if (uidRef.current !== user?.uid) throw new Error('登录状态已改变，请重试');
    setSessions((prev) => (prev.some((s) => s.id === session.id) ? prev : [session, ...prev]));
    return session;
  };

  if (pathname === '/privacy') return <LegalPage kind="privacy" />;
  if (pathname === '/terms') return <LegalPage kind="terms" />;

  if (!authReady) {
    return (
      <main className="min-h-screen bg-base text-primary flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-[16px] border border-border bg-panel p-8 flex flex-col gap-4">
          <div className="h-5 w-24 rounded bg-bubble" />
          <div className="h-8 w-3/4 rounded bg-bubble" />
          <div className="h-4 w-full rounded bg-panel-2" />
        </div>
      </main>
    );
  }

  const activeSessionId = pathname.startsWith('/consult/')
    ? pathname.slice('/consult/'.length)
    : null;
  const activeSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId) ?? null
    : null;

  const effectiveTier = usage.overrideTier ?? tier;

  return (
    <>
      {dataError && <div role="alert" className="fixed top-0 inset-x-0 z-30 bg-panel text-danger p-2">{dataError}<button type="button" onClick={() => setRetry((n) => n + 1)} className="ml-2 underline">重新加载</button></div>}
      <WorkbenchPage key={user?.uid ?? 'visitor'}
        uid={user?.uid ?? null}
        displayName={user?.displayName ?? user?.email ?? '未登录访客'}
        photoURL={user?.photoURL ?? null}
        tier={effectiveTier}
        usage={usage}
        profiles={profiles}
        sessions={sessions}
        activeSession={activeSession}
        pendingHandoff={pendingHandoff}
        onClearPendingHandoff={() => setPendingHandoff(null)}
        onOpenAccountModal={(handoff) => {
          if (handoff) setPendingHandoff(handoff);
          setAuthError(null);
          setAuthNotice(null);
          setSettingsOpen(true);
        }}
        onStartSession={handleStartSession}
        onSelectSession={(sid) => navigate(sid ? `/consult/${sid}` : '/')}
      />

      <Suspense fallback={<p role="status" className="sr-only">正在加载账号界面</p>}>
      {settingsOpen && <SettingsModal key={user?.uid ?? consentUser?.uid ?? 'visitor'}
        open={settingsOpen}
        uid={user?.uid ?? consentUser?.uid ?? null}
        email={user?.email ?? consentUser?.email ?? 'Google 用户'}
        consentRequired={Boolean(consentUser)}
        onConfirmConsent={() => {
          if (!consentUser || authBusy) return;
          setAuthBusy(true); setAuthError(null);
          void finalizePostLogin(consentUser, pendingHandoff, true)
            .catch((error) => setAuthError(formatAppError(error, '账号确认失败，请重试')))
            .finally(() => setAuthBusy(false));
        }}
        authBusy={authBusy}
        authError={authError}
        authNotice={authNotice}
        pendingQuestion={pendingHandoff?.question}
        onConfirmGoogleLogin={() => void handleConfirmGoogleLogin()}
        onEmailAuth={(mode, email, password) => void handleEmailAuth(mode, email, password)}
        onResetPassword={(email) => void handleResetPassword(email)}
        onClose={() => {
          setSettingsOpen(false);
          if (!consentUser) setPendingHandoff(null);
        }}
        onSignOut={() => void handleSignOut()}
      />}
      </Suspense>
    </>
  );
}
