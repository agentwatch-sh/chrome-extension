import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importState } from "../receiver/importer.js";
import { replacePageState } from "../receiver/page-state.js";
import { makeFakeChrome } from "./fake-chrome.mjs";

// Made-up values only. No error text or rejection may ever hold SECRET.
const SECRET = "SENTINEL-not-a-real-value-7f3a";
const ORIGIN = "https://www.app.localhost";
const NONCE = "0123456789abcdef";
const R = ORIGIN + "/__agentwatch_restore_" + NONCE + "__";
const BODY = '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>agentwatch</title>';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};

function makeState(over = {}) {
  return {
    v: 1,
    domain: "app.localhost",
    url: ORIGIN + "/home?x=1",
    origin: ORIGIN,
    cookies: [
      {
        name: "sid", value: SECRET + "-sid", domain: ".app.localhost", hostOnly: false, path: "/",
        secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 2000000000,
      },
      {
        name: "pref", value: SECRET + "-pref", domain: "www.app.localhost", hostOnly: true, path: "/p",
        secure: false, httpOnly: false, sameSite: "strict", session: true,
      },
    ],
    storage: {
      local: { k: SECRET + "-local" },
      session: { s: SECRET + "-session" },
      idb: [{
        name: "db", version: 3,
        stores: [{
          name: "s", keyPath: null, autoIncrement: false,
          indexes: [{ name: "i", keyPath: "a", unique: false, multiEntry: true }],
          records: [{ key: { t: "j", v: 1 }, value: { t: "j", v: SECRET + "-idb" } }],
        }],
      }],
      caches: [],
    },
    ...over,
  };
}

// Timers that never fire on their own; a test fires one by hand.
function fakeTimers() {
  const list = [];
  return {
    list,
    setTimer: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      list.push(h);
      return h;
    },
    clearTimer: (h) => {
      if (h) h.cleared = true;
    },
    pending: (ms) => list.filter((h) => !h.cleared && h.ms === ms),
  };
}

function opts(timers = fakeTimers()) {
  return { setTimer: timers.setTimer, clearTimer: timers.clearTimer, nonce: () => NONCE };
}

const noSecret = (x) => assert.ok(!JSON.stringify(x).includes("SENTINEL"), "a secret leaked: " + JSON.stringify(x));

async function rejectsWith(promise, message) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, "expected a rejection");
  assert.equal(err.message, message);
  noSecret(err.message);
  noSecret(String(err.stack).split("\n")[0]);
}

function describeCall([path, args]) {
  if (path === "debugger.sendCommand") return path + " " + args[1];
  if (path === "scripting.executeScript") {
    return path + " " + (args[0].files ? "files" : args[0].func === replacePageState ? "replacePageState" : "func");
  }
  return path;
}

