import { accessHeader, apiUrl } from "./config";
import type { Dashboard, JournalEntry, Me, Message, Todo, UsEntry } from "./api";

const DB_NAME = "syncura-offline";
const DB_VERSION = 1;
const CACHE_STORE = "responses";
const OUTBOX_STORE = "outbox";
const QUEUEABLE_PATHS = new Set([
  "/log",
  "/settings",
  "/cycle/period-day",
  "/journal",
  "/todos",
  "/us",
  "/chat/send",
  "/chat/read",
]);
const OUTBOX_EVENT = "syncura:outbox";
let activeSync: { scope: string; promise: Promise<number> } | null = null;

interface CachedResponse {
  key: string;
  value: unknown;
  savedAt: string;
}

interface QueuedWrite {
  id?: number;
  scope: string;
  path: string;
  body: unknown;
  optimisticMessageId?: number;
  optimisticEntryId?: string;
  optimisticTodoId?: string;
  todoText?: string;
  knownTodoIds?: string[];
  queuedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Offline storage is unavailable in this browser"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(CACHE_STORE, { keyPath: "key" });
      database.createObjectStore(OUTBOX_STORE, { keyPath: "id", autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open offline storage"));
    request.onblocked = () => reject(new Error("Offline storage is busy in another app window"));
  });
}

function tokenScope(token: string | null): string {
  if (!token) return "guest";
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `account-${(hash >>> 0).toString(16)}`;
}

function cacheKey(path: string, token: string | null): string {
  return `${tokenScope(token)}:${path}`;
}

function readValue<T>(value: unknown, fallback: T): T {
  return value === undefined || value === null ? fallback : (value as T);
}

function notifyQueueChanged() {
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}

export async function getCachedResponse<T>(path: string, token: string | null): Promise<T | null> {
  const database = await openDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(cacheKey(path, token));
      request.onsuccess = () => resolve((request.result as CachedResponse | undefined)?.value);
      request.onerror = () => reject(request.error ?? new Error("Could not read offline data"));
    });
    return value === undefined ? null : (value as T);
  } finally {
    database.close();
  }
}

export async function saveCachedResponse(path: string, token: string | null, value: unknown): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(CACHE_STORE, "readwrite");
      transaction.objectStore(CACHE_STORE).put({
        key: cacheKey(path, token),
        value,
        savedAt: new Date().toISOString(),
      } satisfies CachedResponse);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save offline data"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline data save was cancelled"));
    });
  } finally {
    database.close();
  }
}

async function readQueue(token: string): Promise<QueuedWrite[]> {
  const database = await openDatabase();
  try {
    return await new Promise<QueuedWrite[]>((resolve, reject) => {
      const request = database.transaction(OUTBOX_STORE, "readonly").objectStore(OUTBOX_STORE).getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as QueuedWrite[])
            .filter((entry) => entry.scope === tokenScope(token))
            .sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
        );
      request.onerror = () => reject(request.error ?? new Error("Could not read pending offline changes"));
    });
  } finally {
    database.close();
  }
}

async function addToQueue(entry: Omit<QueuedWrite, "id">): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, "readwrite");
      transaction.objectStore(OUTBOX_STORE).add(entry);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not queue this offline change"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline change queue was cancelled"));
    });
  } finally {
    database.close();
  }
  notifyQueueChanged();
}

async function removeFromQueue(id: number): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, "readwrite");
      transaction.objectStore(OUTBOX_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove a synced change"));
    });
  } finally {
    database.close();
  }
  notifyQueueChanged();
}

async function replaceQueuedTodoId(
  token: string,
  afterId: number,
  from: string,
  to: string,
  completedIds: string[],
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, "readwrite");
      const store = transaction.objectStore(OUTBOX_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        for (const item of request.result as QueuedWrite[]) {
          if (item.scope !== tokenScope(token)) continue;
          if (item.id !== undefined && item.id > afterId && item.path === "/todos") {
            const payload = item.body as Record<string, unknown>;
            if (payload.id === from) payload.id = to;
            item.body = payload;
            item.knownTodoIds = [...new Set([...(item.knownTodoIds ?? []), ...completedIds])];
            store.put(item);
          }
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not update queued task references"));
    });
  } finally {
    database.close();
  }
}

