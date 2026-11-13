// The bridge (contract C10) against the shared vectors (test/vectors/bridge.json),
// wired as agent/sw.js wires it: the fake chrome, the real ReceiverLink and
// the Bridge, with the eager attach and the hold of a new tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Bridge, BRIDGE_VERSION, CONTENT_TYPES, OPS, TARGET_METHODS, WAIT_DEFAULT_MS, WAIT_MAX_MS } from "../agent/bridge.js";
import { attachments } from "../agent/attach.js";
import { HOLD_MAX_MS, HOLD_FORCE_MS } from "../agent/hold.js";
import { ReceiverLink } from "../agent/link.js";
import { mainOps, setScopes } from "../agent/allowlist.js";
import { receiver } from "../agent/receiver.js";
import { NEW_TAB_WAIT_MS } from "../agent/popups.js";
import { REMOVAL_WAIT_MS } from "../agent/removals.js";
import { RESTORE_MAX_MS, TOMBSTONE_MS } from "../agent/tabmap.js";
import { MAX_RESULT, MAX_TO_DAEMON, PART_BYTES, RESULT_PART_BYTES, splitParts } from "../agent/wire.js";
import { makeFakeChrome } from "./fake-chrome.mjs";

const V = JSON.parse(readFileSync(new URL("./vectors/bridge.json", import.meta.url), "utf8"));
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const infoVector = V.requests.find((v) => v.req.op === "bridge.info").res.data;
const NAV = {
  userAgent: infoVector.userAgent,
  userAgentData: {
    getHighEntropyValues: async () => ({ fullVersionList: [{ brand: "Not.A/Brand", version: "99.0.0.0" }, { brand: "Chromium", version: "1.0.0.0" }] }),
  },
};

// Wired as agent/sw.js wires it: the worker's start (the cleanup, the removal of every session rule
// and the restore of the map from its copy) before the native port connects. scopes: the receiver's
// last applied set_scopes (the vector's setScopes by default; null for none). copy: the
// chrome.storage.session copy of the map that the worker restores.
async function setup({ navigator = NAV, scopes = V.setScopes, tabs = [], copy = null } = {}) {
  const f = makeFakeChrome();
  f.manifest = { version: "0.2.0" };
  f.setTabs(tabs);
  if (copy) f.storage_.session = structuredClone(copy);
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (t) => {
    if (t) t.cleared = true;
  };
  const link = new ReceiverLink(f.chrome, { main: mainOps(f.chrome), bridge: (req) => bridge.handle(req) }, { onLinkChange: () => bridge.reset() });
  const bridge = new Bridge(f.chrome, link, { setTimer, clearTimer, navigator });
  await bridge.reset(); // the worker's start
  await receiver(f.chrome).startup();
  link.start();
  const port = () => f.ports.at(-1);
  port().fireMessage({ t: "link", up: true });
  if (scopes) await setScopes(f.chrome, scopes);
  await flush();
  const send = (req) => {
    for (const p of splitParts(req.id, req, PART_BYTES, "bridge")) port().fireMessage(p);
  };
  const resOf = (id) => port().posted.filter((m) => m.t === "res" && m.id === id);
  const answer = async (req) => {
    send(req);
    await flush();
    const got = resOf(req.id);
    assert.equal(got.length, 1, `${req.id}: exactly one res`);
    return got[0];
  };
  const evs = () => port().posted.filter((m) => m.t === "ev");
  const errorOf = (req) => bridge.handle(req).then(() => null, (e) => e.message);
  return { f, link, bridge, timers, port, send, answer, resOf, evs, errorOf, att: attachments(f.chrome), r: receiver(f.chrome) };
}
// Fires every pending fake timer of ms, once.
function fireTimers(s, ms) {
  for (const t of s.timers.filter((x) => x.ms === ms && !x.cleared)) {
    t.cleared = true;
    t.fn();
  }
}
// The chrome calls since mark, without the port's posts.
const callsSince = (f, mark) => f.calls.slice(mark).filter(([p]) => p !== "port.postMessage");
// The CDP commands since mark, as [method, params].
const cmds = (f, mark) => callsSince(f, mark).filter(([p]) => p === "debugger.sendCommand").map(([, a]) => [a[1], a[2]]);

// The vectors hold the per-scope contract (docs/protocol.md, the intro and C10's "Each tab's scope"):
// tabs.create and windows.create take the scope arg, bridge.tabScopes is an op, tabs.remove is the
// receiver's close, and a tab of the orphan set gets not an agent tab. The receiver meets them from
// part 1a (board ab-v16.31) on.
const SCOPED_OPS = new Set(["tabs.create", "windows.create"]);
const scoped = (v) => SCOPED_OPS.has(v.req.op);
const NEW_OPS = new Set(["bridge.tabScopes"]);
const newOp = (v) => NEW_OPS.has(v.req.op);
const PER_SCOPE_REQUESTS = new Set(["tabs.remove"]);
const perScopeRequest = (v) => scoped(v) || PER_SCOPE_REQUESTS.has(v.req.op) || v.perScope === true;
// Tab 13 of the vectors is in the receiver's orphan set: a tab that a sweep item did not close. The
// setup makes it so: tab 13 has scope md-gone in the map (from the copy), and its close fails (no
// target, and the fallback's chrome.tabs.remove is refused) at the vector's setScopes, which gives
// md-gone no list. withAttach: tab 13 is attached first (an attach from before it joined the set).
async function orphanSetup({ withAttach = false, tabs = [] } = {}) {
  const s = await setup({
    scopes: null,
    tabs: [{ id: 7, windowId: 1, url: "https://a.example/" }, { id: 13, windowId: 1, url: "https://a.example/old" }, ...tabs],
    copy: { "tab:13": "md-gone" },
  });
  if (withAttach) assert.equal((await s.answer({ t: "req", id: "attach-13", op: "debugger.attach", args: [13] })).ok, true, "the attach of tab 13");
  s.f.impl["debugger.getTargets"] = async () => [];
  s.f.impl["tabs.remove"] = async (id) => {
    if (id === 13) throw new Error("Tab 13 holds a dialog");
  };
  await setScopes(s.f.chrome, V.setScopes);
  delete s.f.impl["debugger.getTargets"];
  delete s.f.impl["tabs.remove"];
  assert.equal(s.r.map.isOrphan(13), true, "tab 13 is in the orphan set");
  assert.equal(s.r.map.has(13), false, "and not in the map");
  return s;
}

test("the bridge's constants and ops are C10's", () => {
  const K = V.constants;
  assert.equal(BRIDGE_VERSION, K.BRIDGE_VERSION);
  assert.equal(WAIT_DEFAULT_MS, K.WAIT_DEFAULT_MS);
  assert.equal(WAIT_MAX_MS, K.WAIT_MAX_MS);
  assert.equal(MAX_RESULT, K.MAX_RESULT);
  assert.equal(RESULT_PART_BYTES, K.RESULT_PART_BYTES);
  assert.deepEqual(CONTENT_TYPES, V.contentTypes);
  assert.deepEqual(TARGET_METHODS, V.targetMethods, "the Target methods that the relay sends (review-22 B1)");
  assert.deepEqual(Object.keys(OPS).sort(), V.ops.map((o) => o.op).sort(), "the ops of C10 and no other (no cookie op)");
  for (const o of V.ops) {
    const spec = OPS[o.op];
    assert.deepEqual(spec.kinds, o.kinds, o.op);
    assert.equal(spec.required, o.required, o.op);
    assert.equal(spec.wait, K[o.defaultWait], o.op);
    assert.equal(spec.nullResult, o.result === "`null`", o.op);
  }
});

// Each vector in one setup: its chrome call answers the vector's data, and the vector's res comes.
// before(v, s) and during(v, s) prepare a vector and act while its request runs.
async function requestVectors(s, vectors, { before = () => {}, during = async () => {} } = {}) {
  for (const v of vectors) {
    await before(v, s);
    if (v.chrome) s.f.impl[v.chrome[0]] = async () => structuredClone(v.res.data);
    const mark = s.f.calls.length;
    s.send(v.req);
    await flush();
    await during(v, s);
    await flush();
    assert.deepEqual(s.resOf(v.req.id), [v.res], v.req.id);
    if (v.chrome) {
      assert.ok(callsSince(s.f, mark).some(([p, a]) => p === v.chrome[0] && isDeepStrictEqual(a, v.chrome[1])), `${v.req.id}: ${v.chrome[0]}`);
      delete s.f.impl[v.chrome[0]];
    }
  }
}

