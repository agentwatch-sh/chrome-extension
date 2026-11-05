// The bridge (contract C10) against the shared vectors (test/vectors/bridge.json),
// wired as agent/sw.js wires it: the fake chrome, the real ReceiverLink and
// the Bridge, with the eager attach and the hold of a new tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Bridge, BRIDGE_VERSION, CONTENT_TYPES, OPS, WAIT_DEFAULT_MS, WAIT_MAX_MS } from "../agent/bridge.js";
import { attachments } from "../agent/attach.js";
import { HOLD_MAX_MS, HOLD_FORCE_MS } from "../agent/hold.js";
import { ReceiverLink } from "../agent/link.js";
import { applyAllowlist } from "../agent/dnr.js";
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

async function setup({ navigator = NAV, allowlist = V.allowlist, tabs = [] } = {}) {
  const f = makeFakeChrome();
  f.manifest = { version: "0.2.0" };
  f.setTabs(tabs);
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (t) => {
    if (t) t.cleared = true;
  };
  const link = new ReceiverLink(f.chrome, { main: {}, bridge: (req) => bridge.handle(req) }, { onLinkChange: () => bridge.reset() });
  const bridge = new Bridge(f.chrome, link, { setTimer, clearTimer, navigator });
  await bridge.reset(); // the worker's start
  link.start();
  const port = () => f.ports.at(-1);
  port().fireMessage({ t: "link", up: true });
  if (allowlist) await applyAllowlist(f.chrome, allowlist);
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
  return { f, link, bridge, timers, port, send, answer, resOf, evs, errorOf, att: attachments(f.chrome) };
}
// The chrome calls since mark, without the port's posts.
const callsSince = (f, mark) => f.calls.slice(mark).filter(([p]) => p !== "port.postMessage");
// The CDP commands since mark, as [method, params].
const cmds = (f, mark) => callsSince(f, mark).filter(([p]) => p === "debugger.sendCommand").map(([, a]) => [a[1], a[2]]);

// Since board ab-v16.30 the vectors hold the per-scope contract (docs/protocol.md, the intro and
// C10's "Each tab's scope"): tabs.create and windows.create take the scope arg. The receiver meets
// that from part 1a (board ab-v16.31) on. Until then the vectors of these two ops run as todo tests:
// they report, and they do not fail the run. When OPS gives tabs.create the kind scope, PENDING_1A
// is false and they are plain tests. Part 1a then removes PENDING_1A, and it also changes the
// one-arg tabs.create and windows.create cases of the kinds test below.
const PENDING_1A = OPS["tabs.create"].kinds.includes("scope") ? false : "board ab-v16.31 (part 1a): tabs.create and windows.create take the scope arg";
const SCOPED_OPS = new Set(["tabs.create", "windows.create"]);
const scoped = (v) => SCOPED_OPS.has(v.req.op);
// Since board ab-v16.41 the vectors also hold the op bridge.tabScopes (C10, the orphan-tabs rules), which the
// receiver gets in part 1a too. Until then its vectors run as todo tests in the same way: when OPS has the op,
// PENDING_TAB_SCOPES is false. Part 1a then removes PENDING_TAB_SCOPES, and its test puts the vector's tabs
// (9 and 12, scope ab-lead) into the map first.
// The no-list vectors (b38 to b40, no list for this scope) are scoped ones. Today's setup applies no setScopes,
// so they would also pass for a receiver that ignores it: part 1a's setup must apply the vector's setScopes,
// and keep a positive tabs.create of a scope with a list (ab-lead) in the same setup (review-17 L8).
// The request vector of tabs.remove holds the receiver's close of the per-scope build (Target.closeTarget
// through chrome.debugger, board ab-v16.41): it runs with the scoped ones, under PENDING_1A. Part 1a's setup
// for it: debugger.getTargets gives the target id D8E9F0 for tab 8, tab 8 is open with one other tab (so the
// window rule opens no about:blank), and a tabs.onRemoved of tab 8 comes (the fake timers never fire, so the
// item would wait for ever). Until part 1a the plain test runs the same vector with today's chrome call,
// its chromeToday (chrome.tabs.remove), so today's good path of the op keeps a plain test (review-17b N5).
// The bad request vectors with "perScope": true (b41 to b44: an op of a tab of the orphan set gets not an agent
// tab) run with the scoped ones too. Part 1a's setup for them puts tab 13 into the receiver's orphan set.
// The request vectors with "perScope": true (board ab-v16.48, review-17f note 7: debugger.detach, tabs.get and
// bridge.release of tab 13 stay allowed) run with the scoped ones under PENDING_1A, with the same setup of tab 13.
// Today's receiver has no orphan set and meets them too, so until part 1a the plain test runs them as well.
// Tab 13 of the debugger.detach vector ("bridgeTab": true) is still a bridge tab: requestVectors attaches it first, and
// part 1a's setup attaches it before it puts the tab into the orphan set.
const PENDING_TAB_SCOPES = Object.hasOwn(OPS, "bridge.tabScopes") ? false : "board ab-v16.31 (part 1a): the op bridge.tabScopes";
const NEW_OPS = new Set(["bridge.tabScopes"]);
const newOp = (v) => NEW_OPS.has(v.req.op);
const PER_SCOPE_REQUESTS = new Set(["tabs.remove"]);
const perScopeRequest = (v) => scoped(v) || PER_SCOPE_REQUESTS.has(v.req.op) || v.perScope === true;

