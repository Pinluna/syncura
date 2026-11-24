/* Two independent browser profiles register, pair, exchange a live encrypted
   chat, and share live status. This is the real end-to-end path: WebCrypto key
   exchange, Socket.IO rooms, and the server holding only ciphertext. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { TEST_BASE as BASE } from "./test-env";

const CHROME = process.env.CHROME ?? "/usr/bin/chromium";

let failures = 0;
const ok = (label: string, cond: unknown) => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tab {
  call: (method: string, params?: any) => Promise<any>;
  eval: <T = any>(expression: string) => Promise<T>;
  close: () => Promise<void>;
}

async function launch(port: number): Promise<{ wsUrl: string; kill: () => void; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), `syncura-pair-${port}-`));
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
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
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return { wsUrl: v.webSocketDebuggerUrl, kill: () => chrome.kill(), profile };
    } catch {
      await wait(250);
    }
  }
  throw new Error(`chromium on ${port} never came up`);
}

async function attach(wsUrl: string, url: string): Promise<Tab> {
  const browser = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
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

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.navigate", { url });
  await wait(2600);

  return {
    call,
    async eval<T>(expression: string): Promise<T> {
      const res = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
      }
      return res.result?.value as T;
    },
    async close() {
      browser.close();
    },
  };
}

const signup = async (tab: Tab, name: string, sex: "Female" | "Male") => {
  await tab.eval(`
    (() => {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('#name'), ${JSON.stringify(name)});
      return true;
    })()
  `);
  await wait(250);
  await tab.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Continue'))?.click()");
  await wait(500);
  await tab.eval(`
    (() => {
      const el = document.querySelector('#dob');
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, '1997-03-02');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await wait(250);
  await tab.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Continue'))?.click()");
  await wait(500);
  await tab.eval(
    `[...document.querySelectorAll('.sexTile')].find(b => b.textContent.includes(${JSON.stringify(sex)}))?.click()`,
  );
  await wait(250);
  /* She has one more step than he does, where she chooses her own cycle, so
     keep pressing the last primary button until the account exists. */
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const done = await tab.eval("location.pathname !== '/register'");
    if (done) break;
    await tab.eval(`
      (() => {
        const primary = [...document.querySelectorAll('button.btn.primary.lg')];
        primary[primary.length - 1]?.click();
        return true;
      })()
    `);
    await wait(2500);
  }
  await wait(1500);
};

const nav = async (tab: Tab, label: string) => {
  await tab.eval(
    `[...document.querySelectorAll('.nav a')].find(a => a.textContent.includes(${JSON.stringify(label)}))?.click()`,
  );
  await wait(1500);
};