test("each request vector makes its chrome call and gets the vector's res", async () => {
  const s = await setup({ tabs: [{ id: 7, windowId: 1, url: "https://a.example/" }] });
  await requestVectors(s, V.requests.filter((v) => !newOp(v) && !perScopeRequest(v)));
});

test("bridge.tabScopes is C10's op, and its request vector gets the vector's res: tabs 9 and 12 of the map (restored from the copy)", async () => {
  const o = V.ops.find((x) => x.op === "bridge.tabScopes");
  assert.ok(Object.hasOwn(OPS, o.op), "the receiver has the op");
  assert.deepEqual(OPS[o.op].kinds, o.kinds);
  assert.equal(OPS[o.op].required, o.required);
  assert.equal(OPS[o.op].wait, V.constants[o.defaultWait]);
  const s = await setup({ tabs: [{ id: 9, windowId: 2, url: "about:blank" }, { id: 12, windowId: 2, url: "about:blank" }], copy: { "tab:9": "my-repo", "tab:12": "my-repo" } });
  await requestVectors(s, V.requests.filter(newOp));
});

// tabs.create of tab 8 and windows.create of tab 9 (scope my-repo); tabs.remove of tab 8 by the
// receiver's close (debugger.getTargets gives target D8E9F0 for tab 8; tab 8 is open with tab 7, so
// the window rule opens no about:blank; a tabs.onRemoved of tab 8 comes, as the fake timers never
// fire); debugger.detach, tabs.get and bridge.release of tab 13 of the orphan set.
test("each request vector of the per-scope build: tabs.create and windows.create (the scope arg), tabs.remove (the receiver's close), the allowed ops of the orphan set", async () => {
  const s = await orphanSetup({ withAttach: true, tabs: [{ id: 8, windowId: 1, url: "about:blank" }] });
  s.f.targets_ = [{ id: "D8E9F0", tabId: 8, type: "page", attached: false }];
  await requestVectors(s, V.requests.filter(perScopeRequest), {
    during: async (v) => {
      if (v.req.op === "tabs.remove") {
        assert.deepEqual(s.resOf(v.req.id), [], "the close ends at the tab's tabs.onRemoved");
        assert.equal(s.r.removals.isPending(8), true, "a pending close");
        s.f.chrome.tabs.onRemoved.fire(8, { windowId: 1, isWindowClosing: false });
      }
    },
  });
  assert.ok(!s.f.callsTo("tabs.remove").some(([id]) => id === 8), "no chrome.tabs.remove of tab 8: the receiver's close");
  assert.deepEqual(s.r.map.list(), [{ tabId: 9, scope: "my-repo" }], "tab 8 left the map at its close; tab 9 has its scope");
  assert.deepEqual(s.f.storage_.session, { "tab:9": "my-repo" }, "the copy");
});

async function badRequestVectors(s, vectors) {
  s.att.markRestore(5); // the restore tab of a running import
  for (const v of vectors) {
    const mark = s.f.calls.length;
    assert.deepEqual(await s.answer(v.req), v.res, v.req.id);
    // debugger.attach reads the tab (for its own-origin check) before it acts.
    assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p !== "tabs.get"), [], `${v.req.id}: no chrome call`);
  }
}

