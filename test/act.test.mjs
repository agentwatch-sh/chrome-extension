// The receiver's part of the stored sign-ins (contracts C4, C5 and C10; board ab-v16.97.3): the act
// window, the act's rules A to E with their confirmation, the read of the act store's cookies, the
// act's end, and the exclusions of every other incognito tab. The receiver is wired as agent/sw.js
// wires it (test/receiver-harness.mjs), on the fake chrome, against the shared vector
// test/vectors/act.json. Every cookie value is a made-up test value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SessionRules } from "../agent/dnr.js";
import { importState } from "../agent/importer.js";
import { FEATURES } from "../agent/link.js";
import { callsSince, flush, startReceiver } from "./receiver-harness.mjs";
import { makeFakeChrome } from "./fake-chrome.mjs";

const V = JSON.parse(readFileSync(new URL("./vectors/act.json", import.meta.url), "utf8"));
const WIN = V.actWindow.res.data;
const ACT_TAB = WIN.tabs[0].id; // 31
const REGULAR = { id: 7, windowId: 1, url: "https://staging.example.com/home" };
// The act's rules have the ids 10 to 77 (C5), below the scope rules' 100.
const isActRule = (r) => r.id >= 10 && r.id < 100;

// windows.create with incognito gives the vector's window; its tab is open (with a target, so the
// receiver's close can close it) and has its own cookie store, as an incognito tab has.
function incognitoWindows(f, win = WIN) {
  f.impl["windows.create"] = async (data) => {
    if (data.incognito !== true) return { id: 800 + f.calls.length, incognito: false, ...data, tabs: [{ id: 850 + f.calls.length, incognito: false }] };
    const w = structuredClone(win);
    for (const t of w.tabs) {
      f.tabs_.push({ id: t.id, windowId: w.id, incognito: true, url: "about:blank" });
      f.targets_.push({ id: "T" + t.id, tabId: t.id, type: "page", attached: false });
    }
    f.cookieStores_ = [{ id: "0", tabIds: f.tabs_.filter((t) => !t.incognito).map((t) => t.id) }, { id: "1", tabIds: f.tabs_.filter((t) => t.incognito).map((t) => t.id) }];
    return w;
  };
}

async function setup({ tabs = [REGULAR], copy = null, beforeStart = () => {} } = {}) {
  const s = await startReceiver({
    tabs,
    copy,
    targets: tabs.map((t) => ({ id: "T" + t.id, tabId: t.id, type: "page", attached: false })),
    scopes: V.setScopes,
    beforeStart: (f) => {
      incognitoWindows(f);
      return beforeStart(f);
    },
  });
  // A request of channel main and its one res (no ch).
  s.main = async (req) => {
    s.sendMain(req);
    await flush(12);
    const got = s.port().posted.filter((m) => m.t === "res" && m.id === req.id);
    assert.equal(got.length, 1, `${req.id}: exactly one res`);
    return got[0];
  };
  s.openAct = async () => {
    const res = await s.answer(V.actWindow.req);
    assert.deepEqual(res, V.actWindow.res, "the act window");
    return res;
  };
  return s;
}

// ---- the act window (C10) ----

test("the act window: windows.create with incognito and the mark act opens an incognito window whose tab has the scope for the list rules, in no bridge.tabScopes and no copy key", async () => {
  const s = await setup();
  const mark = s.f.calls.length;
  await s.openAct();
  const calls = callsSince(s.f, mark).map(([p]) => p);
  assert.ok(calls.indexOf("extension.isAllowedIncognitoAccess") < calls.indexOf("tabs.query"), "the incognito check first");
  assert.ok(calls.indexOf("tabs.query") < calls.indexOf("windows.create"), "the check of other incognito tabs before the window");
  assert.deepEqual(s.f.callsTo("windows.create"), [V.actWindow.chrome[1]], "Chrome gets incognito true; the scope and the mark stay in the receiver");
  assert.equal(s.r.map.scopeOf(ACT_TAB), V.scope, "the act tab has its caller's scope");
  assert.equal(s.r.map.isAct(ACT_TAB), true);
  assert.deepEqual(s.r.map.list(), [], "bridge.tabScopes leaves the act tab out");
  assert.deepEqual((await s.answer({ id: "ts", op: "bridge.tabScopes", args: [] })).data, []);
  assert.deepEqual(s.f.storage_.session, V.actWindow.copy, "the copy holds the act window, not the act tab");
  const scopeRule = s.f.sessionRules_.find((r) => r.id === 100);
  assert.deepEqual(scopeRule.condition.tabIds, [ACT_TAB], "the scope's main-frame rule holds the act tab");
  assert.ok(!s.evs().some((e) => e.ev === "bridge.tabScope"), "no bridge.tabScope names the act tab");
});

