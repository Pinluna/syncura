import express, { type Request, type Response, type NextFunction } from "express";
import { Server } from "socket.io";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  DATE_RE,
  buildInsight,
  normaliseLog,
  normaliseStatus,
  todayKey,
} from "./cycle.js";
import {
  createUser,
  db,
  deleteMedia,
  deleteLinkMedia,
  deleteUser,
  emptyLog,
  findLinkByCode,
  linkOf,
  newStatus,
  partnerOf,
  save,
  shapeMe,
  toPublicUser,
  userByToken,
  readMedia,
  writeMedia,
  type Link,
  type LiveStatus,
  type User,
} from "./store.js";
import { notifyIncomingMessage } from "./push.js";
import { recordSocketConnection, trackTraffic, trafficSnapshot, validControlToken } from "./traffic.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.SYNCURA_HOST ?? "127.0.0.1";

const app = express();
const MAX_MEDIA_SIZE = 20 * 1024 * 1024;
const MAX_LINK_MEDIA_STORAGE = 200 * 1024 * 1024;

/* Behind Caddy the real client address arrives in X-Forwarded-For, so the
   rate limiter must trust exactly one proxy hop and nothing else. */
app.set("trust proxy", process.env.SYNCURA_TRUST_PROXY ?? "loopback");
app.disable("x-powered-by");

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function readIceServers(): IceServer[] {
  const value = process.env.SYNCURA_ICE_SERVERS;
  if (!value) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("SYNCURA_ICE_SERVERS must be a JSON array", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error("SYNCURA_ICE_SERVERS must be a JSON array");

  return parsed.map((server) => {
    if (
      typeof server !== "object" ||
      server === null ||
      !("urls" in server) ||
      !(typeof server.urls === "string" ||
        (Array.isArray(server.urls) &&
          server.urls.every((url: unknown) => typeof url === "string"))) ||
      ("username" in server && typeof server.username !== "string") ||
      ("credential" in server && typeof server.credential !== "string")
    ) {
      throw new Error("SYNCURA_ICE_SERVERS contains an invalid ICE server");
    }
    return server as IceServer;
  });
}

const ICE_SERVERS = readIceServers();

/* The phone app runs in a WebView whose origin (https://localhost) is never the
   server, so every API call is cross-origin and needs an allowance. The auth
   token travels in a header rather than a cookie, so a hostile page still cannot
   act as a signed-in user. Set SYNCURA_ORIGINS to a comma-separated allowlist to
   tighten this for a public deployment. */
const ORIGIN_ALLOWLIST = (process.env.SYNCURA_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(trackTraffic);

/* Public deployments gate the whole app behind one shared secret so scanners
   and drive-by signups never reach the intimate data store. The key travels in
   the x-syncura-access header (the phone app and replayed offline writes), in a
   ?k= query parameter (so an invite link opens straight into the site), or in a
   cookie set from that link. No key configured means no gate, which keeps LAN
   and development use unchanged. */
const ACCESS_KEY = (process.env.SYNCURA_ACCESS_KEY ?? "").trim();
const ACCESS_COOKIE = "syncura_access";

function keyMatches(candidate: string | undefined | null): boolean {
  if (!ACCESS_KEY || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(ACCESS_KEY);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookieValue(raw: string | undefined, name: string): string | null {
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/* The health check stays open so uptime scripts and `npm run pretest` keep
   working without holding the invite secret. */
function needsAccess(req: Request): boolean {
  return req.path !== "/api/health" && req.path !== "/__local/traffic";
}

function presentedKey(req: Request): { value: string | undefined; fromLink: boolean } {
  const fromHeader = req.header("x-syncura-access");
  if (fromHeader) return { value: fromHeader, fromLink: false };
  const fromCookie = cookieValue(req.header("cookie"), ACCESS_COOKIE);
  if (fromCookie) return { value: fromCookie, fromLink: false };
  const fromQuery = new URL(req.originalUrl, "http://placeholder").searchParams.get("k") ?? undefined;
  return { value: fromQuery, fromLink: true };
}

function denied(req: Request, res: Response): void {
  if (req.path.startsWith("/api/")) {
    fail(res, 403, "This server needs an invite link");
    return;
  }
  res
    .status(403)
    .type("text/html")
    .send(
      "<!doctype html><meta charset=utf-8><title>Syncura</title>" +
        "<body style=\"font:16px system-ui;padding:3rem;max-width:32rem;margin:auto\">" +
        "<h1>Invite link required</h1>" +
        "<p>Open the full invite link you were sent. It contains a one-time access " +
        "code that this server checks before showing the app.</p></body>",
    );
}

/* A short code stands in for the 48 character invite key so the link can be read
   aloud or typed on a phone: /i/lantern-otter-mist-42. It grants exactly what
   the key does, so it gets its own guess limit, and it is traded for the
   session cookie here rather than kept in the URL the browser remembers. */
const INVITE_CODES = (process.env.SYNCURA_INVITE_CODES ?? "")
  .split(/[\s,]+/)
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);

function codeMatches(candidate: string): boolean {
  return INVITE_CODES.some(
    (code) =>
      code.length === candidate.length && timingSafeEqual(Buffer.from(code), Buffer.from(candidate)),
  );
}

function inviteMiss(req: Request, res: Response): void {
  if (req.accepts("html")) {
    res
      .status(404)
      .type("text/html")
      .send(
        "<!doctype html><meta charset=utf-8><title>Syncura</title>" +
          "<body style=\"font:16px system-ui;padding:3rem;max-width:32rem;margin:auto\">" +
          "<h1>That invite code is not right</h1>" +
          "<p>Check the link you were sent, or ask for a new one.</p></body>",
      );
    return;
  }
  fail(res, 404, "Not a valid invite code");
}

app.get("/i/:code", (req: Request, res: Response) => {
  if (!ACCESS_KEY || INVITE_CODES.length === 0) {
    fail(res, 404, "Not found");
    return;
  }

  const code = String(req.params.code ?? "").toLowerCase();
  if (codeMatches(code)) {
    res.setHeader(
      "Set-Cookie",
      `${ACCESS_COOKIE}=${encodeURIComponent(ACCESS_KEY)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    res.redirect(302, "/");
    return;
  }

  /* Guessing is the whole attack surface here, so a code gets fewer tries than
     the general limit and every miss counts whether or not it was close. */
  if (overLimit("invite", RATE_LIMITS.invite, req.ip)) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_WINDOW_MS / 1000)));
    fail(res, 429, "Too many tries. Try again shortly.");
    return;
  }
  countHit("invite", req.ip);
  inviteMiss(req, res);
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!ACCESS_KEY || !needsAccess(req)) {
    next();
    return;
  }

  const presented = presentedKey(req);
  if (keyMatches(presented.value)) {
    /* An invite link has no cookie of its own, so mint one and let the browser
       carry it from then on. A header from the phone app needs no cookie. */
    if (presented.fromLink) {
      res.setHeader(
        "Set-Cookie",
        `${ACCESS_COOKIE}=${encodeURIComponent(ACCESS_KEY)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
      );
    }
    next();
    return;
  }

  /* A preflight carries no key of its own -- only the names of the headers the
     real request will send -- so it has to pass or the browser blocks it. */
  if (req.method === "OPTIONS") {
    next();
    return;
  }

  denied(req, res);
});

/* Fixed-window counters kept in memory: enough to stop drive-by registration and
   to keep one client from filling the store, without pulling in a dependency. */
const RATE_WINDOW_MS = Number(process.env.SYNCURA_RATE_WINDOW_MS ?? 60_000);
const RATE_LIMITS = {
  register: Number(process.env.SYNCURA_RATE_REGISTER ?? 20),
  connect: Number(process.env.SYNCURA_RATE_CONNECT ?? 10),
  general: Number(process.env.SYNCURA_RATE_GENERAL ?? 600),
  invite: Number(process.env.SYNCURA_RATE_INVITE ?? 10),
} as const;

const rateCounters = new Map<string, { count: number; resetAt: number }>();

function currentCount(bucket: string, ip: string | undefined): number {
  const entry = rateCounters.get(`${bucket}:${ip ?? "unknown"}`);
  if (!entry || entry.resetAt <= Date.now()) return 0;
  return entry.count;
}

function countHit(bucket: string, ip: string | undefined): void {
  const now = Date.now();
  for (const [key, entry] of rateCounters) {
    if (entry.resetAt <= now) rateCounters.delete(key);
  }
  const key = `${bucket}:${ip ?? "unknown"}`;
  const entry = rateCounters.get(key);
  if (entry && entry.resetAt > now) entry.count += 1;
  else rateCounters.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
}

function overLimit(bucket: string, limit: number, ip: string | undefined): boolean {
  return limit > 0 && currentCount(bucket, ip) >= limit;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!needsAccess(req)) {
    next();
    return;
  }
  /* One count per request is enough here: the goal is to stop a single client
     monopolising the process, not to police individual endpoints. */
  const limit = RATE_LIMITS.general;
  if (overLimit("general", limit, req.ip)) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_WINDOW_MS / 1000)));
    fail(res, 429, "Too many requests. Try again shortly.");
    return;
  }
  countHit("general", req.ip);
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.header("origin");
  if (origin && (ORIGIN_ALLOWLIST.length === 0 || ORIGIN_ALLOWLIST.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-syncura-token, x-syncura-access");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: "512kb" }));

const tlsKeyFile = process.env.SYNCURA_TLS_KEY_FILE;
const tlsCertFile = process.env.SYNCURA_TLS_CERT_FILE;
if (Boolean(tlsKeyFile) !== Boolean(tlsCertFile)) {
  throw new Error("Set both SYNCURA_TLS_KEY_FILE and SYNCURA_TLS_CERT_FILE to enable HTTPS");
}
const httpServer =
  tlsKeyFile && tlsCertFile
    ? createHttpsServer({ key: readFileSync(tlsKeyFile), cert: readFileSync(tlsCertFile) }, app)
    : createHttpServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });

const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });

type Authed = { user: User; link: Link | null };

const auth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.header("x-syncura-token");
  const user = userByToken(token);
  if (!user) {
    fail(res, 401, "Not signed in");
    return;
  }
  (req as Request & { auth: Authed }).auth = { user, link: linkOf(user) };
  next();
};

const ctx = (req: Request): Authed => (req as Request & { auth: Authed }).auth;

function emitToLink(link: Link, event: string, payload: unknown) {
  io.to(link.id).emit(event, payload);
}

function partnerOfLink(link: Link | null, user: User): User | null {
  return partnerOf(link, user);
}

function cycleOwner(user: User, partner: User | null): User {
  if (user.sex === "female") return user;
  if (partner?.sex === "female") return partner;
  return user;
}

/* Applies the caller's share permissions to an incoming status patch. Revoking a
   permission scrubs the field that was already collected, so opting out takes
   effect immediately rather than only on the next write. */
function applyStatusGating(user: User, patch: Partial<LiveStatus>): LiveStatus {
  const s = user.settings;
  const next: LiveStatus = { ...(user.status ?? newStatus()), ...patch };

  if (!s.shareLocation) {
    next.latitude = null;
    next.longitude = null;
    next.accuracyM = null;
    next.headingDeg = null;
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

app.post("/api/auth/register", (req, res) => {
  /* Only accounts that actually get created count: a couple of mistyped fields
     should never cost someone their place. */
  if (overLimit("register", RATE_LIMITS.register, req.ip)) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_WINDOW_MS / 1000)));
    fail(res, 429, "Too many signups from here. Try again later.");
    return;
  }
  const { name, dateOfBirth, sex, publicKey } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) return fail(res, 400, "Please enter your name");
  if (name.trim().length > 60) return fail(res, 400, "Please enter your name");
  if (typeof dateOfBirth !== "string" || !DATE_RE.test(dateOfBirth)) {
    return fail(res, 400, "Please enter your date of birth");
  }
  if (sex !== "female" && sex !== "male") return fail(res, 400, "Please choose an option");
  if (typeof publicKey !== "string" || publicKey.length < 10 || publicKey.length > 2000) {
    return fail(res, 400, "Missing encryption key");
  }
  if (dateOfBirth.slice(0, 4) > String(new Date().getFullYear())) {
    return fail(res, 400, "Please enter your date of birth");
  }
  const user = createUser({ name: name.trim(), sex, dateOfBirth, publicKey });
  countHit("register", req.ip);
  res.json({ token: user.token, user: toPublicUser(user) });
});