const BAD_TABS = [
  { id: 5, windowId: 1, url: "https://a.example/__agentwatch_restore_0123456789abcdef__" },
  { id: 6, windowId: 1, url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html" },
  { id: 9, windowId: 1, url: "https://a.example/b" },
];

test("each bad request vector gets its error, and its op never reaches Chrome", async () =>
  badRequestVectors(await setup({ tabs: [{ id: 7, windowId: 1, url: "https://a.example/" }, ...BAD_TABS] }), V.badRequests.filter((v) => !scoped(v) && !v.perScope)));

// The setup applies the vector's setScopes (md-gone has no list, my-repo has md) and keeps a positive
// tabs.create of my-repo, so a receiver that ignored set_scopes would fail (review-17 L8). Tab 13 is in
// the orphan set.
test("each bad request vector of the per-scope build: tabs.create and windows.create (the scope arg, no list), the orphan set", async () => {
  const s = await orphanSetup({ tabs: BAD_TABS });
  await badRequestVectors(s, V.badRequests.filter((v) => scoped(v) || v.perScope));
  const ok = await s.answer({ t: "req", id: "good", op: "tabs.create", args: [{ url: "about:blank" }, V.scope] });
  assert.equal(ok.ok, true, "a scope with a list gets its tab");
  assert.equal(s.r.map.scopeOf(ok.data.id), V.scope);
});

test("the checks run in C10's order: the op, the args, the wait, the tab", async () => {
  const s = await setup();
  s.att.markRestore(5);
  assert.equal(await s.errorOf({ op: "cookies.getAll", args: "x", wait: 0 }), "unknown op");
  const mark = s.f.calls.length;
  assert.equal(await s.errorOf({ op: ["tabs.get"], args: [7] }), "unknown op", "an op is a string");
  assert.deepEqual(callsSince(s.f, mark), []);
  assert.equal(await s.errorOf({ op: "tabs.remove", args: ["5"], wait: 0 }), "bad args");
  assert.equal(await s.errorOf({ op: "tabs.remove", args: [5], wait: 0 }), "bad wait");
  assert.equal(await s.errorOf({ op: "tabs.remove", args: [5], wait: 10 }), "not an agent tab");
  assert.equal(await s.errorOf({ op: "debugger.sendCommand", args: [{ tabId: 9 }, "Page.enable"], wait: null }), "bad wait");
  assert.equal(await s.errorOf({ op: "debugger.sendCommand", args: [{ tabId: 9 }, "Page.enable"] }), "not attached");
  // The scope comes after the args and the wait: a bad scope is bad args, a scope with no list never reaches Chrome.
  assert.equal(await s.errorOf({ op: "tabs.create", args: [{ url: "about:blank" }, "md-gone"], wait: 0 }), "bad wait");
  assert.equal(await s.errorOf({ op: "tabs.create", args: [{ url: "about:blank" }, "md-gone"] }), "no list for this scope");
});

test("not an agent tab comes before not attached: a command of a tab of the orphan set that is not a bridge tab (vector b42)", async () => {
  const s = await orphanSetup();
  assert.equal(s.att.isBridgeTab(13), false);
  assert.equal(await s.errorOf({ op: "debugger.sendCommand", args: [{ tabId: 13, sessionId: "S1" }, "Runtime.enable"] }), "not an agent tab", "a child session too");
  assert.equal(await s.errorOf({ op: "debugger.detach", args: [13] }), null, "debugger.detach stays allowed");
});

test("the kinds of args: each case fits or gets bad args", async () => {
  const s = await setup({ tabs: [{ id: 1, url: "about:blank" }] });
  const fits = [
    ["debugger.getTargets", undefined],
    ["tabs.create", [{ url: "about:blank", active: true, windowId: 0, index: 2 }, "my-repo"]],
    ["tabs.create", [{ url: "about:blank" }, "my-repo"]],
    ["tabs.query", [{ active: true, anything: [1] }]],
    ["windows.get", [1, { populate: true }]],
    ["windows.create", [{ url: "about:blank", left: -10, top: 0, width: 800, height: 600, state: "normal", focused: false }, "my-repo"]],
    ["windows.create", [{ url: "about:blank" }, "A.b_c-9"]],
    ["windows.update", [1, { state: "maximized" }]],
    ["contentSettings.set", ["camera", { primaryPattern: "*://*.a.example/*", setting: "block" }]],
    ["contentSettings.set", ["clipboard", { primaryPattern: "https://sub.a.example:8443/*", setting: "allow" }]],
    ["contentSettings.set", ["location", { primaryPattern: "http://a.example:65535/*", setting: "allow" }]],
    ["contentSettings.clear", ["automaticDownloads"]],
    ["bridge.attachNew", [false]],
    ["debugger.sendCommand", [{ tabId: 1 }, "Target.setAutoAttach", { autoAttach: true, flatten: true }]],
    ["debugger.sendCommand", [{ tabId: 1 }, "Target.getTargetInfo"]],
    ["debugger.sendCommand", [{ tabId: 1, sessionId: "S1" }, "Target.detachFromTarget", { sessionId: "S2" }]],
    ["debugger.sendCommand", [{ tabId: 1 }, "TargetX.createTarget"]],
  ];
  for (const [op, args] of fits) {
    const req = args === undefined ? { op } : { op, args };
    assert.notEqual(await s.errorOf(req), "bad args", `${op} ${JSON.stringify(args)}`);
  }
  const bad = [
    ["debugger.getTargets", [1]],
    ["debugger.attach", [1.5]],
    ["debugger.attach", {}],
    ["debugger.sendCommand", [{ tabId: 1, sessionId: "" }, "Page.enable"]],
    ["debugger.sendCommand", [{ tabId: 1 }, ""]],
    // Of the Target domain only the methods that the relay sends (review-22 B1).
    ["debugger.sendCommand", [{ tabId: 1 }, "Target.createTarget", { url: "chrome://newtab/" }]],
    ["debugger.sendCommand", [{ tabId: 1, sessionId: "S1" }, "Target.closeTarget", { targetId: "x" }]],
    ["debugger.sendCommand", [{ tabId: 1 }, "Target.getTargets"]],
    ["debugger.sendCommand", [{ tabId: 1 }, "Page.enable", []]],
    ["debugger.sendCommand", [{ tabId: 1 }, "Page.enable", null]],
    // A new tab or window opens at about:blank only, and names its scope (C10).
    ["tabs.create", [{ url: "about:blank" }]],
    ["tabs.create", [{ url: "about:blank#x" }, "my-repo"]],
    ["tabs.create", [{ url: "about:newtab" }, "my-repo"]],
    ["tabs.create", [{ url: "data:text/html,x" }, "my-repo"]],
    ["tabs.create", [{ url: "file:///etc/passwd" }, "my-repo"]],
    ["tabs.create", [{ url: "https:a.example" }, "my-repo"]],
    ["tabs.create", [{ url: "HTTPS://A.example/x?y#z" }, "my-repo"]],
    ["tabs.create", [{ url: "about:blank", windowId: -2 }, "my-repo"]],
    ["tabs.create", [{ url: "about:blank", active: 1 }, "my-repo"]],
    ["tabs.create", [{ url: "about:blank" }, "-ab"]],
    ["tabs.create", [{ url: "about:blank" }, "x".repeat(65)]],
    ["tabs.create", [{ url: "about:blank" }, null]],
    ["tabs.query", [null]],
    ["tabs.update", [1, { active: "yes" }]],
    ["tabs.update", [1, { active: true, muted: true }]],
    ["windows.create", [{ url: "about:blank" }]],
    ["windows.create", [{ url: "http://a.example:8080/" }, "my-repo"]],
    ["windows.create", [{ url: "about:blank", width: "800" }, "my-repo"]],
    ["windows.create", [{ url: "about:blank" }, "my repo"]],
    ["windows.update", [1, { focused: 1 }]],
    ["windows.update", [1, { type: "popup" }]],
    ["contentSettings.set", ["location", { primaryPattern: "https://*.example/*", setting: "allow" }]],
    ["contentSettings.set", ["location", { primaryPattern: "https://a.example/x", setting: "allow" }]],
    ["contentSettings.set", ["location", { primaryPattern: "ftp://a.example/*", setting: "allow" }]],
    ["contentSettings.set", ["location", { primaryPattern: "https://a.example/*", setting: "ask" }]],
    // covers() alone takes these: the host must be a normalized C5 host, and the port 1 to 65535.
    ["contentSettings.set", ["location", { primaryPattern: "https://.a.example/*", setting: "allow" }]],
    ["contentSettings.set", ["location", { primaryPattern: "https://x..a.example/*", setting: "allow" }]],
    ["contentSettings.set", ["location", { primaryPattern: "https://-.a.example/*", setting: "allow" }]],
    ["contentSettings.set", ["location", { primaryPattern: "*://*.a.example:99999/*", setting: "allow" }]],
    ["contentSettings.set", ["location", { primaryPattern: "https://a.example:0/*", setting: "allow" }]],
    ["contentSettings.clear", ["cookies"]],
    ["bridge.attachNew", ["true"]],
    ["bridge.release", []],
  ];
  for (const [op, args] of bad) assert.equal(await s.errorOf({ op, args }), "bad args", `${op} ${JSON.stringify(args)}`);
});

test("contentDetails is checked against the union of the lists of the last applied set_scopes: none before one, a shrink at once", async () => {
  const s = await setup({ scopes: null });
  const req = (host) => ({ op: "contentSettings.set", args: ["location", { primaryPattern: `https://${host}/*`, setting: "allow" }] });
  assert.equal(await s.errorOf(req("a.example")), "bad args", "no set_scopes applied since the worker started");
  // Any list counts, also one that no scope names: the receiver does not know which scope calls.
  await setScopes(s.f.chrome, { lists: { md: ["a.example", "z.example"], other: ["b.example"], unused: ["c.example"] }, scopes: { "md-lead": "md" }, default: null });
  for (const h of ["a.example", "b.example", "c.example", "x.c.example", "z.example"]) assert.equal(await s.errorOf(req(h)), null, h);
  assert.equal(await s.errorOf(req("d.example")), "bad args");
  // A refused list counts not. (md loses z.example, so the workers go, and that fails here.)
  s.f.impl["browsingData.remove"] = async () => {
    throw new Error("busy");
  };
  await assert.rejects(setScopes(s.f.chrome, { lists: { md: ["a.example"], "bad name": ["b.example"] }, scopes: { "md-lead": "md" }, default: null }), /service worker removal failed/);
  assert.equal(await s.errorOf(req("b.example")), "bad args", "the new lists count at once, also when the call then failed");
  assert.equal(await s.errorOf(req("a.example")), null);
  // A set_scopes that is not applied (scopes is not an object) is no reference: the last applied one stays.
  delete s.f.impl["browsingData.remove"];
  await setScopes(s.f.chrome, { lists: { md: ["e.example"] }, scopes: [], default: null });
  assert.equal(await s.errorOf(req("a.example")), null);
  assert.equal(await s.errorOf(req("e.example")), "bad args");
});

test("the wait: each op's default, a request's own wait, and timeout when it runs out; a late result is dropped", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  await s.answer({ t: "req", id: "a", op: "debugger.attach", args: [7] });
  let finish;
  s.f.impl["debugger.sendCommand"] = () => new Promise((r) => (finish = r));
  s.f.impl["tabs.get"] = () => new Promise(() => {});
  const from = s.timers.length;
  s.send({ t: "req", id: "c1", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Runtime.evaluate", { awaitPromise: true }] });
  s.send({ t: "req", id: "g1", op: "tabs.get", args: [7] });
  s.send({ t: "req", id: "g2", op: "tabs.get", args: [7], wait: 1234 });
  await flush();
  assert.deepEqual(s.timers.slice(from).map((t) => t.ms), [WAIT_MAX_MS, WAIT_DEFAULT_MS, 1234]);
  s.timers[from].fn();
  await flush();
  assert.deepEqual(s.resOf("c1"), [{ t: "res", ch: "bridge", id: "c1", ok: false, error: "timeout" }]);
  // The receiver never detaches after a timeout: the relay decides (no detach for awaitPromise, C10).
  assert.deepEqual(s.f.callsTo("debugger.detach"), []);
  assert.equal(s.att.isBridgeTab(7), true);
  finish({ result: { value: 2 } }); // Chrome ends the call later
  await flush();
  assert.equal(s.resOf("c1").length, 1, "never a second res");
  assert.equal(s.resOf("g1").length, 0, "the others still run");
});

test("Chrome's error text is the res's error", async () => {
  const s = await setup();
  assert.deepEqual(await s.answer({ t: "req", id: "e", op: "tabs.get", args: [42] }), { t: "res", ch: "bridge", id: "e", ok: false, error: "No tab with id: 42" });
});

test("the bridge calls Chrome for a request before the next one starts, so CDP commands keep the relay's order", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  await s.answer({ t: "req", id: "a", op: "debugger.attach", args: [7] });
  s.f.impl["debugger.sendCommand"] = () => new Promise(() => {});
  const methods = ["Runtime.enable", "Page.enable", "Runtime.evaluate"];
  methods.forEach((m, i) => s.send({ t: "req", id: "o" + i, op: "debugger.sendCommand", args: [{ tabId: 7 }, m] }));
  // No await yet: each chrome call happened while its last part was handled.
  assert.deepEqual(s.f.callsTo("debugger.sendCommand").map((a) => a[1]), methods);
});

test("debugger.attach: already for a bridge tab; a second attach in flight joins the first; a failure reaches both", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }, { id: 8, url: "https://a.example/" }] });
  let done;
  s.f.impl["debugger.attach"] = () => new Promise((r) => (done = r));
  s.send({ t: "req", id: "a1", op: "debugger.attach", args: [7] });
  await flush();
  s.send({ t: "req", id: "a2", op: "debugger.attach", args: [7] });
  await flush();
  assert.equal(s.f.callsTo("debugger.attach").length, 1);
  assert.equal(s.att.isBridgeTab(7), false, "not a bridge tab before the attach ends");
  done();
  await flush();
  assert.deepEqual([...s.resOf("a1"), ...s.resOf("a2")].map((m) => m.data), [{ already: false }, { already: true }]);
  assert.deepEqual((await s.answer({ t: "req", id: "a3", op: "debugger.attach", args: [7] })).data, { already: true });
  s.f.impl["debugger.attach"] = async () => {
    throw new Error("Cannot access a chrome:// URL");
  };
  s.send({ t: "req", id: "b1", op: "debugger.attach", args: [8] });
  s.send({ t: "req", id: "b2", op: "debugger.attach", args: [8] });
  await flush();
  assert.deepEqual([...s.resOf("b1"), ...s.resOf("b2")].map((m) => m.error), ["Cannot access a chrome:// URL", "Cannot access a chrome:// URL"]);
  assert.equal(s.att.isBridgeTab(8), false);
});

