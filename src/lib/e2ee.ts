const PRIVATE_KEY = "syncura.e2ee.private";
const PUBLIC_KEY = "syncura.e2ee.public";

/* Safari and older WebViews type Uint8Array buffers as SharedArrayBuffer-compatible,
   which the WebCrypto signatures reject. Re-view every buffer as a plain ArrayBuffer. */
const buf = (u8: Uint8Array): ArrayBuffer => {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
};

const enc = (data: ArrayBuffer | Uint8Array): string => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let out = "";
  bytes.forEach((b) => {
    out += String.fromCharCode(b);
  });
  return btoa(out);
};

const dec = (value: string): Uint8Array => {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

const derived = new Map<string, CryptoKey>();

export async function ensureKeyPair(): Promise<string> {
  const pub = localStorage.getItem(PUBLIC_KEY);
  if (pub && localStorage.getItem(PRIVATE_KEY)) return pub;

  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const publicJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey));
  const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
  localStorage.setItem(PUBLIC_KEY, publicJwk);
  localStorage.setItem(PRIVATE_KEY, privateJwk);
  derived.clear();
  return publicJwk;
}

async function sharedKey(partnerJwk: string): Promise<CryptoKey> {
  const privateJwk = localStorage.getItem(PRIVATE_KEY);
  if (!privateJwk) throw new Error("Encryption key missing on this device");

  /* The cached secret belongs to a specific pair of keys, so the local private
     key has to be part of the cache key. If it is ever replaced, every derived
     secret must be recomputed or messages would silently fail to open. */
  const cacheKey = `${privateJwk.length}:${partnerJwk.length}:${privateJwk}::${partnerJwk}`;
  const cached = derived.get(cacheKey);
  if (cached) return cached;

  const priv = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(privateJwk),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  );
  const pub = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(partnerJwk),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "ECDH", public: pub },
    priv,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  derived.set(cacheKey, key);
  return key;
}

export async function encrypt(
  partnerJwk: string,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await sharedKey(partnerJwk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(data));
  return { ciphertext: enc(out), iv: enc(iv) };
}

export async function decrypt(
  partnerJwk: string,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await sharedKey(partnerJwk);
  const out = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(dec(iv)) },
    key,
    buf(dec(ciphertext)),
  );
  return new TextDecoder().decode(out);
}

export async function encryptBytes(
  partnerJwk: string,
  plaintext: ArrayBuffer | Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: string }> {
  const key = await sharedKey(partnerJwk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(iv) },
    key,
    buf(data),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv: enc(iv) };
}

export async function decryptBytes(
  partnerJwk: string,
  ciphertext: ArrayBuffer | Uint8Array,
  iv: string,
): Promise<Uint8Array> {
  const key = await sharedKey(partnerJwk);
  const data = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(dec(iv)) },
    key,
    buf(data),
  );
  return new Uint8Array(plaintext);
}

export async function safetyNumber(mine: string, theirs: string): Promise<string> {
  const [a, b] = [mine, theirs].sort();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", buf(new TextEncoder().encode(`${a}|${b}`))),
  );
  const digits = Array.from(digest.slice(0, 10))
    .map((n) => String(n).padStart(3, "0"))
    .join("");
  return (digits.match(/.{1,5}/g) ?? []).slice(0, 6).join(" ");
}

export function wipeKeys() {
  localStorage.removeItem(PRIVATE_KEY);
  localStorage.removeItem(PUBLIC_KEY);
  derived.clear();
}