test("the pair rule and the window's own checks: each windowErrors vector gets its error, and no window opens", async () => {
  for (const v of V.windowErrors) {
    const s = await setup({ tabs: [REGULAR, ...(v.setup === "another incognito tab" ? [V.incognitoTab] : [])] });
    if (v.setup === "no incognito access") s.f.incognitoAllowed = false;
    if (v.setup === "no window") s.f.impl["windows.create"] = async () => undefined;
    if (v.setup === "act window 30") await s.openAct();
    const before = s.f.callsTo("windows.create").length;
    const res = await s.answer(v.req);
    assert.deepEqual(res, { t: "res", ch: "bridge", id: v.req.id, ok: false, error: v.error }, v.req.id);
    if (v.setup !== "no window") assert.equal(s.f.callsTo("windows.create").length, before, `${v.req.id}: no window opens`);
    if (["bad args", "no list for this scope"].includes(v.error)) assert.equal(s.f.callsTo("extension.isAllowedIncognitoAccess").length, v.setup === "act window 30" ? 1 : 0, `${v.req.id}: no chrome call`);
    assert.ok(!s.f.callsTo("tabs.create").some(([p]) => p.windowId === WIN.id), `${v.req.id}: no tab goes into the act window`);
    assert.ok(!s.f.callsTo("windows.update").length, `${v.req.id}: no window moves`);
    assert.ok(!s.f.callsTo("debugger.attach").length, `${v.req.id}: no attach`);
  }
});

test("Chrome's result must be an incognito window with a tab: a window of the default context closes, and the op answers not allowed in incognito", async () => {
  const s = await setup();
  s.f.impl["windows.create"] = async (data) => {
    s.f.tabs_.push({ id: 38, windowId: 39, url: "about:blank" });
    s.f.targets_.push({ id: "T38", tabId: 38, type: "page", attached: false });
    return { ...data, id: 39, incognito: false, tabs: [{ id: 38, windowId: 39, incognito: false }] };
  };
  const res = await s.answer({ ...V.actWindow.req, id: "regular" });
  assert.equal(res.error, "not allowed in incognito");
  await flush();
  assert.ok(!s.f.tabs_.some((t) => t.id === 38), "the window's tab closed");
  assert.equal(s.r.map.has(38), false);
  assert.equal(s.r.map.isAct(38), false);
  assert.deepEqual(s.f.storage_.session, {}, "no act key");
  // An incognito window with no tab: the same text, and no act key stays.
  s.f.impl["windows.create"] = async (data) => ({ id: 45, ...data, tabs: [] });
  assert.equal((await s.answer({ ...V.actWindow.req, id: "notab" })).error, "not allowed in incognito");
  assert.deepEqual(s.f.storage_.session, {});
});

test("a left act ends before the next act window: its tab closes by the receiver's close, its rules and its key go", async () => {
  const s = await setup();
  await s.openAct();
  assert.equal((await s.main(V.rulesReq)).ok, true);
  incognitoWindows(s.f, { ...WIN, id: 32, tabs: [{ ...WIN.tabs[0], id: 33, windowId: 32 }] });
  const res = await s.answer({ ...V.actWindow.req, id: "second" });
  assert.equal(res.ok, true, "the second act window");
  assert.deepEqual(s.f.callsTo("debugger.sendCommand").filter(([, m]) => m === "Target.closeTarget").map(([t]) => t.tabId), [ACT_TAB], "the left act tab closed, with no beforeunload");
  assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB));
  assert.deepEqual(s.f.sessionRules_.filter(isActRule), [], "the left act's rules went");
  assert.deepEqual(s.f.storage_.session, { "act:32": true });
  assert.equal(s.r.map.isAct(33), true);
});

