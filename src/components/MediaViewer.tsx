/* A full-screen viewer for view-once media.

   View-once media is the reason this exists rather than a picture lightbox: the
   attachment has to be downloaded, decrypted and rendered, and closing it has to
   tell the server, so it cannot be delegated to the browser's own image view --
   there is no URL to hand over. That also means the viewer owns the object URL
   and has to revoke it.

   Photos fill the screen edge to edge but keep the status and nav bars: they are
   still content inside a conversation, and a viewer that swallowed the system
   bars made going back feel like leaving the app. Video is the opposite and goes
   truly immersive, because that is what people actually watch fullscreen.

   The screen is a sibling of the chat rather than nested in it, so switching
   tabs cannot leave an open attachment behind with no way back to it. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Play, RotateCcw, X } from "lucide-react";
import { setImmersive } from "../lib/immersive";

export interface ViewerMedia {
  url: string;
  mimeType: string;
  name: string;
  size?: number;
}

function isImage(mimeType: string) {
  return mimeType.startsWith("image/");
}

function isVideo(mimeType: string) {
  return mimeType.startsWith("video/");
}

function humanSize(bytes?: number) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaViewer({
  media,
  note,
  onClose,
}: {
  media: ViewerMedia;
  note?: string;
  onClose: () => void;
}) {
  const immersive = isVideo(media.mimeType);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Immersive is a claim on the whole window, so it is released on the way out
     whatever happened -- closed by the button, by Escape, by back, or by the
     component unmounting because the chat re-rendered. Leaving it set would
     strand the rest of the app without its status bar. */
  useEffect(() => {
    if (!immersive) return;
    setImmersive(true);
    return () => setImmersive(false);
  }, [immersive]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const scheduleHide = useCallback(() => {
    if (!immersive) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsHidden(true), 2800);
  }, [immersive]);

  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [scheduleHide]);

  /* Touching the surface brings the controls back and restarts their timer. On a
     photo there are no controls to show, so this only applies to video. */
  const onSurfaceTap = () => {
    if (!immersive) {
      onClose();
      return;
    }
    setControlsHidden((hidden) => !hidden);
    scheduleHide();
  };

  const togglePlayback = () => {
    const player = video.current;
    if (!player) return;
    if (player.paused) void player.play();
    else player.pause();
    setControlsHidden(false);
    scheduleHide();
  };

  const restart = () => {
    const player = video.current;
    if (!player) return;
    player.currentTime = 0;
    void player.play();
    setControlsHidden(false);
    scheduleHide();
  };

  return (
    <div className="viewer" data-immersive={immersive ? "true" : undefined}>
      <div className="viewer-bar">
        <button type="button" className="btn ghost sm viewer-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <div className="grow">
          <div className="viewer-title">{media.name}</div>
          {humanSize(media.size) && <div className="viewer-sub">{humanSize(media.size)}</div>}
        </div>
        {!immersive && <span className="viewer-sub">Tap outside to close</span>}
      </div>
      <div
        className="viewer-stage"
        data-dismiss={immersive ? undefined : "true"}
        onClick={onSurfaceTap}
      >
        {isImage(media.mimeType) ? (
          <img src={media.url} alt={media.name} />
        ) : isVideo(media.mimeType) ? (
          <>
            <video
              ref={video}
              src={media.url}
              autoPlay
              playsInline
              controls={false}
              onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
            />
            <div className="viewer-controls" data-hidden={controlsHidden ? "true" : undefined}>
              <button type="button" className="viewer-toggle" onClick={togglePlayback} aria-label="Play or pause">
                <Play size={18} />
              </button>
              <button type="button" className="viewer-toggle" onClick={restart} aria-label="Start again">
                <RotateCcw size={18} />
              </button>
              <span className="fine" style={{ color: "#fff", minWidth: "3.5rem" }}>
                {Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, "0")}
              </span>
            </div>
          </>
        ) : (
          <audio src={media.url} controls autoPlay />
        )}
      </div>
      {note && <div className="viewer-note">{note}</div>}
    </div>
  );
}