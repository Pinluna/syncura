import { useCallback, useEffect, useState } from "react";

export type Mode = "light" | "dark" | "auto";

const THEME_KEY = "syncura.theme";
const STYLE_ID = "syncura-accent-theme";

export interface AccentTheme {
  id: string;
  label?: string;
  primary?: string;
  accent?: string;
}

export const ACCENTS: AccentTheme[] = [
  { id: "orchid", label: "Orchid", primary: "#8b5cf6", accent: "#ff5c9d" },
  { id: "aurora", label: "Aurora", primary: "#0ea5a4", accent: "#8b5cf6" },
  { id: "ocean", label: "Ocean", primary: "#3b82f6", accent: "#22d3ee" },
  { id: "sunset", label: "Sunset", primary: "#f97316", accent: "#ec4899" },
  { id: "mint", label: "Mint", primary: "#10b981", accent: "#84cc16" },
  { id: "rose", label: "Rose", primary: "#f43f5e", accent: "#fb923c" },
];

const readTheme = (): AccentTheme => {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (!raw) return { id: "orchid" };
    const parsed = JSON.parse(raw) as AccentTheme;
    return parsed && typeof parsed.id === "string" ? parsed : { id: "orchid" };
  } catch {
    return { id: "orchid" };
  }
};

function applyAccent(theme: AccentTheme) {
  const preset = ACCENTS.find((a) => a.id === theme.id);
  const primary = theme.id === "custom" ? theme.primary : preset?.primary;
  const accent = theme.id === "custom" ? theme.accent : preset?.accent;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!primary || !accent || theme.id === "orchid") {
    style?.remove();
    return;
  }

  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = `
:root {
  --primary: ${primary};
  --primary-foreground: #ffffff;
  --accent: ${accent};
  --accent-foreground: #ffffff;
  --secondary: color-mix(in oklab, ${primary} 14%, transparent);
  --secondary-foreground: color-mix(in oklab, ${primary} 60%, #000);
  --mesh-1: color-mix(in oklab, ${primary} 38%, #fff);
  --mesh-2: color-mix(in oklab, ${accent} 38%, #fff);
  --mesh-3: color-mix(in oklab, ${primary} 18%, #cfe8ff);
  --shadow-focus: 0 0 0 3px color-mix(in oklab, ${primary} 40%, transparent);
  --chart-color-1: ${primary};
  --chart-color-2: ${accent};
}
.dark {
  --primary: color-mix(in oklab, ${primary} 72%, #fff);
  --primary-foreground: #10081f;
  --accent: color-mix(in oklab, ${accent} 78%, #fff);
  --accent-foreground: #10081f;
  --secondary: color-mix(in oklab, ${primary} 24%, transparent);
  --secondary-foreground: color-mix(in oklab, ${primary} 45%, #fff);
  --mesh-1: color-mix(in oklab, ${primary} 55%, #000);
  --mesh-2: color-mix(in oklab, ${accent} 50%, #000);
  --mesh-3: color-mix(in oklab, ${primary} 35%, #06162e);
  --chart-color-1: color-mix(in oklab, ${primary} 72%, #fff);
  --chart-color-2: color-mix(in oklab, ${accent} 78%, #fff);
}`;
}

export function useAccentTheme() {
  const [theme, setThemeState] = useState<AccentTheme>(readTheme);

  useEffect(() => {
    applyAccent(theme);
  }, [theme]);

  const setTheme = useCallback((next: AccentTheme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  return { theme, setTheme };
}

const subscribers = new Set<(mode: Mode) => void>();

export function useThemeMode() {
  const [mode, setModeState] = useState<Mode>(() =>
    document.body.classList.contains("dark") ? "dark" : "light",
  );

  useEffect(() => {
    const listener = (next: Mode) => setModeState(next);
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }, []);

  const setMode = useCallback((next: Mode) => {
    if (next === "auto") {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      const apply = () => document.body.classList.toggle("dark", query.matches);
      query.addEventListener("change", apply);
      apply();
    } else {
      document.body.classList.toggle("dark", next === "dark");
    }
    setModeState(next);
    subscribers.forEach((fn) => fn(next));
    try {
      localStorage.setItem("syncura.mode", next);
    } catch {
      /* ignore */
    }
  }, []);

  return { mode, setMode };
}

export const applyStoredMode = () => {
  try {
    const stored = localStorage.getItem("syncura.mode") as Mode | null;
    if (stored === "dark") document.body.classList.add("dark");
    if (stored === "light") document.body.classList.remove("dark");
  } catch {
    /* ignore */
  }
};
