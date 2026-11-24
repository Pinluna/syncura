import { io, type Socket } from "socket.io-client";

const BASE = process.env.BASE ?? "http://localhost:3001";

let failures = 0;
const ok = (label: string, cond: unknown) => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  const res = await fetch(`${BASE}/api${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-syncura-token": token } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const jwk = (tag: string) => ({
  kty: "EC",
  crv: "P-256",
  x: Buffer.from(tag).toString("base64url").padEnd(43, "A").slice(0, 43),
  y: Buffer.from(`${tag}y`).toString("base64url").padEnd(43, "A").slice(0, 43),
  ext: true,
  key_ops: [],
});

type Events = Record<string, unknown[]>;

function track(socket: Socket): Events {
  const events: Events = {};
  for (const name of [
    "room:ready",
    "presence",
    "typing",
    "status:update",
    "message",
    "message:receipt",
    "hydration:update",
    "todos",
    "call:signal",
    "connect",
    "connect_error",
  ]) {
    socket.on(name as never, (payload: unknown) => {
      (events[name] ??= []).push(payload);
    });
  }
  return events;
}

const last = (events: Events, name: string) => events[name]?.[events[name].length - 1];

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      path: "/socket.io",
      transports: ["websocket"],
      auth: { token },
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error("socket connect timed out")), 8000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function main() {
  console.log("\nsocket auth");
  const anon = io(BASE, { path: "/socket.io", transports: ["websocket"], reconnection: false });
  const rejected = await new Promise<boolean>((resolve) => {
    anon.on("connect_error", () => resolve(true));
    anon.on("connect", () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  ok("unauthenticated socket is refused", rejected);
  anon.close();

  console.log("\naccounts + pairing");
  const she = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Iris",
      dateOfBirth: "1997-03-02",
      sex: "female",
      publicKey: JSON.stringify(jwk("iris")),
    }),
  });
  const he = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Kai",
      dateOfBirth: "1995-11-20",
      sex: "male",
      publicKey: JSON.stringify(jwk("kai")),
    }),
  });
  const sheToken = she.body.token as string;
  const heToken = he.body.token as string;
  const meShe = await call("/me", { token: sheToken });
  await call("/partner/connect", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ code: meShe.body.link.code }),
  });
  const linkId = meShe.body.link.id as string;
  ok("paired", Boolean(linkId));

  console.log("\nsubscribing to the link room");
  const a = await connect(sheToken);
  const b = await connect(heToken);
  const ea = track(a);
  const eb = track(b);

  a.emit("subscribe", linkId);
  await wait(600);
  const ready = last(ea, "room:ready") as { linkId?: string } | undefined;
  ok("room:ready echoes the link", ready?.linkId === linkId);

  b.emit("subscribe", linkId);
  await wait(700);
  const presence = last(ea, "presence") as { members?: string[] } | undefined;
  ok("presence snapshot lists both partners", (presence?.members?.length ?? 0) === 2);
  ok("presence marks partner online", presence?.partnerOnline === true);

  const badRoom = last(eb, "room:ready");
  ok("unrelated channels are ignored", badRoom?.linkId === linkId);

  console.log("\nWebRTC call signaling");
  const callId = "00000000-0000-4000-8000-000000000001";
  a.emit("call:signal", {
    callId,
    kind: "offer",
    mode: "audio",
    data: { type: "offer", sdp: "test-sdp" },
    senderId: "forged-sender",
  });
  await wait(350);
  const callOffer = last(eb, "call:signal") as {
    callId?: string;
    kind?: string;
    mode?: string;
    senderId?: string;
  } | undefined;
  ok("only the paired partner receives call offers", callOffer?.callId === callId && callOffer.kind === "offer");
  ok("server sets the signaling identity", callOffer?.senderId === meShe.body.user.id);
  ok("call offer is not echoed to its sender", !ea["call:signal"]);

  console.log("\ntyping indicator (partner only)");
  b.emit("typing", { typing: true });
  await wait(500);
  ok("partner receives typing", (last(ea, "typing") as { typing?: boolean })?.typing === true);
  ok("sender does not receive its own typing", !eb.typing);
  b.emit("typing", { typing: false });
  await wait(400);
  ok("typing clears", (last(ea, "typing") as { typing?: boolean })?.typing === false);

  console.log("\nlive status over the socket");
  await call("/settings", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ shareLocation: true, shareActivity: true, shareBattery: true }),
  });
  a.emit("status:set", {
    latitude: 48.8566,
    longitude: 2.3522,
    accuracyM: 8,
    activity: "driving",
    batteryLevel: 55,
  });
  await wait(700);
  const pushed = last(eb, "status:update") as { status?: Record<string, unknown> } | undefined;
  ok("partner receives pushed status", pushed?.status?.latitude === 48.8566);
  ok("pushed status respects the opt-in", pushed?.status?.activity === "driving");
  ok("sender is not echoed its own status", !ea["status:update"]);

  console.log("\nwater logging realtime update");
  const hydrationLog = await call("/log", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({
      logDate: (() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      })(),
      waterGlasses: 3,
    }),
  });
  await wait(400);
  const hydration = last(eb, "hydration:update") as { userId?: string; waterGlasses?: number } | undefined;
  ok("water count is accepted", hydrationLog.status === 200 && hydrationLog.body.waterGlasses === 3);
  ok("partner receives the water count", hydration?.userId === meShe.body.user.id && hydration.waterGlasses === 3);

  console.log("\nprivacy gating over the socket");
  await call("/settings", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ shareLocation: false }),
  });
  a.emit("status:set", { latitude: 10 });
  await wait(600);
  const gated = last(eb, "status:update") as { status?: Record<string, unknown> } | undefined;
  ok("gated write blanks location", gated?.status?.latitude === null);
  const dash = await call("/dashboard", { token: heToken });
  ok("stored status was scrubbed on opt-out", dash.body.status?.latitude === null);

  console.log("\nchat broadcast");
  const sent = await call("/chat/send", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({
      ciphertext: Buffer.from("hi-kai").toString("base64"),
      iv: Buffer.from("0123456789ab").toString("base64"),
    }),
  });
  await wait(700);
  const msg = last(eb, "message") as { message?: { ciphertext?: string } } | undefined;
  ok("partner receives the message event", Boolean(msg?.message?.ciphertext));
  ok("message is marked delivered while partner is online", Boolean(sent.body.message?.deliveredAt));
  ok(
    "broadcast is ciphertext only",
    !JSON.stringify(msg ?? {}).includes("hi-kai"),
  );
  const deliveredReceipt = last(ea, "message:receipt") as { messageId?: number; readAt?: string | null } | undefined;
  ok("sender receives a closed-eye delivery receipt", deliveredReceipt?.messageId === sent.body.message.id && !deliveredReceipt.readAt);
  const markedRead = await call("/chat/read", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ throughId: sent.body.message.id }),
  });
  await wait(300);
  const readReceipt = last(ea, "message:receipt") as { messageId?: number; readAt?: string | null } | undefined;
  ok("recipient marks the incoming message as read", markedRead.body.receipts.length === 1);
  ok("sender receives an open-eye read receipt", readReceipt?.messageId === sent.body.message.id && Boolean(readReceipt.readAt));

  console.log("\nshared todos over the socket");
  await call("/todos", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ action: "add", text: "Call mum" }),
  });
  await wait(600);
  const todos = last(ea, "todos") as { todos?: { text?: string }[] } | undefined;
  ok("partner receives the todo list", todos?.todos?.[0]?.text === "Call mum");

  console.log("\nunsubscribe");
  b.emit("unsubscribe");
  await wait(600);
  const afterLeave = last(ea, "presence") as { members?: string[] } | undefined;
  ok("presence drops after leaving", (afterLeave?.members?.length ?? 0) === 1);

  b.close();
  await wait(600);
  const offline = last(ea, "presence") as { partnerOnline?: boolean; lastSeenAt?: string | null } | undefined;
  ok("last seen is updated when partner disconnects", offline?.partnerOnline === false && Boolean(offline.lastSeenAt));
  a.close();
  await wait(300);

  console.log(`\n${failures === 0 ? "ALL REALTIME CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(2);
});