app.get("/api/me", auth, (req, res) => {
  res.json(shapeMe(ctx(req).user));
});

app.post("/api/push/register", auth, (req, res) => {
  const { user } = ctx(req);
  const token = req.body?.token;
  if (typeof token !== "string" || token.length < 20 || token.length > 4096) {
    return fail(res, 400, "Invalid push notification token");
  }
  const tokens = new Set(user.pushTokens ?? []);
  tokens.add(token);
  if (tokens.size > 10) return fail(res, 400, "This account has too many registered devices");
  user.pushTokens = [...tokens];
  save();
  res.json({ ok: true });
});

app.post("/api/push/unregister", auth, (req, res) => {
  const { user } = ctx(req);
  const token = req.body?.token;
  if (typeof token !== "string" || token.length < 20 || token.length > 4096) {
    return fail(res, 400, "Invalid push notification token");
  }
  user.pushTokens = (user.pushTokens ?? []).filter((registered) => registered !== token);
  save();
  res.json({ ok: true });
});

app.post("/api/account/delete", auth, (req, res) => {
  const { user } = ctx(req);
  deleteUser(user);
  res.json({ ok: true });
});

app.get("/api/dashboard", auth, (req, res) => {
  const { user, link } = ctx(req);
  const partner = partnerOfLink(link, user);
  const owner = cycleOwner(user, partner);
  const logs = Object.values(owner.logs).sort((a, b) => a.logDate.localeCompare(b.logDate));

  const fromPartner = partner
    ? {
        name: partner.name,
        entries: Object.values(partner.journal)
          .filter((e) => e.shared)
          .sort((a, b) => b.logDate.localeCompare(a.logDate))
          .slice(0, 15),
      }
    : undefined;

  res.json({
    logs,
    hydration: {
      mine: user.logs[todayKey()]?.waterGlasses ?? 0,
      partner: partner ? partner.logs[todayKey()]?.waterGlasses ?? 0 : null,
    },
    settings: owner.settings,
    owner: { name: owner.name, sex: owner.sex },
    viewer: user.sex,
    link: link
      ? { id: link.id, connected: Boolean(link.bId), partnerName: partner?.name ?? null }
      : null,
    status: partner?.status ?? null,
    partner: partner
      ? { name: partner.name, settings: partner.settings }
      : undefined,
    fromPartner,
  });
});

