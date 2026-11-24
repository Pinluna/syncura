/* Immersive mode: hiding and restoring Android's system bars.

   A WebView cannot ask the system to hide the status and nav bars on its own --
   the window flags belong to the Activity. This is a tiny web-side bridge that
   the native MainActivity calls into whenever focus returns, so whatever the
   page currently wants (immersive or normal) is re-applied after Android has
   decided otherwise.

   The page never calls this directly; it only flips state through
   setImmersive() below, and the native side reads the resulting flag. Keeping
   the browser side free of Capacitor plugin plumbing means the same code works
   unchanged on the web, where this is simply a no-op. */

type Bridge = {
  setImmersive?: (enabled: boolean) => void;
};

let bridge: Bridge | null = null;
let desired = false;

function nativeBridge(): Bridge | null {
  if (bridge) return bridge;
  const candidate = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> } }).Capacitor;
  if (!candidate?.isNativePlatform?.()) return null;
  const plugins = candidate.Plugins as Record<string, { setImmersive?: (value: boolean) => void }> | undefined;
  const plugin = plugins?.Immersive;
  if (!plugin?.setImmersive) return null;
  bridge = plugin as Bridge;
  return bridge;
}

/**
 * Asks for immersive mode, or gives it back.
 *
 * Refuses to hand the bars back while a surface that needs them is still open --
 * this is called from cleanup paths where an ordering mistake would otherwise
 * leave a fullscreen video with a status bar.
 */
export function setImmersive(enabled: boolean): void {
  desired = enabled;
  nativeBridge()?.setImmersive?.(enabled);
  if (typeof document !== "undefined") {
    document.documentElement.toggleAttribute("data-immersive", enabled);
  }
  if (typeof window !== "undefined" && !enabled) {
    // Leave the viewport alone here: Android restores it when the bars come back,
    // and forcing it on the way out is what causes a visible jump.
    window.dispatchEvent(new Event("syncura:immersive"));
  }
}

export function isImmersive(): boolean {
  return desired;
}

declare global {
  interface Window {
    __syncuraSyncImmersive?: () => void;
    __syncuraIncomingCall?: (call: {
      callId: string;
      mode?: string | null;
      caller?: string | null;
    }) => void;
  }
}

/**
 * Re-applies the current state. Called by the native MainActivity after focus
 * returns, because Android puts the bars back after anything it does not know
 * about: the keyboard, a dialog, a rotation, or the app being switched away and
 * back to.
 */
export function installImmersiveBridge(): void {
  if (typeof window === "undefined") return;

  window.__syncuraSyncImmersive = () => {
    setImmersive(desired);
  };

  /* The bars come back on their own in a few situations the page cannot see. On
     a browser this is a visibilitychange for free; on Android it is the focus
     hook, which the native side calls. Both routes end up here. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") setImmersive(desired);
  });
}