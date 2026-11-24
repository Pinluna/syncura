import { readFileSync, writeFileSync } from "node:fs";

/* Ad-hoc: does the call log survive a restart, and do rows written before
   ownerId existed get repaired rather than silently hidden?

   Both are migration concerns, so neither is reachable from a fresh store. The
   restart part is checked by the caller across a server bounce; this mutates a
   real store to plant a legacy row and then asserts the loader fixes it. */

const path = process.env.STORE ?? "/tmp/hermes-verify-store.json";
const raw = readFileSync(path, "utf8");
const db = JSON.parse(raw);

const links = Object.values(db.links) as Array<Record<string, any>>;
if (!links.length) throw new Error("no link in the store to test against");
const link = links[0];
const users = Object.values(db.users) as Array<Record<string, any>>;

console.log(`link aId=${link.aId?.slice(0, 8)} bId=${link.bId?.slice(0, 8)}`);
console.log(`callLog rows before: ${link.callLog.length}`);

// Plant a legacy row: ownerId absent, exactly the shape the first version wrote.
const legacy = {
  id: "11111111-2222-3333-4444-555555555555",
  callerId: link.bId ?? link.aId,
  callId: "99999999-0000-4000-8000-00000000dead",
  mode: "audio",
  startedAt: "2026-01-01T10:00:00.000Z",
  endedAt: "2026-01-01T10:00:05.000Z",
  outcome: "missed",
};
// And drop ownerId from every existing row too, so the repair runs at scale.
for (const row of link.callLog) delete row.ownerId;
link.callLog.push(legacy);
writeFileSync(path, JSON.stringify(db));
console.log(`planted 1 legacy row and stripped ownerId from all ${link.callLog.length}`);
console.log("NOW RESTART THE SERVER, THEN RUN hermes-verify-migrate.ts");