import type { Todo } from "../lib/api";
import { todayKey } from "../lib/cycle";

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function TaskPowerUp({
  todos,
  day,
  celebrate = false,
}: {
  todos: Todo[];
  /* Which day this page belongs to, so the progress never claims credit for
     tasks ticked off yesterday. */
  day?: string;
  celebrate?: boolean;
}) {
  const today = day ?? todayKey();
  const completed = todos.filter((todo) => todo.done && todo.completedAt === today).length;
  const progress = todos.length ? Math.round((completed / todos.length) * 100) : 0;
  const full = progress === 100;

  return (
    <>
      {/* A ring instead of the old bar, and no heading: the circle reads as
          "how much is done" on its own, so the "Today's power-up" label was
          only repeating it in smaller words. The summary line below carries
          the counts, which the ring cannot. */}
      <div
        className={`task-power ${full ? "is-full" : ""}`}
        role="group"
        aria-label={`Task power: ${progress} percent`}
      >
        <div
          className="power-ring"
          role="progressbar"
          aria-label="Tasks completed today"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <svg viewBox="0 0 124 124" aria-hidden focusable="false">
            <circle className="power-ring-track" cx="62" cy="62" r={RADIUS} />
            <circle
              className="power-ring-fill"
              cx="62"
              cy="62"
              r={RADIUS}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - progress / 100)}
            />
          </svg>
          <span className="power-ring-value">{progress}%</span>
        </div>
        <span className="fine power-ring-note">
          {todos.length
            ? `${completed} of ${todos.length} activities checked off today`
            : "Add a task to start powering up"}
        </span>
      </div>
      {celebrate && full && (
        <div className="task-confetti" aria-hidden="true">
          {Array.from({ length: 36 }, (_, index) => (
            <i
              key={index}
              style={
                {
                  "--confetti-x": `${(index * 47 + 11) % 100}%`,
                  "--confetti-delay": `${(index % 9) * 45}ms`,
                  "--confetti-hue": `${(index * 41) % 360}`,
                  "--confetti-drift": `${((index * 29) % 180) - 90}px`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      )}
    </>
  );
}
