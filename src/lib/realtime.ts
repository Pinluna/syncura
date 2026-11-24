import { io, type Socket } from "socket.io-client";
import { tokenStore } from "./api";
import { accessKey, socketUrl } from "./config";
import type { CallRecord, LiveStatus, Message, UsEntry } from "./api";

export interface ChatEvent extends Message {}

export interface CallSignal {
  callId: string;
  kind: "offer" | "answer" | "ice" | "end";
  mode?: "audio" | "video";
  data?: RTCSessionDescriptionInit | RTCIceCandidateInit;
  senderId: string;
}

export interface RealtimeHandlers {
  onMessage: (message: ChatEvent) => void;
  onMessageDeleted: (messageId: number) => void;
  onMessageReceipt: (receipt: { messageId: number; deliveredAt: string; readAt: string | null }) => void;
  onTyping: (typing: boolean) => void;
  onStatus: (status: LiveStatus) => void;
  onPartnerPresence: (online: boolean, lastSeenAt: string | null) => void;
  onTodos: (todos: unknown[]) => void;
  onHydration: (update: { userId: string; waterGlasses: number; logDate: string }) => void;
  /* The pair itself changed: either side linked or unlinked. */
  onLinkChanged: () => void;
  onCallSignal: (signal: CallSignal) => void;
  onCallLog: (records: CallRecord[]) => void;
  onUsEntry: (entry: UsEntry) => void;
}

const NOOP: RealtimeHandlers = {
  onMessage: () => {},
  onMessageDeleted: () => {},
  onMessageReceipt: () => {},
  onTyping: () => {},
  onStatus: () => {},
  onPartnerPresence: () => {},
  onTodos: () => {},
  onHydration: () => {},
  onLinkChanged: () => {},
  onCallSignal: () => {},
  onCallLog: () => {},
  onUsEntry: () => {},
};

const handlers: RealtimeHandlers = { ...NOOP };
const timers = new Map<string, ReturnType<typeof setTimeout>>();

let socket: Socket | null = null;
let linkId: string | null = null;
let partnerPresence: { online: boolean; lastSeenAt: string | null } | null = null;

function emitToLink(event: string, payload: Record<string, unknown> = {}) {
  if (!socket || !linkId) return;
  socket.emit(event, payload);
}

/* Tears down the transport only. The handler registry belongs to the screens that
   subscribed, so it must survive a reconnect -- only an explicit sign-out (which
   unmounts them) is allowed to clear it. */
function teardownSocket() {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  socket = null;
  linkId = null;
  partnerPresence = null;
}

export function connectRealtime(id: string) {
  if (socket && linkId === id && socket.connected) return;

  teardownSocket();
  linkId = id;

  socket = io(socketUrl(), {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    auth: (cb) => cb({ token: tokenStore.get(), accessKey: accessKey() }),
    reconnectionDelay: 800,
    reconnectionDelayMax: 6000,
  });

  const join = () => socket?.emit("subscribe", linkId);
  socket.on("connect", join);
  join();

  socket.on("room:ready", (p: { partnerOnline?: boolean; lastSeenAt?: string | null }) =>
    setPartnerPresence(Boolean(p?.partnerOnline), p?.lastSeenAt ?? null),
  );
  socket.on("presence", (p: { partnerOnline?: boolean; lastSeenAt?: string | null }) => {
    setPartnerPresence(Boolean(p?.partnerOnline), p?.lastSeenAt ?? null);
  });
  socket.on("typing", (p: { typing?: boolean }) => {
    const t = timers.get("partner");
    if (t) clearTimeout(t);
    const typing = Boolean(p?.typing);
    handlers.onTyping(typing);
    if (!typing) return;
    timers.set(
      "partner",
      setTimeout(() => handlers.onTyping(false), 5000),
    );
  });
  socket.on("status:update", (p: { status?: LiveStatus }) => {
    if (p?.status) handlers.onStatus(p.status);
  });
  socket.on("message", (p: { message?: Message }) => {
    if (p?.message) handlers.onMessage(p.message);
  });
  socket.on("message:deleted", (p: { messageId?: number }) => {
    if (Number.isSafeInteger(p?.messageId)) handlers.onMessageDeleted(p.messageId as number);
  });
  socket.on(
    "message:receipt",
    (receipt: { messageId?: number; deliveredAt?: string; readAt?: string | null }) => {
      if (Number.isSafeInteger(receipt?.messageId) && receipt.deliveredAt) {
        handlers.onMessageReceipt({
          messageId: receipt.messageId as number,
          deliveredAt: receipt.deliveredAt,
          readAt: receipt.readAt ?? null,
        });
      }
    },
  );
  socket.on("todos", (p: { todos?: unknown[] }) => {
    if (Array.isArray(p?.todos)) handlers.onTodos(p.todos);
  });
  socket.on("hydration:update", (p: { userId?: string; waterGlasses?: number; logDate?: string }) => {
    if (
      typeof p?.userId === "string" &&
      Number.isInteger(p.waterGlasses) &&
      typeof p.logDate === "string"
    ) {
      handlers.onHydration({
        userId: p.userId,
        waterGlasses: p.waterGlasses as number,
        logDate: p.logDate,
      });
    }
  });
  socket.on("link:changed", () => handlers.onLinkChanged());
  socket.on("call:signal", (signal: CallSignal) => {
    if (
      signal &&
      typeof signal.callId === "string" &&
      ["offer", "answer", "ice", "end"].includes(signal.kind) &&
      typeof signal.senderId === "string"
    ) {
      handlers.onCallSignal(signal);
    }
  });
  socket.on("call:log", (payload: { calls?: CallRecord[] } | CallRecord[]) => {
    const records = Array.isArray(payload) ? payload : payload?.calls;
    if (Array.isArray(records)) handlers.onCallLog(records);
  });
  socket.on("us:entry", (payload: { entry?: UsEntry }) => {
    if (payload?.entry && typeof payload.entry.id === "string") {
      handlers.onUsEntry(payload.entry);
    }
  });
}

export function disconnectRealtime() {
  teardownSocket();
  Object.assign(handlers, NOOP);
}

export function subscribeRealtime(next: Partial<RealtimeHandlers>): () => void {
  Object.assign(handlers, next);
  if (next.onPartnerPresence && partnerPresence) {
    next.onPartnerPresence(partnerPresence.online, partnerPresence.lastSeenAt);
  }
  return () => {
    for (const key of Object.keys(next) as (keyof RealtimeHandlers)[]) {
      (handlers as unknown as Record<string, unknown>)[key] = NOOP[key];
    }
  };
}

function setPartnerPresence(online: boolean, lastSeenAt: string | null) {
  partnerPresence = { online, lastSeenAt };
  handlers.onPartnerPresence(online, lastSeenAt);
}

export function sendTyping(typing: boolean) {
  emitToLink("typing", { typing });
  const existing = timers.get("self");
  if (existing) clearTimeout(existing);
  if (typing) {
    timers.set("self", setTimeout(() => emitToLink("typing", { typing: false }), 4000));
  }
}

export function publishStatus(payload: Record<string, unknown>) {
  emitToLink("status:set", payload);
}

export function sendCallSignal(
  signal: Omit<CallSignal, "senderId">,
) {
  emitToLink("call:signal", signal);
}

