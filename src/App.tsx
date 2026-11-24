import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider, useSession } from "./lib/session";
import { ToastProvider } from "./components/ToastProvider";
import { Shell, NAV } from "./components/Shell";
import { useRouter } from "./lib/router";
import Splash from "./screens/Splash";
import Register from "./screens/Register";
import Home from "./screens/Home";
import Cycle from "./screens/Cycle";
import Chat from "./screens/Chat";
import Together from "./screens/Together";
import Connect from "./screens/Connect";
import Settings from "./screens/Settings";
import { useAccentTheme } from "./lib/themes";
import { useBackExit } from "./lib/useBackExit";
import { Backdrop } from "./components/Backdrop";
import { DeviceStatusSync } from "./components/DeviceStatusSync";
import { PushRegistration } from "./components/PushRegistration";
import { setKeepAlive } from "./lib/callAlerts";
import { installImmersiveBridge } from "./lib/immersive";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000, networkMode: "always" },
  },
});

/* /register is the sign-up form, and it is reachable from Settings rather than
   from the first screen: there is no welcome screen any more, so a fresh install
   lands straight on the loading screen and then either the app or the form.
   Hoisted so the effect below does not re-run on every render just because the
   list is a new array each time. */
const SIGNED_OUT_PATHS = ["/register"];

/* The loading screen is shown while the session resolves, and for at least this
   long afterwards.

   Without the floor it is a one-frame flash on a fast phone: the session usually
   resolves in well under a second, so the mark and the credit would never be
   seen at all. Holding it briefly is what makes the group readable, and it is
   also the only thing that makes it observable by a test. */
const SPLASH_MINIMUM_MS = 900;