app.post("/api/log", auth, (req, res) => {
  const { user } = ctx(req);
  const { logDate, ...rest } = req.body ?? {};
  if (typeof logDate !== "string" || !DATE_RE.test(logDate)) {
    return fail(res, 400, "Invalid date");
  }
  if ("intercourseCount" in rest && user.sex !== "female") {
    return fail(res, 403, "Only the female partner can log intimacy");
  }
  const patch = normaliseLog(rest);
  const base = user.logs[logDate] ?? emptyLog(logDate);
  const merged: typeof base = { ...base, ...patch, logDate };
  user.logs[logDate] = merged;
  save();

  const { link } = ctx(req);
  if (link?.bId) {
    const partner = partnerOfLink(link, user);
    if (partner) {
      emitToLink(link, "log:changed", { userId: user.id, partnerId: partner.id, logDate });
      if (logDate === todayKey()) {
        emitToLink(link, "hydration:update", {
          userId: user.id,
          waterGlasses: merged.waterGlasses,
          logDate,
        });
      }
    }
  }
  res.json(merged);
});

app.post("/api/cycle/period-day", auth, (req, res) => {
  const { user, link } = ctx(req);
  if (user.sex !== "female") return fail(res, 403, "Only the female partner can log period days");
  const { logDate, logged, flow } = req.body ?? {};
  const dateValue =
    typeof logDate === "string" && DATE_RE.test(logDate)
      ? new Date(`${logDate}T00:00:00.000Z`)
      : null;
  if (!dateValue || Number.isNaN(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== logDate) {
    return fail(res, 400, "Invalid period date");
  }
  if (logDate > todayKey()) return fail(res, 400, "Future dates cannot be logged as period days");
  if (typeof logged !== "boolean") return fail(res, 400, "Choose whether this period day is logged");
  if (flow !== undefined && !["light", "medium", "heavy"].includes(flow)) {
    return fail(res, 400, "Choose light, medium or heavy flow");
  }

  const periodDays = new Set(user.settings.periodDays ?? []);
  const periodFlow = { ...(user.settings.periodFlow ?? {}) };
  if (logged) periodDays.add(logDate);
  else {
    periodDays.delete(logDate);
    delete periodFlow[logDate];
  }
  if (logged) periodFlow[logDate] = flow ?? periodFlow[logDate] ?? "medium";
  if (periodDays.size > 3000) return fail(res, 400, "Too many period dates to save");
  user.settings.periodDays = [...periodDays].sort();
  user.settings.periodFlow = periodFlow;
  save();
  if (link?.bId) emitToLink(link, "period:changed", { userId: user.id });
  res.json(shapeMe(user));
});

app.post("/api/settings", auth, (req, res) => {
  const { user } = ctx(req);
  const body = req.body ?? {};
  const s = user.settings;
  const int = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  const date = (v: unknown) => (typeof v === "string" && DATE_RE.test(v) ? v : null);

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > 60) return fail(res, 400, "Please enter your name");
    user.name = name;
  }
  if (int(body.cycleLength, 28, 36)) s.cycleLength = body.cycleLength as number;
  if (int(body.periodLength, 2, 6)) s.periodLength = body.periodLength as number;
  if (body.lastPeriodStart !== undefined) s.lastPeriodStart = date(body.lastPeriodStart);
  if (body.lastPeriodEnd !== undefined) s.lastPeriodEnd = date(body.lastPeriodEnd);
  s.shareActivity = true;
  s.shareBattery = true;
  for (const key of [
    "shareLocation",
    "shareJournal",
    "liveSharing",
  ] as const) {
    if (typeof body[key] === "boolean") s[key] = body[key] as boolean;
  }

  /* Revoking a share permission must stop exposing what was already collected. */
  if (user.status) user.status = applyStatusGating(user, {});

  save();
  res.json(shapeMe(user));
});

app.post("/api/insights", auth, (req, res) => {
  const { user } = ctx(req);
  res.json({ insight: buildInsight(user, todayKey()) });
});

app.get("/api/journal", auth, (req, res) => {
  const { user } = ctx(req);
  res.json({
    entries: Object.values(user.journal).sort((a, b) => b.logDate.localeCompare(a.logDate)),
  });
});

app.post("/api/journal", auth, (req, res) => {
  const { user } = ctx(req);
  const { logDate, text, shared } = req.body ?? {};
  if (typeof logDate !== "string" || !DATE_RE.test(logDate)) return fail(res, 400, "Invalid date");
  const body = typeof text === "string" ? text.slice(0, 8000) : "";
  const isShared = Boolean(shared);
  const existing = user.journal[logDate];
  user.journal[logDate] = { logDate, text: body, shared: isShared, updatedAt: new Date().toISOString() };
  if (!existing && !body) delete user.journal[logDate];
  save();
  res.json(user.journal[logDate] ?? { logDate, text: "", shared: false });
});

