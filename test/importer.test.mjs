import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importState } from "../agent/importer.js";
import { attachments } from "../agent/attach.js";
import { importRules } from "../agent/dnr.js";
import { receiver } from "../agent/receiver.js";
import { replacePageState } from "../agent/page-state.js";
import { makeFakeChrome as makeFake } from "./fake-chrome.mjs";

// The fake chrome, where a tab of tabs.create has a target: the receiver's close (C10) of the
// restore tab is Target.closeTarget, and the tab's tabs.onRemoved comes.
function makeFakeChrome() {
  const f = makeFake();
  f.trackNewTabs = true;
  return f;
}
// The tabs that the receiver's close closed: by Target.closeTarget (its tab), or by its fallback,
// chrome.tabs.remove.
const closesOf = (f) => [
  ...f.callsTo("debugger.sendCommand").filter((a) => a[1] === "Target.closeTarget").map((a) => a[0].tabId),
  ...f.callsTo("tabs.remove").map((a) => a[0]),
];
// The session rules of the import (C5 rules 6 and 7) that each updateSessionRules call adds or removes.
const ruleCalls = (f) => f.callsTo("declarativeNetRequest.updateSessionRules").map(([d]) => d);

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

// The listeners that the receiver itself keeps on the webNavigation events (C5's guard, guard.js).
const ownListeners = (f) => {
  receiver(f.chrome);
  const n = f.chrome.webNavigation;
  return { onCommitted: n.onCommitted.listeners.slice(), onErrorOccurred: n.onErrorOccurred.listeners.slice() };
};

test("the import follows C6 in order and sums the counts", async () => {
  const f = makeFakeChrome();
  const own = ownListeners(f);
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
    cookies_removed: 2, cookies_set: 2, tabs_closed: 0, local: 1, session: 1,
    idb_databases: 1, idb_records: 1, cache_entries: 0, errors: [],
  });
  assert.deepEqual(Object.keys(result), [
    "cookies_removed", "cookies_set", "tabs_closed", "local", "session", "idb_databases", "idb_records",
    "cache_entries", "errors",
  ]);

  const relevant = f.calls.filter(([p]) => !p.startsWith("runtime.") && !p.startsWith("port."));
  assert.deepEqual(relevant.map(describeCall), [
    "tabs.query", // the removal queue's item
    "tabs.query", // the step's second read: no tab of the origin is open
    "cookies.getAll", "cookies.getAll",
    "cookies.remove", "cookies.remove",
    "cookies.set", "cookies.set",
    "tabs.create",
    "declarativeNetRequest.updateSessionRules",
    "debugger.attach",
    "debugger.sendCommand Network.enable",
    "debugger.sendCommand Network.setBypassServiceWorker",
    "debugger.sendCommand Fetch.enable",
    "tabs.update",
    "debugger.sendCommand Fetch.fulfillRequest",
    "scripting.executeScript files",
    "scripting.executeScript replacePageState",
    "debugger.sendCommand Fetch.disable",
    "debugger.detach",
    "scripting.executeScript func",
    "declarativeNetRequest.updateSessionRules",
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
  // C6: the import's rules allow its domain in the restore tab from before its navigation, and they
  // end after the tab's commit of the site's page (the fake commits state.url after the last script).
  assert.deepEqual(ruleCalls(f), [{ removeRuleIds: [6, 7], addRules: importRules("app.localhost", tabId) }, { removeRuleIds: [6, 7] }]);
  assert.deepEqual(f.sessionRules_, [], "no rule of the import is left");
  assert.deepEqual(f.callsTo("debugger.attach"), [[{ tabId }, "1.3"]]);
  assert.deepEqual(f.callsTo("tabs.update"), [[tabId, { url: R }]]);

  // Chromium applies the bypass only for a client that enabled the Network
  // domain (measured on Chromium 156: without it, a site's service worker
  // answered the restore page).
  const commands = f.callsTo("debugger.sendCommand");
  assert.deepEqual(commands[0], [{ tabId }, "Network.enable", {}]);
  assert.deepEqual(commands[1], [{ tabId }, "Network.setBypassServiceWorker", { bypass: true }]);
  assert.deepEqual(commands[2], [{ tabId }, "Fetch.enable", { patterns: [{ urlPattern: R, requestStage: "Request" }] }]);
  const [target, method, params] = commands[3];
  assert.deepEqual(target, { tabId });
  assert.equal(method, "Fetch.fulfillRequest");
  assert.equal(params.requestId, "rq1");
  assert.equal(params.responseCode, 200);
  assert.deepEqual(params.responseHeaders, [
    { name: "Content-Type", value: "text/html; charset=utf-8" },
    { name: "Cache-Control", value: "no-store" },
  ]);
  assert.equal(Buffer.from(params.body, "base64").toString("utf8"), BODY);
  assert.deepEqual(commands[4], [{ tabId }, "Fetch.disable"]);
  assert.deepEqual(f.callsTo("debugger.detach"), [[{ tabId }]]);

  const execs = f.callsTo("scripting.executeScript").map((a) => a[0]);
  assert.deepEqual(execs[0], { target: { tabId }, files: ["lib/codec.js"] });
  assert.deepEqual(execs[1].target, { tabId });
  assert.equal(execs[1].func, replacePageState);
  assert.equal(execs[1].args.length, 2);
  assert.equal(typeof execs[1].args[0], "string");
  // One JSON string: a null keyPath survives (executeScript drops null-valued properties).
  assert.deepEqual(JSON.parse(execs[1].args[0]), state.storage);
  // The second argument is R, for the page's own restore-page check.
  assert.equal(execs[1].args[1], R);
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
  assert.deepEqual(closesOf(f), []);
  assert.equal(f.chrome.debugger.onEvent.listeners.length, 0);
  assert.equal(f.chrome.webNavigation.onCompleted.listeners.length, 0);
  // The receiver's own listeners stay (C5's guard and the blocked notice: guard.js).
  assert.deepEqual(f.chrome.webNavigation.onCommitted.listeners, own.onCommitted);
  assert.deepEqual(f.chrome.webNavigation.onErrorOccurred.listeners, own.onErrorOccurred);
});

