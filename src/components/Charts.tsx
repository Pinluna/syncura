import type { CycleInfo } from "../lib/cycle";
import { PHASE_LABEL, dayKind, todayKey, type HormonePoint } from "../lib/cycle";
import type { CycleSettings, PeriodFlow } from "../lib/api";

/* ------------------------------------------------------------------ hormone chart */

const SERIES = [
  { key: "estradiol", label: "Estradiol", color: "var(--chart-color-1)" },
  { key: "progesterone", label: "Progesterone", color: "var(--chart-color-2)" },
  { key: "lh", label: "LH", color: "var(--chart-color-3)" },
  { key: "fsh", label: "FSH", color: "var(--chart-color-4)" },
] as const;

export type SeriesKey = (typeof SERIES)[number]["key"];

export function HormoneChart({
  data,
  ovulationDay,
  active,
  onToggle,
}: {
  data: HormonePoint[];
  ovulationDay: number;
  active: Record<SeriesKey, boolean>;
  onToggle: (key: SeriesKey) => void;
}) {
  const W = 320;
  const H = 160;
  const pad = { l: 26, r: 8, t: 10, b: 20 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = Math.max(...data.map((d) => Math.max(d.estradiol, d.progesterone, d.lh, d.fsh)), 1);
  const x = (day: number) => pad.l + ((day - 1) / Math.max(1, data.length - 1)) * iw;
  const y = (v: number) => pad.t + ih - (v / max) * ih;

  return (
    <div className="stack" style={{ gap: "0.5rem" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Hormone levels across a cycle"
        style={{ overflow: "visible" }}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={pad.t + ih - f * ih}
              y2={pad.t + ih - f * ih}
              stroke="var(--border-strong)"
              strokeDasharray={f === 0 ? undefined : "3 4"}
              strokeWidth={1}
            />
            <text x={pad.l - 5} y={pad.t + ih - f * ih + 3} fontSize={8} textAnchor="end" fill="var(--muted-foreground)">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        <rect
          x={x(ovulationDay) - 5}
          y={pad.t}
          width={10}
          height={ih}
          fill="var(--accent)"
          opacity={0.16}
          rx={5}
        />
        <text x={x(ovulationDay)} y={pad.t + 9} fontSize={8} textAnchor="middle" fill="var(--accent)" fontWeight={700}>
          ovulation
        </text>
        {SERIES.filter((s) => active[s.key]).map((s) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={data.map((d) => `${x(d.day).toFixed(1)},${y(d[s.key]).toFixed(1)}`).join(" ")}
          />
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} stroke="var(--border-strong)" />
      </svg>
      <div className="chips">
        {SERIES.map((s) => (
          <button
            key={s.key}
            type="button"
            className="chip"
            aria-pressed={active[s.key]}
            onClick={() => onToggle(s.key)}
            style={active[s.key] ? { background: s.color, borderColor: "transparent", color: "#fff" } : undefined}
          >
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: 999,
                background: s.color,
                marginRight: 6,
              }}
            />
            {s.label}
          </button>
        ))}
      </div>
      <span className="fine">Relative hormone curves — estimates, not contraception advice.</span>
    </div>
  );
}

/* ------------------------------------------------------------------ calendar */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DOW = ["M", "T", "W", "T", "F", "S", "S"];

export function CycleCalendar({
  month,
  cfg,
  onMonth,
  selectedDay,
  onSelectDay,
  intimacyCounts = {},
  canLogPeriod = false,
}: {
  month: Date;
  cfg: CycleSettings;
  onMonth: (next: Date) => void;
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
  intimacyCounts?: Record<string, number>;
  canLogPeriod?: boolean;
}) {
  const today = todayKey();
  const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const daysInMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i + 1)).toISOString().slice(0, 10),
    ),
  ];

  const shift = (n: number) =>
    onMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + n, 1)));

  return (
    <div className="stack" style={{ gap: "0.6rem" }}>
      <div className="row">
        <button type="button" className="btn outline sm" onClick={() => shift(-1)} aria-label="Previous month">
          ‹
        </button>
        <strong className="grow" style={{ textAlign: "center", fontFamily: "var(--font-family-display)" }}>
          {MONTHS[month.getUTCMonth()]} {month.getUTCFullYear()}
        </strong>
        <button type="button" className="btn outline sm" onClick={() => shift(1)} aria-label="Next month">
          ›
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 3,
        }}
      >
        {DOW.map((d, i) => (
          <div key={i} className="eyebrow" style={{ textAlign: "center", fontSize: "0.58rem" }}>
            {d}
          </div>
        ))}
        {cells.map((key, i) => {
          if (!key) return <div key={`x${i}`} />;
          const kind = dayKind(key, cfg);
          const isToday = key === today;
          const isSelected = key === selectedDay;
          const inLoggedPeriod = cfg.periodDays?.includes(key) ?? false;
          const flow: PeriodFlow = cfg.periodFlow?.[key] ?? "medium";
          const predictedPeriod = kind === "period" && !inLoggedPeriod;
          const intimacyCount = intimacyCounts[key] ?? 0;
          const day = Number(key.slice(-2));
          return (
            <button
              type="button"
              key={key}
              className={[
                "calendar-day",
                kind === "period" ? "period" : "",
                predictedPeriod ? "predicted" : "",
                inLoggedPeriod ? `logged flow-${flow}` : "",
                kind === "ovulation" ? "ovulation" : "",
                kind === "fertile" ? "fertile" : "",
                isToday ? "today" : "",
                isSelected ? "selected" : "",
              ].filter(Boolean).join(" ")}
              title={key}
              aria-pressed={isSelected}
              aria-label={`${key}${inLoggedPeriod ? `, logged period, ${flow} flow` : predictedPeriod ? ", predicted period" : ""}${intimacyCount ? `, intimacy ${intimacyCount}` : ""}`}
              disabled={canLogPeriod && key > today}
              onClick={() => onSelectDay?.(key)}
            >
              <span className="calendar-day-number">{day}</span>
              {intimacyCount > 0 && (
                <span className="calendar-intimacy" aria-hidden="true">
                  {"♥".repeat(intimacyCount)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="chips" style={{ fontSize: "0.68rem" }}>
        <span className="pill calendar-legend-dotted">
          Predicted period
        </span>
        <span className="pill calendar-legend-logged">
          Logged period
        </span>
        <span className="pill calendar-legend-flow-light">Light</span>
        <span className="pill calendar-legend-flow-medium">Medium</span>
        <span className="pill calendar-legend-flow-heavy">Heavy</span>
        <span className="pill" style={{ background: "color-mix(in oklab, var(--accent) 22%, transparent)", color: "var(--accent)" }}>
          Ovulation
        </span>
        <span className="pill" style={{ background: "color-mix(in oklab, var(--success) 18%, transparent)", color: "var(--success)" }}>
          Fertile
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ summary */

export function CycleSummary({ info }: { info: CycleInfo | null }) {
  if (!info) {
    return (
      <span className="sub">
        Set your last period start in <strong>Settings</strong> to unlock cycle predictions.
      </span>
    );
  }
  return (
    <div className="stack" style={{ gap: "0.5rem" }}>
      <div className="row">
        <span className="badge success">{PHASE_LABEL[info.phase]}</span>
        <span className="sub">Cycle day {info.cycleDay} of {info.cycleLength}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Next</dt>
          <dd>{info.daysUntilNext} d</dd>
        </div>
        <div>
          <dt>Ovulation</dt>
          <dd>{info.ovulationDate.slice(5).replace("-", "/")}</dd>
        </div>
        <div>
          <dt>Period</dt>
          <dd>{info.periodLength} d</dd>
        </div>
      </dl>
      {info.isFuturePeriodLogged && (
        <span className="fine">
          Your period start is dated in the future — predictions are estimated from that date.
        </span>
      )}
    </div>
  );
}