test("the import follows C6 in order and sums the counts", async () => {
  const f = makeFakeChrome();
  f.cookies_ = [
    { name: "old", value: SECRET + "-old", domain: ".app.localhost", hostOnly: false, path: "/", secure: true },
    {
      name: "chip", value: SECRET + "-chip", domain: "www.app.localhost", hostOnly: true, path: "/", secure: true,
      partitionKey: { topLevelSite: "https://app.localhost", hasCrossSiteAncestor: false },
    },
  ];
  f.pageResult = { local: 1, session: 1, idb_databases: 1, idb_records: 1, cache_entries: 0, errors: [] };
  const state = makeState();
  const result = await importState(f.chrome, state, opts());

  assert.deepEqual(result, {
    cookies_removed: 2, cookies_set: 2, local: 1, session: 1,
    idb_databases: 1, idb_records: 1, cache_entries: 0, errors: [],
  });
  assert.deepEqual(Object.keys(result), [
    "cookies_removed", "cookies_set", "local", "session", "idb_databases", "idb_records", "cache_entries", "errors",
  ]);

  const relevant = f.calls.filter(([p]) => !p.startsWith("runtime.") && !p.startsWith("port."));
  assert.deepEqual(relevant.map(describeCall), [
    "cookies.getAll", "cookies.getAll",
    "cookies.remove", "cookies.remove",
    "cookies.set", "cookies.set",
    "tabs.create",
    "debugger.attach",
    "debugger.sendCommand Fetch.enable",
    "tabs.update",
    "debugger.sendCommand Fetch.fulfillRequest",
    "scripting.executeScript files",
    "scripting.executeScript replacePageState",
    "debugger.sendCommand Fetch.disable",
    "debugger.detach",
    "scripting.executeScript func",
  ]);

  // Cookie reads: the domain, then every partition.
  assert.deepEqual(f.callsTo("cookies.getAll"), [[{ domain: "app.localhost" }], [{ domain: "app.localhost", partitionKey: {} }]]);
  // The unpartitioned cookie came back from both reads and is removed once.
  assert.deepEqual(f.callsTo("cookies.remove").map((a) => a[0]), [
    { url: "https://app.localhost/", name: "old" },
    { url: "https://www.app.localhost/", name: "chip", partitionKey: { topLevelSite: "https://app.localhost", hasCrossSiteAncestor: false } },
  ]);
  assert.deepEqual(f.callsTo("cookies.set").map((a) => a[0]), [
    {
      url: "https://app.localhost/", name: "sid", value: SECRET + "-sid", path: "/", secure: true, httpOnly: true,
      sameSite: "lax", domain: ".app.localhost", expirationDate: 2000000000,
    },
    { url: "http://www.app.localhost/p", name: "pref", value: SECRET + "-pref", path: "/p", secure: false, httpOnly: false, sameSite: "strict" },
  ]);

  const [createArgs] = f.callsTo("tabs.create");
  assert.deepEqual(createArgs, [{ url: "about:blank", active: true }]);
  const tabId = f.callsTo("tabs.update")[0][0];
  assert.equal(typeof tabId, "number");
  assert.deepEqual(f.callsTo("debugger.attach"), [[{ tabId }, "1.3"]]);
  assert.deepEqual(f.callsTo("tabs.update"), [[tabId, { url: R }]]);

  const commands = f.callsTo("debugger.sendCommand");
  assert.deepEqual(commands[0], [{ tabId }, "Fetch.enable", { patterns: [{ urlPattern: R, requestStage: "Request" }] }]);
  const [target, method, params] = commands[1];
  assert.deepEqual(target, { tabId });
  assert.equal(method, "Fetch.fulfillRequest");
  assert.equal(params.requestId, "rq1");
  assert.equal(params.responseCode, 200);
  assert.deepEqual(params.responseHeaders, [
    { name: "Content-Type", value: "text/html; charset=utf-8" },
    { name: "Cache-Control", value: "no-store" },
  ]);
  assert.equal(Buffer.from(params.body, "base64").toString("utf8"), BODY);
  assert.deepEqual(commands[2], [{ tabId }, "Fetch.disable"]);
  assert.deepEqual(f.callsTo("debugger.detach"), [[{ tabId }]]);

  const execs = f.callsTo("scripting.executeScript").map((a) => a[0]);
  assert.deepEqual(execs[0], { target: { tabId }, files: ["lib/codec.js"] });
  assert.deepEqual(execs[1].target, { tabId });
  assert.equal(execs[1].func, replacePageState);
  assert.equal(execs[1].args.length, 1);
  assert.equal(typeof execs[1].args[0], "string");
  // One JSON string: a null keyPath survives (executeScript drops null-valued properties).
  assert.deepEqual(JSON.parse(execs[1].args[0]), state.storage);
  assert.deepEqual(execs[2].target, { tabId });
  assert.deepEqual(execs[2].args, [state.url]);

  // The navigation runs after the injected script returned.
  const replaced = [];
  globalThis.location = { replace: (u) => replaced.push(u) };
  try {
    assert.equal(execs[2].func(...execs[2].args), undefined);
    assert.deepEqual(replaced, []);
    await settle(2);
    assert.deepEqual(replaced, [state.url]);
  } finally {
    delete globalThis.location;
  }

  // The tab stays open on the site, and every listener is gone.
  assert.equal(f.callsTo("tabs.remove").length, 0);
  assert.equal(f.chrome.debugger.onEvent.listeners.length, 0);
  assert.equal(f.chrome.webNavigation.onCompleted.listeners.length, 0);
  assert.equal(f.chrome.webNavigation.onErrorOccurred.listeners.length, 0);
});