test("every timer of an import is cleared when it ends", async () => {
  const f = makeFakeChrome();
  const timers = fakeTimers();
  await importState(f.chrome, makeState(), opts(timers));
  assert.ok(timers.list.length > 0);
  assert.deepEqual(timers.list.filter((h) => !h.cleared), []);
  // 4 s: the wait for the restore tab's commit, and the end of the import's rules.
  assert.deepEqual([...new Set(timers.list.map((h) => h.ms))].sort((a, b) => a - b), [4000, 20000, 60000, 100000]);
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
    cookies_removed: 0, cookies_set: 1, tabs_closed: 0, local: 2, session: 1, idb_databases: 1, idb_records: 4,
    cache_entries: 3, errors: ["cookie pref: not set", "idb db/s: 1 records skipped"],
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
  // The receiver's close cannot attach either: its fallback removes the tab.
  assert.equal(f.callsTo("tabs.remove").length, 1);
  assert.equal(f.callsTo("debugger.sendCommand").length, 0);
  assert.equal(f.callsTo("tabs.update").length, 0);
  assert.deepEqual(f.sessionRules_, [], "the cleanup removed the import's rules");
});

test("each later step names itself when it fails, and the tab is closed after a detach", async () => {
  // A command that fails; the receiver's close of the restore tab (Target.closeTarget) still closes it.
  const failing = (method) => (f) => {
    f.impl["debugger.sendCommand"] = async (t, m) => {
      if (m === method) throw new Error(SECRET);
      if (m === "Target.closeTarget") f.closeTab(t.tabId);
      return {};
    };
  };
  const cases = [
    ["fetch enable", failing("Fetch.enable")],
    ["fetch enable", failing("Network.setBypassServiceWorker")],
    ["fetch enable", failing("Network.enable")],
    ["restore page", (f) => { f.pageResult = { fatal: "not the restore page" }; }],
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
    assert.deepEqual(closesOf(f), [tabIdOf()], step);
    assert.deepEqual(f.sessionRules_, [], step);
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
    assert.equal(closesOf(f).length, 1);
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
    assert.equal(closesOf(f).length, 1);
    assert.deepEqual(f.sessionRules_, []);
  }
});