test("the bridge's constants and ops are C10's", () => {
  const K = V.constants;
  assert.equal(BRIDGE_VERSION, K.BRIDGE_VERSION);
  assert.equal(WAIT_DEFAULT_MS, K.WAIT_DEFAULT_MS);
  assert.equal(WAIT_MAX_MS, K.WAIT_MAX_MS);
  assert.equal(MAX_RESULT, K.MAX_RESULT);
  assert.equal(RESULT_PART_BYTES, K.RESULT_PART_BYTES);
  assert.deepEqual(CONTENT_TYPES, V.contentTypes);
  const known = V.ops.filter((o) => !(PENDING_TAB_SCOPES && NEW_OPS.has(o.op)));
  assert.deepEqual(Object.keys(OPS).sort(), known.map((o) => o.op).sort(), "the ops of C10 and no other (no cookie op)");
  for (const o of known.filter((x) => !SCOPED_OPS.has(x.op))) {
    const spec = OPS[o.op];
    assert.deepEqual(spec.kinds, o.kinds, o.op);
    assert.equal(spec.required, o.required, o.op);
    assert.equal(spec.wait, K[o.defaultWait], o.op);
    assert.equal(spec.nullResult, o.result === "`null`", o.op);
  }
});

test("tabs.create and windows.create are C10's: the scope arg", { todo: PENDING_1A }, () => {
  for (const o of V.ops.filter((x) => SCOPED_OPS.has(x.op))) {
    const spec = OPS[o.op];
    assert.deepEqual(spec.kinds, o.kinds, o.op);
    assert.equal(spec.required, o.required, o.op);
  }
});

async function requestVectors(vectors) {
  const s = await setup({ tabs: [{ id: 7, windowId: 1, url: "https://a.example/" }, { id: 13, windowId: 1, url: "https://a.example/old" }] });
  // A vector with "bridgeTab": true needs its tab attached first: tab 13's attach from before it joined the orphan set.
  for (const tabId of new Set(vectors.filter((v) => v.bridgeTab).map((v) => v.req.args[0]))) {
    assert.equal((await s.answer({ t: "req", id: `attach-${tabId}`, op: "debugger.attach", args: [tabId] })).ok, true, `the attach of tab ${tabId} before its vectors`);
  }
  for (const v of vectors) {
    if (v.chrome) s.f.impl[v.chrome[0]] = async () => structuredClone(v.res.data);
    const mark = s.f.calls.length;
    assert.deepEqual(await s.answer(v.req), v.res, v.req.id);
    if (v.chrome) {
      assert.ok(callsSince(s.f, mark).some(([p, a]) => p === v.chrome[0] && isDeepStrictEqual(a, v.chrome[1])), `${v.req.id}: ${v.chrome[0]}`);
      delete s.f.impl[v.chrome[0]];
    }
  }
}

const today = (v) => (PENDING_1A && v.chromeToday ? { ...v, chrome: v.chromeToday } : v);
test("each request vector makes its chrome call and gets the vector's res", () =>
  requestVectors(V.requests.filter((v) => !scoped(v) && !newOp(v) && (PENDING_1A ? true : !perScopeRequest(v))).map(today)));

test("bridge.tabScopes is C10's op, and its request vector gets the vector's res", { todo: PENDING_TAB_SCOPES }, async () => {
  const o = V.ops.find((x) => x.op === "bridge.tabScopes");
  assert.ok(Object.hasOwn(OPS, o.op), "the receiver has the op");
  assert.deepEqual(OPS[o.op].kinds, o.kinds);
  assert.equal(OPS[o.op].required, o.required);
  assert.equal(OPS[o.op].wait, V.constants[o.defaultWait]);
  await requestVectors(V.requests.filter(newOp));
});