app.get("/api/todos", auth, (req, res) => {
  res.json({ todos: ctx(req).link?.todos ?? [] });
});

app.get("/api/us", auth, (req, res) => {
  const { link } = ctx(req);
  if (!link?.bId) return fail(res, 409, "You're not connected to anyone yet");
  const day = todayKey();
  const currentEntries = link.usEntries.filter((entry) => entry.logDate === day);
  if (currentEntries.length !== link.usEntries.length) {
    link.usEntries = currentEntries;
    save();
  }
  res.json({ entries: link.usEntries.filter((entry) => entry.logDate === day) });
});

app.post("/api/us", auth, (req, res) => {
  const { user, link } = ctx(req);
  if (!link?.bId) return fail(res, 409, "You're not connected to anyone yet");
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return fail(res, 400, "Write a message for your shared thread");
  if (text.length > 2000) return fail(res, 400, "Keep shared thread messages under 2,000 characters");
  const day = todayKey();
  link.usEntries = link.usEntries.filter((entry) => entry.logDate === day);
  const entry = {
    id: randomUUID(),
    senderId: user.id,
    logDate: day,
    text,
    createdAt: new Date().toISOString(),
  };
  link.usEntries.push(entry);
  save();
  emitToLink(link, "us:entry", { entry });
  res.json({ entry });
});

app.post("/api/todos", auth, (req, res) => {
  const { link } = ctx(req);
  const { action, id, text } = req.body ?? {};

  if (!link) return fail(res, 409, "You're not connected to anyone yet");

  switch (action) {
    case "add": {
      if (typeof text !== "string" || !text.trim()) {
        return fail(res, 400, "Type what the task is");
      }
      if (link.todos.length >= 100) return fail(res, 400, "That's plenty of tasks already");
      link.todos.push({
        id: randomBytes(6).toString("hex"),
        text: text.trim().slice(0, 160),
        done: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      break;
    }
    case "toggle": {
      if (typeof id !== "string") return fail(res, 400, "Which task?");
      const todo = link.todos.find((t) => t.id === id);
      if (!todo) return fail(res, 404, "That task is gone");
      todo.done = !todo.done;
      todo.completedAt = todo.done ? todayKey() : null;
      break;
    }
    case "remove": {
      if (typeof id !== "string") return fail(res, 400, "Which task?");
      const before = link.todos.length;
      link.todos = link.todos.filter((t) => t.id !== id);
      if (link.todos.length === before) return fail(res, 404, "That task is gone");
      break;
    }
    case "clearDone":
      link.todos = link.todos.filter((t) => !t.done);
      break;
    default:
      return fail(res, 400, "Unknown action");
  }

  save();
  if (link.bId) emitToLink(link, "todos", { todos: link.todos });
  res.json({ todos: link.todos });
});

app.post("/api/status", auth, (req, res) => {
  const { user, link } = ctx(req);
  user.status = applyStatusGating(user, normaliseStatus((req.body ?? {}) as Record<string, unknown>));
  save();
  if (link?.bId) emitToLink(link, "status:update", { status: user.status });
  res.json({ ok: true, status: user.status });
});

app.get("/api/calls/ice", auth, (req, res) => {
  if (!ctx(req).link?.bId) return fail(res, 409, "Connect with your partner before calling");
  res.json({ iceServers: ICE_SERVERS });
});

app.post("/api/partner/connect", auth, (req, res) => {
  /* Link codes are long enough that guessing them is hopeless, so this is here
     to stop someone spraying thousands of guesses rather than to protect a
     secret. Every attempt counts here, since a failed one means a wrong code. */
  if (overLimit("connect", RATE_LIMITS.connect, req.ip)) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_WINDOW_MS / 1000)));
    fail(res, 429, "Too many link attempts. Try again later.");
    return;
  }
  countHit("connect", req.ip);
  const { user, link } = ctx(req);
  const raw = req.body?.code;
  if (typeof raw !== "string" || raw.trim().length < 6) {
    return fail(res, 400, "Paste your partner's link");
  }
  if (raw.trim().length > 300) return fail(res, 400, "Paste your partner's link");

  const target = findLinkByCode(raw);
  if (!target) return fail(res, 404, "That link doesn't match anyone");
  if (target.aId === user.id) return fail(res, 400, "That's your own link");

  const targetOwner = db.users[target.aId];
  if (!targetOwner) return fail(res, 404, "That link doesn't match anyone");
  if (user.sex !== "male") {
    return fail(res, 403, "Only women can share a connection link");
  }
  if (targetOwner.sex !== "female") {
    return fail(res, 400, "Enter the connection link from your female partner");
  }

  if (link?.bId) {
    const existing = partnerOfLink(link, user);
    if (existing && existing.id !== targetOwner.id) {
      return fail(res, 409, "Disconnect from your current partner first");
    }
  }

  if (target.bId && target.bId !== user.id) {
    return fail(res, 409, "That link is already spoken for");
  }

  target.bId = user.id;
  target.connectedAt = new Date().toISOString();
  save();
  emitToLink(target, "link:changed", { linkId: target.id });
  res.json({ partnerName: targetOwner.name, linkId: target.id });
});