test("every timer of an import is cleared when it ends", async () => {
  const f = makeFakeChrome();
  const timers = fakeTimers();
  await importState(f.chrome, makeState(), opts(timers));
  assert.ok(timers.list.length > 0);
  assert.deepEqual(timers.list.filter((h) => !h.cleared), []);
  assert.deepEqual([...new Set(timers.list.map((h) => h.ms))].sort((a, b) => a - b), [20000, 100000]);
});

test("the default nonce is 16 hex characters and differs per import", async () => {
  const urls = [];
  for (let i = 0; i < 2; i++) {
    const f = makeFakeChrome();
    await importState(f.chrome, makeState(), { setTimer: fakeTimers().setTimer, clearTimer: () => {} });
    urls.push(f.callsTo("tabs.update")[0][1].url);
  }
  for (const u of urls) assert.match(u, /^https:\/\/www\.app\.localhost\/__agentwatch_restore_[0-9a-f]{16}__$/);
  assert.notEqual(urls[0], urls[1]);
});

test("a cookie that fails names the cookie in errors and the import goes on", async () => {
  const f = makeFakeChrome();
  f.impl["cookies.set"] = async (d) => {
    if (d.name === "sid") throw new Error("could not set " + d.value);
    return null;
  };
  const state = makeState();
  state.cookies.push({
    name: "far", value: SECRET + "-far", domain: "other.localhost", hostOnly: true, path: "/",
    secure: true, httpOnly: false, sameSite: "lax", session: true,
  });
  f.pageResult = { local: 1, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] };
  const result = await importState(f.chrome, state, opts());
  assert.equal(result.cookies_set, 0);
  assert.deepEqual(result.errors, ["cookie sid: not set", "cookie pref: not set", "cookie far: out of scope"]);
  // The out-of-scope cookie never reached cookies.set.
  assert.deepEqual(f.callsTo("cookies.set").map((a) => a[0].name), ["sid", "pref"]);
  assert.equal(f.callsTo("scripting.executeScript").length, 3);
  assert.equal(result.local, 1);
  noSecret(result);
});

test("a cookie removal that throws is reported and does not count", async () => {
  const f = makeFakeChrome();
  f.cookies_ = [
    { name: "a", value: SECRET, domain: "app.localhost", hostOnly: true, path: "/", secure: true },
    { name: "b", value: SECRET, domain: "app.localhost", hostOnly: true, path: "/", secure: true },
    { name: "c", value: SECRET, domain: "app.localhost", hostOnly: true, path: "/", secure: true },
  ];
  f.impl["cookies.remove"] = async (d) => {
    if (d.name === "a") throw new Error("no " + SECRET);
    if (d.name === "b") return null;
    return { ...d };
  };
  const result = await importState(f.chrome, makeState({ cookies: [] }), opts());
  assert.equal(result.cookies_removed, 1);
  assert.deepEqual(result.errors, ["cookie a: not removed"]);
  noSecret(result);
});

test("a cookie read that fails rejects with cookies and opens no tab", async () => {
  const f = makeFakeChrome();
  f.impl["cookies.getAll"] = async () => {
    throw new Error("read failed " + SECRET);
  };
  await rejectsWith(importState(f.chrome, makeState(), opts()), "cookies");
  assert.equal(f.callsTo("tabs.create").length, 0);
});

