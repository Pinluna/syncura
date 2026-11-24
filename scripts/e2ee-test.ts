/* Exercises the real src/lib/e2ee.ts against Node's WebCrypto, with just enough
   of a DOM shim for localStorage. Verifies the browser-side chat scheme end to end. */

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

const { ensureKeyPair, encrypt, decrypt, safetyNumber, wipeKeys } = await import("../src/lib/e2ee.js");

let failures = 0;
const ok = (label: string, cond: unknown) => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
};

const TEXT = "hey — period starts tomorrow 💜";

console.log("\nkey exchange");
wipeKeys();
const alicePub = await ensureKeyPair();
ok("generates a public key", typeof alicePub === "string" && alicePub.length > 40);

const jwk = JSON.parse(alicePub) as { kty?: string; crv?: string; x?: string };
ok("public key is a P-256 JWK", jwk.kty === "EC" && jwk.crv === "P-256" && Boolean(jwk.x));

const again = await ensureKeyPair();
ok("reuses the stored key pair", again === alicePub);

/* Each "device" is a separate localStorage snapshot. */
const snapshot = (): [string, string][] => [...store.entries()];
const restore = (snap: [string, string][]) => {
  store.clear();
  for (const [k, v] of snap) store.set(k, v);
};

const aliceKeys = snapshot();

console.log("\nseparate device, separate keys");
restore([]);
const bobPub = await ensureKeyPair();
ok("second device has a different key", bobPub !== alicePub);
const bobKeys = snapshot();

console.log("\nencrypt / decrypt roundtrip");
/* Alice seals against Bob's public key; Bob opens it against his own key pair. */
const sealed = await encrypt(bobPub, TEXT);
ok("ciphertext is not the plaintext", !sealed.ciphertext.includes("period"));
ok("ciphertext decodes as base64", /^[A-Za-z0-9+/=]+$/.test(sealed.ciphertext));
ok("iv is 12 bytes of base64", Buffer.from(sealed.iv, "base64").length === 12);

const opened = await decrypt(bobPub, sealed.ciphertext, sealed.iv);
ok("recipient recovers the plaintext", opened === TEXT);

console.log("\ntamper detection (AES-GCM)");
let tampered = false;
try {
  const bytes = Buffer.from(sealed.ciphertext, "base64");
  bytes[0] ^= 0xff;
  await decrypt(bobPub, bytes.toString("base64"), sealed.iv);
} catch {
  tampered = true;
}
ok("modified ciphertext is rejected", tampered);

let badIv = false;
try {
  const bytes = Buffer.from(sealed.iv, "base64");
  bytes[0] ^= 0xff;
  await decrypt(bobPub, sealed.ciphertext, bytes.toString("base64"));
} catch {
  badIv = true;
}
ok("modified iv is rejected", badIv);

console.log("\nwrong recipient cannot read");
restore([]);
const evePub = await ensureKeyPair();
let denied = false;
try {
  await decrypt(evePub, sealed.ciphertext, sealed.iv);
} catch {
  denied = true;
}
ok("a third device cannot decrypt", denied);

console.log("\nbidirectional messaging");
/* Bob's keys are loaded here, so he must seal against Alice's public key. */
restore(bobKeys);
const back = await encrypt(alicePub, "got it, thank you");

/* Alice now loads her keys and opens it against Bob's public key. */
restore(aliceKeys);
const roundTrip = await decrypt(bobPub, back.ciphertext, back.iv);
ok("reply reaches the original device", roundTrip === "got it, thank you");

const reseal = await encrypt(bobPub, "and again");
ok("alice can reply using bob's key", (await decrypt(bobPub, reseal.ciphertext, reseal.iv)) === "and again");

console.log("\nempty and unicode payloads");
const empty = await encrypt(bobPub, "");
ok("empty message roundtrips", (await decrypt(bobPub, empty.ciphertext, empty.iv)) === "");
const emoji = await encrypt(bobPub, "🌙🌙🌙");
ok("emoji roundtrips", (await decrypt(bobPub, emoji.ciphertext, emoji.iv)) === "🌙🌙🌙");

console.log("\nrecovering from a lost key pair");
/* If the stored private key is replaced, the cached secret must not be reused. */
const rederived = await encrypt(bobPub, "after regeneration");
restore(bobKeys);
const rederivedBack = await decrypt(alicePub, rederived.ciphertext, rederived.iv);
ok("cached secret is invalidated when keys change", rederivedBack === "after regeneration");

console.log("\nsafety numbers");
const n1 = await safetyNumber(alicePub, bobPub);
const n2 = await safetyNumber(bobPub, alicePub);
ok("safety number is stable across orderings", n1 === n2);
ok("safety number has 6 groups", n1.split(" ").length === 6);
ok("safety number is digit groups", /^\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}$/.test(n1));
const n3 = await safetyNumber(alicePub, evePub);
ok("different pairs get different numbers", n3 !== n1);

console.log(`\n${failures === 0 ? "ALL E2EE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
