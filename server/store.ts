import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { todayKey } from "./cycle.js";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

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
     Nothing in the app predicts anything while this is false, so a calendar
     never shows somebody else's idea of a cycle. */
  cycleConfigured: boolean;
  /* Dates the owner has dismissed as predictions. They stay out of the calendar
     and out of every derived phase until the cycle is recalculated. */
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

/* The shared task list is a page per day. When the date on todoDay is no longer
   today the finished and unfinished tasks move into history and the list starts
   again empty, so each morning opens a fresh page rather than yesterday's. */
export interface TodoDay {
  day: string;
  todos: Todo[];
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
  deliveredAt?: string;
  readAt?: string;
  mediaId?: string;
  viewOnce?: boolean;
  mediaOpenedAt?: string;
}

export interface MediaFile {
  id: string;
  uploaderId: string;
  size: number;
  createdAt: string;
  viewOnce?: boolean;
  messageId?: number;
  openedBy?: string;
  openedAt?: string;
}

/**
 * One row of call history in one person's log.
 *
 * Recorded on the server rather than on either phone: the call log has to agree
 * for both people, and the phone that was not in the room cannot write it.
 *
 * A row is written per person, so `ownerId` is who the row belongs to while
 * `callerId` is who placed the call. The two are the same for the caller's own
 * row and different for the other, which is what makes "dialed" and "received"
 * read correctly from either side.
 *
 * `outcome` is from the point of view of the person reading the log. A dialed
 * call that connected is still "dialed" -- the colour answers "what happened to
 * my side of this", not "who pressed the button".
 */
export interface CallRecord {
  id: string;
  /** Whose log this row appears in. One row is written per person. */
  ownerId: string;
  /** Who placed the call, kept for the record rather than for the read. */
  callerId: string;
  callId: string;
  mode: "audio" | "video";
  startedAt: string;
  endedAt: string;
  /** How it ended, relative to the person reading the log. */
  outcome: "missed" | "received" | "dialed";
  /** Set when the call connected, so duration is meaningful. */
  connectedAt?: string;
}

export interface UsEntry {
  id: string;
  senderId: string;
  logDate: string;
  text: string;
  createdAt: string;
}

export interface User {
  id: string;
  token: string;
  name: string;
  sex: Sex;
  dateOfBirth: string;
  publicKey: string;
  createdAt: string;
  settings: CycleSettings;
  logs: Record<string, DailyLog>;
  journal: Record<string, JournalEntry>;
  status: LiveStatus | null;
  lastSeenAt?: string | null;
  pushTokens?: string[];
}

export interface Link {
  id: string;
  code: string;
  aId: string;
  bId: string | null;
  createdAt: string;
  connectedAt: string | null;
  messages: Message[];
  todos: Todo[];
  todoDay: string | null;
  todoHistory: TodoDay[];
  usEntries: UsEntry[];
  mediaFiles: Record<string, MediaFile>;
  callLog: CallRecord[];
  nextMessageId: number;
}

interface Db {
  users: Record<string, User>;
  tokens: Record<string, string>;
  links: Record<string, Link>;
}

const PATH = process.env.SYNCURA_DATA_FILE
  ? resolve(process.env.SYNCURA_DATA_FILE)
  : join(process.cwd(), "data", "syncura.json");
const MEDIA_PATH = `${PATH}.media`;
const ENCRYPTED_PREFIX = Buffer.from("SYNCURA-DB-ENC-V1\n");

function loadDataKey(): Buffer | null {
  const encoded = process.env.SYNCURA_DATA_KEY?.trim();
  if (!encoded) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SYNCURA_DATA_KEY is required in production");
    }
    return null;
  }

  const key = Buffer.from(encoded, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new Error("SYNCURA_DATA_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

const DATA_KEY = loadDataKey();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string, field: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`Syncura data file has an invalid ${field}`);
  }
  return decoded;
}

function encrypt(plaintext: Buffer): Buffer {
  if (!DATA_KEY) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", DATA_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = JSON.stringify({
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  return Buffer.concat([ENCRYPTED_PREFIX, Buffer.from(envelope)]);
}

function decrypt(contents: Buffer): Buffer {
  if (!DATA_KEY) {
    throw new Error("This Syncura data file is encrypted; set SYNCURA_DATA_KEY to open it");
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(contents.subarray(ENCRYPTED_PREFIX.length).toString("utf8"));
  } catch (error) {
    throw new Error("Syncura encrypted data envelope is invalid", { cause: error });
  }
  if (
    !isRecord(envelope) ||
    envelope.version !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Syncura encrypted data envelope is invalid");
  }

  const iv = decodeBase64(envelope.iv, "initialization vector");
  const tag = decodeBase64(envelope.tag, "authentication tag");
  const ciphertext = decodeBase64(envelope.ciphertext, "ciphertext");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Syncura encrypted data envelope has invalid cryptographic fields");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", DATA_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new Error("Syncura data could not be decrypted; the key may be wrong or the file corrupted", {
      cause: error,
    });
  }
}

