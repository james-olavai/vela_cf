import { useEffect, useState } from 'react';
import { onIdTokenChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  DEFAULT_PRODUCTS,
  TierSchema,
  type CatalogProduct,
  type ProfileRecord,
  type SessionRecord,
  type Tier,
  type UsageRecord,
  utcMonthPeriodStart,
} from '@vela-cf/shared';
import { auth, googleProvider, initAnalyticsConsent } from './lib/firebase';
import { navigate, usePathname } from './lib/router';
import {
  createConsultationSession,
  ensureUserRecord,
  fetchPublishedProducts,
  loadLocalSessions,
  loadLocalUsage,
  subscribeProfiles,
} from './lib/store';
import { AccountPage } from './pages/AccountPage';
import { CatalogPage } from './pages/CatalogPage';
import { ChatPage } from './pages/ChatPage';
import { LegalPage } from './pages/LegalPage';
import { MainPage } from './pages/MainPage';
import { ProfilesPage } from './pages/ProfilesPage';

export function App() {
  const pathname = usePathname();
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [tier, setTier] = useState<Tier>('free');
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [products, setProducts] = useState<CatalogProduct[]>(DEFAULT_PRODUCTS);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [usage, setUsage] = useState<UsageRecord>(() => ({
    periodStart: utcMonthPeriodStart(),
    used: 0,
  }));

  useEffect(() => {
    void initAnalyticsConsent();
    void fetchPublishedProducts().then(setProducts);
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
        setProfilesLoaded(false);
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

      unsubProfiles = subscribeProfiles(nextUser.uid, (list) => {
        setProfiles(list);
        setProfilesLoaded(true);
      });
      setAuthReady(true);
    });

    return () => {
      unsubAuth();
      if (unsubProfiles) unsubProfiles();
    };
  }, []);

  const handleGoogleLogin = async () => {
    const cred = await signInWithPopup(auth, googleProvider);
    await ensureUserRecord(
      cred.user.uid,
      cred.user.email ?? '',
      cred.user.displayName ?? '',
    );
    const unsubTemp = subscribeProfiles(cred.user.uid, (list) => {
      unsubTemp();
      navigate(list.length > 0 ? '/consult' : '/profiles');
    });
  };

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const handleStartSession = (product: CatalogProduct, profile: ProfileRecord) => {
    if (!user) return;
    const session = createConsultationSession(user.uid, product, profile);
    setSessions(loadLocalSessions(user.uid));
    navigate(`/consult/${session.id}`);
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

  if (!user || pathname === '/') {
    return (
      <MainPage
        isSignedIn={Boolean(user)}
        onGoogleLogin={handleGoogleLogin}
        hasProfiles={profilesLoaded && profiles.length > 0}
      />
    );
  }

  if (pathname === '/profiles') {
    return (
      <ProfilesPage
        uid={user.uid}
        tier={tier}
        used={usage.used}
        profiles={profiles}
      />
    );
  }

  if (pathname === '/account') {
    return (
      <AccountPage
        uid={user.uid}
        email={user.email ?? 'Google 用户'}
        tier={tier}
        usage={usage}
        onSignOut={handleSignOut}
      />
    );
  }

  if (pathname.startsWith('/consult/')) {
    const sessionId = pathname.slice('/consult/'.length);
    const activeSession = sessions.find((s) => s.id === sessionId);
    if (activeSession) {
      const activeProfile =
        profiles.find((p) => p.id === activeSession.profileId) ?? profiles[0] ?? null;
      return (
        <ChatPage
          uid={user.uid}
          tier={tier}
          usage={usage}
          session={activeSession}
          sessions={sessions}
          profile={activeProfile}
          onUsageChange={setUsage}
        />
      );
    }
  }

  return (
    <CatalogPage
      tier={tier}
      used={usage.used}
      profiles={profiles}
      products={products}
      sessions={sessions}
      onStartSession={handleStartSession}
    />
  );
}
