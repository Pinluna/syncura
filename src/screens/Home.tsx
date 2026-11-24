import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Dashboard } from "../lib/api";
import { Card, ErrorCard, Loading, Icon } from "../components/ui";
import { useSession } from "../lib/session";
import { useToast } from "../components/ToastProvider";
import { CycleRing, WaterGlass } from "../components/Gauges";
import { CycleSummary } from "../components/Charts";
import {
  FEELINGS,
  MEAL_TYPES,
  PHASE_LABEL,
  WATER_GOAL,
  addDays,
  getCycleInfo,
  relativeTime,
  todayKey,
} from "../lib/cycle";
import { subscribeRealtime } from "../lib/realtime";
import { navigate } from "../lib/router";
import { TaskPowerUp } from "../components/TaskPowerUp";

const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
};

export default function Home() {
  const { me } = useSession();
  const toast = useToast();
  const qc = useQueryClient();

  const dash = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const todos = useQuery({ queryKey: ["todos"], queryFn: api.todos });
  const insight = useQuery({
    queryKey: ["insight"],
    queryFn: api.insights,
    enabled: Boolean(dash.data?.logs.length),
    staleTime: 60_000,
  });

  useEffect(
    () =>
      subscribeRealtime({
        onStatus: () => void qc.invalidateQueries({ queryKey: ["dashboard"] }),
        onHydration: () => void qc.invalidateQueries({ queryKey: ["dashboard"] }),
        /* The whole page, so a rollover at midnight empties the list instead of
           leaving yesterday's tasks sitting under today's date. */
        onTodos: (page) => qc.setQueryData(["todos"], page),
        onMessage: () => {},
        onTyping: () => {},
        onPartnerPresence: () => void qc.invalidateQueries({ queryKey: ["dashboard"] }),
      }),
    [qc],
  );

  if (dash.isLoading) {
    return (
      <div className="stack">
        <div className="pageTop">
          <h1>Home</h1>
        </div>
        <Loading rows={4} />
      </div>
    );
  }

  if (!dash.data || !me) {
    return (
      <div className="stack">
        <ErrorCard
          message={dash.error instanceof Error ? dash.error.message : "Could not load your dashboard"}
          onRetry={() => void dash.refetch()}
        />
      </div>
    );
  }

  const data = dash.data;
  const today = todayKey();
  const log = data.logs.find((l) => l.logDate === today);
  const info = getCycleInfo(data.settings, today);
  const items = todos.data?.todos ?? [];
  const openTodos = items.filter((t) => !t.done);
  const partnerOnline = Boolean(data.status);
  /* Whether the day on screen is hers or yours. Compared on identity, not on
     the name: a couple who happen to share a name would otherwise be handed
     the controls for each other's log. */
  const viewingPartner = data.owner.id !== me.user.id;

  const saveWater = async (waterGlasses: number) => {
    try {
      await api.log({ logDate: today, waterGlasses });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save water");
    }
  };

  return (
    <div className="stack">
      <div className="pageTop">
        <h1>{greeting()}{viewingPartner ? `, ${me.user.name}` : `, ${me.user.name.split(" ")[0]}`}</h1>
        <span className="sub">
          {viewingPartner ? `Tracking ${data.owner.name}'s cycle` : "Here's how today is going"}
        </span>
      </div>

      <Card
        title={viewingPartner ? `${data.owner.name}'s cycle` : "Your cycle"}
        icon="calendar"
        badge={info ? PHASE_LABEL[info.phase] : "not set up"}
      >
        {info ? (
          <>
            <CycleRing
              cycleDay={info.cycleDay}
              cycleLength={info.cycleLength}
              periodLength={info.periodLength}
              phase={PHASE_LABEL[info.phase]}
            />
            <CycleSummary info={info} />
          </>
        ) : (
          <CycleSetupPrompt ownerName={viewingPartner ? data.owner.name : null} />
        )}
      </Card>

      <Card title="Water today" icon="drop">
        <div className="water-pair">
          <WaterGlass
            label="Me"
            glasses={data.hydration.mine}
            goal={WATER_GOAL}
            onSet={(next) => void saveWater(next)}
          />
          <WaterGlass
            label={data.link?.partnerName ?? "Partner"}
            glasses={data.hydration.partner ?? 0}
            goal={WATER_GOAL}
            editable={false}
            onSet={() => {}}
          />
        </div>
        <span className="fine">Each of you can log your own water; the other glass is view-only.</span>
      </Card>

      <FeelingsCard
        log={log}
        onSaved={() => void qc.invalidateQueries({ queryKey: ["dashboard"] })}
        readOnly={viewingPartner}
        ownerName={data.owner.name}
      />
      <MealsCard
        log={log}
        phase={info?.phase ?? null}
        onSaved={() => void qc.invalidateQueries({ queryKey: ["dashboard"] })}
        readOnly={viewingPartner}
        ownerName={data.owner.name}
      />

      <LoggedHistoryCard logs={data.logs} ownerName={data.owner.name} />

      {/* The journal is not here: it is shared deliberately, entry by entry,
          through her own toggle, and reaches him over the Together tab rather
          than being laid out beside the rest of her day whether she likes it or
          not. */}
      {!viewingPartner && (
        <JournalCard log={log} onSaved={() => void qc.invalidateQueries({ queryKey: ["dashboard"] })} />
      )}
      <IntimacyCard
        log={log}
        logs={data.logs}
        canEdit={me.user.sex === "female"}
        onSaved={() => void qc.invalidateQueries({ queryKey: ["dashboard"] })}
      />

      <Card title="Shared tasks" icon="check" action={<span className="sub">{openTodos.length} open</span>}>
        <TaskPowerUp todos={items} day={todos.data?.day} />
        {items.length === 0 ? (
          <span className="sub">No tasks yet — add some in Together.</span>
        ) : (
          <div className="stack" style={{ gap: "0.35rem" }}>
            {items.slice(0, 5).map((t) => (
              <div key={t.id} className="row">
                <Icon name={t.done ? "check" : "calendar"} size={15} />
                <span
                  className="grow"
                  style={{
                    textDecoration: t.done ? "line-through" : undefined,
                    opacity: t.done ? 0.55 : 1,
                    fontSize: "0.86rem",
                  }}
                >
                  {t.text}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Insight" icon="sparkle">
        {insight.isLoading ? (
          <span className="sub">Reading your recent logs…</span>
        ) : insight.data?.insight ? (
          <p>{insight.data.insight}</p>
        ) : (
          <span className="sub">Log a few days and patterns will show up here.</span>
        )}
      </Card>

      {data.link?.connected && (
        <Card title={data.link.partnerName ?? "Partner"} icon="users">
          <div className="row">
            <span className={`dot ${partnerOnline ? "" : "stale"}`} />
            <span className="sub">
              {data.status
                ? `${data.status.activity === "idle" ? "still" : data.status.activity === "unknown" ? "unavailable" : data.status.activity} • updated ${relativeTime(data.status.updatedAt, Date.now())}`
                : "No live status right now"}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/* Nothing is predicted until the woman has chosen her own numbers, so this is
   a genuine "not yet" rather than a guess. It points at the place where she
   chooses them instead of quietly assuming 28 and 5 behind her back. */
function CycleSetupPrompt({ ownerName }: { ownerName: string | null }) {
  return (
    <div className="stack">
      <span className="sub">
        {ownerName
          ? `${ownerName} has not set her cycle up yet, so there is nothing to predict.`
          : "Your cycle is not set up yet, so nothing is predicted here."}
      </span>
      {!ownerName && (
        <button type="button" className="btn primary" onClick={() => navigate("/settings")}>
          Set up your cycle
        </button>
      )}
      <span className="fine">
        Cycle length, period length and the day your last period started are all yours to choose in Settings.
      </span>
    </div>
  );
}

function useLogWriter(onSaved: () => void) {
  const qc = useQueryClient();
  const toast = useToast();

  return useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        await api.log({ logDate: todayKey(), ...patch });
        onSaved();
        await qc.invalidateQueries({ queryKey: ["dashboard"] });
        await qc.invalidateQueries({ queryKey: ["me"] });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save");
      }
    },
    [onSaved, qc, toast],
  );
}

function FeelingsCard({
  log,
  onSaved,
  readOnly = false,
  ownerName,
}: {
  log?: Dashboard["logs"][number];
  onSaved: () => void;
  /* The partner's side of the pair: her entries are shown, never edited. The
     server already refuses the write -- a log patch always lands on the caller's
     own record -- so this only has to stop offering the controls. */
  readOnly?: boolean;
  ownerName?: string | null;
}) {
  const selected = log?.feelings ?? [];
  const [customFeeling, setCustomFeeling] = useState("");
  const write = useLogWriter(onSaved);

  const toggle = (f: string) => {
    const next = selected.includes(f) ? selected.filter((x) => x !== f) : [...selected, f].slice(0, 6);
    void write({ feelings: next });
  };

  const addCustomFeeling = () => {
    const feeling = customFeeling.trim().slice(0, 30);
    if (!feeling || selected.some((entry) => entry.toLowerCase() === feeling.toLowerCase())) return;
    void write({ feelings: [...selected, feeling].slice(0, 12) });
    setCustomFeeling("");
  };

  return (
    <Card title="How are you feeling?" icon="mood">
      <div className="chips">
        {selected.length ? selected.map((f) => (
          readOnly ? (
            <span key={f} className="chip static">
              {f}
            </span>
          ) : (
            <button
              key={f}
              type="button"
              className="chip"
              aria-label={`Remove ${f}`}
              aria-pressed="true"
              onClick={() => toggle(f)}
            >
              {f} ×
            </button>
          )
        )) : <span className="sub">No feelings selected yet.</span>}
      </div>
      {readOnly ? (
        ownerName && (
          <span className="fine">{ownerName} logs these; you can see them but not change them.</span>
        )
      ) : (
        <>
      <details className="feeling-picker">
        <summary>Choose from the list</summary>
        <div className="chips">
          {FEELINGS.filter((feeling) => !selected.includes(feeling)).map((feeling) => (
            <button key={feeling} type="button" className="chip" onClick={() => toggle(feeling)}>
              {feeling}
            </button>
          ))}
        </div>
      </details>
      <div className="row">
        <input
          className="input grow"
          value={customFeeling}
          maxLength={30}
          placeholder="Add your own feeling"
          aria-label="Add a custom feeling"
          onChange={(event) => setCustomFeeling(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addCustomFeeling();
            }
          }}
        />
        <button type="button" className="btn secondary sm" disabled={!customFeeling.trim()} onClick={addCustomFeeling}>
          Add
        </button>
      </div>
        </>
      )}
    </Card>
  );
}

function MealsCard({
  log,
  phase,
  onSaved,
  readOnly = false,
  ownerName,
}: {
  log?: Dashboard["logs"][number];
  phase: NonNullable<ReturnType<typeof getCycleInfo>>["phase"] | null;
  onSaved: () => void;
  readOnly?: boolean;
  ownerName?: string | null;
}) {
  const [text, setText] = useState("");
  const [type, setType] = useState<(typeof MEAL_TYPES)[number]>("breakfast");
  const meals = log?.meals ?? [];
  const write = useLogWriter(onSaved);
  const toast = useToast();

  const add = async () => {
    const body = text.trim();
    if (!body) return;
    await write({
      meals: [...meals, { id: Date.now().toString(36), type, text: body, loggedAt: new Date().toISOString() }],
    });
    setText("");
  };

  const remove = async (id: string) => {
    await write({ meals: meals.filter((m) => m.id !== id) });
  };

  return (
    <Card title="Meals" icon="meal">
      <div className="stack">
        {meals.length > 0 && (
          <div className="stack" style={{ gap: "0.35rem" }}>
            {meals.slice(-6).reverse().map((m) => (
              <div key={m.id} className="row">
                <span className="pill">{m.type}</span>
                <span className="grow" style={{ fontSize: "0.85rem" }}>
                  {m.text}
                </span>
                {m.loggedAt && (
                  <time className="fine" dateTime={m.loggedAt}>
                    {new Date(m.loggedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </time>
                )}
                {!readOnly && (
                  <button type="button" className="plainBtn" onClick={() => void remove(m.id)} aria-label="Remove">
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {readOnly ? (
          meals.length > 0 &&
          ownerName && (
            <span className="fine">{ownerName} logs these; you can see them but not change them.</span>
          )
        ) : (
          <>
        <label className="field">
          <span>Meal or snack</span>
          <select className="select" value={type} onChange={(event) => setType(event.target.value as (typeof MEAL_TYPES)[number])}>
            {MEAL_TYPES.map((mealType) => (
              <option key={mealType} value={mealType}>
                {mealType[0].toUpperCase() + mealType.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <input
            className="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What did you eat?"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add().catch((err) => toast.error(String(err)));
              }
            }}
          />
          <button type="button" className="btn primary" onClick={() => void add()} disabled={!text.trim()}>
            <Icon name="plus" />
          </button>
        </div>
          </>
        )}
      </div>
      <MealCycleNote meals={meals} phase={phase} />
    </Card>
  );
}

/* Her earlier feelings and meals, read-only.

   The cards above only ever show today, so without this the partner could see
   what she logged at the moment and nothing of how the days went before it --
   which is most of what the log is for. Every row is a past day, so there is
   nothing here to write to: the controls only exist on today's card. */
function LoggedHistoryCard({
  logs,
  ownerName,
}: {
  logs: Dashboard["logs"];
  ownerName: string;
}) {
  const [expanded, setExpanded] = useState(false);

  /* Newest first, and today is left out because the cards above are already
     showing it. A day with neither a feeling nor a meal carries nothing worth
     a row, so it is dropped rather than listed as a blank. */
  const days = logs
    .filter((log) => log.logDate !== todayKey() && (log.feelings.length > 0 || log.meals.length > 0))
    .sort((a, b) => b.logDate.localeCompare(a.logDate));

  if (days.length === 0) return null;

  const SHOWN = 3;
  const visible = expanded ? days : days.slice(0, SHOWN);

  return (
    <Card title="Earlier days" icon="calendar">
      <div className="stack" style={{ gap: "0.5rem" }}>
        {visible.map((log) => (
          <div key={log.logDate} className="logged-history-day">
            <span className="eyebrow">{dayLabel(log.logDate)}</span>
            {log.feelings.length > 0 && (
              <div className="chips">
                {log.feelings.map((feeling) => (
                  <span key={feeling} className="chip static">
                    {feeling}
                  </span>
                ))}
              </div>
            )}
            {log.meals.length > 0 && (
              <div className="stack" style={{ gap: "0.3rem" }}>
                {log.meals.map((meal) => (
                  <div key={meal.id} className="row">
                    <span className="pill">{meal.type}</span>
                    <span className="grow" style={{ fontSize: "0.85rem" }}>
                      {meal.text}
                    </span>
                    {meal.loggedAt && (
                      <time className="fine" dateTime={meal.loggedAt}>
                        {new Date(meal.loggedAt).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </time>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {days.length > SHOWN && (
          <button
            type="button"
            className="btn ghost sm"
            style={{ alignSelf: "flex-start" }}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Show less" : `Show ${days.length - SHOWN} more`}
          </button>
        )}
        <span className="fine">
          {ownerName} logs these; you can read them but not change them.
        </span>
      </div>
    </Card>
  );
}

/* "Yesterday" reads better than a bare date, and a date further back than that
   is only ever a date. */
function dayLabel(logDate: string) {
  const today = todayKey();
  if (logDate === addDays(today, -1)) return "Yesterday";
  if (logDate === addDays(today, -2)) return "Two days ago";
  return logDate;
}

function MealCycleNote({
  meals,
  phase,
}: {
  meals: Dashboard["logs"][number]["meals"];
  phase: NonNullable<ReturnType<typeof getCycleInfo>>["phase"] | null;
}) {
  const foods = meals.map((meal) => meal.text.toLowerCase()).join(" ");
  let note = phase
    ? `In the ${PHASE_LABEL[phase].toLowerCase()}, regular balanced meals and hydration can support general wellbeing. A meal cannot reliably change cycle timing.`
    : "Cycle details are not available yet. Meals are recorded for your own patterns; a meal cannot reliably change cycle timing.";

  if (phase === "menstrual" && /\b(spinach|kale|beans|lentils|iron|beef|tofu)\b/.test(foods)) {
    note = "Your log includes iron-containing foods. Dietary iron helps replace normal iron losses during bleeding, but food logs cannot diagnose or treat low iron.";
  } else if (/\b(coffee|caffeine|energy drink|cola)\b/.test(foods)) {
    note = "Your log includes caffeine. If it affects your sleep or how you feel around your period, noticing your own pattern may be useful; sensitivity varies.";
  } else if (/\b(oats|oatmeal|wholegrain|whole grain|brown rice)\b/.test(foods)) {
    note = "Your log includes whole grains, a source of fiber and energy. This is general nutrition information, not a prediction of cycle symptoms.";
  }

  return (
    <div className="meal-cycle-note" role="note">
      <strong><Icon name="sparkle" size={15} /> Cycle & meal note</strong>
      <p>{note}</p>
      <span className="fine">General information only; individual responses differ.</span>
    </div>
  );
}

function IntimacyCard({
  log,
  logs,
  canEdit,
  onSaved,
}: {
  log?: Dashboard["logs"][number];
  logs: Dashboard["logs"];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const count = log?.intercourseCount ?? 0;
  const write = useLogWriter(onSaved);
  const history = logs.filter((entry) => entry.intercourseCount > 0).slice(-7).reverse();
  return (
    <Card title="Intimacy" icon="heart">
      <div className="row">
        <span className="grow sub">Logged today</span>
        {canEdit && (
          <button
            type="button"
            className="btn outline icon-lg"
            onClick={() => void write({ intercourseCount: Math.max(0, count - 1) })}
            disabled={count === 0}
            aria-label="Decrease today's count"
          >
            <Icon name="chevronLeft" />
          </button>
        )}
        <Icon name="heart" />
        <strong style={{ minWidth: "2rem", textAlign: "center", fontFamily: "var(--font-family-display)", fontSize: "1.4rem" }}>
          {count}
        </strong>
        {canEdit && (
          <button
            type="button"
            className="btn primary icon-lg"
            onClick={() => void write({ intercourseCount: count + 1 })}
            disabled={count >= 20}
            aria-label="Increase today's count"
          >
            <Icon name="plus" />
          </button>
        )}
      </div>
      {history.length > 0 && (
        <div className="stack intimacy-history">
          {history.map((entry) => (
            <div className="row intimacy-history-row" key={entry.logDate}>
              <time className="grow" dateTime={entry.logDate}>{entry.logDate}</time>
              <Icon name="heart" size={14} />
              <strong>{entry.intercourseCount}</strong>
            </div>
          ))}
        </div>
      )}
      {!canEdit && <span className="fine">Only your female partner can change these shared counts.</span>}
    </Card>
  );
}

function JournalCard({ log, onSaved }: { log?: Dashboard["logs"][number]; onSaved: () => void }) {
  const [text, setText] = useState(log?.journal ?? "");
  const [shared, setShared] = useState(log?.journalShared ?? false);
  const write = useLogWriter(onSaved);

  useEffect(() => {
    setText(log?.journal ?? "");
    setShared(log?.journalShared ?? false);
  }, [log?.journal, log?.journalShared, log?.logDate]);

  return (
    <Card title="Journal" icon="notebook">
      <div className="stack">
        <textarea
          className="textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's on your mind today?"
        />
        <label className="switchRow">
          <div className="grow">
            <strong>Share with partner</strong>
            <span>Visible in Together.</span>
          </div>
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => {
              setShared(e.target.checked);
              void write({ journal: text, journalShared: e.target.checked });
            }}
          />
        </label>
        <button
          type="button"
          className="btn secondary"
          onClick={() => void write({ journal: text, journalShared: shared })}
          disabled={text === (log?.journal ?? "") && shared === (log?.journalShared ?? false)}
        >
          Save journal
        </button>
      </div>
    </Card>
  );
}

