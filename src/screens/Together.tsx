import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type UsEntry } from "../lib/api";
import { Card, Loading, EmptyState, Icon } from "../components/ui";
import { useSession } from "../lib/session";
import { useToast } from "../components/ToastProvider";
import { addDays, formatTimestamp, todayKey } from "../lib/cycle";
import { subscribeRealtime } from "../lib/realtime";
import { TaskPowerUp } from "../components/TaskPowerUp";

function JournalComposer() {
  const qc = useQueryClient();
  const toast = useToast();
  const today = todayKey();
  const [text, setText] = useState("");
  const [shared, setShared] = useState(true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await api.saveJournal({ logDate: today, text, shared });
      setText("");
      toast.success("Journal saved");
      await qc.invalidateQueries({ queryKey: ["journal"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <textarea
        className="textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`${today} — how today felt…`}
      />
      <label className="switchRow">
        <div className="grow">
          <strong>Share with partner</strong>
          <span>They'll see this entry in Together.</span>
        </div>
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
      </label>
      <button type="button" className="btn primary" onClick={save} disabled={saving || !text.trim()}>
        Save entry
      </button>
    </div>
  );
}

function Todos() {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [celebrate, setCelebrate] = useState(false);
  const celebrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const todos = useQuery({ queryKey: ["todos"], queryFn: api.todos });
  const items = todos.data?.todos ?? [];
  /* The list is a page for one day. Yesterday's is kept so the pair can look
     back rather than losing it, but it is never mixed in with today's. */
  const [showYesterday, setShowYesterday] = useState(false);
  const history = todos.data?.history ?? [];
  const yesterday = history.find((entry) => entry.day === addDays(todayKey(), -1));
  const older = history.filter((entry) => entry.day !== addDays(todayKey(), -1));

  useEffect(
    () => () => {
      if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
    },
    [],
  );

  const act = async (input: { action: string; id?: string; text?: string }) => {
    try {
      const before = todayCompletion(items);
      const result = await api.postTodo(input);
      qc.setQueryData(["todos"], result);
      const after = todayCompletion(result.todos);
      if (input.action === "toggle" && result.todos.length > 0 && before < items.length && after === result.todos.length) {
        if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
        setCelebrate(true);
        celebrationTimer.current = setTimeout(() => setCelebrate(false), 2600);
      } else if (after < result.todos.length) {
        setCelebrate(false);
      }
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  return (
    <div className="stack">
      <TaskPowerUp todos={items} celebrate={celebrate} day={todos.data?.day} />
      <div className="row">
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a shared task"
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              act({ action: "add", text });
              setText("");
            }
          }}
        />
        <button
          type="button"
          className="btn primary icon-lg"
          onClick={() => {
            if (!text.trim()) return;
            act({ action: "add", text });
            setText("");
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing on the list"
          hint="Add a task you want to do together. The list empties itself at midnight and yesterday's is kept below."
        />
      ) : (
        <div className="stack" style={{ gap: "0.4rem" }}>
          {items.map((t) => (
            <div key={t.id} className="row card" style={{ padding: "0.6rem 0.75rem" }}>
              <button
                type="button"
                className={`chip ${t.done ? "on" : ""}`}
                style={{ padding: "0.2rem 0.45rem" }}
                onClick={() => act({ action: "toggle", id: t.id })}
                aria-label={t.done ? "Mark not done" : "Mark done"}
              >
                <Icon name="check" size={13} />
              </button>
              <span className="grow" style={{ textDecoration: t.done ? "line-through" : undefined, opacity: t.done ? 0.6 : 1 }}>
                {t.text}
              </span>
              <button type="button" className="plainBtn" onClick={() => act({ action: "remove", id: t.id })}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {history.length > 0 && (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <button
            type="button"
            className="btn ghost sm"
            style={{ alignSelf: "flex-start" }}
            aria-expanded={showYesterday}
            onClick={() => setShowYesterday((open) => !open)}
          >
            {showYesterday ? "Hide earlier days" : `Earlier days (${history.length})`}
          </button>
          {showYesterday &&
            [...(yesterday ? [yesterday] : []), ...older]
              .slice()
              .reverse()
              .map((entry) => (
                <div key={entry.day} className="stack" style={{ gap: "0.3rem" }}>
                  <span className="eyebrow">
                    {entry.day === addDays(todayKey(), -1) ? "Yesterday" : entry.day} ·{" "}
                    {entry.todos.filter((todo) => todo.done).length}/{entry.todos.length} done
                  </span>
                  {entry.todos.length === 0 ? (
                    <span className="fine">Nothing was on the list.</span>
                  ) : (
                    entry.todos.map((todo) => (
                      <div key={todo.id} className="row card" style={{ padding: "0.5rem 0.7rem", opacity: 0.75 }}>
                        <span className="grow" style={{ textDecoration: todo.done ? "line-through" : undefined }}>
                          {todo.text}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ))}
        </div>
      )}
    </div>
  );
}

function todayCompletion(items: { done: boolean; completedAt?: string | null }[]) {
  const today = todayKey();
  return items.filter((todo) => todo.done && todo.completedAt === today).length;
}

function UsThread() {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [today, setToday] = useState(todayKey());
  const thread = useQuery({
    queryKey: ["us", today],
    queryFn: api.usEntries,
    enabled: Boolean(me?.link?.connected),
    refetchInterval: 15_000,
  });
  const entries = thread.data?.entries ?? [];

  useEffect(() => {
    const timer = setInterval(() => setToday(todayKey()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(
    () =>
      subscribeRealtime({
        onUsEntry: (entry) => {
          if (entry.logDate !== today) return;
          qc.setQueryData<{ entries: UsEntry[] }>(["us", today], (current) => ({
            entries: [...(current?.entries ?? []).filter((item) => item.id !== entry.id), entry]
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
          }));
        },
      }),
    [qc, today],
  );

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    try {
      const { entry } = await api.addUsEntry(body);
      qc.setQueryData<{ entries: UsEntry[] }>(["us", today], (current) => ({
        entries: [...(current?.entries ?? []).filter((item) => item.id !== entry.id), entry]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      }));
      setText("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send to Us");
    }
  };

  return (
    <div className="us-thread">
      <div className="us-thread-messages" aria-live="polite">
        {!me?.link?.connected ? (
          <EmptyState icon="link" title="Connect to start your thread" hint="Your shared daily thread appears here after pairing." />
        ) : thread.isLoading ? (
          <Loading rows={1} />
        ) : entries.length === 0 ? (
          <EmptyState icon="leaf" title="A new day together" hint="Add the first note to today's shared thread." />
        ) : (
          entries.map((entry) => {
            const mine = entry.senderId === me?.user.id;
            return (
              <article key={entry.id} className={`us-thread-entry ${mine ? "mine" : ""}`}>
                <span className="eyebrow">
                  {mine ? "Me" : me?.link?.partnerName ?? "Partner"}
                </span>
                <p>{entry.text}</p>
                <time className="fine" dateTime={entry.createdAt}>
                  {new Date(entry.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </time>
              </article>
            );
          })
        )}
      </div>
      <form
        className="us-thread-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          className="textarea"
          value={text}
          maxLength={2000}
          onChange={(event) => setText(event.target.value)}
          placeholder="Add to today's thread…"
          rows={2}
        />
        <button type="submit" className="btn primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
      <span className="fine">Today's thread clears when a new day begins. Your entries are shared with your partner.</span>
    </div>
  );
}

export default function Together() {
  const queryClient = useQueryClient();
  const journal = useQuery({ queryKey: ["journal"], queryFn: api.journal });
  const entries = journal.data?.entries ?? [];
  const privateEntries = entries.filter((entry) => !entry.shared);

  useEffect(
    () =>
      subscribeRealtime({
        onTodos: (page) => queryClient.setQueryData(["todos"], page),
      }),
    [queryClient],
  );
  return (
    <div className="stack">
      <div className="pageTop">
        <h1>Together</h1>
        <span className="sub">Journal, tasks, and each other's day.</span>
      </div>
      <Card title="My journal" icon="notebook">
        <div className="stack">
          <JournalComposer />
        </div>
      </Card>
      <Card title="Shared tasks" icon="check">
        <Todos />
      </Card>
      <Card title="Us" icon="users">
        <UsThread />
      </Card>
      {privateEntries.length > 0 && (
        <Card title="My private entries" icon="notebook">
          <div className="stack">
            {privateEntries.map((entry) => (
              <div key={entry.logDate} className="card" style={{ background: "var(--glass)" }}>
                <div className="eyebrow">Me</div>
                <p style={{ whiteSpace: "pre-wrap" }}>{entry.text}</p>
                <span className="fine">{formatTimestamp(entry.updatedAt)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

