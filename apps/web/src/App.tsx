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
  loadLocalSessions,
  loadLocalUsage,
  saveCachedChart,
  saveProfile,
  subscribeProfiles,
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
    const unsubAuth = onIdTokenChanged(auth, async (nextUser) => {
      if (unsubProfiles) {
        unsubProfiles();
        unsubProfiles = undefined;
      }

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

      setSessions(loadLocalSessions(nextUser.uid));
      setUsage(loadLocalUsage(nextUser.uid));

      unsubProfiles = subscribeProfiles(nextUser.uid, setProfiles);
      setAuthReady(true);
    });

    return () => {
      unsubAuth();
      if (unsubProfiles) unsubProfiles();
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
          const session = createConsultationSession(
            uid,
            tier,
            pendingHandoff.mode,
            chosen.length > 0 ? chosen : [savedProfiles[0]],
          );
          setSessions(loadLocalSessions(uid));
          navigate(`/consult/${session.id}`);
        } else {
          setPendingHandoff(null);
        }
      }
      setAuthModalOpen(false);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google 登录失败，请重试');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const handleStartSession = (mode: ConsultationMode, selectedProfiles: ProfileRecord[]): SessionRecord => {
    const session = createConsultationSession(user!.uid, tier, mode, selectedProfiles);
    setSessions(loadLocalSessions(user!.uid));
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
        onUsageChange={setUsage}
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