test("debugger.attach refuses a tab of the agent package's own origin, also by its pendingUrl", async () => {
  const own = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
  const s = await setup({ tabs: [{ id: 3, url: "", pendingUrl: own + "x.html" }, { id: 4, url: "chrome-extension://other/x.html" }] });
  assert.equal((await s.answer({ t: "req", id: "o1", op: "debugger.attach", args: [3] })).error, "not an agent tab");
  assert.equal((await s.answer({ t: "req", id: "o2", op: "debugger.attach", args: [4] })).ok, true, "another origin is Chrome's to refuse");
  assert.deepEqual(s.f.callsTo("debugger.attach"), [[{ tabId: 4 }, "1.3"]]);
});

test("debugger.detach: null with no call for a tab that is not a bridge tab; after an attach in flight, it waits and detaches", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  assert.deepEqual(await s.answer({ t: "req", id: "d0", op: "debugger.detach", args: [7] }), { t: "res", ch: "bridge", id: "d0", ok: true, data: null });
  assert.equal(s.f.callsTo("debugger.detach").length, 0);
  let done;
  s.f.impl["debugger.attach"] = () => new Promise((r) => (done = r));
  s.send({ t: "req", id: "a", op: "debugger.attach", args: [7] });
  await flush();
  s.send({ t: "req", id: "d1", op: "debugger.detach", args: [7] }); // the relay detaches after an attach timed out
  await flush();
  assert.equal(s.f.callsTo("debugger.detach").length, 0);
  done();
  await flush();
  assert.deepEqual(s.f.callsTo("debugger.detach"), [[{ tabId: 7 }]]);
  assert.equal(s.att.isBridgeTab(7), false);
  assert.equal((await s.answer({ t: "req", id: "c", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Page.enable"] })).error, "not attached");
});

test("attach and detach of a tab run in arrival order: a detach in the same tick as the attach detaches it", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  s.send({ t: "req", id: "a", op: "debugger.attach", args: [7] });
  s.send({ t: "req", id: "d", op: "debugger.detach", args: [7] }); // the relay pipelines the requests of one tab
  await flush();
  assert.deepEqual(s.resOf("a").map((m) => m.data), [{ already: false }]);
  assert.deepEqual(s.resOf("d").map((m) => m.data), [null]);
  assert.deepEqual(s.f.callsTo("debugger.detach"), [[{ tabId: 7 }]]);
  assert.equal(s.att.isBridgeTab(7), false);
});

test("a link change while the attach reads its tab: no attach, no bridge tab, no answer", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  let give;
  s.f.impl["tabs.get"] = (id) => new Promise((r) => (give = () => r({ id, url: "https://a.example/" })));
  s.send({ t: "req", id: "old", op: "debugger.attach", args: [7] });
  await flush();
  s.port().fireMessage({ t: "link", up: true }); // a new daemon connection
  await flush();
  give();
  await flush();
  assert.deepEqual(s.resOf("old"), []);
  assert.deepEqual(s.f.callsTo("debugger.attach"), [], "the attach belongs to no connection, so it never starts");
  assert.equal(s.att.isBridgeTab(7), false);
});

test("attach, detach, attach: each runs after the one before, and the tab ends attached", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  const done = [];
  s.f.impl["debugger.attach"] = () => new Promise((r) => done.push(r));
  s.send({ t: "req", id: "a1", op: "debugger.attach", args: [7] });
  await flush();
  s.send({ t: "req", id: "d1", op: "debugger.detach", args: [7] }); // the relay's detach after an attach timed out
  s.send({ t: "req", id: "a2", op: "debugger.attach", args: [7] });
  await flush();
  assert.equal(done.length, 1);
  done[0]();
  await flush();
  assert.equal(done.length, 2, "the second attach starts after the detach");
  done[1]();
  await flush();
  assert.deepEqual(["a1", "d1", "a2"].map((id) => s.resOf(id).map((m) => m.data)), [[{ already: false }], [null], [{ already: false }]]);
  assert.deepEqual(s.f.callsTo("debugger.detach"), [[{ tabId: 7 }]]);
  assert.equal(s.att.isBridgeTab(7), true);
});

test("bridge.attachNew turns the eager attach on and off", async () => {
  const s = await setup();
  const on = V.requests.find((v) => v.req.op === "bridge.attachNew").req;
  assert.deepEqual(await s.answer(on), { t: "res", ch: "bridge", id: on.id, ok: true, data: null });
  assert.equal(s.att.attachNew, true);
  assert.deepEqual(await s.answer({ t: "req", id: "off", op: "bridge.attachNew", args: [false] }), { t: "res", ch: "bridge", id: "off", ok: true, data: null });
  assert.equal(s.att.attachNew, false);
});

// ---- events ----

// Fire a vector's chrome event on the fake.
function fire(f, [path, args]) {
  const [api, event] = path.split(".");
  f.chrome[api][event].fire(...structuredClone(args));
}

test("each event vector: the chrome event gives the vector's ev", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  await s.answer({ t: "req", id: "a", op: "debugger.attach", args: [7] });
  await s.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [true] }); // for the two tabs.onCreated vectors
  s.f.impl["debugger.attach"] = async ({ tabId }) => {
    if (tabId === 10) throw new Error("Cannot access a chrome:// URL");
  };
  for (const v of V.eventVectors.filter((x) => x.chrome !== null)) {
    const before = s.evs().length;
    fire(s.f, v.chrome);
    await flush();
    assert.deepEqual(s.evs().slice(before), [v.ev], v.chrome[0]);
  }
});

test("debugger events only for a bridge tab: never for the restore tab or a tab the bridge did not attach", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  await s.answer({ t: "req", id: "a", op: "debugger.attach", args: [7] });
  s.att.markRestore(5);
  const before = s.evs().length;
  s.f.chrome.debugger.onEvent.fire({ tabId: 5 }, "Fetch.requestPaused", { requestId: "r" });
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Page.loadEventFired", {});
  s.f.chrome.debugger.onDetach.fire({ tabId: 9 }, "target_closed");
  s.f.chrome.debugger.onEvent.fire({ tabId: 7 }, "Page.frameNavigated");
  assert.deepEqual(s.evs().slice(before), [{ t: "ev", ch: "bridge", ev: "debugger.onEvent", source: { tabId: 7 }, method: "Page.frameNavigated", params: {} }]);
  s.f.chrome.debugger.onDetach.fire({ tabId: 7 }, "canceled_by_user");
  assert.equal(s.att.isBridgeTab(7), false, "Chrome's detach ends the bridge tab");
  s.f.chrome.debugger.onEvent.fire({ tabId: 7 }, "Page.loadEventFired", {});
  assert.deepEqual(s.evs().slice(before + 1).map((e) => e.ev), ["debugger.onDetach"]);
});

