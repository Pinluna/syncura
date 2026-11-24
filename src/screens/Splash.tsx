/* The loading screen.

   One group, always together: the mark-and-wordmark lockup with the small
   "Made By LUNA" credit directly beneath it. They are a single flex column, not
   two independently positioned elements, so there is no arrangement in which one
   appears without the other -- which was the thing that kept going wrong when
   they were placed separately.

   Neither image paints a background. Both are cut-outs, so whatever sits behind
   the splash (the mesh backdrop, or a wallpaper) shows through the empty parts
   and the group reads as one mark rather than two pictures on plates. */
import { useEffect, useState } from "react";
import { isNative } from "../lib/config";

export default function Splash() {
  /* A brief hold so the mark is not a one-frame flash on a fast phone, but never
     long enough to feel like a wait: it disappears as soon as the session
     resolves, and that is usually before this ever runs. */
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 900);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main className="splash" data-ready={ready ? "true" : "false"}>
      <div className="splash-group">
        <div className="splash-mark">
          <img src="/syncura-full-mark.png" alt="Syncura" />
        </div>
        <div className="splash-credit">
          <img src="/syncura-loading-bottom.png" alt="Made by Luna" />
        </div>
      </div>
      {isNative && <span className="splash-note">Loading…</span>}
    </main>
  );
}