test("each request vector of the per-scope build: tabs.create and windows.create (the scope arg), tabs.remove (the receiver's close), the allowed ops of the orphan set", { todo: PENDING_1A }, () => requestVectors(V.requests.filter(perScopeRequest)));

async function badRequestVectors(vectors) {
  const s = await setup({
    tabs: [
      { id: 5, windowId: 1, url: "https://a.example/__agentwatch_restore_0123456789abcdef__" },
      { id: 6, windowId: 1, url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html" },
      { id: 7, windowId: 1, url: "https://a.example/" },
      { id: 9, windowId: 1, url: "https://a.example/b" },
    ],
  });
  s.att.markRestore(5); // the restore tab of a running import
  for (const v of vectors) {
    const mark = s.f.calls.length;
    assert.deepEqual(await s.answer(v.req), v.res, v.req.id);
    // debugger.attach reads the tab (for its own-origin check) before it acts.
    assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p !== "tabs.get"), [], `${v.req.id}: no chrome call`);
  }
}

test("each bad request vector gets its error, and its op never reaches Chrome", () => badRequestVectors(V.badRequests.filter((v) => !scoped(v) && !v.perScope)));

test("each bad request vector of the per-scope build: tabs.create and windows.create (the scope arg, no list), the orphan set", { todo: PENDING_1A }, () => badRequestVectors(V.badRequests.filter((v) => scoped(v) || v.perScope)));

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
});

test("the kinds of args: each case fits or gets bad args", async () => {
  const s = await setup({ tabs: [{ id: 1, url: "about:blank" }] });
  const fits = [
    ["debugger.getTargets", undefined],
    ["tabs.create", [{ url: "HTTPS://A.example/x?y#z", active: true, windowId: 0, index: 2 }]],
    ["tabs.create", [{ url: "about:blank" }]],
    ["tabs.query", [{ active: true, anything: [1] }]],
    ["windows.get", [1, { populate: true }]],
    ["windows.create", [{ url: "http://a.example:8080/", left: -10, top: 0, width: 800, height: 600, state: "normal", focused: false }]],
    ["windows.update", [1, { state: "maximized" }]],
    ["contentSettings.set", ["camera", { primaryPattern: "*://*.a.example/*", setting: "block" }]],
    ["contentSettings.set", ["clipboard", { primaryPattern: "https://sub.a.example:8443/*", setting: "allow" }]],
    ["contentSettings.set", ["location", { primaryPattern: "http://a.example:65535/*", setting: "allow" }]],
    ["contentSettings.clear", ["automaticDownloads"]],
    ["bridge.attachNew", [false]],
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
    ["debugger.sendCommand", [{ tabId: 1 }, "Page.enable", []]],
    ["debugger.sendCommand", [{ tabId: 1 }, "Page.enable", null]],
    ["tabs.create", [{ url: "about:blank#x" }]],
    ["tabs.create", [{ url: "about:newtab" }]],
    ["tabs.create", [{ url: "data:text/html,x" }]],
    ["tabs.create", [{ url: "file:///etc/passwd" }]],
    ["tabs.create", [{ url: "https:a.example" }]],
    ["tabs.create", [{ url: "https://a.example/", windowId: -2 }]],
    ["tabs.create", [{ url: "https://a.example/", active: 1 }]],
    ["tabs.query", [null]],
    ["tabs.update", [1, { active: "yes" }]],
    ["tabs.update", [1, { active: true, muted: true }]],
    ["windows.create", [{ url: "https://a.example/", width: "800" }]],
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

test("contentDetails is checked against the applied allowlist: none before a set_allowlist, a shrink at once", async () => {
  const s = await setup({ allowlist: null });
  const req = (host) => ({ op: "contentSettings.set", args: ["location", { primaryPattern: `https://${host}/*`, setting: "allow" }] });
  assert.equal(await s.errorOf(req("a.example")), "bad args", "no list applied since the worker started");
  await applyAllowlist(s.f.chrome, ["a.example", "b.example"]);
  assert.equal(await s.errorOf(req("b.example")), null);
  s.f.impl["browsingData.remove"] = async () => {
    throw new Error("busy");
  };
  await assert.rejects(applyAllowlist(s.f.chrome, ["a.example"]));
  assert.equal(await s.errorOf(req("b.example")), "bad args", "the rule in force counts, also when the call then failed");
  assert.equal(await s.errorOf(req("a.example")), null);
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