test("tabs.onUpdated only with url, title or status; webNavigation.onErrorOccurred for the main frame only", async () => {
  const s = await setup();
  s.send({ t: "req", id: "i", op: "bridge.info", args: [] });
  await flush();
  s.f.chrome.tabs.onUpdated.fire(7, { audible: true }, { id: 7 });
  s.f.chrome.tabs.onUpdated.fire(7, { favIconUrl: "https://a.example/f.ico" }, { id: 7 });
  s.f.chrome.webNavigation.onErrorOccurred.fire({ tabId: 7, frameId: 3, url: "https://b.example/", error: "net::ERR_BLOCKED_BY_CLIENT" });
  assert.deepEqual(s.evs(), []);
  s.f.chrome.tabs.onUpdated.fire(7, { title: "T" }, { id: 7 });
  assert.deepEqual(s.evs().map((e) => e.changeInfo), [{ title: "T" }]);
});

test("an event above MAX_TO_DAEMON goes as bridge.tooLarge with what the relay needs", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  await s.answer({ t: "req", id: "a", op: "debugger.attach", args: [7] });
  const big = "x".repeat(MAX_TO_DAEMON);
  s.f.chrome.debugger.onEvent.fire({ tabId: 7, sessionId: "A1B2C3" }, "Fetch.requestPaused", { requestId: "interception-job-4.0", request: { postData: big } });
  s.f.chrome.debugger.onEvent.fire({ tabId: 7 }, "Network.webSocketFrameReceived", { requestId: "9", response: { payloadData: big } });
  s.f.chrome.tabs.onUpdated.fire(9, { title: big }, { id: 9, title: big });
  s.f.chrome.tabs.onCreated.fire({ id: 10, pendingUrl: "data:text/html," + big });
  fireTimers(s, NEW_TAB_WAIT_MS); // a tab with no navigation target: its event NEW_TAB_WAIT_MS late (part 1b)
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ sourceTabId: 7, tabId: 11, url: "data:text/html," + big });
  s.f.chrome.downloads.onCreated.fire({ id: 3, url: "data:text/plain," + big });
  const want = V.eventVectors.filter((v) => v.ev.ev === "bridge.tooLarge").map((v) => v.ev);
  const of = (name, method) => want.find((e) => e.of === name && e.method === method);
  assert.deepEqual(s.evs(), [
    of("debugger.onEvent", "Fetch.requestPaused"),
    of("debugger.onEvent", "Network.webSocketFrameReceived"),
    of("tabs.onUpdated"),
    of("tabs.onCreated"),
    of("webNavigation.onCreatedNavigationTarget"),
    of("downloads.onCreated"),
  ]);
  assert.equal(of("downloads.onCreated").tabId, -1, "a download names no tab");
});

// ---- the cleanup ----

test("the cleanup at a link change: the eager attach goes off, every bridge tab and attached target is detached, except the restore tab", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }, { id: 8, url: "https://a.example/" }] });
  await s.answer({ t: "req", id: "a7", op: "debugger.attach", args: [7] });
  await s.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [true] });
  s.att.markRestore(5);
  s.f.targets_ = [
    { id: "T5", tabId: 5, type: "page", attached: true },
    { id: "T6", tabId: 6, type: "page", attached: true }, // attached by a worker before this one
    { id: "T7", tabId: 7, type: "page", attached: true },
    { id: "T8", tabId: 8, type: "page", attached: false },
    { id: "W1", type: "worker", attached: true },
  ];
  s.f.impl["debugger.detach"] = async ({ tabId }) => {
    if (tabId === 6) throw new Error("Debugger is not attached to the tab with id: 6.");
  };
  let finish;
  s.f.impl["tabs.get"] = () => new Promise((r) => (finish = r));
  s.send({ t: "req", id: "slow", op: "tabs.get", args: [8] });
  await flush();
  const mark = s.f.calls.length;
  s.port().fireMessage({ t: "link", up: true }); // a new daemon connection
  await flush();
  assert.equal(s.att.attachNew, false);
  assert.equal(s.att.isBridgeTab(7), false);
  assert.deepEqual(s.f.callsTo("debugger.detach").slice(-2).map(([t]) => t.tabId).sort(), [6, 7]);
  assert.ok(!callsSince(s.f, mark).some(([p, a]) => p === "debugger.detach" && a[0].tabId === 5), "the restore tab keeps the import's attachment");
  finish({ id: 8 });
  await flush();
  assert.deepEqual(s.resOf("slow"), [], "the answer of a request from before the link change is dropped");
});

test("an attach that ends after a link change detaches its tab; a new attach of that tab waits for it", async () => {
  const s = await setup({ tabs: [{ id: 7, url: "https://a.example/" }] });
  const done = [];
  s.f.impl["debugger.attach"] = () => new Promise((r) => done.push(r));
  s.send({ t: "req", id: "old", op: "debugger.attach", args: [7] });
  await flush();
  s.port().fireMessage({ t: "link", up: true });
  await flush();
  s.send({ t: "req", id: "new", op: "debugger.attach", args: [7] });
  await flush();
  assert.equal(done.length, 1, "the new attach waits for the old one");
  done[0]();
  await flush();
  assert.deepEqual(s.f.callsTo("debugger.detach"), [[{ tabId: 7 }]], "the old attach belongs to no connection");
  assert.equal(done.length, 2);
  done[1]();
  await flush();
  assert.deepEqual(s.resOf("old"), []);
  assert.deepEqual(s.resOf("new").map((m) => m.data), [{ already: false }]);
  assert.equal(s.att.isBridgeTab(7), true);
});

test("the cleanup at the worker's start detaches every attached tab; a disconnect runs it too", async () => {
  const f = makeFakeChrome();
  f.targets_ = [{ id: "T4", tabId: 4, type: "page", attached: true }];
  const link = { eventsOpen: () => false, sendEvent: () => {} };
  const bridge = new Bridge(f.chrome, link);
  await bridge.reset();
  assert.deepEqual(f.callsTo("debugger.detach"), [[{ tabId: 4 }]]);
  const s = await setup();
  const mark = s.f.calls.length;
  s.port().fireDisconnect();
  await flush();
  assert.ok(callsSince(s.f, mark).some(([p]) => p === "debugger.getTargets"));
});

// ---- the restore tab and the one module that attaches ----

test("the import marks its restore tab while it runs: the bridge refuses it, and every attach goes through attach.js", async () => {
  const src = (p) => readFileSync(new URL("../agent/" + p, import.meta.url), "utf8");
  for (const file of readdirSync(new URL("../agent/", import.meta.url)).filter((n) => n.endsWith(".js") && n !== "attach.js")) {
    assert.ok(!/debugger\.attach\(/.test(src(file)), `${file} calls no chrome.debugger.attach`);
  }
  const { importState } = await import("../agent/importer.js");
  const s = await setup();
  s.f.impl["tabs.create"] = async (props) => ({ id: 31, ...props });
  let reached;
  const seen = new Promise((r) => (reached = r));
  s.f.impl["debugger.attach"] = async () => {
    reached(await s.errorOf({ op: "tabs.update", args: [31, { active: true }] }));
  };
  const timers = [];
  const imported = importState(s.f.chrome, {
    v: 1, domain: "a.example", origin: "https://a.example", url: "https://a.example/", cookies: [], storage: { local: {}, session: {}, idb: [], caches: [] },
  }, { setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {}, nonce: () => "0123456789abcdef" });
  assert.equal(await seen, "not an agent tab", "during the import, its tab is not an agent tab");
  await imported;
  assert.equal(s.att.isRestoreTab(31), false, "after the import, the tab is a tab like any other");
});

test("bridge.info: the brand Google Chrome first, else Chromium, else an empty fullVersion", async () => {
  const ua = (list) => ({ userAgent: "UA", userAgentData: { getHighEntropyValues: async () => ({ fullVersionList: list }) } });
  const cases = [
    [ua([{ brand: "Chromium", version: "2.0" }, { brand: "Google Chrome", version: "2.1" }]), "2.1"],
    [ua([{ brand: "Chromium", version: "2.0" }]), "2.0"],
    [ua([{ brand: "Other", version: "3.0" }]), ""],
    [{ userAgent: "UA" }, ""],
    [{ userAgent: "UA", userAgentData: { getHighEntropyValues: async () => { throw new Error("no"); } } }, ""],
  ];
  for (const [navigator, want] of cases) {
    const s = await setup({ navigator });
    const res = await s.answer({ t: "req", id: "i", op: "bridge.info", args: [] });
    assert.deepEqual(res.data, { bridge: 1, version: "0.2.0", id: "abcdefghijklmnopabcdefghijklmnop", userAgent: "UA", fullVersion: want });
  }
});

// ---- the eager attach and the hold of a new tab ----

const POPUP = { id: 9, windowId: 1, index: 2, openerTabId: 7, active: true, url: "", pendingUrl: "https://a.example/popup", title: "", status: "loading" };
const HOLD_PATTERNS = [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }];
const paused = (requestId, url = "https://a.example/popup", frameId = "F9") => ({ requestId, request: { url, method: "GET" }, frameId, resourceType: "Document" });
const pauseEv = (tabId, params) => ({ t: "ev", ch: "bridge", ev: "debugger.onEvent", source: { tabId }, method: "Fetch.requestPaused", params });
const holdTimers = (s) => s.timers.filter((t) => t.ms === HOLD_MAX_MS && !t.cleared);