function unlink(link: Link, user: User) {
  const partner = partnerOfLink(link, user);
  if (link.aId === user.id) link.aId = partner?.id ?? link.aId;
  else link.bId = null;
  link.messages = [];
  link.todos = [];
  link.usEntries = [];
  deleteLinkMedia(link);
  save();
  if (partner) emitToLink(link, "link:changed", { linkId: link.id });
  return { disconnected: Boolean(partner) };
}

app.post("/api/partner/disconnect", auth, (req, res) => {
  const { user, link } = ctx(req);
  if (!link) return res.json({ ok: true });
  const result = unlink(link, user);
  res.json({ ok: true, disconnected: result.disconnected });
});

app.get("/api/chat/messages", auth, (req, res) => {
  const { link } = ctx(req);
  const messages = link?.bId
    ? link.messages.map((message) => {
        const media = message.mediaId ? link.mediaFiles[message.mediaId] : undefined;
        return media?.viewOnce
          ? {
              ...message,
              viewOnce: true,
              ...(media.openedAt ? { mediaOpenedAt: media.openedAt } : {}),
            }
          : message;
      })
    : [];
  res.json({ messages });
});

app.post("/api/chat/read", auth, (req, res) => {
  const { user, link } = ctx(req);
  const throughId = req.body?.throughId;
  if (!link?.bId) return fail(res, 409, "You're not connected to anyone yet");
  if (!Number.isSafeInteger(throughId) || throughId < 1) return fail(res, 400, "Invalid message receipt");

  const readAt = new Date().toISOString();
  const receipts = link.messages
    .filter((message) => message.id <= throughId && message.senderId !== user.id && !message.readAt)
    .map((message) => {
      message.deliveredAt ??= readAt;
      message.readAt = readAt;
      return { messageId: message.id, deliveredAt: message.deliveredAt, readAt };
    });
  if (receipts.length) {
    save();
    for (const receipt of receipts) emitToLink(link, "message:receipt", receipt);
  }
  res.json({ receipts });
});

app.post(
  "/api/chat/media",
  auth,
  express.raw({ type: "application/octet-stream", limit: MAX_MEDIA_SIZE }),
  (req, res) => {
    const { user, link } = ctx(req);
    if (!link?.bId) return fail(res, 409, "You're not connected to anyone yet");
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return fail(res, 400, "Media upload is empty");
    }
    if (req.body.length > MAX_MEDIA_SIZE) return fail(res, 413, "Media must be 20 MB or smaller");
    if (Object.keys(link.mediaFiles).length >= 500) {
      return fail(res, 413, "This chat has reached its media storage limit");
    }
    const storedBytes = Object.values(link.mediaFiles).reduce((total, file) => total + file.size, 0);
    if (storedBytes + req.body.length > MAX_LINK_MEDIA_STORAGE) {
      return fail(res, 413, "This chat has reached its 200 MB media storage limit");
    }

    const id = randomUUID();
    try {
      writeMedia(id, req.body);
    } catch (error) {
      console.error("Could not store encrypted chat media", error);
      return fail(res, 500, "Could not save this media");
    }
    link.mediaFiles[id] = {
      id,
      uploaderId: user.id,
      size: req.body.length,
      createdAt: new Date().toISOString(),
      ...(req.get("x-syncura-view-once") === "true" ? { viewOnce: true } : {}),
    };
    save();
    res.json({ id, size: req.body.length });
  },
);