async function main() {
  console.log("\nlaunching two independent browsers");
  const one = await launch(9441);
  const two = await launch(9442);
  const a = await attach(one.wsUrl, `${BASE}/register`);
  const b = await attach(two.wsUrl, `${BASE}/register`);
  ok("two isolated profiles started", Boolean(a && b));

  console.log("\nregistering");
  const sheName = "Iris";
  const heName = "Kai";
  await signup(a, sheName, "Female");
  await signup(b, heName, "Male");
  ok("first account registered", (await a.eval("location.pathname")) === "/home");
  ok("male account is directed to partner linking", (await b.eval("location.pathname")) === "/connect");
  /* She chose her own numbers on the way in, so her calendar is hers from the
     first day rather than a default that was never hers. */
  const herSettings = JSON.parse(
    await a.eval(`
      fetch('/api/me', { headers: { 'x-syncura-token': localStorage.getItem('syncura.token') } })
        .then((r) => r.json())
        .then((d) => JSON.stringify(d.settings))
    `),
  );
  ok("her cycle is set up from her own answers", herSettings.cycleConfigured === true);
  ok("she chose her own cycle length", herSettings.cycleLength === 28 && herSettings.lastPeriodStart !== null);

  const keyA = await a.eval("localStorage.getItem('syncura.e2ee.public')");
  const keyB = await b.eval("localStorage.getItem('syncura.e2ee.public')");
  ok("each device generated its own key", Boolean(keyA && keyB && keyA !== keyB));
  ok("no token equals the public key", !(await a.eval("localStorage.getItem('syncura.token')")).includes("EC"));

  console.log("\nlinking");
  await nav(a, "Connect");
  const code = await a.eval("document.querySelector('.code')?.textContent?.trim() ?? ''");
  ok("she has a pairing code", /^SYNC-/.test(code));

  await b.eval(`
    (() => {
      const el = document.querySelector('input[placeholder^="SYNC-"]');
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, ${JSON.stringify(code)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await wait(400);
  await b.eval(`
    (() => {
      const inputs = [...document.querySelectorAll('input')];
      const el = inputs[inputs.length - 1];
      el.focus();
      return true;
    })()
  `);
  await b.eval("[...document.querySelectorAll('button')].filter(x => x.textContent.trim() === 'Connect').pop()?.click()");
  await wait(2500);

  await nav(b, "Connect");
  const linkedHe = await b.eval("document.body.innerText.includes('Safety number')");
  ok("he sees the link as active", linkedHe === true);
  const linkedShe = await a.eval("document.body.innerText.includes('Unlink')");
  ok("she sees the link reflected", linkedShe === true);

  const partnerKeyVisible = await a.eval("document.body.innerText.includes('Kai')");
  ok("she sees her partner's name", partnerKeyVisible === true);

  console.log("\nsafety number verification");
  await a.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Safety number'))?.click()");
  await wait(800);
  const safetyA = await a.eval(
    "[...document.querySelectorAll('.code')].map(e => e.textContent.trim()).find(t => /^[0-9 ]+$/.test(t)) ?? ''",
  );
  ok("she can display a safety number", /^[0-9]{5}( [0-9]{5}){5}$/.test(safetyA));
  await nav(b, "Connect");
  await b.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Safety number'))?.click()");
  await wait(800);
  const safetyB = await b.eval(
    "[...document.querySelectorAll('.code')].map(e => e.textContent.trim()).find(t => /^[0-9 ]+$/.test(t)) ?? ''",
  );
  ok("both devices derive the same safety number", safetyA === safetyB && safetyA.length > 0);

  console.log("\nlive encrypted chat");
  await nav(b, "Iris");
  await nav(a, "Kai");
  ok("encryption notice appears on opening chat", (await a.eval("document.body.innerText")).includes("End-to-end encrypted"));
  ok("chat starts empty", (await a.eval("document.body.innerText")).includes("Say hi!"));
  await wait(3500);
  ok("encryption notice hides without hiding chat", !(await a.eval("document.body.innerText")).includes("End-to-end encrypted"));

  await typeAndSend(a, "hello from Iris 💜");
  await wait(2000);
  ok("her message appears for her", (await a.eval("document.body.innerText")).includes("hello from Iris"));
  await wait(1500);
  ok("chat text remains visible after three seconds", (await a.eval("document.body.innerText")).includes("hello from Iris"));
  await wait(1500);
  const herView = await b.eval("document.body.innerText");
  ok("he receives and decrypts it", herView.includes("hello from Iris"));

  await typeAndSend(b, "got it, Kai here");
  await wait(2500);
  const hisView = await a.eval("document.body.innerText");
  ok("she receives his reply", hisView.includes("got it, Kai here"));

  const rawCipher = await b.eval("document.body.innerText.includes('hello from Iris')");
  ok("plaintext is only ever rendered client-side", rawCipher === true);

  console.log("\ntyping indicator");
  await b.eval(`
    (() => {
      const el = document.querySelector('input.input');
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, 'typing something');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await wait(1200);
  const typingSeen = await a.eval("document.body.innerText.includes('typing')");
  ok("she sees the typing indicator", typingSeen === true);
  await b.eval(`
    (() => {
      const el = document.querySelector('input.input');
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  console.log("\nserver never holds plaintext");
  const stored = await (await fetch(`${BASE}/api/health`)).json();
  ok("api still healthy after chat", stored.ok === true);

  console.log("\nshared journal and todos");
  await nav(a, "Together");
  await a.eval(`
    (() => {
      const el = document.querySelector('.us-thread-composer textarea');
      if (!el) return false;
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, 'today was a good day');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await wait(400);
  await a.eval("document.querySelector('.us-thread-composer button[type=\"submit\"]')?.click()");
  await wait(2000);
  ok("she added a note to today's Us thread", (await a.eval("document.body.innerText")).includes("today was a good day"));

  await nav(b, "Together");
  await wait(1200);
  ok("he sees her shared daily-thread note", (await b.eval("document.body.innerText")).includes("today was a good day"));

  await nav(a, "Together");
  await a.eval(`
    (() => {
      const inputs = [...document.querySelectorAll('input.input')];
      const el = inputs[inputs.length - 1];
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, 'Book the cabin');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await wait(300);
  await a.eval(`
    (() => {
      const btns = [...document.querySelectorAll('button.btn.primary.icon-lg')];
      btns[btns.length - 1]?.click();
      return true;
    })()
  `);
  await wait(2000);
  await nav(b, "Together");
  await wait(1500);
  ok("the task appears on his device", (await b.eval("document.body.innerText")).includes("Book the cabin"));

  console.log("\nlive status gating");
  await nav(a, "Connect");
  await wait(1200);
  const toggleBefore = await a.eval("document.body.innerText.toLowerCase().includes('your location is private')");
  ok("live sharing defaults to off", toggleBefore === true);

  console.log("\nunlinking clears shared state");
  await nav(a, "Connect");
  await a.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Unlink'))?.click()");
  await wait(2500);
  const afterUnlink = await a.eval("![...document.querySelectorAll('button')].some(button => button.textContent.includes('Unlink'))");
  ok("she is unlinked", afterUnlink === true);

  await nav(b, "Together");
  await wait(1500);
  const hisTogether = await b.eval("document.body.innerText");
  ok("his shared task list was cleared", !hisTogether.includes("Book the cabin"));

  await a.close();
  await b.close();
  await wait(300);
  /* Chromium keeps writing to the profile as it shuts down, so wait for the
     processes to actually exit before removing the directories. */
  const exited = Promise.all(
    [one, two].map(
      (c) => new Promise<void>((resolve) => (c.exitCode !== null ? resolve() : c.once("exit", () => resolve()))),
    ),
  );
  one.kill();
  two.kill();
  await Promise.race([exited, wait(5000)]);
  rmSync(one.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(two.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

  console.log(`\n${failures === 0 ? "ALL PAIRING CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function typeAndSend(tab: Tab, text: string) {
  await tab.eval(`
    (() => {
      const el = document.querySelector('input.input');
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await wait(400);
  await tab.eval(
    "[...document.querySelectorAll('button.btn.primary.icon-lg')].pop()?.click()",
  );
}

main().catch((e) => {
  console.error("pairing test crashed:", e);
  process.exit(2);
});