// The eager attach on, and a new tab that it attached and holds. Chrome's
// target of the tab has the id of the tab's top frame ("F" + id, as paused()).
async function heldTab(s, tab = POPUP) {
  s.f.targets_.push({ id: "F" + tab.id, tabId: tab.id, type: "page", attached: false });
  await s.answer({ t: "req", id: "on" + tab.id, op: "bridge.attachNew", args: [true] });
  s.f.chrome.tabs.onCreated.fire(structuredClone(tab));
  await flush();
  assert.deepEqual(s.evs().at(-1), { t: "ev", ch: "bridge", ev: "tabs.onCreated", tab, attached: true, held: true });
}

test("the eager attach: one op of the tab's chain attaches the new tab and starts its hold; the event comes after", async () => {
  const s = await setup();
  assert.equal(HOLD_MAX_MS, V.constants.HOLD_MAX_MS);
  await s.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [true] });
  const mark = s.f.calls.length;
  const before = s.evs().length;
  s.f.chrome.tabs.onCreated.fire(structuredClone(POPUP));
  // All start in the listener: the hold's Fetch.enable does not wait for the
  // attach's answer (measured: the first request leaves a few ms after the
  // event); the targets give the id of the tab's top frame.
  assert.deepEqual(callsSince(s.f, mark), [
    ["debugger.attach", [{ tabId: 9 }, "1.3"]],
    ["debugger.sendCommand", [{ tabId: 9 }, "Fetch.enable", { patterns: HOLD_PATTERNS }]],
    ["debugger.getTargets", []],
  ]);
  assert.equal(s.att.isBridgeTab(9), false, "a bridge tab only once its hold is on");
  await flush();
  assert.equal(callsSince(s.f, mark).length, 3);
  assert.deepEqual(s.evs().slice(before), [{ t: "ev", ch: "bridge", ev: "tabs.onCreated", tab: POPUP, attached: true, held: true }]);
  assert.equal(s.att.isBridgeTab(9), true);
  assert.equal(holdTimers(s).length, 1);
});

test("the eager attach: off, a tab of the agent's own origin, Chrome's refusal, a failed Fetch.enable, the relay first", async () => {
  const own = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html";
  const cases = [
    ["off", { off: true }, { attached: false, held: false }, []],
    ["own origin", { tab: { ...POPUP, pendingUrl: own } }, { attached: false, held: false }, []],
    ["Chrome refuses the attach", { attach: "Cannot access a chrome:// URL" }, { attached: false, held: false, error: "Cannot access a chrome:// URL" }, ["debugger.attach", "debugger.sendCommand", "debugger.getTargets"]],
    ["Fetch.enable fails", { fetch: "No tab with given id 9." }, { attached: true, held: false }, ["debugger.attach", "debugger.sendCommand", "debugger.getTargets"]],
  ];
  for (const [name, c, want, calls] of cases) {
    const s = await setup();
    await s.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [!c.off] });
    if (c.attach) s.f.impl["debugger.attach"] = async () => { throw new Error(c.attach); };
    if (c.fetch) s.f.impl["debugger.sendCommand"] = async () => { throw new Error(c.fetch); };
    const mark = s.f.calls.length;
    const tab = c.tab ?? POPUP;
    s.f.chrome.tabs.onCreated.fire(structuredClone(tab));
    await flush();
    // Off: a tab with no navigation target gets its event NEW_TAB_WAIT_MS late (part 1b).
    if (c.off) fireTimers(s, NEW_TAB_WAIT_MS);
    assert.deepEqual(s.evs().at(-1), { t: "ev", ch: "bridge", ev: "tabs.onCreated", tab, ...want }, name);
    assert.deepEqual(callsSince(s.f, mark).map(([p]) => p), calls, name);
    assert.equal(s.att.isBridgeTab(9), want.attached, name);
    assert.equal(holdTimers(s).length, 0, name);
  }
  // A tab that the relay attached first is a bridge tab with no hold.
  const s = await setup({ tabs: [{ id: 9, url: "https://a.example/" }] });
  await s.answer({ t: "req", id: "a", op: "debugger.attach", args: [9] });
  await s.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [true] });
  const mark = s.f.calls.length;
  s.f.chrome.tabs.onCreated.fire(structuredClone(POPUP));
  await flush();
  assert.deepEqual(s.evs().at(-1), { t: "ev", ch: "bridge", ev: "tabs.onCreated", tab: POPUP, attached: true, held: false });
  assert.deepEqual(callsSince(s.f, mark), []);
});

test("a relay op of a new tab waits for its eager attach: an attach answers already, a command before it is not attached", async () => {
  const s = await setup();
  await s.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [true] });
  let done;
  s.f.impl["debugger.attach"] = () => new Promise((r) => (done = r));
  s.f.chrome.tabs.onCreated.fire(structuredClone(POPUP));
  s.send({ t: "req", id: "a9", op: "debugger.attach", args: [9] });
  assert.equal((await s.answer({ t: "req", id: "c9", op: "debugger.sendCommand", args: [{ tabId: 9 }, "Page.enable"] })).error, "not attached");
  assert.deepEqual(s.resOf("a9"), []);
  done();
  await flush();
  assert.deepEqual(s.resOf("a9").map((m) => m.data), [{ already: true }]);
  assert.equal(s.f.callsTo("debugger.attach").length, 1);
  assert.equal(s.evs().at(-1).held, true);
});

test("a link change during the eager attach: the tab is detached, no hold stays, and no event goes", async () => {
  for (const at of ["attach", "Fetch.enable"]) {
    const s = await setup();
    await s.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [true] });
    let done;
    if (at === "attach") s.f.impl["debugger.attach"] = () => new Promise((r) => (done = r));
    else s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Fetch.enable" ? new Promise((r) => (done = r)) : Promise.resolve({}));
    s.f.chrome.tabs.onCreated.fire(structuredClone(POPUP));
    await flush();
    const before = s.evs().length;
    s.port().fireMessage({ t: "link", up: true });
    await flush();
    done({});
    await flush();
    assert.equal(s.att.isBridgeTab(9), false, at);
    assert.deepEqual(s.f.callsTo("debugger.detach").map(([t]) => t.tabId), [9], at);
    assert.equal(s.evs().length, before, at);
    assert.equal(holdTimers(s).length, 0, at);
  }
});

test("a tab that closes during its eager attach: Chrome's detach before the answers; it is no bridge tab, and the event says so", async () => {
  for (const at of ["attach", "Fetch.enable"]) {
    const s = await setup();
    await s.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [true] });
    let done;
    if (at === "attach") s.f.impl["debugger.attach"] = () => new Promise((r) => (done = r));
    else s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Fetch.enable" ? new Promise((r) => (done = r)) : Promise.resolve({}));
    s.f.chrome.tabs.onCreated.fire(structuredClone(POPUP));
    await flush();
    const before = s.evs().length;
    s.f.chrome.debugger.onDetach.fire({ tabId: 9 }, "target_closed");
    done({});
    await flush();
    assert.deepEqual(s.evs().slice(before), [{ t: "ev", ch: "bridge", ev: "tabs.onCreated", tab: POPUP, attached: false, held: false }], at);
    assert.equal(s.att.isBridgeTab(9), false, at);
    assert.equal(holdTimers(s).length, 0, at);
    assert.deepEqual(s.f.callsTo("debugger.detach"), [], at);
  }
});