test("a popup of an act tab is an act tab: its scope for the list rules, no bridge.tabScope, no copy key, not in bridge.tabScopes", async () => {
  const s = await setup();
  await s.openAct();
  s.f.tabs_.push({ id: 35, windowId: 36, incognito: true, url: "about:blank" });
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ tabId: 35, sourceTabId: ACT_TAB, sourceFrameId: 0, url: "about:blank" });
  await flush();
  assert.equal(s.r.map.isAct(35), true);
  assert.equal(s.r.map.scopeOf(35), V.scope);
  assert.deepEqual(s.r.map.list(), []);
  assert.ok(!s.evs().some((e) => e.ev === "bridge.tabScope"));
  assert.deepEqual(s.f.storage_.session, V.actWindow.copy);
  assert.deepEqual(s.f.sessionRules_.find((r) => r.id === 100).condition.tabIds.sort(), [ACT_TAB, 35]);
  // A popup of an act tab that closed a moment before is an act tab too.
  s.f.closeTab(35);
  await flush();
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ tabId: 37, sourceTabId: 35, sourceFrameId: 0, url: "about:blank" });
  await flush();
  assert.equal(s.r.map.isAct(37), true, "a kept act tab's popup");
});

test("an incognito tab is never attached eagerly and never gets the operator mark", async () => {
  const s = await setup();
  assert.equal((await s.answer({ id: "eager", op: "bridge.attachNew", args: [true] })).ok, true);
  s.f.tabs_.push({ id: 50, windowId: 51, incognito: true, url: "", pendingUrl: "chrome://newtab/" });
  s.f.chrome.tabs.onCreated.fire({ id: 50, windowId: 51, incognito: true, url: "", pendingUrl: "chrome://newtab/" });
  await flush();
  assert.equal(s.r.map.isMarked(50), false, "no mark");
  assert.deepEqual(s.f.callsTo("debugger.attach"), [], "no eager attach");
  const created = s.evs().find((e) => e.ev === "tabs.onCreated" && e.tab.id === 50);
  assert.deepEqual([created.attached, created.held], [false, false]);
  // A regular tab at the New Tab page still gets the mark (the operator's own).
  s.f.chrome.tabs.onCreated.fire({ id: 52, windowId: 1, url: "", pendingUrl: "chrome://newtab/" });
  await flush();
  assert.equal(s.r.map.isMarked(52), true);
});

test("debugger.attach: an act tab attaches (the service's own session); another incognito tab is not an agent tab", async () => {
  const s = await setup({ tabs: [REGULAR, V.incognitoTab] });
  // windows.create refuses while the other incognito tab is open: open the act window first.
  s.f.tabs_ = s.f.tabs_.filter((t) => t.id !== V.incognitoTab.id);
  await s.openAct();
  s.f.tabs_.push(V.incognitoTab);
  assert.deepEqual((await s.answer({ id: "att-act", op: "debugger.attach", args: [ACT_TAB] })).data, { already: false });
  assert.equal((await s.answer({ id: "att-40", op: "debugger.attach", args: [V.incognitoTab.id] })).error, "not an agent tab");
  assert.deepEqual(s.f.callsTo("debugger.attach").map(([t]) => t.tabId), [ACT_TAB]);
});

