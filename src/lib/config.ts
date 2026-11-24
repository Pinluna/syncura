/* Where the API and socket server live.

   In the browser the app is usually served by the same Node process, so the
   current origin is correct. Inside the Capacitor WebView the origin is
   https://localhost, which is the phone itself and never the API, so it must
   be excluded here -- otherwise every call is answered by the bundled
   index.html instead of the server. On a device the base URL therefore has to
   be entered in Settings, or baked in at build time with VITE_NATIVE_API_BASE
   (falling back to VITE_API_BASE). */
import { Capacitor } from "@capacitor/core";

const BASE_KEY = "syncura.apiBase";
const ACCESS_STORE_KEY = "syncura.accessKey";

const injected = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
const nativeInjected = (import.meta.env.VITE_NATIVE_API_BASE as string | undefined)?.trim();
const injectedAccess = (import.meta.env.VITE_ACCESS_KEY as string | undefined)?.trim();

export const isNative = Capacitor.isNativePlatform();

function stored(): string | null {
  try {
    return localStorage.getItem(BASE_KEY);
  } catch {
    return null;
  }
}

function webOrigin(): string | null {
  /* The WebView is deliberately excluded: its origin is never the API. */
  if (isNative || typeof window === "undefined") return null;
  if (!/^https?:$/.test(window.location.protocol)) return null;
  return window.location.origin;
}

const DEFAULT_BASE = "http://localhost:5002";

function normalise(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

/* Splits an invite link into the address of the server and the access code it
   carries. Both the website invite link and the address pasted into Settings on
   the phone can be the same full link, so either route stores the two parts in
   the place each part belongs. */
function splitInvite(value: string): { base: string | null; access: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { base: null, access: null };

  const hash = trimmed.indexOf("#");
  const withoutHash = hash === -1 ? trimmed : trimmed.slice(0, hash);
  let access: string | null = null;
  let base = withoutHash;

  try {
    const parsed = new URL(withoutHash);
    const fromQuery = parsed.searchParams.get("k");
    if (fromQuery) access = fromQuery;
    parsed.searchParams.delete("k");
    base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    /* Not an absolute URL: treat the whole thing as an address. */
  }

  if (!access && hash !== -1) {
    access = new URLSearchParams(trimmed.slice(hash + 1)).get("k");
  }

  return { base: normalise(base), access: access?.trim() ?? null };
}

function storeAccess(value: string | null): void {
  try {
    if (value) localStorage.setItem(ACCESS_STORE_KEY, value);
  } catch {
    /* private mode */
  }
}

/* Read while this module is first evaluated, which happens before the router can
   redirect away from the invite link and take the code with it. */
const INVITE_AT_BOOT: string | null = (() => {
  try {
    if (typeof window === "undefined") return null;
    const fromQuery = new URLSearchParams(window.location.search).get("k");
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("k");
    const found = (fromQuery ?? fromHash)?.trim();
    if (found) storeAccess(found);
    return found ?? null;
  } catch {
    return null;
  }
})();

/* The access code for a server behind an invite link, in the order a visitor is
   most likely to supply it: the link they just opened, the value stored from an
   earlier visit or a pasted Settings address, then a code baked into the build.
   Servers without a gate never ask, so on a home network this stays inert. */
export function accessKey(): string | null {
  if (INVITE_AT_BOOT) return INVITE_AT_BOOT;
  try {
    const saved = localStorage.getItem(ACCESS_STORE_KEY);
    if (saved) return saved;
  } catch {
    /* private mode */
  }
  return injectedAccess ?? null;
}

/* Ready-made headers for the servers that sit behind an invite link. */
export function accessHeader(): Record<string, string> {
  const key = accessKey();
  return key ? { "x-syncura-access": key } : {};
}

export function forgetAccessKey(): void {
  try {
    localStorage.removeItem(ACCESS_STORE_KEY);
  } catch {
    /* ignore */
  }
}

/* A Settings override wins over the build-time default so the app can be
   pointed at a machine on the same network without rebuilding. */
export function apiBase(): string {
  const saved = splitInvite(stored() ?? "");
  if (saved.base) return saved.base;

  if (isNative) {
    const baked = splitInvite(nativeInjected ?? injected ?? "");
    if (baked.access) storeAccess(baked.access);
    return baked.base ?? DEFAULT_BASE;
  }

  return normalise(injected) ?? webOrigin() ?? DEFAULT_BASE;
}

export function apiUrl(path = ""): string {
  return `${apiBase()}/api${path}`;
}

export function socketUrl(): string {
  return apiBase();
}

/* Accepts either a plain address or a whole invite link. */
export function setApiBase(value: string): void {
  try {
    const { base, access } = splitInvite(value);
    if (access) storeAccess(access);
    if (base) localStorage.setItem(BASE_KEY, base);
    else localStorage.removeItem(BASE_KEY);
  } catch {
    /* private mode */
  }
}

export function currentApiBase(): string {
  const saved = splitInvite(stored() ?? "");
  return saved.access ? `${saved.base ?? ""}/?k=${saved.access}` : saved.base ?? "";
}

/* Lets a stale override be dropped if the server it names is unreachable. */
export function clearApiBase(): void {
  try {
    localStorage.removeItem(BASE_KEY);
  } catch {
    /* ignore */
  }
}

