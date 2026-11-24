import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTROL_HOST = "127.0.0.1";
const CONTROL_PORT = Number(process.env.SYNCURA_CONTROL_PORT ?? 3002);
const API_PORT = Number(process.env.PORT ?? 3001);
const CONTROL_TOKEN = randomBytes(32).toString("hex");
const STATE_DIR = join(homedir(), ".local", "share", "syncura");
const TLS_KEY_PATH = process.env.SYNCURA_TLS_KEY_FILE ?? join(STATE_DIR, "tls", "server.key");
const TLS_CERT_PATH = process.env.SYNCURA_TLS_CERT_FILE ?? join(STATE_DIR, "tls", "server.pem");
const DATA_KEY_PATH = join(STATE_DIR, "data.key");
const MANAGED_TOKEN = randomBytes(32).toString("hex");
const SAFE_HOSTS = new Set([
  `127.0.0.1:${CONTROL_PORT}`,
  `localhost:${CONTROL_PORT}`,
  `[::1]:${CONTROL_PORT}`,
]);

let managedProcess: ChildProcess | null = null;
let managedSince: number | null = null;
let lastError: string | null = null;

interface TrafficSnapshot {
  startedAt: string;
  capturedAt: string;
  totals: {
    requests: number;
    errors: number;
    responseBytes: number;
    connections: number;
    disconnections: number;
  };
  activeSockets: number;
  buckets: { minute: string; requests: number; errors: number; responseBytes: number }[];
  recent: { at: string; method: string; path: string; status: number; durationMs: number; responseBytes: number }[];
}

function routeAddress(): string | null {
  try {
    const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
    const defaultRoute = routes.find((line) => {
      const [, destination, , flags] = line.trim().split(/\s+/);
      return destination === "00000000" && (Number.parseInt(flags, 16) & 1) === 1;
    });
    const iface = defaultRoute?.trim().split(/\s+/)[0];
    if (!iface) return null;
    const addresses = readFileSync(`/sys/class/net/${iface}/address`, "utf8");
    if (!addresses.trim()) return null;
    const { stdout } = requireExecIp();
    return stdout;
  } catch {
    return null;
  }
}

function requireExecIp(): { stdout: string } {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const result = execFileSync("ip", ["-4", "-o", "addr", "show", "scope", "global"], { encoding: "utf8" });
  const routeResult = execFileSync("ip", ["-4", "route", "get", "1.1.1.1"], { encoding: "utf8" });
  const iface = routeResult.match(/\bdev\s+(\S+)/)?.[1];
  const address = result
    .split("\n")
    .find((line) => line.includes(` ${iface} `))
    ?.match(/\binet\s+([\d.]+)\//)?.[1];
  return { stdout: address ?? "" };
}

function serverHost(): string {
  const configured = process.env.SYNCURA_HOST;
  if (configured && configured !== "0.0.0.0" && configured !== "::") return configured;
  return routeAddress() ?? configured ?? "127.0.0.1";
}

function tlsAvailable(): boolean {
  return existsSync(TLS_KEY_PATH) && existsSync(TLS_CERT_PATH);
}

function apiUrl(): string {
  const protocol = tlsAvailable() ? "https" : "http";
  return `${protocol}://${serverHost()}:${API_PORT}`;
}

function serverEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.PORT = String(API_PORT);
  env.SYNCURA_HOST = serverHost();
  env.SYNCURA_CONTROL_TOKEN = MANAGED_TOKEN;
  if (!env.SYNCURA_TLS_KEY_FILE && tlsAvailable()) env.SYNCURA_TLS_KEY_FILE = TLS_KEY_PATH;
  if (!env.SYNCURA_TLS_CERT_FILE && tlsAvailable()) env.SYNCURA_TLS_CERT_FILE = TLS_CERT_PATH;
  if (!env.SYNCURA_DATA_KEY && existsSync(DATA_KEY_PATH)) {
    env.SYNCURA_DATA_KEY = readFileSync(DATA_KEY_PATH, "utf8").trim();
  }
  return env;
}

