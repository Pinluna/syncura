import type { CycleSettings } from "./api";

const DAY = 86_400_000;

export const todayKey = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    .toISOString()
    .slice(0, 10);
};

export const parseKey = (key: string): number => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

export const toKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (key: string, n: number): string => toKey(parseKey(key) + n * DAY);

export const diffDays = (a: string, b: string): number => Math.round((parseKey(a) - parseKey(b)) / DAY);

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function periodLen(cfg: CycleSettings): number {
  return cfg.periodLength;
}

/* Ovulation sits 14 days before the next period starts. */
export const ovulationOffset = (cfg: CycleSettings): number => cfg.cycleLength - 14 - 1;

/* Two days after ovulation are marked unsafe rather than fertile: the egg is
   gone but the body has not settled yet. */
export const POST_OVULATION_UNSAFE = 2;

function cycleStart(cfg: CycleSettings): string | null {
  const logged = [...new Set(cfg.periodDays ?? [])].sort();
  if (logged.length === 0) return cfg.lastPeriodStart;

  let runStart = logged[0];
  let previous = logged[0];
  for (const day of logged.slice(1)) {
    if (diffDays(day, previous) > 1) runStart = day;
    previous = day;
  }
  return runStart;
}

export type DayKind = "period" | "ovulation" | "fertile" | null;

/* Nothing is predicted until the account owner has chosen her own cycle, so a
   fresh account shows an empty calendar rather than somebody else's guess. */
export function isCycleConfigured(cfg: CycleSettings): boolean {
  return cfg.cycleConfigured !== false;
}

export function isDismissed(dateKey: string, cfg: CycleSettings): boolean {
  return (cfg.ignoredDates ?? []).includes(dateKey);
}

export function dayKind(dateKey: string, cfg: CycleSettings): DayKind {
  if (cfg.periodDays?.includes(dateKey)) return "period";
  if (!isCycleConfigured(cfg)) return null;
  if (isDismissed(dateKey, cfg)) return null;
  const start = cycleStart(cfg);
  if (!start) return null;
  const t = diffDays(dateKey, start);
  const r = mod(t, cfg.cycleLength);
  if (r < periodLen(cfg)) return "period";
  const n = ovulationOffset(cfg);
  if (r === n) return "ovulation";
  if (r >= n - 5 && r <= n + POST_OVULATION_UNSAFE) return "fertile";
  return null;
}

/* The days right after ovulation that the calendar marks as unsafe. */
export function isUnsafeAfterOvulation(dateKey: string, cfg: CycleSettings): boolean {
  if (cfg.periodDays?.includes(dateKey)) return false;
  if (!isCycleConfigured(cfg) || isDismissed(dateKey, cfg)) return false;
  const start = cycleStart(cfg);
  if (!start) return false;
  const n = ovulationOffset(cfg);
  const r = mod(diffDays(dateKey, start), cfg.cycleLength);
  return r > n && r <= n + POST_OVULATION_UNSAFE;
}

export interface CycleInfo {
  cycleDay: number;
  cycleLength: number;
  phase: "menstrual" | "follicular" | "fertile" | "luteal";
  kind: DayKind;
  nextPeriod: string;
  daysUntilNext: number;
  ovulationDate: string;
  isFuturePeriodLogged: boolean;
  periodLength: number;
  periodOngoing: boolean;
  unsafeDates: string[];
  configured: boolean;
}

export function getCycleInfo(cfg: CycleSettings, today = todayKey()): CycleInfo | null {
  if (!isCycleConfigured(cfg)) return null;
  const startDate = cycleStart(cfg);
  if (!startDate) return null;
  const t = diffDays(today, startDate);
  const r = mod(t, cfg.cycleLength);
  const start = addDays(today, -r);
  const next = addDays(start, cfg.cycleLength);
  const kind = dayKind(today, cfg);
  const offset = ovulationOffset(cfg);
  const len = periodLen(cfg);
  const unsafeDates = Array.from({ length: POST_OVULATION_UNSAFE }, (_, i) =>
    addDays(start, offset + i + 1),
  );

  let phase: CycleInfo["phase"] = "follicular";
  if (r < len) phase = "menstrual";
  else if (kind === "fertile" || kind === "ovulation") phase = "fertile";
  else if (r > offset + POST_OVULATION_UNSAFE) phase = "luteal";

  return {
    cycleDay: r + 1,
    cycleLength: cfg.cycleLength,
    phase,
    kind,
    nextPeriod: next,
    daysUntilNext: diffDays(next, today),
    ovulationDate: addDays(start, offset),
    isFuturePeriodLogged: t < 0,
    periodLength: len,
    periodOngoing: kind === "period",
    unsafeDates,
    configured: true,
  };
}

export const PHASE_LABEL: Record<CycleInfo["phase"], string> = {
  menstrual: "Period",
  follicular: "Follicular phase",
  fertile: "Fertile window",
  luteal: "Luteal phase",
};

const gauss = (x: number, mu: number, sig: number) => Math.exp(-((x - mu) ** 2) / (2 * sig ** 2));
const clamp100 = (v: number) => Math.round(Math.max(0, Math.min(100, v)));

export interface HormonePoint {
  day: number;
  estradiol: number;
  progesterone: number;
  lh: number;
  fsh: number;
}

export function hormoneCurve(cycleLength: number): HormonePoint[] {
  const a = cycleLength - 14;
  return Array.from({ length: cycleLength }, (_, i) => {
    const day = i + 1;
    return {
      day,
      estradiol: clamp100(14 + 62 * gauss(day, a - 1.5, 3.1) + 30 * gauss(day, a + 7, 3.6)),
      progesterone: clamp100(4 + 92 * gauss(day, a + 7, 3.7)),
      lh: clamp100(7 + 93 * gauss(day, a - 0.6, 0.9)),
      fsh: clamp100(22 + 26 * gauss(day, 3, 3.2) + 38 * gauss(day, a - 0.6, 1.3)),
    };
  });
}

export const FEELINGS = [
  "Happy",
  "Calm",
  "Energetic",
  "Loving",
  "Tired",
  "Anxious",
  "Sad",
  "Irritable",
  "Cramps",
  "Headache",
  "Bloating",
  "Cravings",
  "Backache",
  "Nausea",
] as const;

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;

export const CYCLE_LENGTHS = [28, 29, 30, 31, 32, 33, 34, 35, 36];
export const PERIOD_LENGTHS = [2, 3, 4, 5, 6];

export const WATER_GOAL = 8;

export const haversine = (
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number => {
  const R = 6371e3;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

export const relativeTime = (iso: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
};

export const formatTimestamp = (iso: string): string =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

