import { useEffect, useState } from "react";
import { loadWallpaper } from "../lib/wallpaper";

export function Backdrop({ personalize = true }: { personalize?: boolean }) {
  const [wallpaper, setWallpaper] = useState<Blob | null>(null);
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!personalize) return;
    let alive = true;
    const refresh = () => {
      void loadWallpaper()
        .then((value) => {
          if (alive) setWallpaper(value);
        })
        .catch((error: unknown) => {
          console.error("Could not load the saved wallpaper", error);
        });
    };
    refresh();
    window.addEventListener("syncura:wallpaper-changed", refresh);
    return () => {
      alive = false;
      window.removeEventListener("syncura:wallpaper-changed", refresh);
    };
  }, [personalize]);

  useEffect(() => {
    if (!wallpaper) {
      setWallpaperUrl(null);
      return;
    }
    const url = URL.createObjectURL(wallpaper);
    setWallpaperUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [wallpaper]);

  return (
    <>
      {personalize && wallpaperUrl && (
        <div className="personal-wallpaper" aria-hidden>
          {wallpaper?.type.startsWith("video/") ? (
            <video src={wallpaperUrl} autoPlay muted loop playsInline />
          ) : (
            <img src={wallpaperUrl} alt="" />
          )}
        </div>
      )}
      <div className="mesh" aria-hidden />
      <div className="liquid" aria-hidden>
        <svg width="0" height="0" style={{ position: "absolute" }}>
          <defs>
            <filter id="syncura-goo">
              <feGaussianBlur in="SourceGraphic" stdDeviation="42" result="blur" />
              <feColorMatrix
                in="blur"
                mode="matrix"
                values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -12"
              />
            </filter>
          </defs>
        </svg>
        <i className="b1" />
        <i className="b2" />
        <i className="b3" />
        <i className="b4" />
        <i className="b5" />
      </div>
      <div className="clear-liquid" aria-hidden>
        <i className="clear-liquid-shape shape-a" />
        <i className="clear-liquid-shape shape-b" />
        <i className="clear-liquid-shape shape-c" />
        <i className="clear-liquid-shape shape-d" />
      </div>
    </>
  );
}
