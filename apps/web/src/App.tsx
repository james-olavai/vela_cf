import { useEffect, useState } from 'react';
import { onIdTokenChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  TierSchema,
  type ConsultationMode,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
  type UsageRecord,
  utcMonthPeriodStart,
} from '@vela-cf/shared';
import { AuthGateModal } from './components/AuthGateModal';
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

export function App() {
  const pathname = usePathname();
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [tier, setTier] = useState<Tier>('free');
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [usage, setUsage] = useState<UsageRecord>(() => ({
    periodStart: utcMonthPeriodStart(),
    used: 0,
  }));

  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [pendingHandoff, setPendingHandoff] = useState<PendingHandoff | null>(null);

  useEffect(() => {
    void initAnalyticsConsent();
  }, []);

  useEffect(() => {
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
      setUsage({ periodStart: utcMonthPeriodStart(), used: e2eUsed });
      unsubProfiles = subscribeProfiles('e2e_test_user', setProfiles);
      setAuthReady(true);
      return cleanupSubs;
    }

    const unsubAuth = onIdTokenChanged(auth, async (nextUser) => {
      cleanupSubs();

      setUser(nextUser);
      if (!nextUser) {
        setTier('free');
        setProfiles([]);
        setSessions([]);
        setUsage({ periodStart: utcMonthPeriodStart(), used: 0 });
        setAuthReady(true);
        return;
      }

      try {
        const tokenRes = await nextUser.getIdTokenResult();
        const parsedTier = TierSchema.safeParse(tokenRes.claims.stripeRole);
        setTier(parsedTier.success ? parsedTier.data : 'free');
      } catch {
        setTier('free');
      }

      unsubProfiles = subscribeProfiles(nextUser.uid, setProfiles);
      unsubSessions = subscribeSessions(nextUser.uid, setSessions);
      unsubUsage = subscribeUsage(nextUser.uid, setUsage);
      setAuthReady(true);
    });

    return () => {
      unsubAuth();
      cleanupSubs();
    };
  }, []);

  const handleConfirmGoogleLogin = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      const uid = cred.user.uid;
      await ensureUserRecord(uid, cred.user.email ?? '', cred.user.displayName ?? '');

      if (pendingHandoff) {
        const now = new Date().toISOString();
        const savedProfiles: ProfileRecord[] = [];
        for (const dp of pendingHandoff.draftProfiles) {
          const savedId = await saveProfile(uid, null, dp);
          savedProfiles.push({
            ...dp,
            id: savedId,
            createdAt: now,
            updatedAt: now,
          });
        }
        if (pendingHandoff.chart && savedProfiles[0]) {
          saveCachedChart(uid, savedProfiles[0].id, pendingHandoff.chart);
        }
        if (pendingHandoff.question && savedProfiles.length > 0) {
          const chosen = pendingHandoff.selectedIndices
            .map((idx) => savedProfiles[idx])
            .filter(Boolean);
          const session = await createConsultationSession(
            pendingHandoff.mode,
            chosen.length > 0 ? chosen : [savedProfiles[0]],
          );
          setSessions((prev) => (prev.some((s) => s.id === session.id) ? prev : [session, ...prev]));
          navigate(`/consult/${session.id}`);
        } else {
          setPendingHandoff(null);
        }
      }
      setAuthModalOpen(false);
    } catch (err) {
      setAuthError(formatAppError(err, 'Google 登录失败，请重试'));
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
  ): Promise<SessionRecord> => {
    const session = await createConsultationSession(mode, selectedProfiles);
    setSessions((prev) => (prev.some((s) => s.id === session.id) ? prev : [session, ...prev]));
    navigate(`/consult/${session.id}`);
    return session;
  };

  if (pathname === '/privacy') return <LegalPage kind="privacy" />;
  if (pathname === '/terms') return <LegalPage kind="terms" />;

  if (!authReady) {
    return (
      <main className="min-h-screen bg-[#070812] text-[#f8fafc] flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-[16px] border border-[#26304d] bg-[#101527] p-8 flex flex-col gap-4">
          <div className="h-5 w-24 rounded bg-[#1d2540]" />
          <div className="h-8 w-3/4 rounded bg-[#1d2540]" />
          <div className="h-4 w-full rounded bg-[#161d33]" />
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

  return (
    <>
      <WorkbenchPage
        uid={user?.uid ?? null}
        email={user?.email ?? 'Google 用户'}
        displayName={user?.displayName ?? user?.email ?? '未登录访客'}
        photoURL={user?.photoURL ?? null}
        tier={tier}
        usage={usage}
        profiles={profiles}
        sessions={sessions}
        activeSession={activeSession}
        pendingHandoff={pendingHandoff}
        onClearPendingHandoff={() => setPendingHandoff(null)}
        onRequireAuth={(handoff) => {
          setPendingHandoff(handoff);
          setAuthError(null);
          setAuthModalOpen(true);
        }}
        onStartSession={handleStartSession}
        onSelectSession={(sid) => navigate(sid ? `/consult/${sid}` : '/')}
        onSignOut={() => void handleSignOut()}
      />

      <AuthGateModal
        open={authModalOpen}
        busy={authBusy}
        error={authError}
        pendingQuestion={pendingHandoff?.question}
        onConfirmLogin={() => void handleConfirmGoogleLogin()}
        onClose={() => {
          setAuthModalOpen(false);
          setPendingHandoff(null);
        }}
      />
    </>
  );
}