test("the hold's own Fetch events never reach the relay; bridge.release continues the held request and ends the hold's Fetch", async () => {
  const s = await setup();
  await heldTab(s);
  const before = s.evs().length;
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  assert.equal(s.evs().length, before, "the hold keeps its request");
  const mark = s.f.calls.length;
  s.send({ t: "req", id: "rel", op: "bridge.release", args: [9] });
  // No await comes before the calls, so they reach Chrome before the relay's next command.
  assert.deepEqual(cmds(s.f, mark), [["Fetch.continueRequest", { requestId: "h1" }], ["Fetch.disable", undefined]]);
  await flush();
  assert.deepEqual(s.resOf("rel").map((m) => m.data), [null]);
  assert.equal(holdTimers(s).length, 0);
  // The hold is over: the tab's Fetch events go to the relay, and a second release calls nothing.
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("c1"));
  assert.deepEqual(s.evs().slice(before), [pauseEv(9, paused("c1"))]);
  const again = s.f.calls.length;
  assert.deepEqual((await s.answer({ t: "req", id: "rel2", op: "bridge.release", args: [9] })).data, null);
  assert.deepEqual(callsSince(s.f, again), []);
});

test("the hold keeps every paused document request of the tab's top frame; a frame's request goes on at once", async () => {
  const s = await setup();
  await heldTab(s);
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  const before = s.evs().length;
  const mark = s.f.calls.length;
  // For example a frame of a page whose own request left before the hold was on.
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("f2", "https://c.example/frame", "F-child"));
  assert.deepEqual(cmds(s.f, mark), [["Fetch.continueRequest", { requestId: "f2" }]]);
  // A second top-level navigation during the hold waits too.
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h3", "https://a.example/second"));
  assert.equal(cmds(s.f, mark).length, 1);
  assert.equal(s.evs().length, before);
  const rel = s.f.calls.length;
  await s.answer({ t: "req", id: "rel", op: "bridge.release", args: [9] });
  assert.deepEqual(cmds(s.f, rel), [
    ["Fetch.continueRequest", { requestId: "h1" }], ["Fetch.continueRequest", { requestId: "h3" }], ["Fetch.disable", undefined],
  ]);
  // Before the targets answer, the top frame is not known: the hold keeps every document request.
  const t = await setup();
  let targets;
  t.f.impl["debugger.getTargets"] = () => new Promise((r) => (targets = r));
  await t.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [true] });
  t.f.chrome.tabs.onCreated.fire(structuredClone(POPUP));
  await flush();
  const m2 = t.f.calls.length;
  t.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("x1", "https://c.example/frame", "F-child"));
  assert.deepEqual(cmds(t.f, m2), []);
  targets([{ id: "F9", tabId: 9, type: "page" }]);
  await flush();
  t.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("x2", "https://c.example/frame", "F-child"));
  assert.deepEqual(cmds(t.f, m2), [["Fetch.continueRequest", { requestId: "x2" }]]);
});

test("while the release runs, the hold continues a request that its Fetch still pauses; after Fetch.disable, events are the relay's", async () => {
  const s = await setup();
  await heldTab(s);
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  let disabled;
  s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Fetch.disable" ? new Promise((r) => (disabled = r)) : Promise.resolve({}));
  s.send({ t: "req", id: "rel", op: "bridge.release", args: [9] });
  const before = s.evs().length;
  const mark = s.f.calls.length;
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h2", "https://a.example/next")); // a redirect
  assert.deepEqual(cmds(s.f, mark), [["Fetch.continueRequest", { requestId: "h2" }]]);
  assert.equal(s.evs().length, before);
  disabled({});
  await flush();
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("c3"));
  assert.deepEqual(s.evs().slice(before), [pauseEv(9, paused("c3"))]);
});

test("a client's Fetch command on the tab during the hold: Fetch.enable gives the held request to the client; Fetch.disable ends the hold", async () => {
  // One FetchHandler serves the tab's session: a client's Fetch.enable replaces
  // the hold's patterns, and a client's Fetch.disable continues every paused
  // request and turns Fetch off.
  const cases = [
    ["Fetch.enable of the tab", [[{ tabId: 9 }, "Fetch.enable", { patterns: [{ urlPattern: "*" }] }]], "relay"],
    ["Fetch.enable of a child session", [[{ tabId: 9, sessionId: "S1" }, "Fetch.enable", {}]], "hold"],
    ["Fetch.enable that failed", [[{ tabId: 9 }, "Fetch.enable", { bad: 1 }]], "hold"],
    ["Fetch.disable of the tab", [[{ tabId: 9 }, "Fetch.disable", {}]], "ended"],
    ["Fetch.enable, then Fetch.disable", [[{ tabId: 9 }, "Fetch.enable", {}], [{ tabId: 9 }, "Fetch.disable", {}]], "ended"],
  ];
  for (const [name, commands, outcome] of cases) {
    const s = await setup();
    await heldTab(s);
    s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
    s.f.impl["debugger.sendCommand"] = async (t, method, params) => {
      if (params && params.bad) throw new Error("Invalid parameters");
      return {};
    };
    for (const [i, args] of commands.entries()) await s.answer({ t: "req", id: "c" + i, op: "debugger.sendCommand", args });
    const before = s.evs().length;
    const mark = s.f.calls.length;
    if (outcome === "relay") s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("c1", "https://a.example/app.js"));
    await s.answer({ t: "req", id: "rel", op: "bridge.release", args: [9] });
    const want = {
      relay: [[], [pauseEv(9, paused("c1", "https://a.example/app.js")), pauseEv(9, paused("h1"))]],
      hold: [[["Fetch.continueRequest", { requestId: "h1" }], ["Fetch.disable", undefined]], []],
      ended: [[], []],
    }[outcome];
    assert.deepEqual([cmds(s.f, mark), s.evs().slice(before)], want, name);
    assert.equal(holdTimers(s).length, 0, name);
  }
});

test("a client's Fetch command in flight when the hold ends: the release waits for its answer", async () => {
  for (const [method, ok, wantCmds, wantEvs] of [
    ["Fetch.enable", true, [], [pauseEv(9, paused("h1"))]],
    ["Fetch.enable", false, [["Fetch.continueRequest", { requestId: "h1" }], ["Fetch.disable", undefined]], []],
    ["Fetch.disable", true, [], []],
  ]) {
    const name = `${method} ${ok ? "answered" : "failed"}`;
    const s = await setup();
    await heldTab(s);
    s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
    let answer;
    s.f.impl["debugger.sendCommand"] = (t, m) => (m === method ? new Promise((res, rej) => (answer = () => (ok ? res({}) : rej(new Error("no"))))) : Promise.resolve({}));
    s.send({ t: "req", id: "c", op: "debugger.sendCommand", args: [{ tabId: 9 }, method, {}] });
    const before = s.evs().length;
    const mark = s.f.calls.length;
    s.send({ t: "req", id: "rel", op: "bridge.release", args: [9] });
    holdTimers(s).forEach((t) => t.fn()); // HOLD_MAX_MS waits too
    await flush();
    assert.deepEqual([cmds(s.f, mark), s.evs().slice(before), s.resOf("rel")], [[], [], []], name);
    answer();
    await flush();
    assert.deepEqual([cmds(s.f, mark), s.evs().slice(before)], [wantCmds, wantEvs], name);
    assert.deepEqual(s.resOf("rel").map((m) => m.data), [null], name);
  }
});

test("a client's Fetch command that never answers: the release forces the finish after HOLD_FORCE_MS", async () => {
  const s = await setup();
  await heldTab(s);
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  s.f.impl["debugger.sendCommand"] = (t, m) => (m === "Fetch.enable" ? new Promise(() => {}) : Promise.resolve({}));
  s.send({ t: "req", id: "c", op: "debugger.sendCommand", args: [{ tabId: 9 }, "Fetch.enable", {}] });
  const mark = s.f.calls.length;
  s.send({ t: "req", id: "rel", op: "bridge.release", args: [9] });
  await flush();
  assert.deepEqual([cmds(s.f, mark), s.resOf("rel")], [[], []], "the release waits for the client's command");
  const force = s.timers.filter((t) => t.ms === HOLD_FORCE_MS && !t.cleared);
  assert.equal(force.length, 1, "one short timer is armed");
  force[0].fn();
  await flush();
  assert.deepEqual(cmds(s.f, mark), [["Fetch.continueRequest", { requestId: "h1" }], ["Fetch.disable", undefined]]);
  assert.deepEqual(s.resOf("rel").map((m) => m.data), [null]);
});

test("HOLD_MAX_MS: the receiver releases a hold itself, so a tab never waits for a relay that does not answer", async () => {
  const s = await setup();
  await heldTab(s);
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  const [timer] = holdTimers(s);
  const mark = s.f.calls.length;
  timer.fn();
  assert.deepEqual(cmds(s.f, mark), [["Fetch.continueRequest", { requestId: "h1" }], ["Fetch.disable", undefined]]);
  await flush();
  const again = s.f.calls.length;
  await s.answer({ t: "req", id: "rel", op: "bridge.release", args: [9] });
  assert.deepEqual(callsSince(s.f, again), [], "the relay's late release finds no hold");
});