export async function pendingWriteCount(token: string | null): Promise<number> {
  if (!token) return 0;
  return (await readQueue(token)).length;
}

function todayKey(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function getCached<T>(path: string, token: string, fallback: T): Promise<T> {
  return readValue(await getCachedResponse<T>(path, token), fallback);
}

async function applyOfflineMutation(path: string, payload: Record<string, unknown>, token: string): Promise<unknown> {
  const me = await getCached<Me | null>("/me", token, null);
  const now = new Date().toISOString();

  if (path === "/log") {
    const logDate = String(payload.logDate ?? todayKey());
    const dash = await getCached<Dashboard | null>("/dashboard", token, null);
    const baseLog = dash?.logs.find((log) => log.logDate === logDate) ?? {
      logDate,
      waterGlasses: 0,
      feelings: [],
      meals: [],
      journal: "",
      journalShared: false,
      intercourseCount: 0,
    };
    const log = { ...baseLog, ...payload, logDate };
    if (dash) {
      const logs = dash.owner.name === me?.user.name
        ? [...dash.logs.filter((item) => item.logDate !== logDate), log].sort((a, b) => a.logDate.localeCompare(b.logDate))
        : dash.logs;
      await saveCachedResponse("/dashboard", token, {
        ...dash,
        logs,
        hydration: { ...dash.hydration, ...(logDate === todayKey() && "waterGlasses" in payload ? { mine: log.waterGlasses } : {}) },
      });
    }
    return log;
  }

  if (path === "/settings" || path === "/cycle/period-day") {
    if (!me) throw new Error("Your saved account is unavailable offline; reconnect before changing settings.");
    let settings = me.settings;
    if (path === "/settings") {
      settings = { ...settings, ...payload };
    } else {
      const logDate = String(payload.logDate);
      const dates = new Set(settings.periodDays ?? []);
      if (payload.logged === true) dates.add(logDate);
      else dates.delete(logDate);
      settings = { ...settings, periodDays: [...dates].sort() };
    }
    const updated: Me = {
      ...me,
      user: { ...me.user, ...(typeof payload.name === "string" ? { name: payload.name.trim() } : {}) },
      settings,
    };
    await saveCachedResponse("/me", token, updated);
    const dash = await getCached<Dashboard | null>("/dashboard", token, null);
    if (dash) {
      await saveCachedResponse("/dashboard", token, {
        ...dash,
        ...(dash.owner.name === me.user.name ? { settings } : {}),
        ...(dash.partner?.name === me.user.name ? { partner: { ...dash.partner, settings } } : {}),
      });
    }
    return updated;
  }

  if (path === "/journal") {
    const entry: JournalEntry = {
      logDate: String(payload.logDate),
      text: String(payload.text ?? "").slice(0, 8000),
      shared: Boolean(payload.shared),
      updatedAt: now,
    };
    const journal = await getCached<{ entries: JournalEntry[] }>("/journal", token, { entries: [] });
    await saveCachedResponse("/journal", token, {
      entries: [entry, ...journal.entries.filter((item) => item.logDate !== entry.logDate)],
    });
    return entry;
  }

  if (path === "/todos") {
    const result = await getCached<{ todos: Todo[] }>("/todos", token, { todos: [] });
    const todos = [...result.todos];
    const action = payload.action;
    if (action === "add" && typeof payload.text === "string") {
      todos.push({
        id: `offline-${crypto.randomUUID()}`,
        text: payload.text.trim().slice(0, 160),
        done: false,
        createdAt: now,
        completedAt: null,
      });
    } else if (action === "toggle" && typeof payload.id === "string") {
      const item = todos.find((todo) => todo.id === payload.id);
      if (item) {
        item.done = !item.done;
        item.completedAt = item.done ? todayKey() : null;
      }
    } else if (action === "remove" && typeof payload.id === "string") {
      return saveTodos(todos.filter((todo) => todo.id !== payload.id), token);
    } else if (action === "clearDone") {
      return saveTodos(todos.filter((todo) => !todo.done), token);
    }
    return saveTodos(todos, token);
  }

  if (path === "/us") {
    if (!me) throw new Error("Your saved account is unavailable offline.");
    const result = await getCached<{ entries: UsEntry[] }>("/us", token, { entries: [] });
    const entry: UsEntry = {
      id: `offline-${crypto.randomUUID()}`,
      senderId: me.user.id,
      logDate: todayKey(),
      text: String(payload.text ?? "").trim().slice(0, 2000),
      createdAt: now,
    };
    const entries = [...result.entries.filter((item) => item.logDate === todayKey()), entry];
    await saveCachedResponse("/us", token, { entries });
    return { entry };
  }

  if (path === "/chat/send") {
    if (!me) throw new Error("Your saved account is unavailable offline.");
    const result = await getCached<{ messages: Message[] }>("/chat/messages", token, { messages: [] });
    const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const message: Message = {
      id,
      senderId: me.user.id,
      createdAt: now,
      ciphertext: String(payload.ciphertext),
      iv: String(payload.iv),
      pending: true,
    };
    await saveCachedResponse("/chat/messages", token, { messages: [...result.messages, message] });
    return { message };
  }

  if (path === "/chat/read") {
    const throughId = Number(payload.throughId);
    const result = await getCached<{ messages: Message[] }>("/chat/messages", token, { messages: [] });
    const readAt = now;
    const receipts = result.messages
      .filter((message) => message.id > 0 && message.id <= throughId && message.senderId !== me?.user.id && !message.readAt)
      .map((message) => ({ messageId: message.id, deliveredAt: message.deliveredAt ?? readAt, readAt }));
    await saveCachedResponse("/chat/messages", token, {
      messages: result.messages.map((message) => {
        const receipt = receipts.find((item) => item.messageId === message.id);
        return receipt ? { ...message, deliveredAt: receipt.deliveredAt, readAt: receipt.readAt } : message;
      }),
    });
    return { receipts };
  }

  throw new Error(`This change cannot be saved offline: ${path}`);
}

async function saveTodos(todos: Todo[], token: string): Promise<{ todos: Todo[] }> {
  const result = { todos };
  await saveCachedResponse("/todos", token, result);
  return result;
}

export async function reconcileServerResult(path: string, result: unknown, token: string | null, queued?: QueuedWrite): Promise<void> {
  if (!token) return;
  if (path === "/me" || path === "/settings" || path === "/cycle/period-day") {
    if (path !== "/me") await saveCachedResponse("/me", token, result);
    return;
  }
  if (path === "/dashboard" || path === "/todos" || path === "/insights") {
    await saveCachedResponse(path, token, result);
    return;
  }
  if (path === "/journal") {
    const entry = result as JournalEntry;
    const current = await getCached<{ entries: JournalEntry[] }>("/journal", token, { entries: [] });
    await saveCachedResponse("/journal", token, {
      entries: [entry, ...current.entries.filter((item) => item.logDate !== entry.logDate)],
    });
    return;
  }
  if (path === "/us") {
    const entry = (result as { entry: UsEntry }).entry;
    const current = await getCached<{ entries: UsEntry[] }>("/us", token, { entries: [] });
    await saveCachedResponse("/us", token, {
      entries: [
        ...current.entries.filter(
          (item) => item.id !== entry.id && item.id !== queued?.optimisticEntryId && item.logDate === entry.logDate,
        ),
        entry,
      ],
    });
    return;
  }
  if (path === "/log") {
    const log = result as Dashboard["logs"][number];
    const dash = await getCached<Dashboard | null>("/dashboard", token, null);
    if (dash) {
      await saveCachedResponse("/dashboard", token, {
        ...dash,
        logs: dash.owner.name === (await getCached<Me | null>("/me", token, null))?.user.name
          ? [...dash.logs.filter((item) => item.logDate !== log.logDate), log].sort((a, b) => a.logDate.localeCompare(b.logDate))
          : dash.logs,
        hydration: { ...dash.hydration, ...(log.logDate === todayKey() ? { mine: log.waterGlasses } : {}) },
      });
    }
    return;
  }
  if (path === "/chat/send") {
    const message = (result as { message: Message }).message;
    const current = await getCached<{ messages: Message[] }>("/chat/messages", token, { messages: [] });
    const pendingId = queued?.optimisticMessageId;
    await saveCachedResponse("/chat/messages", token, {
      messages: [
        ...current.messages.filter((item) => item.id !== pendingId && item.id !== message.id),
        message,
      ].sort((a, b) => a.id - b.id),
    });
    return;
  }
  if (path === "/chat/read") {
    const receipts = (result as { receipts: { messageId: number; deliveredAt: string; readAt: string }[] }).receipts;
    const current = await getCached<{ messages: Message[] }>("/chat/messages", token, { messages: [] });
    await saveCachedResponse("/chat/messages", token, {
      messages: current.messages.map((message) => {
        const receipt = receipts.find((item) => item.messageId === message.id);
        return receipt ? { ...message, deliveredAt: receipt.deliveredAt, readAt: receipt.readAt } : message;
      }),
    });
  }
}

export async function queueOfflineMutation<T>(
  path: string,
  payload: Record<string, unknown>,
  token: string | null,
): Promise<T> {
  if (!token || !QUEUEABLE_PATHS.has(path)) {
    throw new Error("This action needs an internet connection to complete.");
  }
  const result = await applyOfflineMutation(path, payload, token);
  const optimisticMessageId =
    path === "/chat/send" && typeof result === "object" && result !== null && "message" in result
      ? Number((result.message as Message).id)
      : undefined;
  const optimisticEntryId =
    path === "/us" && typeof result === "object" && result !== null && "entry" in result
      ? String((result.entry as UsEntry).id)
      : undefined;
  const todoResult = path === "/todos" && typeof result === "object" && result !== null && "todos" in result
    ? result as { todos: Todo[] }
    : null;
  const optimisticTodo = payload.action === "add"
    ? [...(todoResult?.todos ?? [])].reverse().find(
        (todo) => todo.id.startsWith("offline-") && todo.text === String(payload.text).trim(),
      )
    : undefined;
  await addToQueue({
    scope: tokenScope(token),
    path,
    body: payload,
    ...(optimisticMessageId ? { optimisticMessageId } : {}),
    ...(optimisticEntryId ? { optimisticEntryId } : {}),
    ...(optimisticTodo ? {
      optimisticTodoId: optimisticTodo.id,
      todoText: optimisticTodo.text,
      knownTodoIds: todoResult?.todos.filter((todo) => !todo.id.startsWith("offline-")).map((todo) => todo.id) ?? [],
    } : {}),
    queuedAt: new Date().toISOString(),
  });
  return result as T;
}

export function canQueueOfflineMutation(path: string, token: string | null): boolean {
  return Boolean(token && QUEUEABLE_PATHS.has(path));
}

async function performSyncPendingWrites(token: string): Promise<number> {
  const entries = await readQueue(token);
  let synced = 0;
  for (const entry of entries) {
    if (entry.id === undefined) continue;
    const response = await fetch(apiUrl(entry.path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-syncura-token": token,
        ...accessHeader(),
      },
      body: JSON.stringify(entry.body),
    });
    const text = await response.text();
    let result: unknown;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`The server returned an unreadable reply while syncing ${entry.path}`);
    }
    if (!response.ok) {
      const message =
        typeof result === "object" && result !== null && "error" in result && typeof result.error === "string"
          ? result.error
          : `The server rejected a saved change (${response.status})`;
      throw new Error(message);
    }
    if (entry.path === "/todos" && entry.optimisticTodoId && entry.todoText) {
      const todos = (result as { todos?: Todo[] }).todos ?? [];
      const added = todos.find(
        (todo) => todo.text === entry.todoText && !(entry.knownTodoIds ?? []).includes(todo.id),
      );
      if (added) {
        await replaceQueuedTodoId(token, entry.id, entry.optimisticTodoId, added.id, [added.id]);
      }
    }
    await reconcileServerResult(entry.path, result, token, entry);
    await removeFromQueue(entry.id);
    synced += 1;
  }
  return synced;
}

export function syncPendingWrites(token: string | null): Promise<number> {
  if (!token || !navigator.onLine) return Promise.resolve(0);
  const scope = tokenScope(token);
  if (activeSync?.scope === scope) return activeSync.promise;

  const operation = performSyncPendingWrites(token);
  let tracked: Promise<number>;
  tracked = operation.finally(() => {
    if (activeSync?.promise === tracked) activeSync = null;
  });
  activeSync = { scope, promise: tracked };
  return tracked;
}

export { OUTBOX_EVENT };