test("page errors (an unsupported record) pass through after the cookie errors", async () => {
  const f = makeFakeChrome();
  f.impl["cookies.set"] = async (d) => (d.name === "pref" ? null : { ...d });
  f.pageResult = {
    local: 2, session: 1, idb_databases: 1, idb_records: 4, cache_entries: 3,
    errors: ["idb db/s: 1 records skipped"],
  };
  const result = await importState(f.chrome, makeState(), opts());
  assert.deepEqual(result, {
    cookies_removed: 0, cookies_set: 1, local: 2, session: 1, idb_databases: 1, idb_records: 4, cache_entries: 3,
    errors: ["cookie pref: not set", "idb db/s: 1 records skipped"],
  });
});

test("a failing attach detaches nothing, closes the tab and rejects with attach", async () => {
  const f = makeFakeChrome();
  f.impl["debugger.attach"] = async () => {
    throw new Error("Cannot attach " + SECRET);
  };
  await rejectsWith(importState(f.chrome, makeState(), opts()), "attach");
  const [created] = f.calls.filter(([p]) => p === "tabs.create");
  assert.ok(created);
  assert.equal(f.callsTo("debugger.detach").length, 0);
  assert.equal(f.callsTo("tabs.remove").length, 1);
  assert.equal(f.callsTo("debugger.sendCommand").length, 0);
  assert.equal(f.callsTo("tabs.update").length, 0);
});

test("each later step names itself when it fails, and the tab is closed after a detach", async () => {
  const cases = [
    ["fetch enable", (f) => { f.impl["debugger.sendCommand"] = async (t, m) => { if (m === "Fetch.enable") throw new Error(SECRET); return {}; }; }],
    ["codec", (f) => { f.impl["scripting.executeScript"] = async (inj) => { if (inj.files) throw new Error(SECRET); return [{ result: undefined }]; }; }],
    ["write storage", (f) => { f.impl["scripting.executeScript"] = async (inj) => { if (inj.args) throw new Error("x " + inj.args[0]); return [{ result: undefined }]; }; }],
    ["write storage", (f) => { f.pageResult = null; }],
  ];
  for (const [step, arrange] of cases) {
    const f = makeFakeChrome();
    arrange(f);
    const tabIdOf = () => f.callsTo("debugger.attach")[0][0].tabId;
    await rejectsWith(importState(f.chrome, makeState(), opts()), step);
    assert.deepEqual(f.callsTo("debugger.detach"), [[{ tabId: tabIdOf() }]], step);
    assert.deepEqual(f.callsTo("tabs.remove"), [[tabIdOf()]], step);
    assert.equal(f.chrome.debugger.onEvent.listeners.length, 0, step);
    assert.equal(f.chrome.webNavigation.onCompleted.listeners.length, 0, step);
  }
});

test("a failing detach or navigate rejects with its name and closes the tab", async () => {
  {
    const f = makeFakeChrome();
    f.impl["debugger.detach"] = async () => {
      throw new Error(SECRET);
    };
    await rejectsWith(importState(f.chrome, makeState(), opts()), "detach");
    // The step's detach and the cleanup's detach both ran; the tab is closed.
    assert.equal(f.callsTo("debugger.detach").length, 2);
    assert.equal(f.callsTo("tabs.remove").length, 1);
  }
  {
    const f = makeFakeChrome();
    f.impl["scripting.executeScript"] = async (inj) => {
      if (inj.args && inj.args[0] === makeState().url) throw new Error(SECRET);
      return [{ result: inj.func && inj.func.name === "replacePageState" ? f.pageResult : undefined }];
    };
    await rejectsWith(importState(f.chrome, makeState(), opts()), "navigate");
    // Already detached: the cleanup closes the tab only.
    assert.equal(f.callsTo("debugger.detach").length, 1);
    assert.equal(f.callsTo("tabs.remove").length, 1);
  }
});