test("windows.get of the act window answers it; windows.update of it and tabs.create into it are refused", async () => {
  const s = await setup();
  await s.openAct();
  s.f.impl["windows.get"] = async () => structuredClone(V.windowGet.res.data);
  assert.deepEqual(await s.answer(V.windowGet.req), V.windowGet.res);
  assert.deepEqual(s.f.callsTo("windows.get"), [V.windowGet.chrome[1]]);
  assert.equal((await s.answer({ id: "u", op: "windows.update", args: [WIN.id, { left: 0 }] })).error, "not an agent window");
  assert.equal((await s.answer({ id: "c", op: "tabs.create", args: [{ url: "about:blank", windowId: WIN.id }, V.scope] })).error, "not an agent window");
  assert.equal(s.f.callsTo("windows.update").length, 0);
  assert.equal((await s.answer({ id: "u1", op: "windows.update", args: [1, { left: 0 }] })).ok, true, "another window still moves");
});

test("a client's tab that Chrome opens in an incognito window closes, and its op answers not an agent window", async () => {
  const s = await setup();
  s.f.trackNewTabs = true;
  s.f.impl["tabs.create"] = async (props) => {
    s.f.tabs_.push({ id: 60, windowId: WIN.id, incognito: true, url: "about:blank" });
    s.f.targets_.push({ id: "T60", tabId: 60, type: "page", attached: false });
    return { id: 60, windowId: WIN.id, incognito: true, ...props };
  };
  const res = await s.answer({ id: "c60", op: "tabs.create", args: [{ url: "about:blank" }, V.scope] });
  assert.equal(res.error, "not an agent window");
  await flush();
  assert.equal(s.r.map.has(60), false, "no scope");
  assert.ok(!s.f.tabs_.some((t) => t.id === 60), "it closed");
});

// ---- the act's rules (C5) ----

test("act_rules: the receiver writes rules A to E of the vector for the act tab, confirms them by a read, and answers their ids", async () => {
  const s = await setup();
  await s.openAct();
  const mark = s.f.calls.length;
  assert.deepEqual(await s.main(V.rulesReq), V.rulesRes);
  assert.deepEqual(s.f.sessionRules_.filter(isActRule), V.rules);
  const calls = callsSince(s.f, mark).map(([p]) => p);
  assert.deepEqual(calls.filter((p) => p.startsWith("declarativeNetRequest.")), ["declarativeNetRequest.updateSessionRules", "declarativeNetRequest.getSessionRules"], "one call, then the confirmation");
  // Rule C matches in every tab (no tabIds) by the credential's host as the initiator; no rule but B a main frame.
  const c = V.rules.find((r) => r.id === 12);
  assert.equal(Object.hasOwn(c.condition, "tabIds"), false);
  for (const r of V.rules) {
    if (r.id === 11) assert.deepEqual(r.condition.resourceTypes, ["main_frame"]);
    else assert.deepEqual(r.condition.excludedResourceTypes, ["main_frame"]);
    assert.equal(r.priority, r.action.type === "allow" ? 5 : 4);
  }
  // A second act_rules replaces them in one call.
  const again = await s.main({ ...V.rulesReq, id: "m10b", send_to: ["https://staging.example.com"] });
  assert.deepEqual(again.data, { rules: [10, 11, 12, 13, 14, 15] });
  assert.deepEqual(s.f.sessionRules_.filter(isActRule).map((r) => r.id), [10, 11, 12, 13, 14, 15]);
});

test("act_rules: each badRules vector gets its error, and no rule changes", async () => {
  const s = await setup();
  await s.openAct();
  for (const v of V.badRules) {
    const mark = s.f.calls.length;
    assert.deepEqual(await s.main(v.req), { t: "res", id: v.req.id, ok: false, error: v.error }, v.req.id);
    assert.ok(!callsSince(s.f, mark).some(([p]) => p.startsWith("declarativeNetRequest.")), `${v.req.id}: no rule call`);
  }
  assert.deepEqual(s.f.sessionRules_.filter(isActRule), []);
});

