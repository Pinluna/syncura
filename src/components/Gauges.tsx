import { useId } from "react";

export function CycleRing({
  cycleDay,
  cycleLength,
  periodLength,
  phase,
}: {
  cycleDay: number;
  cycleLength: number;
  periodLength: number;
  phase: string;
}) {
  const gradId = useId();
  const R = 76;
  const C = 2 * Math.PI * R;
  const pct = Math.min(1, Math.max(0, cycleDay / cycleLength));
  const arc = C * pct;
  const ringPct = Math.min(1, periodLength / cycleLength);
  const ringArc = C * ringPct;
  const dayLabel = Math.min(cycleDay, cycleLength);

  return (
    <div style={{ position: "relative", display: "grid", placeItems: "center" }}>
      <svg width={200} height={200} viewBox="0 0 200 200" role="img" aria-label={`Cycle day ${dayLabel} of ${cycleLength}`}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--primary)" />
            <stop offset="100%" stopColor="var(--accent)" />
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r={R} fill="none" stroke="var(--muted)" strokeWidth={13} />
        <circle
          cx="100"
          cy="100"
          r={R}
          fill="none"
          stroke="var(--error)"
          strokeWidth={13}
          strokeLinecap="round"
          strokeDasharray={`${ringArc} ${C - ringArc}`}
          transform="rotate(-90 100 100)"
          opacity={0.85}
        />
        <circle
          cx="100"
          cy="100"
          r={R}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={7}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${C - arc}`}
          transform="rotate(-90 100 100)"
        />
        <circle
          cx={100 + R * Math.cos(-Math.PI / 2 + Math.PI * 2 * pct)}
          cy={100 + R * Math.sin(-Math.PI / 2 + Math.PI * 2 * pct)}
          r={5.5}
          fill="var(--accent)"
        />
      </svg>
      <div style={{ position: "absolute", textAlign: "center" }}>
        <div className="eyebrow">Day</div>
        <div style={{ fontFamily: "var(--font-family-display)", fontSize: "2.6rem", fontWeight: 700, lineHeight: 1 }}>
          {dayLabel}
        </div>
        <div className="sub" style={{ fontSize: "0.72rem" }}>{phase}</div>
      </div>
    </div>
  );
}

export function WaterGlass({
  label,
  glasses,
  goal,
  editable = true,
  onSet,
}: {
  label?: string;
  glasses: number;
  goal: number;
  editable?: boolean;
  onSet: (next: number) => void;
}) {
  const filled = Math.min(glasses, goal);
  const pct = goal ? Math.min(1, filled / goal) : 0;

  return (
    <div className="row" style={{ gap: "0.9rem", alignItems: "center" }}>
      <div style={{ position: "relative", width: 74, flex: "none" }}>
        <svg width={74} height={92} viewBox="0 0 74 92" role="img" aria-label={`${glasses} of ${goal} glasses`}>
          <defs>
            <clipPath id="syncura-glass-clip">
              <path d="M10 8h54l-6 74a10 10 0 0 1-10 9H26a10 10 0 0 1-10-9L10 8Z" />
            </clipPath>
          </defs>
          <path
            d="M10 8h54l-6 74a10 10 0 0 1-10 9H26a10 10 0 0 1-10-9L10 8Z"
            fill="var(--muted)"
            stroke="var(--border-strong)"
            strokeWidth={2}
          />
          <rect
            x={10}
            y={91 - 83 * pct}
            width={54}
            height={83 * pct}
            fill="var(--info)"
            opacity={0.55}
            clipPath="url(#syncura-glass-clip)"
          />
          <line
            x1={10}
            x2={64}
            y1={91 - 83 * pct}
            y2={91 - 83 * pct}
            stroke="var(--info)"
            strokeWidth={2.5}
            opacity={0.9}
            clipPath="url(#syncura-glass-clip)"
          />
        </svg>
        <div
          style={{
            position: "absolute",
            insetInline: 0,
            bottom: -4,
            textAlign: "center",
            fontSize: "0.7rem",
            fontWeight: 700,
          }}
        >
          {filled}/{goal}
        </div>
      </div>
      <div className="grow stack" style={{ gap: "0.5rem" }}>
        {label && <strong>{label}</strong>}
        <div className="chips">
          {Array.from({ length: goal }, (_, i) => (
            <button
              key={i}
              type="button"
              className={`chip ${i < glasses ? "on" : ""}`}
              aria-label={`Set water to ${i + 1} glass${i ? "s" : ""}`}
              aria-pressed={i < glasses}
              disabled={!editable}
              style={{ padding: "0.25rem 0.55rem", fontSize: "0.7rem" }}
              onClick={() => onSet(glasses === i + 1 ? i : i + 1)}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <span className="fine">
          {glasses >= goal ? "Goal reached — lovely." : `${goal - glasses} more to reach today's goal.`}
        </span>
      </div>
    </div>
  );
}
