/* Regression test for the signup crash on device.

   Inside the Capacitor WebView the page origin is https://localhost, which is
   the phone itself and never the API. The app used to treat that origin as the
   server, so POST /api/auth/register came back as the bundled index.html and
   the gender step died with "Unexpected token <". This drives the real built
   app under a simulated WebView and asserts the request leaves for the API. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import WebSocket from "ws";

const API = process.env.API ?? "http://localhost:3001";
const SHELL_PORT = Number(process.env.SHELL_PORT ?? 3021);
const CHROME = process.env.CHROME ?? "/usr/bin/chromium";
const PORT = 9335;

let failures = 0;
const ok = (label: string, cond: unknown) => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/* Stands in for the Capacitor asset server: serves the SPA shell from an origin
   that is deliberately NOT the API, exactly like https://localhost on a phone. */
const shell = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  let file = join(process.cwd(), "dist", url);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(process.cwd(), "dist", "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

async function main() {
  await new Promise<void>((r) => shell.listen(SHELL_PORT, r));
  const profile = mkdtempSync(join(tmpdir(), "syncura-native-"));
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--window-size=412,915",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let wsUrl = "";
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await wait(250);
    }
  }
  if (!wsUrl) throw new Error("chromium devtools never came up");

  const browser = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise<void>((res, rej) => {
    browser.on("open", res);
    browser.on("error", rej);
  });

  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  browser.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result);
      pending.delete(msg.id);
    }
  });
  const send = (method: string, params: any = {}, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      browser.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method: string, params: any = {}) => send(method, params, sessionId);
  const evaluate = async <T,>(expression: string): Promise<T> => {
    const res = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
    return res.result?.value as T;
  };

  await call("Page.enable");
  await call("Runtime.enable");

  /* Make the WebView look native before any app code runs, and record where
     fetch actually goes so the assertion is on real traffic. */
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.androidBridge = { postMessage: () => {} };
      window.__fetched = [];
      const realFetch = window.fetch;
      window.fetch = function (input, init) {
        window.__fetched.push(String(input && input.url ? input.url : input));
        return realFetch.apply(this, arguments);
      };
    `,
  });

  console.log("\nsimulated Capacitor WebView (origin is not the API)");
  await call("Page.navigate", { url: `http://localhost:${SHELL_PORT}/welcome` });
  await wait(2600);

  const platform = await evaluate("window.Capacitor?.getPlatform?.() ?? 'unknown'");
  ok("the page detects it is running natively", platform === "android");

  console.log("\nsignup no longer calls the app's own origin");
  const setInput = (selector: string, value: string) => evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  await setInput("#name", "Wren");
  await wait(200);
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Continue'))?.click()");
  await wait(500);
  await setInput("#dob", "1996-04-11");
  await wait(200);
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Continue'))?.click()");
  await wait(500);
  await evaluate("[...document.querySelectorAll('.sexTile')].find(b => b.textContent.includes('Female'))?.click()");
  await wait(200);

  await evaluate("window.__fetched.length = 0");
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Start tracking'))?.click()");
  await wait(3000);

  const fetched = await evaluate<string[]>("window.__fetched");
  const register = fetched.find((u) => u.includes("/auth/register"));
  ok("the register request was sent", Boolean(register));
  ok("it went to the API, not the app's own origin", Boolean(register?.startsWith(API)));
  ok("no request went to the WebView origin", !fetched.some((u) => u.startsWith(`http://localhost:${SHELL_PORT}/api`)));

  console.log("\nsignup completes");
  const token = await evaluate<string | null>("localStorage.getItem('syncura.token')");
  ok("the account was created and a token stored", Boolean(token));
  const path = await evaluate("location.pathname");
  const text = await evaluate<string>("document.body.innerText");
  ok("she reaches the home screen", path === "/home");
  if (path !== "/home") {
    console.log(`      path=${path}`);
    console.log(`      fetches=${JSON.stringify(fetched)}`);
    console.log(`      body=${JSON.stringify(text.slice(0, 300))}`);
  }
  ok("no JSON parse error is shown", !text.includes("Unexpected token"));
  ok("no 'isn't a Syncura API' warning", !text.includes("isn't a Syncura API"));

  console.log("\nthe server address can be changed in-app");
  await evaluate("window.history.pushState({}, '', '/settings'); window.dispatchEvent(new Event('syncura:navigate'))");
  await wait(1200);
  const inSettings = await evaluate("document.body.innerText.includes('Server address')");
  ok("a signed-in user can reach the server setting", inSettings === true);

  /* Signing out is the only way back to Welcome, which is where a first-run
     user has to be able to fix the address before they have an account. */
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign out')?.click()",
  );
  await wait(2000);
  const signedOut = await evaluate("location.pathname");
  ok("signing out returns to the welcome screen", signedOut === "/welcome");
  const onWelcome = await evaluate("document.body.innerText.includes('Using a self-hosted server?')");
  ok("a signed-out user can reach the server setting", onWelcome === true);

  browser.close();
  /* Chromium keeps writing to the profile as it shuts down, so wait for the
     process to actually exit before removing the directory. */
  const exited = new Promise<void>((resolve) => chrome.once("exit", () => resolve()));
  chrome.kill();
  await Promise.race([exited, wait(5000)]);
  shell.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

  console.log(`\n${failures === 0 ? "ALL NATIVE BOOT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("native boot test crashed:", e);
  process.exit(2);
});