function persist(database: Db) {
  const directory = dirname(PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = `${PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let temporaryExists = false;
  try {
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    try {
      writeFileSync(descriptor, encrypt(Buffer.from(JSON.stringify(database))));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, PATH);
    temporaryExists = false;
    temporaryExists = false;

    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (temporaryExists) unlinkSync(temporaryPath);
  }
}

const blankStatus = (): LiveStatus => ({
  latitude: null,
  longitude: null,
  accuracyM: null,
  activity: "unknown",
  batteryLevel: null,
  isCharging: null,
  speedMs: null,
  headingDeg: null,
  stepsToday: null,
  updatedAt: new Date().toISOString(),
});

export const defaultSettings = (): CycleSettings => ({
  cycleLength: 28,
  periodLength: 5,
  lastPeriodStart: null,
  lastPeriodEnd: null,
  periodDays: [],
  periodFlow: {},
  /* The numbers above are only arithmetic defaults for the charts. Nothing is
     predicted until the owner has chosen her own cycle at first login. */
  cycleConfigured: false,
  ignoredDates: [],
  shareLocation: false,
  shareActivity: true,
  shareBattery: true,
  shareJournal: false,
  liveSharing: false,
});

export const emptyLog = (logDate: string): DailyLog => ({
  logDate,
  waterGlasses: 0,
  feelings: [],
  meals: [],
  journal: "",
  journalShared: false,
  intercourseCount: 0,
});

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeCode(): string {
  const groups = [0, 1, 2].map(() => {
    let out = "";
    for (let i = 0; i < 4; i++) out += CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length];
    return out;
  });
  return `SYNC-${groups.join("-")}`;
}

function seed(): Db {
  return { users: {}, tokens: {}, links: {} };
}

function load(): Db {
  if (!existsSync(PATH)) return seed();

  const contents = readFileSync(PATH);
  const encrypted = contents.subarray(0, ENCRYPTED_PREFIX.length).equals(ENCRYPTED_PREFIX);
  const plaintext = encrypted ? decrypt(contents) : contents;

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    throw new Error("Syncura data file is not valid JSON; refusing to start with an empty database", {
      cause: error,
    });
  }

  if (!isRecord(parsed)) throw new Error("Syncura data file has an invalid top-level structure");
  const users = parsed.users ?? {};
  const tokens = parsed.tokens ?? {};
  const links = parsed.links ?? {};
  if (!isRecord(users) || !isRecord(tokens) || !isRecord(links)) {
    throw new Error("Syncura data file has an invalid database structure");
  }

  const database = {
    users: users as Db["users"],
    tokens: tokens as Db["tokens"],
    links: links as Db["links"],
  };
  let migrated = false;
  for (const user of Object.values(database.users)) {
    if (!Array.isArray(user.pushTokens)) {
      user.pushTokens = [];
      migrated = true;
    }
    if (!isRecord(user.settings)) {
      user.settings = defaultSettings();
      migrated = true;
    } else if (!user.settings.shareActivity || !user.settings.shareBattery) {
      user.settings.shareActivity = true;
      user.settings.shareBattery = true;
      migrated = true;
    }
    /* An account that has real cycle history behind it already chose her own
       numbers, so she keeps them; everyone else is asked at first login. */
    if (typeof user.settings.cycleConfigured !== "boolean") {
      const hasHistory =
        (Array.isArray(user.settings.periodDays) && user.settings.periodDays.length > 0) ||
        typeof user.settings.lastPeriodStart === "string";
      user.settings.cycleConfigured = hasHistory;
      migrated = true;
    }
    if (!Array.isArray(user.settings.ignoredDates)) {
      user.settings.ignoredDates = [];
      migrated = true;
    } else {
      for (const date of user.settings.ignoredDates) {
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          user.settings.ignoredDates = user.settings.ignoredDates.filter((entry) => entry !== date);
          migrated = true;
        }
      }
    }
    if (!Array.isArray(user.settings.periodDays)) {
      const start = user.settings.lastPeriodStart;
      const explicitEnd = user.settings.lastPeriodEnd;
      const startMs = typeof start === "string" ? Date.parse(`${start}T00:00:00.000Z`) : NaN;
      const endMs = typeof explicitEnd === "string" ? Date.parse(`${explicitEnd}T00:00:00.000Z`) : NaN;
      const upperBound = Number.isFinite(endMs) && endMs >= startMs
        ? Math.min(endMs, startMs + 11 * 86_400_000)
        : Math.min(Date.now(), startMs + 11 * 86_400_000);
      const migratedDays: string[] = [];
      if (Number.isFinite(startMs) && upperBound >= startMs) {
        for (let day = startMs; day <= upperBound; day += 86_400_000) {
          migratedDays.push(new Date(day).toISOString().slice(0, 10));
        }
      }
      user.settings.periodDays = migratedDays;
      migrated = true;
    }
    if (!isRecord(user.settings.periodFlow)) {
      user.settings.periodFlow = {};
      migrated = true;
    } else {
      for (const [date, flow] of Object.entries(user.settings.periodFlow)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !["light", "medium", "heavy"].includes(flow)) {
          delete user.settings.periodFlow[date];
          migrated = true;
        }
      }
    }
  }
  for (const link of Object.values(database.links)) {
    if (!Array.isArray(link.usEntries)) {
      link.usEntries = [];
      migrated = true;
    }
    if (!Array.isArray(link.todos)) {
      link.todos = [];
      migrated = true;
    }
    if (!Array.isArray(link.todoHistory)) {
      link.todoHistory = [];
      migrated = true;
    }
    /* An existing list belongs to today rather than being thrown away, so the
       first rollover after this upgrade still happens at the next midnight. */
    if (typeof link.todoDay !== "string" && link.todos.length > 0) {
      link.todoDay = todayKey();
      migrated = true;
    }
    if (!isRecord(link.mediaFiles)) {
      link.mediaFiles = {};
      migrated = true;
    }
    for (const media of Object.values(link.mediaFiles)) {
      if (!media.viewOnce) {
        media.viewOnce = true;
        migrated = true;
      }
    }
    /* Links created before call history existed have no log. Treated as empty
       rather than left undefined, so every reader gets an array and nothing has
       to guess. */
    if (!Array.isArray(link.callLog)) {
      link.callLog = [];
      migrated = true;
    }
    /* Rows written before ownerId existed put the caller on both sides, so the
       "received" row belonged to the other person. Assigning them by outcome
       restores the intended reading rather than leaving the caller with a
       duplicate of their own call. */
    for (const record of link.callLog) {
      if (typeof record.ownerId === "string" && record.ownerId) continue;
      record.ownerId = record.outcome === "dialed" ? record.callerId : link.aId === record.callerId ? (link.bId ?? record.callerId) : link.aId;
      migrated = true;
    }
  }
  if (repairLinks(database)) migrated = true;
  if (migrated || (!encrypted && DATA_KEY)) persist(database);
  return database;
}

/* Two shapes of broken link can be sitting in an existing store.

   1. aId === bId, which is what unlinking used to leave behind: the owner was
      moved onto their partner's slot without the partner's slot being cleared,
      so the pair pointed at one person and the code vanished for the woman who
      owned it.
   2. A link owned by a man who never joined it, left over from the era when
      every account was given a code it could never share.

   Repairing both here means nobody has to delete their account to get unstuck. */
function repairLinks(database: Db): boolean {
  let changed = false;
  for (const link of Object.values(database.links)) {
    const owner = database.users[link.aId];
    if (link.aId === link.bId) {
      const partner = database.users[link.bId];
      /* The owner of a link is always the woman who shared it, so when one of
         the two is her the link belongs to her again -- free, with its code. */
      const keepId = owner?.sex === "female" ? link.aId : partner?.sex === "female" ? link.bId! : link.aId;
      link.aId = keepId;
      link.bId = null;
      link.connectedAt = null;
      changed = true;
      continue;
    }
    if (owner?.sex === "male" && !link.bId) {
      delete database.links[link.id];
      changed = true;
    }
  }
  return changed;
}

export const db: Db = load();

let flushTimer: NodeJS.Timeout | null = null;
let dirty = false;

export function save() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    persist(db);
  }, 120);
}

/* Writing a moment later keeps bursts of changes cheap, but it also means a
   change made in the last moment of a process's life is still sitting in
   memory. Anything that is about to stop -- a restart, a deploy, a signal --
   calls this first so the final write is not lost. */
export function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  persist(db);
}

export function createUser(input: {
  name: string;
  sex: Sex;
  dateOfBirth: string;
  publicKey: string;
}): User {
  const id = randomUUID();
  const token = randomBytes(32).toString("hex");
  const user: User = {
    id,
    token,
    name: input.name,
    sex: input.sex,
    dateOfBirth: input.dateOfBirth,
    publicKey: input.publicKey,
    createdAt: new Date().toISOString(),
    settings: defaultSettings(),
    logs: {},
    journal: {},
    status: null,
    pushTokens: [],
  };
  db.users[id] = user;
  db.tokens[token] = id;
  /* Only a woman shares a connection link, so only a woman gets one. Minting a
     spare link for every account gave a man a second link that shadowed the one
     he had actually joined, and the app then read that empty spare forever. */
  if (input.sex === "female") {
    const link: Link = {
      id: randomUUID(),
      code: makeCode(),
      aId: id,
      bId: null,
      createdAt: new Date().toISOString(),
      connectedAt: null,
      messages: [],
      todos: [],
      todoDay: null,
      todoHistory: [],
      usEntries: [],
      callLog: [],
      mediaFiles: {},
      nextMessageId: 1,
    };
    db.links[link.id] = link;
  }
  save();
  return user;
}

/* Starts a new day's page of tasks. Anything still on the list -- done or not --
   is kept as history so a new day never silently destroys it. Returns true when
   the list actually changed, which is the caller's cue to tell the partner. */
export function rolloverTodos(link: Link, day = todayKey()): boolean {
  if (link.todoDay === day) return false;
  const carried = link.todos.filter((todo) => todo.text.trim().length > 0);
  if (carried.length > 0) {
    const from = link.todoDay ?? day;
    const existing = link.todoHistory.find((entry) => entry.day === from);
    if (existing) existing.todos = carried;
    else link.todoHistory.push({ day: from, todos: carried });
    if (link.todoHistory.length > 30) link.todoHistory.splice(0, link.todoHistory.length - 30);
  }
  link.todos = [];
  link.todoDay = day;
  return true;
}

export function userByToken(token: string | undefined): User | null {
  if (!token) return null;
  const id = db.tokens[token];
  return id ? (db.users[id] ?? null) : null;
}

/* Only the account that shares the code owns a link, and only a female can be
   that owner, so a link with a male owner is either an unused spare or the
   wreckage of an older unlink that handed the link over instead of freeing it.
   Resolving the link a user is really sharing means ignoring anything they are
   merely the owner of, which is what used to leave a man stuck on the linking
   screen with `connected: false` while his partner's link sat right there. */
export function linkOf(user: User): Link | null {
  const mine = Object.values(db.links).filter(
    (l) => (l.aId === user.id || l.bId === user.id) && l.aId !== l.bId,
  );
  const shared = mine.find((l) => l.bId && (l.aId === user.id || l.bId === user.id));
  if (shared) return shared;
  return mine.find((l) => l.aId === user.id) ?? mine[0] ?? null;
}

export function partnerOf(link: Link | null, user: User): User | null {
  if (!link) return null;
  const otherId = link.aId === user.id ? link.bId : link.aId;
  return otherId ? (db.users[otherId] ?? null) : null;
}

export function findLinkByCode(raw: string): Link | null {
  const cleaned = raw.trim().toUpperCase();
  const match = cleaned.match(/SYNC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  const code = match ? match[0] : cleaned;
  return Object.values(db.links).find((l) => l.code === code) ?? null;
}

function mediaPath(id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid media id");
  return join(MEDIA_PATH, id);
}

export function writeMedia(id: string, contents: Buffer) {
  mkdirSync(MEDIA_PATH, { recursive: true, mode: 0o700 });
  writeFileSync(mediaPath(id), contents, { flag: "wx", mode: 0o600 });
}

export function readMedia(id: string): Buffer | null {
  const path = mediaPath(id);
  return existsSync(path) ? readFileSync(path) : null;
}

export function deleteMedia(id: string) {
  const path = mediaPath(id);
  if (existsSync(path)) unlinkSync(path);
}

export function deleteLinkMedia(link: Link) {
  for (const id of Object.keys(link.mediaFiles ?? {})) {
    deleteMedia(id);
  }
  link.mediaFiles = {};
}

export function newStatus(): LiveStatus {
  return blankStatus();
}

export function deleteUser(user: User) {
  for (const link of Object.values(db.links)) {
    if (link.bId === user.id) {
      /* The owner keeps the link and its code, so it is simply free again and
         can be linked to somebody else. */
      link.bId = null;
      link.connectedAt = null;
      link.messages = [];
      deleteLinkMedia(link);
      save();
    } else if (link.aId === user.id) {
      /* The code died with the account that shared it. */
      deleteLinkMedia(link);
      delete db.links[link.id];
    }
  }
  delete db.users[user.id];
  for (const [token, id] of Object.entries(db.tokens)) if (id === user.id) delete db.tokens[token];
  save();
}

export function toPublicUser(user: User) {
  return { id: user.id, name: user.name, sex: user.sex, publicKey: user.publicKey };
}

export function shapeMe(user: User) {
  const link = linkOf(user);
  const partner = partnerOf(link, user);
  return {
    user: toPublicUser(user),
    link: link
      ? {
          id: link.id,
          code: user.sex === "female" ? link.code : "",
          connected: Boolean(link.bId),
          partnerName: partner?.name ?? null,
          partnerPublicKey: partner?.publicKey ?? null,
        }
      : null,
    settings: user.settings,
  };
}