app.get("/api/chat/media/:id", auth, (req, res) => {
  const { user, link } = ctx(req);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const media = link?.mediaFiles[id];
  if (!link?.bId || !media) return fail(res, 404, "That media is no longer available");
  if (media.viewOnce) {
    if (media.uploaderId === user.id) {
      return fail(res, 403, "View-once media can only be opened by its recipient");
    }
    if (media.openedAt) return fail(res, 410, "This view-once media has already been opened");
  }
  try {
    const contents = readMedia(id);
    if (!contents) return fail(res, 404, "That media is no longer available");
    if (media.viewOnce) {
      media.openedBy = user.id;
      media.openedAt = new Date().toISOString();
      save();
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("application/octet-stream").send(contents);
  } catch (error) {
    console.error("Could not read encrypted chat media", error);
    return fail(res, 500, "Could not download this media");
  }
});

app.post("/api/chat/media/:id/close", auth, (req, res) => {
  const { user, link } = ctx(req);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const media = link?.mediaFiles[id];
  if (!link?.bId || !media?.viewOnce || media.uploaderId === user.id || !media.messageId) {
    return fail(res, 404, "That opened media is no longer available");
  }

  const messageId = media.messageId;
  try {
    deleteMedia(id);
    delete link.mediaFiles[id];
    link.messages = link.messages.filter((message) => message.id !== messageId);
    save();
    emitToLink(link, "message:deleted", { messageId });
    res.json({ ok: true });
  } catch (error) {
    console.error("Could not remove viewed chat media", error);
    return fail(res, 500, "Could not remove this viewed media");
  }
});

app.delete("/api/chat/media/:id", auth, (req, res) => {
  const { user, link } = ctx(req);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const media = link?.mediaFiles[id];
  if (!link?.bId || !media || media.uploaderId !== user.id) {
    return fail(res, 404, "That media is no longer available");
  }
  try {
    deleteMedia(id);
    delete link.mediaFiles[id];
    save();
    res.json({ ok: true });
  } catch (error) {
    console.error("Could not delete encrypted chat media", error);
    return fail(res, 500, "Could not remove this media");
  }
});

app.post("/api/chat/send", auth, (req, res) => {
  const { user, link } = ctx(req);
  if (!link?.bId) return fail(res, 409, "You're not connected to anyone yet");
  const { ciphertext, iv, mediaId } = req.body ?? {};
  if (typeof ciphertext !== "string" || ciphertext.length < 1 || ciphertext.length > 12000) {
    return fail(res, 400, "Message not sent");
  }
  if (typeof iv !== "string" || iv.length < 8 || iv.length > 64) {
    return fail(res, 400, "Message not sent");
  }
  const media = mediaId === undefined ? undefined : link.mediaFiles[mediaId];
  if (
    mediaId !== undefined &&
    (typeof mediaId !== "string" || !media || media.uploaderId !== user.id || media.messageId)
  ) {
    return fail(res, 400, "That media could not be attached to this message");
  }
  const members = new Set<string>();
  for (const sid of io.sockets.adapter.rooms.get(link.id) ?? []) {
    const id = io.sockets.sockets.get(sid)?.data.userId;
    if (id) members.add(id);
  }
  const partner = partnerOfLink(link, user);
  const message = {
    id: link.nextMessageId++,
    senderId: user.id,
    createdAt: new Date().toISOString(),
    ciphertext,
    iv,
    ...(media
      ? {
          mediaId: media.id,
          viewOnce: media.viewOnce === true,
        }
      : {}),
    ...(partner && members.has(partner.id) ? { deliveredAt: new Date().toISOString() } : {}),
  };
  if (media) media.messageId = message.id;
  link.messages.push(message);
  if (link.messages.length > 500) link.messages.splice(0, link.messages.length - 500);
  save();
  emitToLink(link, "message", { message });
  if (partner) {
    void notifyIncomingMessage(partner, user.name).catch((error: unknown) => {
      console.error("Could not deliver a push notification for the new chat message", error);
    });
  }
  if (message.deliveredAt) {
    emitToLink(link, "message:receipt", {
      messageId: message.id,
      deliveredAt: message.deliveredAt,
      readAt: null,
    });
  }
  res.json({ message });
});

io.use((socket, next) => {
  if (ACCESS_KEY) {
    const rawCookie = socket.handshake.headers.cookie ?? "";
    const fromCookie = cookieValue(rawCookie, ACCESS_COOKIE);
    const presented = socket.handshake.auth?.accessKey ?? fromCookie ?? undefined;
    if (!keyMatches(typeof presented === "string" ? presented : undefined)) {
      next(new Error("unauthorised"));
      return;
    }
  }
  const token = socket.handshake.auth?.token ?? socket.handshake.query?.token;
  const user = userByToken(typeof token === "string" ? token : undefined);
  if (!user) {
    next(new Error("unauthorised"));
    return;
  }
  socket.data.userId = user.id;
  next();
});

io.on("connection", (socket) => {
  recordSocketConnection(true);
  const userId: string = socket.data.userId;

  const linkFor = (channel: unknown): Link | null => {
    if (typeof channel !== "string") return null;
    return (
      Object.values(db.links).find(
        (l) => l.id === channel && (l.aId === userId || l.bId === userId),
      ) ?? null
    );
  };

  const announcePresence = (channel: string) => {
    const members = new Set<string>();
    for (const sid of io.sockets.adapter.rooms.get(channel) ?? []) {
      const id = io.sockets.sockets.get(sid)?.data.userId;
      if (id) members.add(id);
    }
    const link = linkFor(channel);
    const user = db.users[userId];
    const partner = link && user ? partnerOfLink(link, user) : null;
    const presence = {
      members: [...members],
      partnerOnline: Boolean(partner && members.has(partner.id)),
      lastSeenAt: partner?.lastSeenAt ?? null,
    };
    for (const sid of io.sockets.adapter.rooms.get(channel) ?? []) {
      const recipientId = io.sockets.sockets.get(sid)?.data.userId;
      const recipient = recipientId ? db.users[recipientId] : null;
      const recipientPartner = link && recipient ? partnerOfLink(link, recipient) : null;
      io.to(sid).emit("presence", {
        members: presence.members,
        partnerOnline: Boolean(recipientPartner && members.has(recipientPartner.id)),
        lastSeenAt: recipientPartner?.lastSeenAt ?? null,
      });
    }
    return presence;
  };

  const markLastSeenIfAway = (channel: string) => {
    const hasOtherSocket = [...(io.sockets.adapter.rooms.get(channel) ?? [])].some((sid) => {
      if (sid === socket.id) return false;
      return io.sockets.sockets.get(sid)?.data.userId === userId;
    });
    if (!hasOtherSocket && db.users[userId]) {
      db.users[userId].lastSeenAt = new Date().toISOString();
      save();
    }
  };

  socket.on("subscribe", (channel: unknown) => {
    const link = linkFor(channel);
    if (!link) return;
    socket.join(link.id);
    socket.data.channel = link.id;
    const presence = announcePresence(link.id);
    socket.emit("room:ready", {
      linkId: link.id,
      partnerOnline: presence.partnerOnline,
      lastSeenAt: presence.lastSeenAt,
    });
    const deliveredAt = new Date().toISOString();
    const receipts = link.messages
      .filter((message) => message.senderId !== userId && !message.deliveredAt)
      .map((message) => {
        message.deliveredAt = deliveredAt;
        return { messageId: message.id, deliveredAt, readAt: message.readAt ?? null };
      });
    if (receipts.length) {
      save();
      for (const receipt of receipts) emitToLink(link, "message:receipt", receipt);
    }
  });

  socket.on("unsubscribe", () => {
    const channel = socket.data.channel;
    if (typeof channel !== "string") return;
    markLastSeenIfAway(channel);
    socket.leave(channel);
    socket.data.channel = undefined;
    announcePresence(channel);
  });

  socket.on("typing", (payload: unknown) => {
    const link = linkFor(socket.data.channel);
    if (!link?.bId) return;
    const typing = Boolean((payload as { typing?: unknown } | null)?.typing);
    socket.to(link.id).emit("typing", { typing, userId });
  });

  socket.on("status:set", (payload: unknown) => {
    const link = linkFor(socket.data.channel);
    const user = db.users[userId];
    if (!link || !user) return;
    const patch = normaliseStatus((payload ?? {}) as Record<string, unknown>);
    user.status = applyStatusGating(user, patch);
    save();
    socket.to(link.id).emit("status:update", { status: user.status });
  });

  socket.on("call:signal", (payload: unknown) => {
    const link = linkFor(socket.data.channel);
    if (!link?.bId || typeof payload !== "object" || payload === null) return;
    const signal = payload as {
      callId?: unknown;
      kind?: unknown;
      mode?: unknown;
      data?: unknown;
    };
    if (
      typeof signal.callId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(signal.callId) ||
      !["offer", "answer", "ice", "end"].includes(String(signal.kind))
    ) {
      return;
    }
    if (signal.kind !== "end") {
      if (typeof signal.data !== "object" || signal.data === null) return;
      if (JSON.stringify(signal.data).length > 48_000) return;
    }
    if (
      signal.kind === "offer" &&
      signal.mode !== "audio" &&
      signal.mode !== "video"
    ) {
      return;
    }
    const partner = db.users[userId] ? partnerOfLink(link, db.users[userId]) : null;
    if (!partner) return;
    const forwarded = {
      callId: signal.callId,
      kind: signal.kind,
      ...(signal.kind === "offer" ? { mode: signal.mode } : {}),
      ...(signal.data === undefined ? {} : { data: signal.data }),
      senderId: userId,
    };
    for (const socketId of io.sockets.adapter.rooms.get(link.id) ?? []) {
      if (io.sockets.sockets.get(socketId)?.data.userId === partner.id) {
        io.to(socketId).emit("call:signal", forwarded);
      }
    }
  });

  socket.on("disconnect", () => {
    recordSocketConnection(false);
    const channel = socket.data.channel;
    if (typeof channel !== "string") return;
    markLastSeenIfAway(channel);
    announcePresence(channel);
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/__local/traffic", (req, res) => {
  if (!validControlToken(req.header("x-syncura-control-token"), process.env.SYNCURA_CONTROL_TOKEN)) {
    res.sendStatus(404);
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(trafficSnapshot(io.engine.clientsCount));
});

/* Serve the built SPA so one process is the whole product. Unknown paths fall
   through to index.html because the client owns its own routing. */
const DIST = join(process.cwd(), "dist");
app.use(express.static(DIST, { index: false, maxAge: "1h" }));
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) return next();
  res.sendFile(join(DIST, "index.html"), (err) => {
    if (err) next();
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`syncura api listening on ${tlsKeyFile ? "https" : "http"}://${HOST}:${PORT}`);
});

