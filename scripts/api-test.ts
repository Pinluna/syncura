import { randomBytes } from "node:crypto";

import { TEST_BASE as BASE } from "./test-env";

let failures = 0;

const ok = (label: string, cond: unknown) => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
};

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
  x: randomBytes(32).toString("base64url"),
  y: randomBytes(32).toString("base64url"),
  ext: true,
  key_ops: [],
  tag,
});

const stub = (id: string) => Buffer.from(`cipher-${id}`).toString("base64");
const ivStub = () => Buffer.from(randomBytes(12)).toString("base64");

async function main() {
  console.log("\nhealth");
  const health = await call("/health");
  ok("GET /health -> 200", health.status === 200 && health.body.ok === true);

  /* The phone app runs in a WebView whose origin is not the server, so the API
     has to answer cross-origin calls or every request fails as "Failed to fetch". */
  console.log("\ncors (the app is a WebView on a different origin)");
  const preflight = await fetch(`${BASE}/api/auth/register`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://localhost",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-syncura-token",
    },
  });
  ok("preflight is answered without a body", preflight.status === 204);
  ok(
    "preflight allows the requesting origin",
    preflight.headers.get("access-control-allow-origin") === "https://localhost",
  );
  const allowHeaders = preflight.headers.get("access-control-allow-headers") ?? "";
  ok("preflight allows the auth header", allowHeaders.includes("x-syncura-token"));

  const crossOrigin = await fetch(`${BASE}/api/health`, { headers: { Origin: "https://localhost" } });
  ok(
    "a cross-origin GET echoes the origin",
    crossOrigin.headers.get("access-control-allow-origin") === "https://localhost",
  );
  ok(
    "responses vary on Origin so caches stay correct",
    (crossOrigin.headers.get("vary") ?? "").toLowerCase().includes("origin"),
  );

  const crossPost = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://localhost" },
    body: JSON.stringify({
      name: "Cora",
      dateOfBirth: "1998-05-15",
      sex: "female",
      publicKey: JSON.stringify(jwk("c1")),
    }),
  });
  ok(
    "a cross-origin signup is allowed through",
    crossPost.status === 200 && crossPost.headers.get("access-control-allow-origin") !== null,
  );

  console.log("\nregistration validation");
  const shortKey = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "A", dateOfBirth: "1998-05-15", sex: "female", publicKey: "" }),
  });
  ok("rejects missing publicKey", shortKey.status === 400);
  const badSex = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "A", dateOfBirth: "1998-05-15", sex: "other", publicKey: "x".repeat(40) }),
  });
  ok("rejects invalid sex", badSex.status === 400);
  const badDob = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "A", dateOfBirth: "15/05/1998", sex: "female", publicKey: "x".repeat(40) }),
  });
  ok("rejects malformed date", badDob.status === 400);
  const future = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "A", dateOfBirth: "2999-01-01", sex: "female", publicKey: "x".repeat(40) }),
  });
  ok("rejects future date of birth", future.status === 400);

  console.log("\naccounts");
  const she = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Mara",
      dateOfBirth: "1997-03-02",
      sex: "female",
      publicKey: JSON.stringify(jwk("she")),
    }),
  });
  ok("registers partner one", she.status === 200 && typeof she.body.token === "string");
  ok("token is not the raw public key", she.body.token !== JSON.stringify(jwk("she")));

  const he = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Theo",
      dateOfBirth: "1995-11-20",
      sex: "male",
      publicKey: JSON.stringify(jwk("he")),
    }),
  });
  ok("registers partner two", he.status === 200 && typeof he.body.token === "string");

  const anotherMale = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Alex",
      dateOfBirth: "1994-06-12",
      sex: "male",
      publicKey: JSON.stringify(jwk("another-male")),
    }),
  });
  ok("registers another male account", anotherMale.status === 200);

  const anotherFemale = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Nina",
      dateOfBirth: "1996-02-21",
      sex: "female",
      publicKey: JSON.stringify(jwk("another-female")),
    }),
  });
  ok("registers another female account", anotherFemale.status === 200);

  const sheToken = she.body.token as string;
  const heToken = he.body.token as string;
  const anotherMaleToken = anotherMale.body.token as string;
  const anotherFemaleToken = anotherFemale.body.token as string;

  const meShe = await call("/me", { token: sheToken });
  ok("GET /me returns settings", meShe.status === 200 && meShe.body.settings.cycleLength === 28);
  ok("activity and battery sharing are enabled by default", meShe.body.settings.shareActivity && meShe.body.settings.shareBattery);
  ok("GET /me exposes own pairing code", /^SYNC-/.test(meShe.body.link?.code ?? ""));
  ok("link starts unconnected", meShe.body.link?.connected === false);

  const noAuth = await call("/me");
  ok("GET /me without token is 401", noAuth.status === 401);
  const badAuth = await call("/me", { token: "nope" });
  ok("GET /me with bad token is 401", badAuth.status === 401);

  const noPushAuth = await call("/push/register", {
    method: "POST",
    body: JSON.stringify({ token: "f".repeat(64) }),
  });
  ok("push token registration requires authentication", noPushAuth.status === 401);
  const invalidPush = await call("/push/register", {
    token: she.body.token as string,
    method: "POST",
    body: JSON.stringify({ token: "short" }),
  });
  ok("malformed push tokens are rejected", invalidPush.status === 400);
  const registeredPush = await call("/push/register", {
    token: she.body.token as string,
    method: "POST",
    body: JSON.stringify({ token: "f".repeat(64) }),
  });
  ok("authenticated devices can register a push token", registeredPush.status === 200);
  const duplicatePush = await call("/push/register", {
    token: she.body.token as string,
    method: "POST",
    body: JSON.stringify({ token: "f".repeat(64) }),
  });
  ok("push token registration is idempotent", duplicatePush.status === 200);
  const removedPush = await call("/push/unregister", {
    token: she.body.token as string,
    method: "POST",
    body: JSON.stringify({ token: "f".repeat(64) }),
  });
  ok("devices can revoke push token registration", removedPush.status === 200);

  console.log("\nsettings");
  const renamed = await call("/settings", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ name: "Mara B" }),
  });
  ok("rename persists", renamed.status === 200 && renamed.body.user.name === "Mara B");

  const cycle = await call("/settings", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ cycleLength: 30, periodLength: 4, lastPeriodStart: "2026-09-20" }),
  });
  ok("cycle settings apply", cycle.body.settings.cycleLength === 30 && cycle.body.settings.periodLength === 4);

  const clamped = await call("/settings", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ cycleLength: 400, periodLength: 99 }),
  });
  ok("out-of-range cycle length ignored", clamped.body.settings.cycleLength === 30);
  ok("out-of-range period length ignored", clamped.body.settings.periodLength === 4);

  const badDate = await call("/settings", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ lastPeriodStart: "nope" }),
  });
  ok("malformed date nulled", badDate.body.settings.lastPeriodStart === null);
  const sharingDefaults = await call("/settings", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ shareActivity: false, shareBattery: false }),
  });
  ok("activity and battery sharing cannot be disabled independently", sharingDefaults.body.settings.shareActivity && sharingDefaults.body.settings.shareBattery);

  console.log("\npairing");
  const herCode = meShe.body.link.code as string;
  const connectSelf = await call("/partner/connect", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ code: herCode }),
  });
  ok("cannot pair with own code", connectSelf.status === 400);

  const anotherMaleMe = await call("/me", { token: anotherMaleToken });
  const anotherFemaleMe = await call("/me", { token: anotherFemaleToken });
  const femaleCannotConnect = await call("/partner/connect", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ code: anotherFemaleMe.body.link.code }),
  });
  ok("female accounts cannot receive a partner link", femaleCannotConnect.status === 403);

  /* Only the woman shares a link. A man used to be handed one of his own that
     he never used, which is what could leave him stuck on the linking screen
     after pairing. */
  ok("male accounts have no link of their own", anotherMaleMe.body.link === null);

  const badCode = await call("/partner/connect", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ code: "SYNC-ZZZZ-ZZZZ-ZZZZ" }),
  });
  ok("unknown code -> 404", badCode.status === 404);

  const pair = await call("/partner/connect", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ code: herCode }),
  });
  ok("pairs with partner code", pair.status === 200 && pair.body.partnerName === "Mara B");

  const rePair = await call("/partner/connect", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ code: anotherFemaleMe.body.link.code }),
  });
  ok("connected male cannot switch partners without disconnecting", rePair.status === 409);

  const meHe = await call("/me", { token: heToken });
  ok("he is connected", meHe.body.link?.connected === true);
  ok("he has partner public key", Boolean(meHe.body.link?.partnerPublicKey));

  const meShe2 = await call("/me", { token: sheToken });
  ok("she sees partner name", meShe2.body.link?.partnerName === "Theo");

  console.log("\nperiod and intimacy calendar logs");
  const periodDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const periodLogged = await call("/cycle/period-day", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ logDate: periodDay, logged: true, flow: "light" }),
  });
  ok(
    "female user can log an actual period day with flow",
    periodLogged.status === 200 &&
      periodLogged.body.settings.periodDays.includes(periodDay) &&
      periodLogged.body.settings.periodFlow[periodDay] === "light",
  );
  const periodVisible = await call("/dashboard", { token: heToken });
  ok(
    "partner calendar receives actual period flow",
    periodVisible.body.settings.periodDays.includes(periodDay) &&
      periodVisible.body.settings.periodFlow[periodDay] === "light",
  );
  const invalidFlow = await call("/cycle/period-day", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ logDate: periodDay, logged: true, flow: "extreme" }),
  });
  ok("rejects invalid period flow values", invalidFlow.status === 400);
  const periodRemoved = await call("/cycle/period-day", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ logDate: periodDay, logged: false }),
  });
  ok(
    "removing a period day also clears its flow",
    periodRemoved.status === 200 &&
      !periodRemoved.body.settings.periodDays.includes(periodDay) &&
      !periodRemoved.body.settings.periodFlow[periodDay],
  );
  const malePeriodLog = await call("/cycle/period-day", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ logDate: periodDay, logged: true }),
  });
  ok("male user cannot log period days", malePeriodLog.status === 403);

  console.log("\nshared daily Us thread");
  const unpairedThread = await call("/us", { token: anotherMaleToken });
  ok("unpaired accounts cannot access a shared thread", unpairedThread.status === 409);
  const blankUsEntry = await call("/us", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ text: "  " }),
  });
  ok("empty thread messages are rejected", blankUsEntry.status === 400);
  const usEntry = await call("/us", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ text: "Morning together" }),
  });
  ok("thread message is saved with today's date", usEntry.status === 200 && usEntry.body.entry.text === "Morning together" && usEntry.body.entry.logDate === new Date().toISOString().slice(0, 10));
  const partnerThread = await call("/us", { token: heToken });
  ok("partner sees the shared daily thread", partnerThread.body.entries?.some((entry: { id: string }) => entry.id === usEntry.body.entry.id));
  const secondUsEntry = await call("/us", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ text: "Good morning" }),
  });
  const fullThread = await call("/us", { token: sheToken });
  ok("thread retains multiple entries in order", fullThread.body.entries?.length === 2 && fullThread.body.entries[0].id === usEntry.body.entry.id && fullThread.body.entries[1].id === secondUsEntry.body.entry.id);

  console.log("\ndashboard ownership");
  const dashHe = await call("/dashboard", { token: heToken });
  ok("male viewer sees female partner as cycle owner", dashHe.body.owner?.name === "Mara B");
  ok("dashboard marks the viewer sex", dashHe.body.viewer === "male");
  const dashShe = await call("/dashboard", { token: sheToken });
  ok("female viewer sees herself as owner", dashShe.body.owner?.name === "Mara B");

  console.log("\nlogging");
  const today = new Date().toISOString().slice(0, 10);
  const log = await call("/log", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({
      logDate: today,
      waterGlasses: 6,
      feelings: ["Calm", "Energetic"],
      meals: [{ id: "m1", type: "breakfast", text: "Oats" }],
      journal: "Felt good today",
      journalShared: true,
      intercourseCount: 1,
    }),
  });
  ok("log accepted", log.status === 200 && log.body.waterGlasses === 6);
  ok("meals stored", Array.isArray(log.body.meals) && log.body.meals.length === 1);

  const dashHe2 = await call("/dashboard", { token: heToken });
  ok("male account has own hydration count", dashHe2.body.hydration?.mine === 0);
  ok("partner hydration count is visible", dashHe2.body.hydration?.partner === 6);
  const herToday = dashHe2.body.logs?.find((l: { logDate: string }) => l.logDate === today);
  ok("partner can read shared log", herToday?.waterGlasses === 6);
  ok("feelings round-trip", JSON.stringify(herToday?.feelings) === JSON.stringify(["Calm", "Energetic"]));
  ok("partner sees intimacy count for calendar hearts", herToday?.intercourseCount === 1);
  ok("partner sees her meals", herToday?.meals?.[0]?.text === "Oats");

  /* The shared day is hers to write. A man looking at it is a reader, and that
     has to hold at the server rather than by hiding the controls: a log patch
     always lands on the caller's own record, so his write can only ever reach
     his own day. */
  console.log("\nthe partner's day is read-only for him");
  const hisWrite = await call("/log", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({
      logDate: today,
      feelings: ["Not mine to write"],
      meals: [{ id: "m2", type: "dinner", text: "Not mine to write" }],
    }),
  });
  ok("his own write is accepted", hisWrite.status === 200);
  ok("his write landed on his own record", JSON.stringify(hisWrite.body.feelings) === JSON.stringify(["Not mine to write"]));
  const afterHisWrite = await call("/dashboard", { token: heToken });
  const herUnchanged = afterHisWrite.body.logs?.find((l: { logDate: string }) => l.logDate === today);
  ok("her feelings are untouched by his write", JSON.stringify(herUnchanged?.feelings) === JSON.stringify(["Calm", "Energetic"]));
  ok("her meals are untouched by his write", herUnchanged?.meals?.[0]?.text === "Oats");
  const hisIntimacy = await call("/log", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ logDate: today, intercourseCount: 5 }),
  });
  ok("he cannot write the intimacy count", hisIntimacy.status === 403);

  const badGlass = await call("/log", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ logDate: today, waterGlasses: 9999 }),
  });
  ok("implausible water count clamped, not stored raw", badGlass.body.waterGlasses === 40);

  const badDateLog = await call("/log", {
    token: "not-a-token",
    method: "POST",
    body: JSON.stringify({ logDate: "17-09-2026", waterGlasses: 1 }),
  });
  ok("log without token rejected", badDateLog.status === 401);

  const badShape = await call("/log", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ logDate: "17-09-2026", waterGlasses: 1 }),
  });
  ok("malformed logDate rejected", badShape.status === 400);

  await call("/log", { token: sheToken, method: "POST", body: JSON.stringify({ logDate: today, waterGlasses: 6 }) });

  console.log("\njournal + todos");
  const journal = await call("/journal", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ logDate: today, text: "Shared note", shared: true }),
  });
  ok("journal entry saved", journal.status === 200 && journal.body.text === "Shared note");

  const soloTodos = await call("/todos", { token: sheToken });
  ok("todos work while linked", Array.isArray(soloTodos.body.todos));

  const hisEntries = await call("/dashboard", { token: heToken });
  ok(
    "partner sees shared entry",
    (hisEntries.body.fromPartner?.entries ?? []).some((e: { logDate: string }) => e.logDate === today),
  );

  await call("/journal", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ logDate: "2026-09-01", text: "Private note", shared: false }),
  });
  const hisEntries2 = await call("/dashboard", { token: heToken });
  ok(
    "private entry is not shared",
    !(hisEntries2.body.fromPartner?.entries ?? []).some((e: { text: string }) => e.text === "Private note"),
  );

  const todoAdd = await call("/todos", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ action: "add", text: "Book dinner" }),
  });
  ok("todo added", todoAdd.status === 200 && todoAdd.body.todos?.length === 1);
  const todoId = todoAdd.body.todos[0].id as string;
  const todoToggle = await call("/todos", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ action: "toggle", id: todoId }),
  });
  ok("todo toggles", todoToggle.body.todos[0].done === true);
  ok("task completion is dated for daily progress", /^\d{4}-\d{2}-\d{2}$/.test(todoToggle.body.todos[0].completedAt));
  const todoUntoggle = await call("/todos", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ action: "toggle", id: todoId }),
  });
  ok("unchecking a task clears its daily completion", todoUntoggle.body.todos[0].completedAt === null);
  const todoRetoggle = await call("/todos", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ action: "toggle", id: todoId }),
  });
  ok("checking a task again restores today's completion", /^\d{4}-\d{2}-\d{2}$/.test(todoRetoggle.body.todos[0].completedAt));
  const hisTodos = await call("/todos", { token: sheToken });
  ok("partner shares the same todo list", hisTodos.body.todos?.length === 1);
  const todoRemove = await call("/todos", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ action: "remove", id: todoId }),
  });
  ok("todo removed", todoRemove.body.todos?.length === 0);
  const todoBad = await call("/todos", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ action: "detonate" }),
  });
  ok("unknown todo action rejected", todoBad.status === 400);
  const todoNoText = await call("/todos", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ action: "add", text: "   " }),
  });
  ok("blank todo rejected", todoNoText.status === 400);
  const todoMissing = await call("/todos", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ action: "toggle", id: "deadbeef" }),
  });
  ok("toggling a missing todo 404s", todoMissing.status === 404);

  console.log("\ninsights");
  const insight = await call("/insights", { token: sheToken, method: "POST", body: "{}" });
  ok("insight responds", insight.status === 200 && "insight" in insight.body);

  console.log("\nchat (server is ciphertext-blind)");
  const sendTooSmall = await call("/chat/send", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ ciphertext: "x", iv: "short" }),
  });
  ok("short iv rejected", sendTooSmall.status === 400);

  const sent = await call("/chat/send", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ ciphertext: stub("hello"), iv: ivStub() }),
  });
  ok("message stored", sent.status === 200 && typeof sent.body.message?.id === "number");

  const fetched = await call("/chat/messages", { token: heToken });
  ok("partner can read messages", fetched.body.messages?.length === 1);
  ok(
    "server never sees plaintext",
    !JSON.stringify(fetched.body).includes("hello-text") && fetched.body.messages[0].ciphertext === stub("hello"),
  );

  const senderId = sent.body.message.senderId;
  ok("message records the sender", typeof senderId === "string");
  ok("offline recipient has not received the message yet", !sent.body.message.deliveredAt);
  const markedRead = await call("/chat/read", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ throughId: sent.body.message.id }),
  });
  ok("recipient can mark incoming messages as read", markedRead.status === 200 && markedRead.body.receipts.length === 1);
  const receiptHistory = await call("/chat/messages", { token: sheToken });
  ok("read receipt is persisted with the message", Boolean(receiptHistory.body.messages[0].readAt));

  console.log("\nprivate call configuration and encrypted media storage");
  const iceConfig = await call("/calls/ice", { token: sheToken });
  ok("paired users can read WebRTC ICE configuration", iceConfig.status === 200 && Array.isArray(iceConfig.body.iceServers));
  ok("server-provided ICE URLs reach paired clients", iceConfig.body.iceServers[0]?.urls === "stun:stun.test.invalid:3478");
  const anonymousIce = await call("/calls/ice");
  ok("ICE configuration requires authentication", anonymousIce.status === 401);
  const unpairedIce = await call("/calls/ice", { token: anotherMaleToken });
  ok("unpaired accounts cannot fetch call credentials", unpairedIce.status === 409);

  const encryptedBytes = Uint8Array.from([0, 17, 128, 255, 42]);
  const mediaUpload = await fetch(`${BASE}/api/chat/media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-syncura-token": sheToken,
    },
    body: encryptedBytes,
  });
  const uploaded = await mediaUpload.json() as { id?: string; size?: number };
  ok("ciphertext uploads only for a connected pair", mediaUpload.status === 200 && typeof uploaded.id === "string");
  ok("server records encrypted byte size", uploaded.size === encryptedBytes.length);
  const mediaDownload = await fetch(`${BASE}/api/chat/media/${uploaded.id}`, {
    headers: { "x-syncura-token": heToken },
  });
  const downloadedBytes = new Uint8Array(await mediaDownload.arrayBuffer());
  ok("either partner can download the opaque media bytes", mediaDownload.status === 200);
  ok("downloaded bytes match the upload", Buffer.from(downloadedBytes).equals(Buffer.from(encryptedBytes)));
  const partnerDelete = await fetch(`${BASE}/api/chat/media/${uploaded.id}`, {
    method: "DELETE",
    headers: { "x-syncura-token": heToken },
  });
  ok("only the uploader can delete their media", partnerDelete.status === 404);
  const unrelatedDownload = await fetch(`${BASE}/api/chat/media/${uploaded.id}`, {
    headers: { "x-syncura-token": anotherMaleToken },
  });
  ok("unrelated accounts cannot read pair media", unrelatedDownload.status === 404);

  const onceUploadResponse = await fetch(`${BASE}/api/chat/media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-syncura-token": sheToken,
      "x-syncura-view-once": "true",
    },
    body: encryptedBytes,
  });
  const onceUpload = await onceUploadResponse.json() as { id?: string };
  const onceMessage = await call("/chat/send", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ ciphertext: stub("once"), iv: ivStub(), mediaId: onceUpload.id }),
  });
  ok("view-once upload is linked to its chat message", onceMessage.status === 200 && onceMessage.body.message.viewOnce === true);
  const senderOpen = await fetch(`${BASE}/api/chat/media/${onceUpload.id}`, {
    headers: { "x-syncura-token": sheToken },
  });
  ok("sender cannot open their own view-once media", senderOpen.status === 403);
  const onceView = await fetch(`${BASE}/api/chat/media/${onceUpload.id}`, {
    headers: { "x-syncura-token": heToken },
  });
  ok("recipient can open view-once media", onceView.status === 200);
  const onceAgain = await fetch(`${BASE}/api/chat/media/${onceUpload.id}`, {
    headers: { "x-syncura-token": heToken },
  });
  ok("view-once media cannot be opened a second time", onceAgain.status === 410);
  const openedMessages = await call("/chat/messages", { token: sheToken });
  ok("sender receives media-opened status", Boolean(openedMessages.body.messages.find((message: { id: number }) => message.id === onceMessage.body.message.id)?.mediaOpenedAt));
  const closeOnce = await call(`/chat/media/${onceUpload.id}/close`, {
    token: heToken,
    method: "POST",
    body: "{}",
  });
  ok("closing the viewer deletes the view-once media", closeOnce.status === 200);
  const removedMessage = await call("/chat/messages", { token: sheToken });
  ok("closing the viewer removes its media message", !removedMessage.body.messages.some((message: { id: number }) => message.id === onceMessage.body.message.id));

  console.log("\nlive status (privacy-gated)");
  const gated = await call("/status", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({
      latitude: 51.5072,
      longitude: -0.1276,
      accuracyM: 12,
      activity: "walking",
      batteryLevel: 82,
      isCharging: false,
      speedMs: 1.4,
    }),
  });
  ok("status endpoint accepts", gated.status === 200);
  const hisDashGated = await call("/dashboard", { token: heToken });
  ok(
    "location withheld until she opts in",
    hisDashGated.body.status?.latitude === null && hisDashGated.body.status?.longitude === null,
  );
  ok("activity is shared by default while location stays private", hisDashGated.body.status?.activity === "walking");
  ok("battery is shared by default while location stays private", hisDashGated.body.status?.batteryLevel === 82);
  ok("speed is shared while coordinates remain private", hisDashGated.body.status?.speedMs === 1.4);

  await call("/settings", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ shareLocation: true, shareActivity: true, shareBattery: true }),
  });
  const shared = await call("/status", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({
      latitude: 51.5072,
      longitude: -0.1276,
      accuracyM: 12,
      activity: "walking",
      batteryLevel: 82,
      isCharging: false,
      speedMs: 1.4,
    }),
  });
  ok("status accepted once opted in", shared.status === 200);

  const hisDash = await call("/dashboard", { token: heToken });
  ok("partner reads her location", hisDash.body.status?.latitude === 51.5072);
  ok("activity visible", hisDash.body.status?.activity === "walking");

  const badStatus = await call("/status", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ latitude: 999, batteryLevel: 5000 }),
  });
  ok("out-of-range status ignored", badStatus.status === 200);
  const afterBad = await call("/dashboard", { token: heToken });
  ok("invalid latitude ignored, previous kept", afterBad.body.status?.latitude === 51.5072);
  ok("invalid battery ignored, previous kept", afterBad.body.status?.batteryLevel === 82);

  const partial = await call("/status", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ stepsToday: 4210 }),
  });
  ok("partial update accepted", partial.status === 200);
  const afterPartial = await call("/dashboard", { token: heToken });
  ok("partial update keeps other fields", afterPartial.body.status?.latitude === 51.5072);
  ok("partial update applied", afterPartial.body.status?.stepsToday === 4210);

  await call("/settings", {
    token: sheToken,
    method: "POST",
    body: JSON.stringify({ shareLocation: false }),
  });
  const revoked = await call("/dashboard", { token: heToken });
  ok(
    "revoking sharing blanks location immediately",
    revoked.body.status?.latitude === null,
  );

  console.log("\nunlink");
  const unlink = await call("/partner/disconnect", { token: heToken, method: "POST", body: "{}" });
  ok("unlink ok", unlink.status === 200 && unlink.body.ok === true);
  const mediaAfterUnlink = await fetch(`${BASE}/api/chat/media/${uploaded.id}`, {
    headers: { "x-syncura-token": heToken },
  });
  ok("unlink removes access to old media", mediaAfterUnlink.status === 404);
  ok("unlink clears the shared daily thread", !(await call("/us", { token: heToken })).body.entries);
  const afterUnlink = await call("/chat/messages", { token: heToken });
  ok("chat cleared after unlink", afterUnlink.body.messages?.length === 0);
  const chatAfter = await call("/chat/send", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ ciphertext: stub("x"), iv: ivStub() }),
  });
  ok("cannot chat after unlink", chatAfter.status === 409);

  console.log("\nunlinking keeps the link");
  const sheAfterUnlink = await call("/me", { token: sheToken });
  ok(
    "she keeps the same code after unlinking",
    /^SYNC-/.test(sheAfterUnlink.body.link?.code ?? "") &&
      sheAfterUnlink.body.link.code === herCode,
  );
  ok("her link is free and ready again", sheAfterUnlink.body.link?.connected === false);
  ok("no partner left on her link", sheAfterUnlink.body.link?.partnerName === null);
  const emptyTodos = await call("/todos", { token: sheToken });
  ok("unlink empties the shared task page", emptyTodos.body.todos.length === 0);
  ok("the task page still reports its day", /^\d{4}-\d{2}-\d{2}$/.test(emptyTodos.body.day));

  const relink = await call("/partner/connect", {
    token: heToken,
    method: "POST",
    body: JSON.stringify({ code: herCode }),
  });
  ok("they can pair again with the same code", relink.status === 200);
  ok(
    "he is connected again on the same link",
    (await call("/me", { token: heToken })).body.link?.connected === true,
  );
  await call("/partner/disconnect", { token: heToken, method: "POST", body: "{}" });

  console.log("\ncycle setup and predictions");
  const fresh = await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Nell",
      sex: "female",
      dateOfBirth: "1998-06-15",
      publicKey: "pub-new-0123456789abcdef",
    }),
  });
  const freshToken = fresh.body.token as string;
  const freshMe = await call("/me", { token: freshToken });
  ok("a new account has no cycle set up", freshMe.body.settings.cycleConfigured === false);
  ok("a new account has no predictions", freshMe.body.settings.lastPeriodStart === null);
  const bareInsight = await call("/insights", { token: freshToken, method: "POST", body: "{}" });
  ok("no insights without a chosen cycle", bareInsight.body.insight === null);

  const noStart = await call("/settings", {
    token: freshToken,
    method: "POST",
    body: JSON.stringify({ cycleConfigured: true }),
  });
  ok("choosing a cycle needs a start day", noStart.status === 400);

  /* Started far enough back that the days after ovulation have already
     happened, so they can be logged as well as dismissed. */
  const pastStart = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  const chosen = await call("/settings", {
    token: freshToken,
    method: "POST",
    body: JSON.stringify({ cycleConfigured: true, cycleLength: 30, periodLength: 4, lastPeriodStart: pastStart }),
  });
  ok("her own numbers are saved", chosen.body.settings.cycleLength === 30);
  ok("the cycle counts as chosen", chosen.body.settings.cycleConfigured === true);

  const cycleStart = new Date(`${pastStart}T00:00:00Z`);
  const dayFromStart = (offset: number) => {
    const value = new Date(cycleStart);
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  };
  /* Ovulation is 14 days before the next period, so the two days after it are
     cycleLength - 13 and cycleLength - 12 from the start. */
  const ovulationDay = dayFromStart(chosen.body.settings.cycleLength - 15);
  const unsafeDay = dayFromStart(chosen.body.settings.cycleLength - 14);
  const secondUnsafeDay = dayFromStart(chosen.body.settings.cycleLength - 13);
  ok(
    "the two unsafe days sit either side of nothing else",
    unsafeDay !== secondUnsafeDay && unsafeDay > ovulationDay && secondUnsafeDay > unsafeDay,
  );

  const removedPrediction = await call("/cycle/prediction", {
    token: freshToken,
    method: "POST",
    body: JSON.stringify({ logDate: unsafeDay, remove: true }),
  });
  ok(
    "a predicted date can be taken off the calendar",
    removedPrediction.body.settings.ignoredDates.includes(unsafeDay),
  );
  const malePrediction = await call("/cycle/prediction", {
    token: anotherMaleToken,
    method: "POST",
    body: JSON.stringify({ logDate: unsafeDay, remove: true }),
  });
  ok("only the woman can change predictions", malePrediction.status === 403);
  const restoredPrediction = await call("/cycle/prediction", {
    token: freshToken,
    method: "POST",
    body: JSON.stringify({ logDate: unsafeDay, remove: false }),
  });
  ok("and put back", restoredPrediction.body.settings.ignoredDates.length === 0);

  await call("/cycle/prediction", {
    token: freshToken,
    method: "POST",
    body: JSON.stringify({ logDate: secondUnsafeDay, remove: true }),
  });
  const loggedPeriod = await call("/cycle/period-day", {
    token: freshToken,
    method: "POST",
    body: JSON.stringify({ logDate: secondUnsafeDay, logged: true, flow: "medium" }),
  });
  ok(
    "a logged day is not left on the dismissed list",
    loggedPeriod.status === 200 &&
      !(loggedPeriod.body.settings.ignoredDates ?? []).includes(secondUnsafeDay) &&
      loggedPeriod.body.settings.periodDays.includes(secondUnsafeDay),
  );

  console.log("\naccount deletion");
  const del = await call("/account/delete", { token: heToken, method: "POST", body: "{}" });
  ok("account deleted", del.status === 200);
  const gone = await call("/me", { token: heToken });
  ok("token invalid after deletion", gone.status === 401);
  const survivor = await call("/me", { token: sheToken });
  ok("partner account survives partner deletion", survivor.status === 200);
  ok("survivor is unlinked again", survivor.body.link?.connected === false);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(2);
});

