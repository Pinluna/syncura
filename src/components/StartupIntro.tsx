import { useEffect, useRef, useState } from "react";
import { useSession } from "../lib/session";

const MINIMUM_SHOW_MS = 3000;
const FADE_OUT_MS = 720;

export function StartupIntro() {
  const { loading } = useSession();
  const startedAt = useRef(Date.now());
  const [exiting, setExiting] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (loading || exiting || dismissed) return;
    const remaining = Math.max(0, MINIMUM_SHOW_MS - (Date.now() - startedAt.current));
    const timer = window.setTimeout(() => setExiting(true), remaining);
    return () => window.clearTimeout(timer);
  }, [loading, exiting, dismissed]);

  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => setDismissed(true), FADE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  if (dismissed) return null;

  return (
    <div
      className={`startup-intro ${exiting ? "is-exiting" : ""}`}
      role="status"
      aria-label="Syncura, made by Luna"
    >
      <div className="startup-main-mark">
        <img src="/syncura-full-mark.png" alt="Syncura" />
      </div>
      <div className="startup-credit">
        <img src="/luna-mark.png" alt="" />
        <span>MADE BY LUNA</span>
      </div>
    </div>
  );
}
