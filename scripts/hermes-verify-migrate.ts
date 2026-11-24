import { readFileSync } from "node:fs";

/* The other half of the migration check: after a restart with legacy rows in the
   store, the loader must assign ownerId so both people can still read their own
   log. Run after hermes-verify-plant.ts and a server bounce. */

const path = process.env.STORE ?? "/tmp/hermes-verify-store.json";
let failures = 0;
const ok = (label: string, cond: unknown) => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
};

const db = JSON.parse(readFileSync(path, "utf8"));
const links = Object.values(db.links) as Array<Record<string, any>>;
const link = links[0];

console.log(`\nrows after restart: ${link.callLog.length}`);

ok("every row now has an ownerId", link.callLog.every((r) => typeof r.ownerId === "string" && r.ownerId.length > 0));
ok(
  "every ownerId is one of the two partners",
  link.callLog.every((r) => r.ownerId === link.aId || r.ownerId === link.bId),
);
ok(
  "a missed row is owned by the recipient, not the caller",
  link.callLog
    .filter((r) => r.outcome === "missed")
    .every((r) => r.ownerId !== r.callerId),
);
ok(
  "a dialed row is owned by the caller",
  link.callLog.filter((r) => r.outcome === "dialed").every((r) => r.ownerId === r.callerId),
);
ok(
  "the planted legacy call is present and repaired",
  link.callLog.some((r) => r.callId === "99999999-0000-4000-8000-00000000dead" && r.ownerId === link.aId),
);
ok(
  "each person still sees exactly half the rows",
  (() => {
    const mine = link.callLog.filter((r) => r.ownerId === link.aId).length;
    const theirs = link.callLog.filter((r) => r.ownerId === link.bId).length;
    return mine === theirs && mine + theirs === link.callLog.length && mine > 0;
  })(),
);

console.log(`\n${failures === 0 ? "MIGRATION CHECKS PASSED" : `${failures} MIGRATION CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);