test("act_rules: a failed update or a rule that the read does not find answers rules not held, and the rules before it stay", async () => {
  const s = await setup();
  await s.openAct();
  assert.equal((await s.main(V.rulesReq)).ok, true);
  const before = structuredClone(s.f.sessionRules_);
  s.f.impl["declarativeNetRequest.updateSessionRules"] = async () => {
    throw new Error("Rule with id 14 is not valid.");
  };
  assert.deepEqual(await s.main({ ...V.rulesReq, id: "f1" }), { t: "res", id: "f1", ok: false, error: "rules not held" });
  assert.deepEqual(s.f.sessionRules_, before, "the call is all or nothing");
  delete s.f.impl["declarativeNetRequest.updateSessionRules"];
  s.f.impl["declarativeNetRequest.getSessionRules"] = async () => structuredClone(s.f.sessionRules_).filter((r) => r.id !== 12);
  assert.deepEqual(await s.main({ ...V.rulesReq, id: "f2" }), { t: "res", id: "f2", ok: false, error: "rules not held" }, "no confirmation without rule C");
});

test("a full replace after a failed start keeps the act's rules while an act holds them, and removes a left act's rules otherwise", async () => {
  for (const acting of [true, false]) {
    const f = makeFakeChrome();
    const rules = new SessionRules(f.chrome, () => new Map(), { setTimer: (fn, ms) => (ms === 2000 ? setTimeout(fn, 0) : null), clearTimer: () => {} });
    f.impl["declarativeNetRequest.getSessionRules"] = () => new Promise(() => {}); // the start's removal never ends: unknown
    await rules.start();
    delete f.impl["declarativeNetRequest.getSessionRules"];
    f.sessionRules_ = structuredClone(V.rules);
    if (acting) await rules.setAct(structuredClone(V.rules));
    await rules.replaceAll();
    assert.deepEqual(f.sessionRules_.filter(isActRule).length, acting ? V.rules.length : 0, `acting ${acting}`);
  }
});

// ---- the act store's cookies (C4) ----

test("act_cookies: the cookies of the host in the act tab's store, in C2's form; none of the default store", async () => {
  const s = await setup();
  await s.openAct();
  s.f.cookieStores_ = structuredClone(V.cookieStores);
  s.f.cookies_ = structuredClone(V.cookies);
  assert.deepEqual(await s.main(V.cookiesReq), V.cookiesRes);
  assert.deepEqual(s.f.callsTo("cookies.getAll"), [[{ domain: "staging.example.com", storeId: "1" }], [{ domain: "staging.example.com", storeId: "1", partitionKey: {} }]]);
  for (const v of V.badCookies) assert.deepEqual(await s.main(v.req), { t: "res", id: v.req.id, ok: false, error: v.error }, v.req.id);
  s.f.cookieStores_ = [{ id: "0", tabIds: [7] }];
  assert.deepEqual(await s.main({ ...V.cookiesReq, id: "ns" }), { t: "res", id: "ns", ok: false, error: "no cookie store" });
});

// ---- the act's end ----

test("act_end: every act tab closes (also a popup in another window) before the act's rules go; the key leaves the copy", async () => {
  const s = await setup();
  await s.openAct();
  assert.equal((await s.main(V.rulesReq)).ok, true);
  s.f.tabs_.push({ id: 35, windowId: 36, incognito: true, url: "about:blank" });
  s.f.targets_.push({ id: "T35", tabId: 35, type: "page", attached: false });
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ tabId: 35, sourceTabId: ACT_TAB, sourceFrameId: 0, url: "about:blank" });
  await flush();
  const order = [];
  s.f.impl["debugger.sendCommand"] = async (target, method, params) => {
    if (method === "Target.closeTarget") order.push("close " + target.tabId);
    const t = s.f.targets_.find((x) => x.id === params?.targetId);
    if (method === "Target.closeTarget" && t) s.f.closeTab(t.tabId);
    return method === "Target.closeTarget" ? { success: true } : {};
  };
  s.f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    if ((d.removeRuleIds ?? []).includes(10)) order.push("rules");
    const kept = s.f.sessionRules_.filter((r) => !(d.removeRuleIds ?? []).includes(r.id));
    s.f.sessionRules_ = [...kept, ...structuredClone(d.addRules ?? [])];
  };
  const res = await s.main(V.endReq);
  assert.deepEqual(res, { ...V.endRes, data: { closed: 2 } });
  assert.deepEqual(order.slice(-3).sort(), ["close 31", "close 35", "rules"].sort());
  assert.equal(order.at(-1), "rules", "the rules go after the tabs closed");
  assert.deepEqual(s.f.sessionRules_.filter(isActRule), []);
  assert.deepEqual(s.f.storage_.session, {}, "no act key");
  assert.deepEqual(await s.main({ ...V.endReq, id: "again" }), { t: "res", id: "again", ok: true, data: { closed: 0 } }, "no act: nothing to end");
});