test("a navigation error on the restore page rejects with restore page", async () => {
  const f = makeFakeChrome();
  f.impl["tabs.update"] = async (tabId, props) => {
    setTimeout(() => f.chrome.webNavigation.onErrorOccurred.fire({ tabId, frameId: 0, url: props.url, error: "net::ERR_BLOCKED_BY_CLIENT" }), 0);
    return { id: tabId };
  };
  await rejectsWith(importState(f.chrome, makeState(), opts()), "restore page");
  assert.equal(f.callsTo("debugger.detach").length, 1);
  assert.equal(f.callsTo("tabs.remove").length, 1);
  assert.equal(f.chrome.webNavigation.onErrorOccurred.listeners.length, 0);
});

test("other tabs, other frames and other URLs do not complete the restore page", async () => {
  const f = makeFakeChrome();
  f.autoNavigate = false;
  f.impl["tabs.update"] = async (tabId, props) => {
    setTimeout(() => {
      const wn = f.chrome.webNavigation;
      wn.onErrorOccurred.fire({ tabId: tabId + 1, frameId: 0, url: props.url, error: "net::ERR_FAILED" });
      wn.onErrorOccurred.fire({ tabId, frameId: 3, url: props.url, error: "net::ERR_FAILED" });
      wn.onCompleted.fire({ tabId: tabId + 1, frameId: 0, url: props.url });
      wn.onCompleted.fire({ tabId, frameId: 2, url: props.url });
      wn.onCompleted.fire({ tabId, frameId: 0, url: ORIGIN + "/" });
      // A paused request of another URL continues; one of another tab is left alone.
      f.chrome.debugger.onEvent.fire({ tabId }, "Fetch.requestPaused", { requestId: "other", request: { url: ORIGIN + "/x.js" } });
      f.chrome.debugger.onEvent.fire({ tabId: tabId + 1 }, "Fetch.requestPaused", { requestId: "foreign", request: { url: props.url } });
      setTimeout(() => f.pauseRequest(tabId, props.url), 0);
    }, 0);
    return { id: tabId };
  };
  const result = await importState(f.chrome, makeState(), opts());
  assert.equal(result.errors.length, 0);
  const cmds = f.callsTo("debugger.sendCommand").map((a) => [a[1], a[2] && a[2].requestId]);
  assert.deepEqual(cmds, [
    ["Fetch.enable", undefined],
    ["Fetch.continueRequest", "other"],
    ["Fetch.fulfillRequest", "rq1"],
    ["Fetch.disable", undefined],
  ]);
});

test("a step that passes its 20 s deadline fails with its name; a late tab is closed", async () => {
  const f = makeFakeChrome();
  const timers = fakeTimers();
  let resolveCreate;
  f.impl["tabs.create"] = () => new Promise((r) => (resolveCreate = r));
  const p = importState(f.chrome, makeState(), opts(timers));
  await settle();
  assert.equal(f.callsTo("tabs.create").length, 1);
  const [stepTimer] = timers.pending(20000);
  assert.ok(stepTimer);
  stepTimer.fn();
  await rejectsWith(p, "open tab");
  assert.equal(f.callsTo("tabs.remove").length, 0);
  resolveCreate({ id: 77 });
  await settle();
  assert.deepEqual(f.callsTo("tabs.remove"), [[77]]);
});

test("the whole import has one deadline; the running step is named", async () => {
  const f = makeFakeChrome();
  f.autoNavigate = false;
  const timers = fakeTimers();
  const p = importState(f.chrome, makeState(), opts(timers));
  await settle();
  assert.equal(f.callsTo("tabs.update").length, 1);
  const [whole] = timers.pending(100000);
  assert.ok(whole);
  whole.fn();
  await rejectsWith(p, "restore page");
  assert.equal(f.callsTo("debugger.detach").length, 1);
  assert.equal(f.callsTo("tabs.remove").length, 1);
});