test("a navigation error on the restore page rejects with restore page", async () => {
  const f = makeFakeChrome();
  f.impl["tabs.update"] = async (tabId, props) => {
    setTimeout(() => f.chrome.webNavigation.onErrorOccurred.fire({ tabId, frameId: 0, url: props.url, error: "net::ERR_BLOCKED_BY_CLIENT" }), 0);
    return { id: tabId };
  };
  const own = ownListeners(f);
  await rejectsWith(importState(f.chrome, makeState(), opts()), "restore page");
  assert.equal(f.callsTo("debugger.detach").length, 1);
  assert.equal(closesOf(f).length, 1);
  assert.deepEqual(f.chrome.webNavigation.onErrorOccurred.listeners, own.onErrorOccurred);
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
  // The restore tab's commit after the last step ends the rules (autoNavigate is off here).
  f.impl["scripting.executeScript"] = async (inj) => {
    if (inj.func && inj.func.name === "leaveRestorePage") setTimeout(() => f.chrome.webNavigation.onCommitted.fire({ tabId: inj.target.tabId, frameId: 0, url: inj.args[0] }), 0);
    return [{ frameId: 0, result: inj.func && inj.func.name === "replacePageState" ? structuredClone(f.pageResult) : undefined }];
  };
  const result = await importState(f.chrome, makeState(), opts());
  assert.equal(result.errors.length, 0);
  const cmds = f.callsTo("debugger.sendCommand").map((a) => [a[1], a[2] && a[2].requestId]);
  assert.deepEqual(cmds, [
    ["Network.enable", undefined],
    ["Network.setBypassServiceWorker", undefined],
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
  assert.deepEqual(closesOf(f), []);
  f.targets_.push({ id: "T77", tabId: 77, type: "page", attached: false });
  f.created_.set(77, 1);
  resolveCreate({ id: 77 });
  await settle();
  assert.deepEqual(closesOf(f), [77], "the late tab closes in the removal queue, by the receiver's close");
  assert.equal(attachments(f.chrome).isRestoreTab(77), false, "the late tab is no restore tab of a running import");
});

// C10: the eager attach of a new tab waits while this flag is set, so it never
// attaches the restore tab.
test("the import's flag is set from before its tabs.create until it knows the tab's id, also when the create fails or passes its deadline", async () => {
  const f = makeFakeChrome();
  const att = attachments(f.chrome);
  const seen = [];
  f.impl["tabs.create"] = async (props) => {
    seen.push(["create", att.restoreOpening]);
    return { id: 41, ...props };
  };
  f.impl["debugger.attach"] = async ({ tabId }) => {
    seen.push(["attach", att.restoreOpening, att.isRestoreTab(tabId)]);
  };
  assert.equal(att.restoreOpening, false);
  await importState(f.chrome, makeState(), opts());
  assert.deepEqual(seen, [["create", true], ["attach", false, true]], "the tab is marked when the flag clears");
  assert.equal(att.restoreOpening, false);

  const g = makeFakeChrome();
  g.impl["tabs.create"] = async () => {
    throw new Error("no window");
  };
  await rejectsWith(importState(g.chrome, makeState(), opts()), "open tab");
  assert.equal(attachments(g.chrome).restoreOpening, false);

  const h = makeFakeChrome();
  const timers = fakeTimers();
  h.impl["tabs.create"] = () => new Promise(() => {});
  const p = importState(h.chrome, makeState(), opts(timers));
  await settle();
  assert.equal(attachments(h.chrome).restoreOpening, true);
  timers.pending(20000)[0].fn();
  await rejectsWith(p, "open tab");
  assert.equal(attachments(h.chrome).restoreOpening, false);
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
  assert.equal(closesOf(f).length, 1);
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
  assert.equal(closesOf(f).length, 1);
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

test("the origin's tabs close before the cookie swap and before the restore tab opens; only the browser's last window keeps a tab", async () => {
  const f = makeFakeChrome();
  f.setTabs([
    { id: 1, windowId: 1, url: ORIGIN + "/a" },
    { id: 2, windowId: 1, url: "about:blank", pendingUrl: ORIGIN + "/b?q=1" },
    { id: 3, windowId: 2, url: "https://other.localhost/" },
    { id: 4, windowId: 2, url: "http://www.app.localhost/" }, // another origin: another scheme
    { id: 5, windowId: 2, url: "https://app.localhost/" }, // another origin: another host
  ]);
  f.targets_ = [1, 2].map((id) => ({ id: "T" + id, tabId: id, type: "page", attached: false }));
  const result = await importState(f.chrome, makeState(), opts());
  assert.equal(result.tabs_closed, 2);
  assert.deepEqual(f.callsTo("tabs.query"), [[{}], [{}]], "the item's query, then the step's second read");
  // The closes run in the removal queue, by the receiver's close: an attach for the close,
  // Target.closeTarget (no beforeunload), and the tab's tabs.onRemoved.
  const order = f.calls
    .filter(([p, a]) => ["tabs.create", "tabs.remove", "debugger.attach", "cookies.getAll", "cookies.set"].includes(p) || (p === "debugger.sendCommand" && a[1] === "Target.closeTarget"))
    .map(([p, a]) => [p, p.startsWith("cookies.") ? "" : p === "debugger.sendCommand" ? a[2] : a[0]]);
  const restoreTab = f.callsTo("tabs.update")[0][0];
  assert.deepEqual(order, [
    // The window rule (C10): other tabs stay open (in window 2), so window 1 closes with its last tab.
    ["debugger.attach", { tabId: 1 }],
    ["debugger.attach", { tabId: 2 }],
    ["debugger.sendCommand", { targetId: "T1" }],
    ["debugger.sendCommand", { targetId: "T2" }],
    ["cookies.getAll", ""],
    ["cookies.getAll", ""],
    ["cookies.set", ""],
    ["cookies.set", ""],
    ["tabs.create", { url: "about:blank", active: true }],
    ["debugger.attach", { tabId: restoreTab }],
  ]);
});

test("the browser's last window gets an about:blank first", async () => {
  const f = makeFakeChrome();
  f.setTabs([{ id: 1, windowId: 3, url: ORIGIN + "/a" }, { id: 2, windowId: 3, url: ORIGIN + "/b" }]);
  f.targets_ = [1, 2].map((id) => ({ id: "T" + id, tabId: id, type: "page", attached: false }));
  const result = await importState(f.chrome, makeState(), opts());
  assert.equal(result.tabs_closed, 2);
  assert.deepEqual(f.callsTo("tabs.create")[0], [{ windowId: 3, url: "about:blank", active: false }]);
  const order = f.calls.map(([p, a]) => (p === "debugger.sendCommand" ? a[1] : p));
  assert.ok(order.indexOf("tabs.create") < order.indexOf("Target.closeTarget"));
});

test("a window with other tabs gets no about:blank; a tab already gone does not count", async () => {
  const f = makeFakeChrome();
  f.setTabs([
    { id: 1, windowId: 1, url: ORIGIN + "/a" },
    { id: 2, windowId: 1, url: ORIGIN + "/b" },
    { id: 3, windowId: 1, url: "https://other.localhost/" },
  ]);
  // Tab 2 closed by itself after the item's query: it has no target, and the fallback finds no tab.
  // It does not count, and the step's second read finds no tab of the origin open.
  f.targets_ = [{ id: "T1", tabId: 1, type: "page", attached: false }];
  f.impl["tabs.remove"] = async (id) => {
    if (id === 2) {
      f.tabs_ = f.tabs_.filter((t) => t.id !== 2);
      throw new Error("No tab with id: 2.");
    }
  };
  const result = await importState(f.chrome, makeState(), opts());
  assert.equal(result.tabs_closed, 1);
  assert.deepEqual(f.callsTo("tabs.create").map((a) => a[0]), [{ url: "about:blank", active: true }]);
});

test("a window rule that fails closes no tab of the origin and fails close tabs", async () => {
  const f = makeFakeChrome();
  f.setTabs([{ id: 1, windowId: 1, url: ORIGIN + "/a" }]);
  f.impl["tabs.create"] = async () => {
    throw new Error("no window");
  };
  await rejectsWith(importState(f.chrome, makeState(), opts()), "close tabs");
  assert.deepEqual(closesOf(f), []);
  assert.equal(f.callsTo("cookies.getAll").length, 0, "no cookie swap while a page of the origin is open");
});

// review-20 note 5 (C6 step 1): a close that has not ended at the end of the item's wait (a page that a
// dialog holds) fails the step: no cookie swap while a page of the origin can still write a cookie.
// review-20b (probe N2, C6 step 1): a close can end with an error and leave the tab open (the attach
// fails, and the fallback's chrome.tabs.remove is refused). The step reads the tabs again after the
// item and fails while a tab of the origin is open: no cookie swap, and no ok with tabs_closed 0.
test("a close of the origin's tab that ends with an error and leaves the tab open fails close tabs", { timeout: 5000 }, async () => {
  const f = makeFakeChrome();
  f.setTabs([{ id: 1, windowId: 1, url: ORIGIN + "/a" }, { id: 3, windowId: 1, url: "https://other.localhost/" }]);
  f.impl["debugger.attach"] = async () => {
    throw new Error("Another debugger is already attached to the tab");
  };
  f.impl["tabs.remove"] = async () => {
    throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
  };
  await rejectsWith(importState(f.chrome, makeState(), opts()), "close tabs");
  assert.equal(f.callsTo("cookies.getAll").length, 0, "no cookie swap");
  assert.deepEqual(f.callsTo("tabs.query"), [[{}], [{}]], "the item's query, then the step's second read");
});

test("a close of the origin's tab that has not ended in the item's wait fails close tabs", { timeout: 5000 }, async () => {
  const { receiver } = await import("../agent/receiver.js");
  const { REMOVAL_WAIT_MS } = await import("../agent/removals.js");
  const f = makeFakeChrome();
  f.setTabs([{ id: 1, windowId: 1, url: ORIGIN + "/a" }, { id: 3, windowId: 1, url: "https://other.localhost/" }]);
  f.targets_ = [{ id: "T1", tabId: 1, type: "page", attached: false }];
  f.impl["debugger.sendCommand"] = async () => ({}); // the command answers; no tabs.onRemoved comes
  const qt = fakeTimers();
  Object.assign(receiver(f.chrome).clock, { setTimer: qt.setTimer, clearTimer: qt.clearTimer });
  const p = importState(f.chrome, makeState(), opts());
  for (let i = 0; i < 50 && qt.pending(REMOVAL_WAIT_MS).length === 0; i++) await settle(1);
  qt.pending(REMOVAL_WAIT_MS).forEach((h) => h.fn());
  await rejectsWith(p, "close tabs");
  assert.equal(f.callsTo("cookies.getAll").length, 0);
});

// The import's finding (board ab-v16.31, from PR #53): a send to a domain on no list is normal (ab-dm6:
// a sent site joins no list). The import's rules let the restore page and the site's page load in the
// restore tab with no list, so the import answers ok after it set the cookies.
test("an import of a domain on no list loads under the import's rules and answers ok; the rules end at the tab's first commit after the last step, at most 4 s later", async () => {
  const f = makeFakeChrome();
  f.autoNavigate = true;
  const timers = fakeTimers();
  const p = importState(f.chrome, makeState(), opts(timers));
  const result = await p;
  assert.equal(result.cookies_set, 2);
  const tabId = f.callsTo("tabs.update")[0][0];
  const order = f.calls.map(([path, a]) => (path === "declarativeNetRequest.updateSessionRules" ? (a[0].addRules ? "rules on" : "rules off") : path)).filter((x) => ["rules on", "rules off", "tabs.create", "tabs.update", "scripting.executeScript"].includes(x));
  assert.deepEqual(order, ["tabs.create", "rules on", "tabs.update", "scripting.executeScript", "scripting.executeScript", "scripting.executeScript", "rules off"]);
  assert.deepEqual(importRules("app.localhost", tabId).map((r) => r.condition.tabIds), [[tabId], [tabId]], "the restore tab only");
  // No commit comes: the rules end after RULES_END_MS anyway.
  const g = makeFakeChrome();
  g.autoNavigate = false;
  g.impl["tabs.update"] = async (id, props) => {
    g.pauseRequest(id, props.url);
    return { id, ...props };
  };
  const t2 = fakeTimers();
  const q = importState(g.chrome, makeState(), opts(t2));
  for (let i = 0; i < 50 && t2.pending(4000).length === 0; i++) await settle(1);
  assert.equal(ruleCalls(g).length, 1, "the rules wait for the commit");
  t2.pending(4000)[0].fn();
  await q;
  assert.deepEqual(ruleCalls(g).at(-1), { removeRuleIds: [6, 7] });
});

test("a failed end of the import's rules fails the import and closes its tab", async () => {
  const f = makeFakeChrome();
  let n = 0;
  f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    n += 1;
    if (!d.addRules) throw new Error("busy");
  };
  await rejectsWith(importState(f.chrome, makeState(), opts()), "end rules");
  assert.equal(closesOf(f).length, 1);
  assert.equal(n, 2, "no second removal in the cleanup: the budget of 112 s");
});

test("a tab query that fails rejects with close tabs and opens no restore tab", async () => {
  const f = makeFakeChrome();
  f.impl["tabs.query"] = async () => {
    throw new Error(SECRET);
  };
  await rejectsWith(importState(f.chrome, makeState(), opts()), "close tabs");
  assert.equal(f.callsTo("tabs.create").length, 0);
});

test("the write storage step has 60 s; the other steps 20 s", async () => {
  const f = makeFakeChrome();
  const timers = fakeTimers();
  f.impl["scripting.executeScript"] = (inj) => (inj.args ? new Promise(() => {}) : Promise.resolve([{ result: undefined }]));
  const p = importState(f.chrome, makeState(), opts(timers));
  await settle();
  assert.equal(f.callsTo("scripting.executeScript").length, 2);
  assert.deepEqual(timers.pending(20000), []);
  const [writeTimer] = timers.pending(60000);
  assert.ok(writeTimer);
  assert.equal(timers.pending(100000).length, 1);
  writeTimer.fn();
  await rejectsWith(p, "write storage");
  assert.equal(f.callsTo("debugger.detach").length, 1);
  assert.equal(closesOf(f).length, 1);
});

test("after the cookies step times out, its background work stops", async () => {
  const f = makeFakeChrome();
  const timers = fakeTimers();
  let release;
  const gate = new Promise((r) => (release = r));
  f.impl["cookies.set"] = async (d) => {
    await gate;
    return { ...d };
  };
  const p = importState(f.chrome, makeState(), opts(timers));
  await settle();
  assert.equal(f.callsTo("cookies.set").length, 1);
  const [cookieTimer] = timers.pending(20000);
  cookieTimer.fn();
  await rejectsWith(p, "cookies");
  release();
  await settle();
  assert.equal(f.callsTo("cookies.set").length, 1);
  // The tabs closed before the cookies (M7); no later step runs.
  assert.equal(f.callsTo("tabs.query").length, 2);
  assert.equal(f.callsTo("tabs.create").length, 0);
});

test("after a timeout during cookie removal, no further removal or set happens", async () => {
  const f = makeFakeChrome();
  const timers = fakeTimers();
  f.cookies_ = [
    { name: "a", value: SECRET, domain: "app.localhost", hostOnly: true, path: "/", secure: true },
    { name: "b", value: SECRET, domain: "app.localhost", hostOnly: true, path: "/", secure: true },
  ];
  let release;
  const gate = new Promise((r) => (release = r));
  f.impl["cookies.remove"] = async (d) => {
    await gate;
    return { ...d };
  };
  const p = importState(f.chrome, makeState(), opts(timers));
  await settle();
  timers.pending(20000)[0].fn();
  await rejectsWith(p, "cookies");
  release();
  await settle();
  assert.equal(f.callsTo("cookies.remove").length, 1);
  assert.equal(f.callsTo("cookies.set").length, 0);
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

test("agent/sw.js routes import to importState (the main ops of allowlist.js)", () => {
  const sw = readFileSync(new URL("../agent/sw.js", import.meta.url), "utf8");
  assert.match(sw, /main: mainOps\(chrome\)/);
  const src = readFileSync(new URL("../agent/allowlist.js", import.meta.url), "utf8");
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
  "document", "location", "setTimeout", // the restore-page check; the grace for a blocked delete
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
  assert.match(src, /^async function replacePageState\(json, expectedUrl\)/);
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
  const src = readFileSync(new URL("../agent/page-state.js", import.meta.url), "utf8");
  assert.ok(!/^\s*import\b/m.test(src));
  assert.deepEqual(Object.keys(await import("../agent/page-state.js")), ["replacePageState"]);
});

const realSetTimeout = globalThis.setTimeout;
// The page's grace timer, recorded and shortened (3000 ms -> 40 ms).
function graceTimer(graces) {
  return (fn, ms) => {
    graces.push(ms);
    return realSetTimeout(fn, ms === 3000 ? 40 : ms);
  };
}

// Run fn with page globals replaced (own properties of globalThis), then restore them.
async function withPage(globals, fn) {
  const saved = {};
  for (const k of Object.keys(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: globals[k], configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(globals)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  }
}

function restorePage(over = {}) {
  const touched = [];
  const storage = (name) => ({
    clear: () => touched.push(name + ".clear"),
    setItem: () => touched.push(name + ".setItem"),
  });
  return {
    touched,
    globals: {
      document: { title: "agentwatch", scripts: [] },
      location: { href: R },
      localStorage: storage("localStorage"),
      sessionStorage: storage("sessionStorage"),
      indexedDB: {
        databases: async () => (touched.push("indexedDB.databases"), []),
        deleteDatabase: () => (touched.push("indexedDB.deleteDatabase"), {}),
        open: () => (touched.push("indexedDB.open"), {}),
      },
      caches: { keys: async () => (touched.push("caches.keys"), []), delete: async () => touched.push("caches.delete") },
      agentwatchCodec: { decode: () => null },
      ...over,
    },
  };
}

test("replacePageState touches nothing off the restore page", async () => {
  const json = JSON.stringify({ local: { k: SECRET }, session: {}, idb: [], caches: [] });
  const cases = [
    { document: { title: "Example", scripts: [] } },
    { document: { title: "agentwatch", scripts: [{}] } },
    { location: { href: ORIGIN + "/" } },
    { document: undefined },
  ];
  for (const over of cases) {
    const page = restorePage(over);
    const r = await withPage(page.globals, () => replacePageState(json, R));
    assert.deepEqual(r, { fatal: "not the restore page" });
    assert.deepEqual(page.touched, []);
  }
  // A missing expected URL fails the check too.
  const page = restorePage();
  assert.deepEqual(await withPage(page.globals, () => replacePageState(json)), { fatal: "not the restore page" });
  assert.deepEqual(page.touched, []);
});

test("replacePageState on the restore page clears, then writes", async () => {
  const page = restorePage();
  const r = await withPage(page.globals, () =>
    replacePageState(JSON.stringify({ local: { k: SECRET }, session: { s: SECRET }, idb: [], caches: [] }), R));
  assert.deepEqual(r, { local: 1, session: 1, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] });
  assert.deepEqual(page.touched, [
    "localStorage.clear", "sessionStorage.clear", "indexedDB.databases", "caches.keys",
    "localStorage.setItem", "sessionStorage.setItem",
  ]);
});

test("replacePageState: a delete still blocked after the grace is reported and the import goes on", async () => {
  const requests = [];
  const graces = [];
  const page = restorePage({
    setTimeout: graceTimer(graces),
    indexedDB: {
      databases: async () => [{ name: "held", version: 1 }, { name: "free", version: 1 }],
      deleteDatabase: (name) => {
        const r = { name };
        requests.push(r);
        realSetTimeout(() => (name === "held" ? r.onblocked() : r.onsuccess()), 0);
        return r;
      },
      open: () => {
        throw new Error("no open expected");
      },
    },
  });
  const r = await withPage(page.globals, () =>
    replacePageState(JSON.stringify({ local: { k: "v" }, session: {}, idb: [{ name: "held", version: 1, stores: [] }], caches: [] }), R));
  assert.deepEqual(requests.map((x) => x.name), ["held", "free"]);
  assert.deepEqual(graces, [3000]);
  assert.deepEqual(r, {
    local: 1, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0,
    errors: ["idb held: not replaced (in use)"],
  });
});

test("replacePageState: a delete blocked for a moment that then succeeds is no error", async () => {
  const graces = [];
  const page = restorePage({
    setTimeout: graceTimer(graces),
    indexedDB: {
      databases: async () => [{ name: "slow", version: 1 }],
      deleteDatabase: () => {
        const r = {};
        realSetTimeout(() => r.onblocked(), 0);
        realSetTimeout(() => r.onsuccess(), 10);
        return r;
      },
      open: () => {
        throw new Error("no open expected");
      },
    },
  });
  const r = await withPage(page.globals, () => replacePageState(JSON.stringify({ local: {}, session: {}, idb: [], caches: [] }), R));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(graces, [3000]);
});

test("replacePageState never throws: unreadable input gives zero counts and one fixed error", async () => {
  const page = restorePage();
  const r = await withPage(page.globals, () => replacePageState("{not json " + SECRET, R));
  assert.deepEqual(r, { local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: ["storage: not readable"] });
  assert.deepEqual(page.touched, []);
});

test("replacePageState without the codec writes nothing and says so", async () => {
  const page = restorePage({ agentwatchCodec: undefined });
  const r = await withPage(page.globals, () => replacePageState(JSON.stringify({ local: { k: SECRET } }), R));
  assert.deepEqual(r, { local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: ["storage: codec missing"] });
  assert.deepEqual(page.touched, []);
});