test("debugger.detach releases the hold, then detaches, also with a client's Fetch on; Chrome's own detach ends the hold", async () => {
  const s = await setup();
  await heldTab(s);
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  await s.answer({ t: "req", id: "fe", op: "debugger.sendCommand", args: [{ tabId: 9 }, "Fetch.enable", {}] });
  const before = s.evs().length;
  const mark = s.f.calls.length;
  await s.answer({ t: "req", id: "d", op: "debugger.detach", args: [9] });
  assert.deepEqual(callsSince(s.f, mark).map(([p, a]) => (p === "debugger.sendCommand" ? a[1] : p)), ["Fetch.continueRequest", "Fetch.disable", "debugger.detach"]);
  assert.equal(s.evs().length, before, "the relay gets no request of a tab that it detaches");
  assert.equal(holdTimers(s).length, 0);
  await heldTab(s, { ...POPUP, id: 11 });
  s.f.chrome.debugger.onDetach.fire({ tabId: 11 }, "target_closed");
  assert.equal(holdTimers(s).length, 0);
  const again = s.f.calls.length;
  await s.answer({ t: "req", id: "rel", op: "bridge.release", args: [11] });
  assert.deepEqual(callsSince(s.f, again), []);
});

test("the cleanup at a link change releases every hold, also one with a client's Fetch, before it detaches", async () => {
  const s = await setup();
  await heldTab(s);
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  await s.answer({ t: "req", id: "fe", op: "debugger.sendCommand", args: [{ tabId: 9 }, "Fetch.enable", {}] });
  const before = s.evs().length;
  const mark = s.f.calls.length;
  s.port().fireMessage({ t: "link", up: true });
  await flush();
  assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p !== "debugger.getTargets").map(([p, a]) => (p === "debugger.sendCommand" ? a[1] : p)),
    ["Fetch.continueRequest", "Fetch.disable", "debugger.detach"]);
  assert.equal(s.att.attachNew, false);
  assert.equal(s.evs().length, before, "no client is left for the held request");
  assert.equal(holdTimers(s).length, 0);
});

test("the import's restore tab: a new tab's eager attach waits while the import creates it; the restore tab is skipped, the others are held", async () => {
  const { importState } = await import("../agent/importer.js");
  const s = await setup();
  await s.answer({ t: "req", id: "on", op: "bridge.attachNew", args: [true] });
  const other = { id: 32, url: "", pendingUrl: "https://a.example/other" };
  let waited = null;
  s.f.impl["tabs.create"] = async (props) => {
    // Chrome fires tabs.onCreated before tabs.create answers; another tab can come at the same time.
    s.f.chrome.tabs.onCreated.fire({ id: 31, url: "", pendingUrl: "about:blank" });
    s.f.chrome.tabs.onCreated.fire(structuredClone(other));
    await flush();
    waited = { events: s.evs().filter((e) => e.ev === "tabs.onCreated").length, attaches: s.f.callsTo("debugger.attach").length };
    return { id: 31, ...props };
  };
  const timers = [];
  await importState(s.f.chrome, {
    v: 1, domain: "a.example", origin: "https://a.example", url: "https://a.example/", cookies: [], storage: { local: {}, session: {}, idb: [], caches: [] },
  }, { setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {}, nonce: () => "0123456789abcdef" });
  await flush();
  assert.deepEqual(waited, { events: 0, attaches: 0 }, "nothing is attached while the import does not know its tab");
  const created = s.evs().filter((e) => e.ev === "tabs.onCreated");
  assert.deepEqual(created.map((e) => [e.tab.id, e.attached, e.held]), [[31, false, false], [32, true, true]]);
  assert.deepEqual(s.f.callsTo("debugger.attach").map(([t]) => t.tabId).sort(), [31, 32], "the restore tab is attached once: by the import");
  assert.equal(s.att.isBridgeTab(31), false);
});

// ---- the merge guard's floor (C5, C10; board ab-v16.99) ----

const floorOf = (s) => s.f.sessionRules_.find((r) => r.id === 9);
test("bridge.mergeGuard: the floor holds from the worker's start; the op leaves out only the bridge's own tabs; a detach writes the floor before chrome.debugger.detach; a link change takes every tab back before its detaches", async () => {
  const s = await setup({ tabs: [{ id: 7, windowId: 1, url: "https://a.example/" }, { id: 8, windowId: 1, url: "https://a.example/b" }] });
  assert.deepEqual(floorOf(s).condition.requestDomains, ["github.com"], "the floor from the worker's start");
  assert.equal(Object.hasOwn(floorOf(s).condition, "excludedTabIds"), false);
  const att7 = await s.answer({ t: "req", id: "g-a7", op: "debugger.attach", args: [7] });
  assert.equal(att7.ok, true, JSON.stringify(att7));
  const r = await s.answer({ t: "req", id: "g-1", op: "bridge.mergeGuard", args: [{ hosts: ["github-standin.localhost"], tabs: [7, 8] }] });
  assert.deepEqual(r, { t: "res", ch: "bridge", id: "g-1", ok: true, data: null });
  assert.deepEqual([floorOf(s).condition.requestDomains, floorOf(s).condition.excludedTabIds], [["github.com", "github-standin.localhost"], [7]], "tab 8 is no bridge tab: it stays in the floor");
  const mark = s.f.calls.length;
  assert.equal((await s.answer({ t: "req", id: "g-d7", op: "debugger.detach", args: [7] })).ok, true);
  const seq = callsSince(s.f, mark).map(([p]) => p).filter((p) => p === "declarativeNetRequest.updateSessionRules" || p === "debugger.detach");
  assert.deepEqual(seq, ["declarativeNetRequest.updateSessionRules", "debugger.detach"], "the floor first, then the detach");
  assert.equal(Object.hasOwn(floorOf(s).condition, "excludedTabIds"), false);
  // A link change: the floor holds every tab again before any detach.
  assert.equal((await s.answer({ t: "req", id: "g-a8", op: "debugger.attach", args: [8] })).ok, true);
  await s.answer({ t: "req", id: "g-2", op: "bridge.mergeGuard", args: [{ hosts: [], tabs: [8] }] });
  assert.deepEqual(floorOf(s).condition.excludedTabIds, [8]);
  const mark2 = s.f.calls.length;
  s.port().fireMessage({ t: "link", up: true }); // a new daemon connection: a link change
  await flush();
  const seq2 = callsSince(s.f, mark2).map(([p]) => p).filter((p) => p === "declarativeNetRequest.updateSessionRules" || p === "debugger.detach");
  assert.equal(seq2[0], "declarativeNetRequest.updateSessionRules", `the floor before the detaches: ${seq2.join(", ")}`);
  assert.equal(Object.hasOwn(floorOf(s).condition, "excludedTabIds"), false);
});

test("bridge.mergeGuard: Chrome's own detach takes the tab back into the floor; bad args get bad args and change nothing", async () => {
  const s = await setup({ tabs: [{ id: 7, windowId: 1, url: "https://a.example/" }] });
  assert.equal((await s.answer({ t: "req", id: "h-a7", op: "debugger.attach", args: [7] })).ok, true);
  await s.answer({ t: "req", id: "h-1", op: "bridge.mergeGuard", args: [{ hosts: [], tabs: [7] }] });
  assert.deepEqual(floorOf(s).condition.excludedTabIds, [7]);
  s.f.chrome.debugger.onDetach.fire({ tabId: 7 }, "target_closed");
  await flush();
  assert.equal(Object.hasOwn(floorOf(s).condition, "excludedTabIds"), false);
  const before = JSON.stringify(floorOf(s));
  for (const args of [[{ hosts: ["https://github.com"], tabs: [] }], [{ hosts: [], tabs: ["7"] }], [{ hosts: [], tabs: [], all: true }], [{ hosts: Array.from({ length: 17 }, (_, i) => `h${i}.example`), tabs: [] }], []]) {
    assert.equal(await s.errorOf({ t: "req", id: "h-bad", op: "bridge.mergeGuard", args }), "bad args", JSON.stringify(args).slice(0, 60));
  }
  assert.equal(JSON.stringify(floorOf(s)), before);
});