test("a cleanup call that hangs does not hang the import", async () => {
  const f = makeFakeChrome();
  const timers = fakeTimers();
  f.impl["scripting.executeScript"] = async () => {
    throw new Error(SECRET);
  };
  f.impl["debugger.detach"] = () => new Promise(() => {});
  const p = importState(f.chrome, makeState(), opts(timers));
  await settle();
  const [cleanupTimer] = timers.list.filter((h) => !h.cleared && h.ms < 20000);
  assert.ok(cleanupTimer, "a bounded cleanup timer");
  assert.ok(cleanupTimer.ms <= 5000);
  cleanupTimer.fn();
  await rejectsWith(p, "codec");
  assert.equal(f.callsTo("tabs.remove").length, 1);
});

test("a second import waits until the first ends, success or failure", async () => {
  const f1 = makeFakeChrome();
  const f2 = makeFakeChrome();
  const f3 = makeFakeChrome();
  let release;
  const gate = new Promise((r) => (release = r));
  f1.impl["cookies.getAll"] = async () => {
    await gate;
    return [];
  };
  f2.impl["debugger.attach"] = async () => {
    throw new Error("busy");
  };
  const p1 = importState(f1.chrome, makeState(), opts());
  const p2 = importState(f2.chrome, makeState(), opts());
  const p3 = importState(f3.chrome, makeState(), opts());
  await settle();
  assert.equal(f2.calls.length, 0);
  assert.equal(f3.calls.length, 0);
  release();
  await p1;
  await rejectsWith(p2, "attach");
  const r3 = await p3;
  assert.equal(r3.errors.length, 0);
  assert.ok(f3.callsTo("debugger.detach").length === 1);
});

test("an invalid state is refused before any chrome call", async () => {
  const bad = [
    makeState({ domain: "App.localhost" }),
    makeState({ domain: "localhost" }),
    makeState({ origin: "https://www.other.localhost" }),
    makeState({ origin: "https://www.app.localhost/path" }),
    makeState({ origin: "https://www.app.localhost:443" }),
    makeState({ origin: "ftp://www.app.localhost" }),
    makeState({ url: "https://www.other.localhost/" }),
    makeState({ url: "javascript:alert(1)" }),
    makeState({ cookies: null }),
    makeState({ storage: null }),
    null,
  ];
  for (const s of bad) {
    const f = makeFakeChrome();
    await rejectsWith(importState(f.chrome, s, opts()), "invalid state");
    assert.equal(f.calls.length, 0);
  }
});

test("receiver/sw.js routes import to importState", () => {
  const src = readFileSync(new URL("../receiver/sw.js", import.meta.url), "utf8");
  assert.match(src, /import \{ importState \} from "\.\/importer\.js";/);
  assert.match(src, /import: \(req\) => importState\(chrome, req\.state\)/);
  assert.ok(!src.includes("not available yet"));
});

// ---- replacePageState: it runs only in a page, so test that it is self-contained ----

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do",
  "else", "false", "finally", "for", "function", "if", "in", "instanceof", "let", "new", "null", "of",
  "return", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while",
  "undefined", // a read-only global constant
]);
const ALLOWED = new Set([
  "globalThis", "localStorage", "sessionStorage", "indexedDB", "caches", "Response", "atob",
  "Promise", "Object", "JSON", "Error", "Uint8Array",
]);

// A small tokenizer: enough for the plain code of page-state.js (no regular
// expression or template literals there; it refuses a template literal).
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith("//", i)) { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j; continue; }
    if (src.startsWith("/*", i)) { i = src.indexOf("*/", i) + 2; continue; }
    if (c === "`") throw new Error("template literal in page code");
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out.push({ t: "str" });
      i = j + 1;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 100));
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    const num = /^[0-9][\w.]*/.exec(src.slice(i, i + 100));
    if (num) { out.push({ t: "num" }); i += num[0].length; continue; }
    const p = ["...", "?.", "=>"].find((s) => src.startsWith(s, i)) || c;
    out.push({ t: "p", v: p });
    i += p.length;
  }
  return out;
}