test("act_end: while a tab of the act stays open, the act's rules stay and the answer is act not closed", async () => {
  const s = await setup();
  await s.openAct();
  assert.equal((await s.main(V.rulesReq)).ok, true);
  s.f.impl["debugger.sendCommand"] = async () => ({ success: true }); // Chrome drops the close
  s.f.impl["tabs.remove"] = async () => {
    throw new Error("No tab with id");
  };
  s.sendMain(V.endReq);
  await flush(12);
  await s.fire(2000);
  await s.fire(2000);
  const res = s.port().posted.filter((m) => m.t === "res" && m.id === V.endReq.id);
  assert.deepEqual(res, [{ t: "res", id: V.endReq.id, ok: false, error: "act not closed" }]);
  assert.deepEqual(s.f.sessionRules_.filter(isActRule), V.rules, "the rules stay");
});

test("a link change ends the act: its tab closes and its rules go", async () => {
  const s = await setup();
  await s.openAct();
  assert.equal((await s.main(V.rulesReq)).ok, true);
  s.port().fireMessage({ t: "link", up: true });
  await flush(16);
  assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB), "the act tab closed");
  assert.deepEqual(s.f.sessionRules_.filter(isActRule), []);
  assert.deepEqual(s.f.storage_.session, {});
});

test("the worker's start closes the act window of the copy (a worker before it opened it)", async () => {
  const left = { id: ACT_TAB, windowId: WIN.id, incognito: true, url: "https://staging.example.com/login" };
  const s = await setup({ tabs: [REGULAR, left], copy: { "act:30": true, "tab:7": V.scope } });
  await flush(8);
  assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB), "the left act tab closed");
  assert.equal(s.r.map.has(ACT_TAB), false);
  assert.deepEqual(s.f.storage_.session, { "tab:7": V.scope });
});

// ---- the exclusions ----

test("no blocked notice comes from an act tab: its host can carry the password", async () => {
  const s = await setup();
  await s.openAct();
  s.f.chrome.webNavigation.onBeforeNavigate.fire({ tabId: ACT_TAB, frameId: 0, url: "https://tracker.localhost/x?p=1" });
  s.f.chrome.webNavigation.onErrorOccurred.fire({ tabId: ACT_TAB, frameId: 0, url: "https://other.localhost/y", error: "net::ERR_BLOCKED_BY_CLIENT" });
  await flush();
  assert.deepEqual(s.notices(), []);
  assert.ok(s.f.callsTo("tabs.update").some(([id, p]) => id === ACT_TAB && p.url === "about:blank"), "the guard still sends the act tab away");
  // A tab of the agent's context still gets its notice (tab 7 has no scope: the union of the
  // lists, and no list covers tracker.localhost).
  s.f.chrome.webNavigation.onBeforeNavigate.fire({ tabId: 7, frameId: 0, url: "https://tracker.localhost/x" });
  await flush();
  assert.deepEqual(s.notices().map((n) => [n.tab, n.host]), [[7, "tracker.localhost"]]);
});

test("set_scopes never closes an incognito tab that is no act tab; the sweep closes an act tab whose scope has no list", async () => {
  const s = await setup();
  await s.openAct();
  s.f.tabs_.push({ id: 40, windowId: 41, incognito: true, url: "https://off.localhost/" });
  s.f.targets_.push({ id: "T40", tabId: 40, type: "page", attached: false });
  const res = await s.set({ ...V.setScopes, scopes: { "my-repo": null } });
  assert.equal(res.closed, 1);
  assert.ok(s.f.tabs_.some((t) => t.id === 40), "the other incognito tab stays");
  assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB), "the act tab closed by the sweep");
});

