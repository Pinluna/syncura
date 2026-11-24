import { useEffect, useState } from "react";

export function useRouter() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    window.addEventListener("syncura:navigate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("syncura:navigate", onPop);
    };
  }, []);

  const go = (next: string, replace = false) => {
    if (next === window.location.pathname) return;
    if (replace) window.history.replaceState({}, "", next);
    else window.history.pushState({}, "", next);
    window.scrollTo(0, 0);
    setPath(next);
  };

  return { path, go };
}

export const navigate = (next: string) => {
  window.history.pushState({}, "", next);
  window.dispatchEvent(new Event("syncura:navigate"));
};

export function useIsOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