function Routes() {
  const { path, go } = useRouter();
  const { me, loading, resolved } = useSession();
  useAccentTheme();

  /* The path the app was launched on, captured once.

     In the Android WebView the URL survives the process being killed, so an
     install that was last sitting on /register reopens on /register even though
     the stored token is still good. That stranded a signed-in person on the
     sign-up form on every launch, which read as "logged out" and led to a fresh
     account being created each time. */
  const [bootPath] = useState(() => window.location.pathname);

  /* Set as soon as the app moves off the path it launched on.

     Opening /register on purpose -- from Settings, to add a second account --
     also has to keep working, and it happens after the launch, so the launch
     path on its own cannot tell the two apart. Once anything has navigated,
     wherever the app is afterwards is a place somebody asked to be. */
  const hasNavigated = useRef(false);
  useEffect(() => {
    if (path !== bootPath) hasNavigated.current = true;
  }, [path, bootPath]);

  /* Started at mount rather than when loading flips, so the floor is measured
     from the app opening rather than from however long the request took. */
  const [splashUntil] = useState(() => Date.now() + SPLASH_MINIMUM_MS);
  const [splashDone, setSplashDone] = useState(false);
  useEffect(() => {
    if (loading) return;
    const remaining = splashUntil - Date.now();
    if (remaining <= 0) {
      setSplashDone(true);
      return;
    }
    const timer = window.setTimeout(() => setSplashDone(true), remaining);
    return () => window.clearTimeout(timer);
  }, [loading, splashUntil]);

  /* The sign-up form is deliberately off the nav: it is reached from Settings so
     it never interrupts someone just opening the app. */
  const known = ["/register", ...NAV.map((n) => n.path)];

  /* Registered here rather than in the shell so the sign-up form is covered too:
     there is nowhere "Home" to go back to before an account exists, so it joins
     Home in asking twice. */
  useBackExit(path, (next) => go(next, true));

  /* Gated on `resolved`, not on `!loading`.

     `loading` is false both when there is genuinely no account and during the
     window before the session has been asked, and this effect used to treat
     those two the same. So on a launch that reopened on /home -- which is what
     the Android WebView restores after the process is killed -- the app jumped
     to /register before /me had answered, that counted as having navigated, and
     the redirect back below then refused to fire because it read the move as
     somebody opening the form on purpose. A perfectly good session ended up
     looking signed out. Waiting for the answer means the form is only ever
     reached by somebody who really has no account. */
  useEffect(() => {
    if (resolved && !me && !SIGNED_OUT_PATHS.includes(path)) {
      go("/register", true);
    }
  }, [resolved, me, path, go]);

  /* Reopening on /register with a live session goes to the app instead.

     Only when the app has not moved since it launched: that is the reopened
     case, whereas a trip to /register made after navigating is somebody opening
     the form on purpose. Waits for `resolved` so this only runs once the
     session has actually answered -- redirecting while the answer was still in
     flight would flash the home screen at somebody genuinely signed out. */
  useEffect(() => {
    if (!resolved || loading) return;
    if (me && path === "/register" && !hasNavigated.current) {
      go("/home", true);
    }
  }, [resolved, loading, me, path, go]);

  /* A man without a partner can only enter her link, so he is held on the
     linking screen -- but only once the answer is actually in. Deciding from a
     half-settled query is what used to strand him there after linking: the
     screen was still showing "not connected" while the pair was already set up,
     so he never got out of it on the web or in the app. Once the link is real
     the hold lifts and Connect renders the paired view, which is a normal tab
     again rather than a dead end. */
  const linked = Boolean(me?.link?.connected);
  const maleNeedsPartner = me?.user.sex === "male" && !linked;
  const maleGateSettled = resolved && !loading;

  useEffect(() => {
    if (maleGateSettled && maleNeedsPartner && path !== "/connect") {
      go("/connect", true);
    }
  }, [maleGateSettled, maleNeedsPartner, path, go]);

  useEffect(() => {
    document.title = path === "/register" ? "Syncura" : `Syncura · ${path.slice(1)}`;
  }, [path]);

  /* The loading screen, and nothing else: it is shown while the session resolves
     and for the brief minimum afterwards. It is not a destination and not in the
     router -- there is no /welcome to navigate back to any more. */
  if (loading || !splashDone) {
    return <Splash />;
  }

  /* Signed out: the sign-up form. With no account there is nowhere else to go, so
     it is shown outside the shell rather than inside a tab bar that belongs to
     somebody else. */
  if (!me) {
    return <Register />;
  }

  if (maleNeedsPartner && maleGateSettled) return <Connect />;

  if (!known.includes(path)) {
    go("/home", true);
    return null;
  }

  /* Signing in a second account from Settings replaces this one on submit, so
     the form has to render even while somebody is already signed in. It sits
     outside the shell for that reason. */
  if (path === "/register") return <Register />;

  const screen = (() => {
    switch (path) {
      case "/cycle":
        return <Cycle />;
      case "/chat":
        return <Chat />;
      case "/together":
        return <Together />;
      case "/connect":
        return <Connect />;
      case "/settings":
        return <Settings />;
      default:
        return <Home />;
    }
  })();

  return (
    <Shell path={path} go={go}>
      {screen}
    </Shell>
  );
}

export default function App() {
  /* Lets the native side re-assert immersive mode and hand over a call that
     arrived while the page was not running. Installed once, above everything. */
  useEffect(() => {
    installImmersiveBridge();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ToastProvider>
          <DeviceStatusSync />
          <PushRegistration />
          <KeepAlive />
          <Backdrop />
          <Routes />
        </ToastProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

/**
 * Holds the process alive while there is a signed-in account.
 *
 * Chat and calls travel over a socket, so without this Android reclaims the app
 * and nothing arrives with it closed -- which is the whole point of being able to
 * be reached. Started on sign-in and stopped on sign-out, so a signed-out app is
 * not holding a connection open behind the user's back.
 */
function KeepAlive() {
  const { me } = useSession();

  useEffect(() => {
    if (!me) return;
    void setKeepAlive(true);
  }, [me]);

  return null;
}

