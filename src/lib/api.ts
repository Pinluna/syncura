import { accessHeader, apiUrl } from "./config";
import {
  canQueueOfflineMutation,
  getCachedResponse,
  pendingWriteCount,
  queueOfflineMutation,
  reconcileServerResult,
  saveCachedResponse,
  syncPendingWrites,
} from "./offline";

const TOKEN_KEY = "syncura.token";
const PUSH_TOKEN_KEY = "syncura.pushToken";

export const tokenStore = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(value: string) {
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {
      /* private mode */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

export const pushTokenStore = {
  get() {
    try {
      return localStorage.getItem(PUSH_TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(value: string) {
    try {
      localStorage.setItem(PUSH_TOKEN_KEY, value);
    } catch {
      /* Notifications still work if token persistence is unavailable. */
    }
  },
  clear() {
    try {
      localStorage.removeItem(PUSH_TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

export const pendingCode = {
  get() {
    try {
      return sessionStorage.getItem("syncura.pendingCode");
    } catch {
      return null;
    }
  },
  set(value: string) {
    try {
      sessionStorage.setItem("syncura.pendingCode", value);
    } catch {
      /* ignore */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem("syncura.pendingCode");
    } catch {
      /* ignore */
    }
  },
};

export type Sex = "female" | "male";
export type PeriodFlow = "light" | "medium" | "heavy";

export interface CycleSettings {
  cycleLength: number;
  periodLength: number;
  lastPeriodStart: string | null;
  lastPeriodEnd: string | null;
  periodDays: string[];
  periodFlow?: Record<string, PeriodFlow>;
  /* False until the account owner picks her own cycle numbers at first login.
     Nothing is predicted while this is false, which is what keeps a first-login
     calendar clean. */
  cycleConfigured: boolean;
  /* Predicted dates the owner has dismissed from the calendar. */
  ignoredDates?: string[];
  shareLocation: boolean;
  shareActivity: boolean;
  shareBattery: boolean;
  shareJournal: boolean;
  liveSharing: boolean;
}

export interface Meal {
  id: string;
  type: "breakfast" | "lunch" | "dinner" | "snack";
  text: string;
  loggedAt?: string;
}

export interface DailyLog {
  logDate: string;
  waterGlasses: number;
  feelings: string[];
  meals: Meal[];
  journal: string;
  journalShared: boolean;
  intercourseCount: number;
}

export interface JournalEntry {
  logDate: string;
  text: string;
  shared: boolean;
  updatedAt: string;
}

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  completedAt?: string | null;
}

/* The shared task list is a page per day: `todos` is today's page and `history`
   holds the pages that have already been closed out. */
export interface TodoDay {
  day: string;
  todos: Todo[];
}

export interface TodoPage {
  todos: Todo[];
  day: string;
  history: TodoDay[];
}

export interface LiveStatus {
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  activity: "driving" | "idle" | "walking" | "unknown";
  batteryLevel: number | null;
  isCharging: boolean | null;
  speedMs: number | null;
  headingDeg: number | null;
  stepsToday: number | null;
  updatedAt: string;
}

export interface Message {
  id: number;
  senderId: string;
  createdAt: string;
  ciphertext: string;
  iv: string;
  pending?: boolean;
  deliveredAt?: string;
  readAt?: string;
  mediaId?: string;
  viewOnce?: boolean;
  mediaOpenedAt?: string;
}

export interface ChatAttachment {
  kind: "syncura-attachment";
  id: string;
  name: string;
  mimeType: string;
  size: number;
  iv: string;
}

/**
 * One row of call history, as this person sees it.
 *
 * The server sends only the rows belonging to the reader, so `outcome` is already
 * from the right side and needs no interpretation here.
 */
export interface CallRecord {
  id: string;
  ownerId: string;
  callerId: string;
  callId: string;
  mode: "audio" | "video";
  startedAt: string;
  endedAt: string;
  /** missed = rang and was not answered, received = answered, dialed = placed here. */
  outcome: "missed" | "received" | "dialed";
  connectedAt?: string;
}

export interface UsEntry {
  id: string;
  senderId: string;
  logDate: string;
  text: string;
  createdAt: string;
}

export interface Me {
  user: { id: string; name: string; sex: Sex; publicKey: string };
  link: {
    id: string;
    code: string;
    connected: boolean;
    partnerName: string | null;
    partnerPublicKey: string | null;
  } | null;
  settings: CycleSettings;
}

export interface Dashboard {
  logs: DailyLog[];
  hydration: { mine: number; partner: number | null };
  settings: CycleSettings;
  owner: { id: string; name: string; sex: Sex };
  viewer: Sex;
  link: { id: string; connected: boolean; partnerName: string | null } | null;
  status: LiveStatus | null;
  partner?: { name: string; settings: CycleSettings };
  fromPartner?: { name: string; entries: JournalEntry[] };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const method = (init.method ?? "GET").toUpperCase();
  if (token && typeof navigator !== "undefined" && navigator.onLine) {
    let pending = 0;
    try {
      pending = await pendingWriteCount(token);
    } catch (error) {
      console.error("Could not check for saved offline changes before syncing", error);
    }
    if (pending > 0) {
      try {
        await syncPendingWrites(token);
      } catch (syncError) {
        if (method === "GET" || path === "/insights") {
          const cached = await getCachedResponse<T>(path, token);
          if (cached !== null) return cached;
        } else if (method === "POST" && canQueueOfflineMutation(path, token)) {
          const payload = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
          return queueOfflineMutation<T>(path, payload, token);
        }
        throw syncError;
      }
    }
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-syncura-token": token } : {}),
        ...accessHeader(),
        ...init.headers,
      },
    });
  } catch (error) {
    if (method === "GET" || path === "/insights") {
      try {
        const cached = await getCachedResponse<T>(path, token);
        if (cached !== null) return cached;
      } catch (cacheError) {
        console.error(`Could not read the offline cache for ${path}`, cacheError);
      }
    }

    if (method === "POST" && error instanceof TypeError) {
      try {
        const payload = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        return await queueOfflineMutation<T>(path, payload, token);
      } catch (offlineError) {
        if (offlineError instanceof Error && offlineError.message.startsWith("This action needs")) {
          throw offlineError;
        }
        if (!(offlineError instanceof Error && offlineError.message.startsWith("This change cannot"))) {
          throw offlineError;
        }
      }
    }
    throw error;
  }
  const text = await response.text();
  /* An HTML body means the request reached something that is not the API --
     usually the base URL pointing at the app's own WebView rather than a
     server. Say that plainly instead of surfacing a JSON parse error. */
  let body: any;
  if (!text) {
    body = {};
  } else if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new ApiError(response.status, "That server isn't a Syncura API. Check the server address.");
  } else {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, "The server sent a reply Syncura couldn't read.");
    }
  }
  if (!response.ok) throw new ApiError(response.status, body.error ?? "Something went wrong");
  if (method === "GET" || path === "/insights") {
    await saveCachedResponse(path, token, body).catch((error: unknown) => {
      console.error(`Could not save offline data for ${path}`, error);
    });
  } else if (method === "POST") {
    await reconcileServerResult(path, body, token).catch((error: unknown) => {
      console.error(`Could not update the offline cache after ${path}`, error);
    });
  }
  return body as T;
}

export const api = {
  register: (input: { name: string; dateOfBirth: string; sex: Sex; publicKey: string }) =>
    request<{ token: string; user: Me["user"] }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  me: () => request<Me>("/me"),
  deleteAccount: () => request<{ ok: true }>("/account/delete", { method: "POST", body: "{}" }),
  dashboard: () => request<Dashboard>("/dashboard"),
  log: (patch: Partial<DailyLog> & { logDate: string }) =>
    request<DailyLog>("/log", { method: "POST", body: JSON.stringify(patch) }),
  settings: (patch: Partial<CycleSettings> & { name?: string }) =>
    request<Me>("/settings", { method: "POST", body: JSON.stringify(patch) }),
  setPeriodDay: (logDate: string, logged: boolean, flow?: PeriodFlow) =>
    request<Me>("/cycle/period-day", {
      method: "POST",
      body: JSON.stringify({ logDate, logged, flow }),
    }),
  removePrediction: (logDate: string, remove: boolean) =>
    request<Me>("/cycle/prediction", {
      method: "POST",
      body: JSON.stringify({ logDate, remove }),
    }),
  insights: () => request<{ insight: string | null }>("/insights", { method: "POST", body: "{}" }),
  journal: () => request<{ entries: JournalEntry[] }>("/journal"),
  saveJournal: (input: { logDate: string; text: string; shared: boolean }) =>
    request<JournalEntry>("/journal", { method: "POST", body: JSON.stringify(input) }),
  todos: () => request<TodoPage>("/todos"),
  usEntries: async () => {
    const response = await request<{ entries: UsEntry[] }>("/us");
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { entries: response.entries.filter((entry) => entry.logDate === today) };
  },
  addUsEntry: (text: string) =>
    request<{ entry: UsEntry }>("/us", { method: "POST", body: JSON.stringify({ text }) }),
  postTodo: (input: { action: string; id?: string; text?: string }) =>
    request<TodoPage>("/todos", { method: "POST", body: JSON.stringify(input) }),
  status: (payload: Record<string, unknown>) =>
    request<{ ok: true }>("/status", { method: "POST", body: JSON.stringify(payload) }),
  connect: (code: string) =>
    request<{ partnerName: string; linkId: string }>("/partner/connect", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  registerPushToken: async (token: string) => {
    const result = await request<{ ok: true }>("/push/register", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    pushTokenStore.set(token);
    return result;
  },
  unregisterPushToken: (token: string) =>
    request<{ ok: true }>("/push/unregister", { method: "POST", body: JSON.stringify({ token }) }),
  disconnect: () => request<{ ok: true }>("/partner/disconnect", { method: "POST", body: "{}" }),
  messages: () => request<{ messages: Message[] }>("/chat/messages"),
  callLog: () => request<{ calls: CallRecord[] }>("/calls"),
  closeCall: (callId: string) =>
    request<{ ok: true }>("/calls/close", { method: "POST", body: JSON.stringify({ callId }) }),
  markMessagesRead: (throughId: number) =>
    request<{ receipts: { messageId: number; deliveredAt: string; readAt: string }[] }>("/chat/read", {
      method: "POST",
      body: JSON.stringify({ throughId }),
    }),
  send: (payload: { ciphertext: string; iv: string; mediaId?: string }) =>
    request<{ message: Message }>("/chat/send", { method: "POST", body: JSON.stringify(payload) }),
  callIceServers: () => request<{ iceServers: RTCIceServer[] }>("/calls/ice"),
  uploadMedia: (contents: ArrayBuffer, viewOnce = false) =>
    request<{ id: string; size: number }>("/chat/media", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(viewOnce ? { "X-Syncura-View-Once": "true" } : {}),
      },
      body: contents,
    }),
  closeViewedMedia: (id: string) =>
    request<{ ok: true }>(`/chat/media/${encodeURIComponent(id)}/close`, {
      method: "POST",
      body: "{}",
    }),
  deleteMedia: (id: string) =>
    request<{ ok: true }>(`/chat/media/${encodeURIComponent(id)}`, { method: "DELETE" }),
  downloadMedia: async (id: string) => {
    const token = tokenStore.get();
    const response = await fetch(apiUrl(`/chat/media/${encodeURIComponent(id)}`), {
      headers: {
        ...(token ? { "x-syncura-token": token } : {}),
        ...accessHeader(),
      },
    });
    if (!response.ok) {
      let message = "Could not download this media";
      try {
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
          message = body.error;
        }
      } catch {
        /* Keep the download-specific error when the server response is not JSON. */
      }
      throw new ApiError(response.status, message);
    }
    return response.arrayBuffer();
  },
};