function freeNames(src) {
  const tk = tokenize(src);
  const declared = new Set();
  const idsBetween = (from, to) => tk.slice(from, to).filter((x) => x.t === "id").forEach((x) => declared.add(x.v));
  const close = (i) => { // index of the bracket that closes tk[i]
    const open = tk[i].v;
    const shut = { "(": ")", "[": "]", "{": "}" }[open];
    let depth = 0;
    for (let j = i; j < tk.length; j++) {
      if (tk[j].v === open) depth++;
      if (tk[j].v === shut && --depth === 0) return j;
    }
    throw new Error("unbalanced");
  };
  for (let i = 0; i < tk.length; i++) {
    const x = tk[i];
    if (x.t === "id" && ["const", "let", "var"].includes(x.v)) {
      const n = tk[i + 1];
      if (n.t === "id") declared.add(n.v);
      else idsBetween(i + 1, close(i + 1));
    }
    if (x.t === "id" && x.v === "function") {
      let j = i + 1;
      if (tk[j].t === "id") declared.add(tk[j++].v);
      idsBetween(j, close(j));
    }
    if (x.t === "id" && x.v === "catch" && tk[i + 1].v === "(") idsBetween(i + 1, close(i + 1));
    if (x.v === "=>") {
      const prev = tk[i - 1];
      if (prev.t === "id") declared.add(prev.v);
      else if (prev.v === ")") {
        let depth = 0;
        for (let j = i - 1; j >= 0; j--) {
          if (tk[j].v === ")") depth++;
          if (tk[j].v === "(" && --depth === 0) { idsBetween(j, i); break; }
        }
      }
    }
  }
  const free = new Set();
  for (let i = 0; i < tk.length; i++) {
    const x = tk[i];
    if (x.t !== "id" || KEYWORDS.has(x.v) || declared.has(x.v)) continue;
    const prev = tk[i - 1];
    const next = tk[i + 1];
    if (prev && (prev.v === "." || prev.v === "?.")) continue; // a property
    if (next && next.v === ":" && prev && (prev.v === "{" || prev.v === ",")) continue; // an object key
    free.add(x.v);
  }
  return { free, tokens: tk };
}

test("replacePageState is self-contained: no name from outside but page globals and the codec", () => {
  const src = replacePageState.toString();
  assert.match(src, /^async function replacePageState\(json\)/);
  const { free, tokens } = freeNames(src);
  const outside = [...free].filter((n) => !ALLOWED.has(n));
  assert.deepEqual(outside, []);
  // globalThis is used only to read the codec.
  tokens.forEach((x, i) => {
    if (x.t === "id" && x.v === "globalThis") {
      assert.equal(tokens[i + 1].v, ".");
      assert.equal(tokens[i + 2].v, "agentwatchCodec");
    }
  });
  // It compiles on its own, outside this module.
  const fn = new Function("return (" + src + ");")();
  assert.equal(typeof fn, "function");
});

test("the free-name check catches an outside reference", () => {
  const { free } = freeNames("function f(a) { const b = helper(a.x); return { k: b, n: Array.isArray(a) ? 1 : 2 }; }");
  assert.deepEqual([...free].sort(), ["Array", "helper"]);
});

test("page-state.js has no import and exports only replacePageState", async () => {
  const src = readFileSync(new URL("../receiver/page-state.js", import.meta.url), "utf8");
  assert.ok(!/^\s*import\b/m.test(src));
  assert.deepEqual(Object.keys(await import("../receiver/page-state.js")), ["replacePageState"]);
});

test("replacePageState never throws: unreadable input gives zero counts and one fixed error", async () => {
  const r = await replacePageState("{not json " + SECRET);
  assert.deepEqual(r, { local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: ["storage: not readable"] });
});

test("replacePageState without the codec writes nothing and says so", async () => {
  const saved = globalThis.agentwatchCodec;
  delete globalThis.agentwatchCodec;
  try {
    const r = await replacePageState(JSON.stringify({ local: { k: SECRET } }));
    assert.deepEqual(r, { local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: ["storage: codec missing"] });
  } finally {
    if (saved) globalThis.agentwatchCodec = saved;
  }
});
