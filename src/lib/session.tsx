import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, tokenStore, pushTokenStore, pendingCode, ApiError, type Me } from "./api";
import { ensureKeyPair, wipeKeys } from "./e2ee";
import { connectRealtime, disconnectRealtime, subscribeRealtime } from "./realtime";
import { applyStoredMode } from "./themes";
import { syncPendingWrites } from "./offline";

interface Prefs {
  liveSharing: boolean;
}

const PREFS_KEY = "syncura.prefs";

/* Every cache scoped to the pair goes stale when the link itself changes: the
   partner key, the shared dashboard, the encrypted message log, and the shared
   task list. Listing them once keeps a new link-scoped query from being silently
   left stale on the next link or unlink. */
export async function invalidatePairCaches(queryClient: QueryClient) {
  await Promise.all(
    ["me", "dashboard", "messages", "todos"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}

const readPrefs = (): Prefs => {
  const base: Prefs = { liveSharing: false };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return base;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && "liveSharing" in parsed && typeof parsed.liveSharing === "boolean"
      ? { liveSharing: parsed.liveSharing }
      : base;
  } catch {
    return base;
  }
};

interface SessionValue {
  me: Me | null;
  loading: boolean;
  /* True once the account has been asked for and the answer is in, so the app
     can tell "not connected" apart from "not known yet". The linking screen
     waits for this rather than showing itself on a half-loaded answer. */
  resolved: boolean;
  error: string | null;
  prefs: Prefs;
  setPrefs: (patch: Partial<Prefs>) => void;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
  updateMe: (patch: Partial<Me["settings"]> & { name?: string }) => Promise<void>;
  refresh: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [authed, setAuthed] = useState(() => Boolean(tokenStore.get()));

  useEffect(() => {
    applyStoredMode();
    void ensureKeyPair();
    setBootstrapped(true);
  }, []);

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
    enabled: bootstrapped && authed,
  });

  const me = meQuery.data ?? null;
  const linkId = me?.link?.id ?? null;

  useEffect(() => {
    if (!bootstrapped || !authed) return;
    let active = true;
    const sync = () => {
      if (!navigator.onLine) return;
      void syncPendingWrites(tokenStore.get())
        .then((synced) => {
          if (active && synced > 0) void queryClient.invalidateQueries();
        })
        .catch((error: unknown) => {
          console.error("Could not synchronize saved offline changes", error);
        });
    };
    sync();
    window.addEventListener("online", sync);
    return () => {
      active = false;
      window.removeEventListener("online", sync);
    };
  }, [bootstrapped, authed, queryClient]);

  /* A rejected token means the account was deleted on another device. Drop it
     rather than looping on the error. */
  useEffect(() => {
    if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
      tokenStore.clear();
      setAuthed(false);
      queryClient.clear();
    }
  }, [meQuery.error, queryClient]);

  useEffect(() => {
    if (linkId) connectRealtime(linkId);
    else disconnectRealtime();
  }, [linkId]);

  /* A link changed on the other device, so every link-scoped cache here is
     stale: the partner key, the dashboard, any pending chat, and the shared
     task list all have to refetch. */
  useEffect(
    () =>
      subscribeRealtime({
        onLinkChanged: () => {
          void invalidatePairCaches(queryClient);
        },
      }),
    [queryClient],
  );

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const signIn = useCallback(
    async (token: string) => {
      tokenStore.set(token);
      setAuthed(true);
      await queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const signOut = useCallback(() => {
    const pushToken = pushTokenStore.get();
    if (pushToken && tokenStore.get()) {
      void api.unregisterPushToken(pushToken).catch((error: unknown) => {
        console.error("Could not unregister push notifications during sign-out", error);
      });
    }
    pushTokenStore.clear();
    disconnectRealtime();
    wipeKeys();
    tokenStore.clear();
    pendingCode.clear();
    queryClient.clear();
    setAuthed(false);
  }, [queryClient]);

  const updateMe = useCallback(
    async (patch: Partial<Me["settings"]> & { name?: string }) => {
      const me = await api.settings(patch);
      queryClient.setQueryData<Me>(["me"], me);
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    [queryClient],
  );

  const value = useMemo<SessionValue>(
    () => ({
      me,
      /* Without a stored token there is nothing to fetch, so the app is ready
         immediately and must fall through to the welcome screen. */
      loading: bootstrapped && authed && !meQuery.isSuccess && !meQuery.isError,
      resolved: !authed || !bootstrapped || meQuery.isSuccess || meQuery.isError,
      error: meQuery.error instanceof Error ? meQuery.error.message : null,
      prefs,
      setPrefs,
      signIn,
      signOut,
      updateMe,
      refresh: () => void meQuery.refetch(),
    }),
    [me, bootstrapped, authed, meQuery, prefs, setPrefs, signIn, signOut, updateMe],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