test("the window rule: an incognito tab never counts as a tab that stays, and the about:blank tab never goes into an incognito window", async () => {
  const s = await setup();
  await s.openAct();
  // The last tab of the default context closes while the act window is open: an about:blank tab
  // opens in its window first.
  assert.equal((await s.answer({ id: "rm7", op: "tabs.remove", args: [7] })).ok, true);
  assert.deepEqual(s.f.callsTo("tabs.create"), [[{ windowId: 1, url: "about:blank", active: false }]]);
  // Only the act's tabs are left: the act's end opens a new window of the default context.
  s.f.tabs_ = s.f.tabs_.filter((t) => t.incognito === true);
  assert.equal((await s.main(V.endReq)).ok, true);
  assert.deepEqual(s.f.callsTo("windows.create").at(-1), [{ url: "about:blank", focused: false }]);
  assert.ok(!s.f.callsTo("tabs.create").some(([p]) => p.windowId === WIN.id));
});

test("the import leaves the act's context out: no incognito tab closes in step 1, and the restore tab opens in a window of the default context", async () => {
  const f = makeFakeChrome();
  f.trackNewTabs = true;
  const state = { v: 1, domain: "staging.example.com", url: "https://staging.example.com/", origin: "https://staging.example.com", cookies: [], storage: { local: {}, session: {}, idb: [], caches: [] } };
  f.tabs_ = [{ id: 7, windowId: 1, url: "https://staging.example.com/a" }, { id: 8, windowId: 2, url: "about:blank" }, { id: ACT_TAB, windowId: WIN.id, incognito: true, url: "https://staging.example.com/login" }];
  f.targets_ = f.tabs_.map((t) => ({ id: "T" + t.id, tabId: t.id, type: "page", attached: false }));
  const timers = { setTimer: () => ({}), clearTimer: () => {} };
  const result = await importState(f.chrome, state, { ...timers, nonce: () => "0123456789abcdef" });
  assert.equal(result.tabs_closed, 1, "tab 7 of the default context");
  assert.ok(f.tabs_.some((t) => t.id === ACT_TAB), "the act tab stays");
  assert.deepEqual(f.callsTo("tabs.create")[0], [{ url: "about:blank", active: true, windowId: 2 }]);
});

test("the import fails its step open tab when Chrome opens the restore tab in an incognito window", async () => {
  const f = makeFakeChrome();
  f.trackNewTabs = true;
  f.tabs_ = [{ id: 8, windowId: 2, url: "about:blank" }];
  f.targets_ = [{ id: "T8", tabId: 8, type: "page", attached: false }];
  f.impl["tabs.create"] = async (props) => {
    f.tabs_.push({ id: 70, windowId: WIN.id, incognito: true, url: "about:blank" });
    f.targets_.push({ id: "T70", tabId: 70, type: "page", attached: false });
    return { id: 70, windowId: WIN.id, incognito: true, ...props };
  };
  const state = { v: 1, domain: "staging.example.com", url: "https://staging.example.com/", origin: "https://staging.example.com", cookies: [], storage: { local: {}, session: {}, idb: [], caches: [] } };
  const timers = { setTimer: () => ({}), clearTimer: () => {} };
  await assert.rejects(importState(f.chrome, state, { ...timers, nonce: () => "0123456789abcdef" }), { message: "open tab" });
  assert.ok(!f.tabs_.some((t) => t.id === 70), "the incognito restore tab closed");
});

// ---- the hello and the manifest ----

test("the hello names the feature act, and the manifest keeps incognito spanning", () => {
  assert.deepEqual(FEATURES, V.features);
  const manifest = JSON.parse(readFileSync(new URL("../agent/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.incognito, "spanning", "one worker for both contexts, so the session rules apply in the act window");
});
