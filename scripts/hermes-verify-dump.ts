import { io } from "socket.io-client";

const BASE = "http://localhost:5002";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { "x-syncura-token": token } : {}) },
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

function connect(token: string) {
  return new Promise<ReturnType<typeof io>>((resolve, reject) => {
    const s = io(BASE, { path: "/socket.io", transports: ["websocket"], auth: { token }, reconnection: false });
    const t = setTimeout(() => reject(new Error("timeout")), 8000);
    s.on("connect", () => { clearTimeout(t); resolve(s); });
    s.on("connect_error", (e) => { clearTimeout(t); reject(e); });
  });
}

const she = await api("/auth/register", "", { method: "POST", body: JSON.stringify({ name: "Iris", dateOfBirth: "1997-03-02", sex: "female", publicKey: JSON.stringify(jwk("iris")) }) });
const he = await api("/auth/register", "", { method: "POST", body: JSON.stringify({ name: "Kai", dateOfBirth: "1995-11-20", sex: "male", publicKey: JSON.stringify(jwk("kai")) }) });
const sheToken = she.body.token, heToken = he.body.token;
const sheId = she.body.user.id, heId = he.body.user.id;
const me = await api("/me", sheToken);
await api("/partner/connect", heToken, { method: "POST", body: JSON.stringify({ code: me.body.link.code }) });
const linkId = me.body.link.id;

const a = await connect(sheToken);
const b = await connect(heToken);
a.emit("subscribe", linkId);
b.emit("subscribe", linkId);
await wait(800);

const callId = "00000000-0000-4000-8000-00000000aaaa";
console.log("she dials:", sheId, "he answers:", heId);
a.emit("call:signal", { callId, kind: "offer", mode: "video", data: { type: "offer", sdp: "v=0" } });
await wait(500);
b.emit("call:signal", { callId, kind: "answer", data: { type: "answer", sdp: "v=0" } });
await wait(400);
a.emit("call:signal", { callId, kind: "end" });
await wait(900);

const his = await api("/calls", heToken);
const her = await api("/calls", sheToken);
console.log("\n--- HIS /api/calls status", his.status);
console.log(JSON.stringify(his.body, null, 2));
console.log("\n--- HER /api/calls status", her.status);
console.log(JSON.stringify(her.body, null, 2));
console.log("\nsheId", sheId, "heId", heId);

a.close(); b.close();
await wait(200);
process.exit(0);