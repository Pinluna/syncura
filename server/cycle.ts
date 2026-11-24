import type { DailyLog, LiveStatus, Sex, User } from "./store.js";

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

export const diffDays = (a: string, b: string): number =>
  Math.round((parseKey(a) - parseKey(b)) / DAY);

const mod = (a: number, n: number) => ((a % n) + n) % n;

type Cfg = User["settings"];

export function periodLen(cfg: Cfg): number {
  return cfg.periodLength;
}

function cycleStart(cfg: Cfg): string | null {
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

export function dayKind(
  dateKey: string,
  cfg: Cfg,
): "period" | "ovulation" | "fertile" | null {
  if (cfg.periodDays?.includes(dateKey)) return "period";
  const start = cycleStart(cfg);
  if (!start) return null;
  const t = diffDays(dateKey, start);
  const r = mod(t, cfg.cycleLength);
  if (r < periodLen(cfg)) return "period";
  const n = cfg.cycleLength - 14 - 1;
  if (r === n) return "ovulation";
  if (r >= n - 5 && r <= n + 1) return "fertile";
  return null;
}

export interface CycleInfo {
  cycleDay: number;
  cycleLength: number;
  phase: "menstrual" | "follicular" | "fertile" | "luteal";
  kind: "period" | "ovulation" | "fertile" | null;
  nextPeriod: string;
  daysUntilNext: number;
  ovulationDate: string;
  isFuturePeriodLogged: boolean;
  periodLength: number;
  periodOngoing: boolean;
}

export function getCycleInfo(cfg: Cfg, today = todayKey()): CycleInfo | null {
  const startDate = cycleStart(cfg);
  if (!startDate) return null;
  const t = diffDays(today, startDate);
  const r = mod(t, cfg.cycleLength);
  const start = addDays(today, -r);
  const next = addDays(start, cfg.cycleLength);
  const kind = dayKind(today, cfg);
  const ovulationOffset = cfg.cycleLength - 14 - 1;
  const len = periodLen(cfg);

  let phase: CycleInfo["phase"] = "follicular";
  if (r < len) phase = "menstrual";
  else if (kind === "fertile" || kind === "ovulation") phase = "fertile";
  else if (r > ovulationOffset + 1) phase = "luteal";

  return {
    cycleDay: r + 1,
    cycleLength: cfg.cycleLength,
    phase,
    kind,
    nextPeriod: next,
    daysUntilNext: diffDays(next, today),
    ovulationDate: addDays(start, ovulationOffset),
    isFuturePeriodLogged: t < 0,
    periodLength: len,
    periodOngoing: kind === "period",
  };
}

const gauss = (x: number, mu: number, sig: number) => Math.exp(-((x - mu) ** 2) / (2 * sig ** 2));
const clamp100 = (v: number) => Math.round(Math.max(0, Math.min(100, v)));

export function hormones(day: number, cycleLength: number) {
  const a = cycleLength - 14;
  return {
    estradiol: clamp100(14 + 62 * gauss(day, a - 1.5, 3.1) + 30 * gauss(day, a + 7, 3.6)),
    progesterone: clamp100(4 + 92 * gauss(day, a + 7, 3.7)),
    lh: clamp100(7 + 93 * gauss(day, a - 0.6, 0.9)),
    fsh: clamp100(22 + 26 * gauss(day, 3, 3.2) + 38 * gauss(day, a - 0.6, 1.3)),
  };
}

export function hormoneCurve(cycleLength: number) {
  return Array.from({ length: cycleLength }, (_, i) => ({
    day: i + 1,
    ...hormones(i + 1, cycleLength),
  }));
}

const PHASE_TEXT: Record<CycleInfo["phase"], string> = {
  menstrual:
    "Your period is the start of a new cycle. Oestrogen and progesterone are both low, which is why energy often dips here.",
  follicular:
    "Oestrogen is climbing and the lining of the uterus is rebuilding. This is usually the stretch with the most energy and the clearest head.",
  fertile:
    "Oestrogen peaks just before ovulation, and the LH surge is what triggers it. This is the window the predictions are pointing at.",
  luteal:
    "Progesterone is high and the body is preparing for the next period. Energy often softens and cravings come easier in this phase.",
};

export function buildInsight(user: User, today = todayKey()): string | null {
  const info = getCycleInfo(user.settings, today);
  if (!info) return null;
  const until = info.daysUntilNext;
  const nextText =
    until === 0
      ? "Your next period is expected today."
      : until === 1
        ? "Your next period is expected tomorrow."
        : `Your next period is expected in ${until} days, around ${addDays(today, until)}.`;
  return `${PHASE_TEXT[info.phase]} ${nextText}`;
}

export function normaliseLog(patch: Record<string, unknown>): Partial<DailyLog> {
  const out: Record<string, unknown> = {};
  if (typeof patch.waterGlasses === "number") {
    out.waterGlasses = Math.max(0, Math.min(40, Math.round(patch.waterGlasses)));
  }
  if (Array.isArray(patch.feelings)) {
    out.feelings = patch.feelings
      .filter((f): f is string => typeof f === "string")
      .map((f) => f.trim().slice(0, 30))
      .slice(0, 12);
  }
  if (Array.isArray(patch.meals)) {
    out.meals = patch.meals
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
      .slice(0, 20)
      .map((m) => ({
        id: String(m.id ?? ""),
        type: (["breakfast", "lunch", "dinner", "snack"] as const).includes(m.type as never)
          ? (m.type as DailyLog["meals"][number]["type"])
          : "snack",
        text: String(m.text ?? "").trim().slice(0, 120),
        loggedAt: typeof m.loggedAt === "string" ? m.loggedAt.slice(0, 40) : undefined,
      }))
      .filter((m) => m.text.length > 0);
  }
  if (typeof patch.journal === "string") out.journal = patch.journal.slice(0, 8000);
  if (typeof patch.journalShared === "boolean") out.journalShared = patch.journalShared;
  if (typeof patch.intercourseCount === "number") {
    out.intercourseCount = Math.max(0, Math.min(20, Math.round(patch.intercourseCount)));
  }
  return out as Partial<DailyLog>;
}

export function normaliseStatus(patch: Record<string, unknown>): Partial<LiveStatus> {
  const out: Record<string, unknown> = {};

  const numeric = (key: keyof LiveStatus, lo: number, hi: number) => {
    if (!(key in patch)) return;
    const value = patch[key];
    if (value === null) {
      out[key] = null;
      return;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= lo && value <= hi) {
      out[key] = value;
    }
  };

  numeric("latitude", -90, 90);
  numeric("longitude", -180, 180);
  numeric("accuracyM", 0, 100000);
  numeric("batteryLevel", 0, 100);
  numeric("speedMs", 0, 400);
  numeric("headingDeg", 0, 360);
  numeric("stepsToday", 0, 200000);

  if ("activity" in patch) {
    out.activity = ["driving", "idle", "walking", "unknown"].includes(patch.activity as string)
      ? patch.activity
      : "unknown";
  }
  if ("isCharging" in patch) {
    out.isCharging = typeof patch.isCharging === "boolean" ? patch.isCharging : null;
  }

  return out as Partial<LiveStatus>;
}

export function isSex(v: unknown): v is Sex {
  return v === "female" || v === "male";
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

