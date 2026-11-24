import { useCallback, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { useToast } from "../components/ToastProvider";

/* How long the second press has to arrive. Long enough to notice the hint,
   short enough that a second back press never feels like it did nothing. */
const CONFIRM_WINDOW_MS = 2200;

/* Android's back gesture belongs to the app, not the WebView's history: the
   default behaviour walks out of Syncura from whichever tab happened to be
   open, which loses the reader's place without warning.

   Instead, back from any tab lands on Home, and back from Home asks once before
   it leaves. Two presses from Home is the only way out, so nothing is closed by
   accident while scrolling or reading. */
export function useBackExit(path: string, go: (next: string) => void) {
  const toast = useToast();
  const armedAt = useRef(0);
  const armedPath = useRef("");
  const atHome = path === "/home" || path === "/welcome";

  const leave = useCallback(() => {
    armedAt.current = 0;
    void CapApp.exitApp();
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const listener = CapApp.addListener("backButton", () => {
      if (!atHome) {
        armedAt.current = 0;
        go("/home");
        return;
      }

      const now = Date.now();
      if (armedPath.current === path && now - armedAt.current <= CONFIRM_WINDOW_MS) {
        leave();
        return;
      }

      armedPath.current = path;
      armedAt.current = now;
      toast.show("Press back again to leave Syncura");
    });

    return () => {
      armedAt.current = 0;
      void listener.then((handle) => handle.remove());
    };
  }, [atHome, path, go, leave, toast]);
}