function requestJson<T>(urlValue: string, token?: string): Promise<{ status: number; body: T | null }> {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(urlValue);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        timeout: 1800,
        rejectUnauthorized: false,
        headers: token ? { "x-syncura-control-token": token } : {},
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 1_000_000) request.destroy(new Error("Local response is too large"));
        });
        response.on("end", () => {
          let parsed: T | null = null;
          try {
            parsed = body ? (JSON.parse(body) as T) : null;
          } catch {
            parsed = null;
          }
          resolvePromise({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Local server did not respond in time")));
    request.on("error", reject);
    request.end();
  });
}

async function listenerPid(): Promise<number | null> {
  try {
    const { stdout } = await execFile("ss", ["-ltnpH", `sport = :${API_PORT}`], { timeout: 2500 });
    const match = stdout.match(/\bpid=(\d+)\b/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function isProjectApiProcess(pid: number): boolean {
  try {
    const cwd = readFileSync(`/proc/${pid}/cwd`, "utf8");
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return cwd === ROOT && args.some((arg) => /(^|\/)server\/index\.ts$/.test(arg));
  } catch {
    return false;
  }
}

async function isHealthy(): Promise<boolean> {
  try {
    const result = await requestJson<{ ok?: boolean }>(`${apiUrl()}/api/health`);
    return result.status === 200 && result.body?.ok === true;
  } catch {
    return false;
  }
}

async function getSnapshot(): Promise<TrafficSnapshot | null> {
  try {
    const result = await requestJson<TrafficSnapshot>(
      `${apiUrl()}/__local/traffic`,
      MANAGED_TOKEN,
    );
    return result.status === 200 ? result.body : null;
  } catch {
    return null;
  }
}

async function stopPid(pid: number): Promise<void> {
  if (!isProjectApiProcess(pid)) {
    throw new Error("The process using the Syncura API port is not a verified Syncura server; it was left untouched.");
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const activePid = await listenerPid();
    if (activePid !== pid && !(await isHealthy())) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error("Syncura did not stop in time. The process was not force-killed.");
}

async function startServer(): Promise<void> {
  const pid = await listenerPid();
  if (pid !== null) {
    if (!isProjectApiProcess(pid)) {
      throw new Error(`Port ${API_PORT} is used by another process; it was left untouched.`);
    }
    if (managedProcess?.pid === pid) return;
    await stopPid(pid);
  }

  lastError = null;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(ROOT, "server", "index.ts")],
    {
      cwd: ROOT,
      env: serverEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  managedProcess = child;
  managedSince = Date.now();
  child.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line.includes("syncura api listening")) console.info(line);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      lastError = line.slice(-500);
      console.error(`Syncura server: ${lastError}`);
    }
  });
  child.once("error", (error) => {
    lastError = error.message;
    managedProcess = null;
    managedSince = null;
  });
  child.once("exit", (code, signal) => {
    if (managedProcess === child) {
      managedProcess = null;
      managedSince = null;
      if (code !== 0 && code !== null) lastError = `Server exited with code ${code}`;
      else if (signal) lastError = `Server stopped (${signal})`;
    }
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(lastError ?? "Syncura server exited before becoming ready.");
    }
    if (await isHealthy()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  child.kill("SIGTERM");
  throw new Error(lastError ?? "Syncura server did not become ready within 15 seconds.");
}

async function stopServer(): Promise<void> {
  const pid = await listenerPid();
  if (pid === null) return;
  await stopPid(pid);
  if (managedProcess && managedProcess.pid === pid) {
    managedProcess = null;
    managedSince = null;
  }
}

async function status() {
  const [healthy, pid] = await Promise.all([isHealthy(), listenerPid()]);
  const verified = pid !== null && isProjectApiProcess(pid);
  const snapshot = healthy ? await getSnapshot() : null;
  return {
    running: healthy,
    managed: healthy && pid !== null && managedProcess?.pid === pid,
    controllable: healthy && verified,
    host: serverHost(),
    port: API_PORT,
    protocol: tlsAvailable() ? "https" : "http",
    url: apiUrl(),
    pid: verified ? pid : null,
    uptimeSeconds: snapshot
      ? Math.max(0, Math.floor((Date.now() - new Date(snapshot.startedAt).getTime()) / 1000))
      : managedSince
        ? Math.max(0, Math.floor((Date.now() - managedSince) / 1000))
        : null,
    traffic: snapshot,
    lastError,
  };
}

function safeEqual(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  const item = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : undefined;
}

function isSameLocalOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host || !SAFE_HOSTS.has(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host === host;
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function serveAsset(path: string, response: ServerResponse) {
  const files: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  };
  const asset = files[path];
  if (!asset) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  try {
    const body = readFileSync(join(ROOT, "public", "control", asset.file));
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (path === "/") {
      response.setHeader("Set-Cookie", `syncura_control=${CONTROL_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    }
    response.end(body);
  } catch {
    response.writeHead(500);
    response.end("Could not read the local control panel files");
  }
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && ["/", "/app.css", "/app.js"].includes(url.pathname)) {
    serveAsset(url.pathname, response);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (!isSameLocalOrigin(request) || !safeEqual(readCookie(request, "syncura_control"), CONTROL_TOKEN)) {
      sendJson(response, 403, { error: "This local control session is not authorized." });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, await status());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/start") {
      try {
        await startServer();
        sendJson(response, 200, await status());
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start Syncura";
        lastError = message;
        sendJson(response, 409, { error: message });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/stop") {
      try {
        await stopServer();
        sendJson(response, 200, await status());
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not stop Syncura";
        lastError = message;
        sendJson(response, 409, { error: message });
      }
      return;
    }
  }
  response.writeHead(404);
  response.end("Not found");
}

const controlServer = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    console.error("Local control panel request failed", error);
    if (!response.headersSent) sendJson(response, 500, { error: "The local control request failed." });
    else response.destroy();
  });
});

controlServer.on("error", (error) => {
  console.error(`Could not start the local control panel on ${CONTROL_HOST}:${CONTROL_PORT}`, error);
  process.exitCode = 1;
});

controlServer.listen(CONTROL_PORT, CONTROL_HOST, () => {
  console.log(`Syncura local control panel: http://${CONTROL_HOST}:${CONTROL_PORT}`);
  console.log("This panel listens only on this PC's loopback interface.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    controlServer.close();
    if (managedProcess && managedProcess.exitCode === null) managedProcess.kill("SIGTERM");
  });
}
