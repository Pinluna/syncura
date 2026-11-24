/* Headless Chromium smoke test: loads the built app, walks the signup flow,
   and fails on any console error or unhandled rejection. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3001";
const CHROME = process.env.CHROME ?? "/usr/bin/chromium";
const PORT = 9333;

let failures = 0;
const ok = (label: string, cond: unknown, detail?: unknown) => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined && detail !== "") console.log(`        ${detail}`);
  }
};

const profile = mkdtempSync(join(tmpdir(), "syncura-smoke-"));
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function endpoint(path: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      return await endpoint("/json/version");
    } catch {
      await wait(250);
    }
  }
  throw new Error("chromium devtools never came up");
}

async function main() {
  const version = await connect();
  const ws = version.webSocketDebuggerUrl;

  const { default: WebSocket } = await import("ws").catch(() => ({ default: null }));
  if (!WebSocket) throw new Error("the ws package is required for the smoke test");

  const browser = new WebSocket(ws, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => {
    browser.on("open", res);
    browser.on("error", rej);
  });

  let nextId = 0;
  const pending = new Map<number, (v: any) => void>();
  const events: any[] = [];
  browser.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  const send = (method: string, params: any = {}, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

  const call = (method: string, params: any = {}) => send(method, params, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Network.enable");

  const evaluate = async (expression: string) => {
    const res = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
    }
    return res.result?.value;
  };

  /* A fixed sleep is flaky when the whole suite runs back to back, so wait on
     the thing being asserted instead of the clock. */
  const waitFor = async (expression: string, label: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      /* The document may not have a body yet, so a throwing probe is just
         "not ready" rather than a failure. */
      let ready = false;
      try {
        ready = Boolean(await evaluate(`Boolean(${expression})`));
      } catch {
        ready = false;
      }
      if (ready) return true;
      if (Date.now() > deadline) {
        console.log(`        (timed out waiting for ${label})`);
        return false;
      }
      await wait(150);
    }
  };

  const BENIGN = [
    /* Chrome warns when vibrate() runs without a trusted gesture. Automated
       clicks are never trusted gestures, so this is a harness artefact. */
    "navigator.vibrate",
    "Blocked call to",
    /* The app pulls its fonts from Google Fonts and is built to work without
       them, so an unreachable font host is not an app fault. */
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "ERR_ADDRESS_UNREACHABLE",
    "ERR_NAME_NOT_RESOLVED",
    "ERR_INTERNET_DISCONNECTED",
  ];

  const problems = () =>
    events
      .filter((e) => {
        if (e.method === "Runtime.exceptionThrown") return true;
        if (e.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(e.params.type)) return true;
        if (e.method === "Log.entryAdded" && e.params.entry.level === "error") return true;
        return false;
      })
      .map((e) =>
        e.method === "Runtime.exceptionThrown"
          ? e.params.exceptionDetails.exception?.description ?? "exception"
          : e.method === "Log.entryAdded"
            ? e.params.entry.text
            : (e.params.args ?? []).map((a: any) => a.value ?? a.description).join(" "),
      )
      .filter((text) => !BENIGN.some((b) => text.includes(b)));

  const uniqueName = `Smoke${Date.now().toString().slice(-6)}`;

  console.log("\nload the welcome screen");
  await call("Page.navigate", { url: `${BASE}/welcome` });
  const rendered = await waitFor(
    "document.body?.innerText?.includes('Syncura') === true",
    "the welcome screen",
  );
  const title = await evaluate("document.title");
  ok("document title is set", typeof title === "string" && title.length > 0);
  const step1 = await evaluate(
    "document.body.innerText.includes('get to know you') || document.body.innerText.includes('Syncura')",
  );
  ok("welcome copy renders", step1 === true && rendered === true);
  const wordmark = await evaluate("document.querySelector('.wordmark')?.textContent ?? ''");
  ok("wordmark is Syncura", wordmark === "Syncura");
  const fontsLoaded = await evaluate("document.fonts ? document.fonts.status : 'unknown'");
  console.log(`        (document.fonts.status = ${fontsLoaded})`);
  ok("no console errors on welcome", problems().length === 0, problems().join(" | "));

  console.log("\nsignup flow");
  await evaluate(`
    (() => {
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        desc.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('#name'), ${JSON.stringify(uniqueName)});
      return true;
    })()
  `);
  await wait(300);
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Continue'))?.click()",
  );
  await wait(600);
  const step2 = await evaluate("document.body.innerText.includes('born')");
  ok("advances to date of birth", step2 === true);

  await evaluate(`
    (() => {
      const el = document.querySelector('#dob');
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      desc.set.call(el, '1997-03-02');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await wait(300);
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Continue'))?.click()",
  );
  await wait(600);
  const step3 = await evaluate("document.body.innerText.includes('identify')");
  ok("advances to sex choice", step3 === true);

  await evaluate(
    "[...document.querySelectorAll('.sexTile')].find(b => b.textContent.includes('Female'))?.click()",
  );
  await wait(300);
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Start tracking'))?.click()",
  );
  await wait(3000);

  const onHome = await evaluate("location.pathname");
  ok("lands on /home", onHome === "/home");
  const greeting = await evaluate("document.querySelector('h1')?.textContent ?? ''");
  ok("greeting greets the new user", greeting.includes(uniqueName));
  const navCount = await evaluate("document.querySelectorAll('.nav a').length");
  ok("bottom nav has 6 destinations", navCount === 6);
  const hasCycleRing = await evaluate("Boolean(document.querySelector('svg'))");
  ok("home renders visualisations", hasCycleRing === true);
  ok("no console errors after signup", problems().length === 0, problems().join(" | "));

  console.log("\npairing code");
  await evaluate("[...document.querySelectorAll('.nav a')].find(a => a.textContent.includes('Connect'))?.click()");
  await wait(1500);
  const code = await evaluate("document.querySelector('.code')?.textContent?.trim() ?? ''");
  ok("connect screen shows a pairing code", /^SYNC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code));

  console.log("\nnavigating every screen");
  for (const [label, needle] of [
    ["Cycle", "Hormone levels"],
    ["Chat", "Chat"],
    ["Together", "Shared tasks"],
    ["Settings", "Appearance"],
    ["Home", "Water"],
  ]) {
    await evaluate(
      `[...document.querySelectorAll('.nav a')].find(a => a.textContent.includes(${JSON.stringify(label)}))?.click()`,
    );
    await wait(1200);
    const has = await evaluate(`document.body.innerText.includes(${JSON.stringify(needle)})`);
    ok(`${label} renders`, has === true);
  }

  console.log("\ntheme switching");
  await evaluate("[...document.querySelectorAll('.nav a')].find(a => a.textContent.includes('Settings'))?.click()");
  await wait(1200);
  await evaluate(
    "[...document.querySelectorAll('.chip')].find(b => b.textContent.includes('Ocean'))?.click()",
  );
  await wait(500);
  const accent = await evaluate(
    "getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()",
  );
  ok("accent theme applies", accent.length > 0 && accent.toLowerCase() !== "#8b5cf6");

  await evaluate("[...document.querySelectorAll('.chip')].find(b => b.textContent.trim() === 'Dark')?.click()");
  await wait(500);
  const dark = await evaluate("document.body.classList.contains('dark')");
  ok("dark mode applies", dark === true);

  await evaluate("[...document.querySelectorAll('.chip')].find(b => b.textContent.includes('Light'))?.click()");
  await wait(400);
  const light = await evaluate("!document.body.classList.contains('dark')");
  ok("light mode restores", light === true);

  console.log("\nlogging today");
  await evaluate("[...document.querySelectorAll('.nav a')].find(a => a.textContent.includes('Home'))?.click()");
  await wait(1500);
  await evaluate("[...document.querySelectorAll('.chip')].find(b => b.textContent.trim() === 'Calm')?.click()");
  await wait(1200);
  const glassChip = await evaluate(
    "Boolean([...document.querySelectorAll('.chip')].find(b => b.getAttribute('aria-label')?.startsWith('Set water')))",
  );
  ok("water control is interactive", glassChip === true);
  await evaluate(
    "[...document.querySelectorAll('.chip')].find(b => b.getAttribute('aria-label')?.startsWith('Set water to 3'))?.click()",
  );
  await wait(1200);
  const waterLabel = await evaluate(
    "document.body.innerText.match(/(\\d+)\\/8/)?.[1] ?? ''",
  );
  ok("water count updates to 3", waterLabel === "3");

  console.log("\ncycle unlock");
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Set to today'))?.click()",
  );
  await wait(1800);
  const unlocked = await evaluate("document.body.innerText.includes('Cycle day')");
  ok("cycle tracking unlocks", unlocked === true);

  await evaluate("[...document.querySelectorAll('.nav a')].find(a => a.textContent.includes('Cycle'))?.click()");
  await wait(1500);
  const ringText = await evaluate("document.body.innerText.replace(/\\s+/g, ' ')");
  /* innerText reflects text-transform, so the "Day" eyebrow reads as "DAY". */
  ok("cycle screen shows the day count", /day 1 of 28/i.test(String(ringText)));
  ok("cycle screen shows the phase", /menstrual|follicular|fertile|luteal/i.test(String(ringText)));
  const legend = await evaluate("document.body.innerText.includes('Ovulation')");
  ok("calendar legend renders", legend === true);

  console.log("\nlogout");
  await evaluate("[...document.querySelectorAll('.nav a')].find(a => a.textContent.includes('Settings'))?.click()");
  await wait(1200);
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign out')?.click()",
  );
  await wait(2000);
  const afterLogout = await evaluate("location.pathname");
  ok("sign out returns to welcome", afterLogout === "/welcome");

  const finalProblems = problems();
  console.log(`\nconsole problems observed: ${finalProblems.length}`);
  for (const p of finalProblems.slice(0, 12)) console.log(`   ! ${p}`);
  ok("no console errors across the whole session", finalProblems.length === 0);

  browser.close();
  /* Chromium keeps writing to the profile as it shuts down, so wait for the
     process to actually exit before removing the directory. */
  const exited = new Promise<void>((resolve) => chrome.once("exit", () => resolve()));
  chrome.kill();
  await Promise.race([exited, wait(5000)]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

  console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
  process.exit(2);
});
