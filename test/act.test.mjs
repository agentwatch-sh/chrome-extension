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

async function setup({ tabs = [REGULAR], copy = null, beforeStart = () => {}, scopes = V.setScopes } = {}) {
  const s = await startReceiver({
    tabs,
    copy,
    targets: tabs.map((t) => ({ id: "T" + t.id, tabId: t.id, type: "page", attached: false })),
    scopes,
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
    if (v.setup.startsWith("act window 30")) await s.openAct();
    if (v.setup === "act window 30 attached") assert.equal((await s.answer({ id: "att", op: "debugger.attach", args: [ACT_TAB] })).ok, true);
    const before = s.f.callsTo("windows.create").length;
    const attaches = s.f.callsTo("debugger.attach").length;
    const res = await s.answer(v.req);
    assert.deepEqual(res, { t: "res", ch: "bridge", id: v.req.id, ok: false, error: v.error }, v.req.id);
    if (v.setup !== "no window") assert.equal(s.f.callsTo("windows.create").length, before, `${v.req.id}: no window opens`);
    if (["bad args", "no list for this scope"].includes(v.error)) assert.equal(s.f.callsTo("extension.isAllowedIncognitoAccess").length, v.setup.startsWith("act window 30") ? 1 : 0, `${v.req.id}: no chrome call`);
    assert.ok(!s.f.callsTo("tabs.create").some(([p]) => p.windowId === WIN.id || p.windowId === V.incognitoTab.windowId), `${v.req.id}: no tab goes into an incognito window`);
    assert.ok(!s.f.callsTo("windows.update").length, `${v.req.id}: no window moves`);
    assert.equal(s.f.callsTo("debugger.attach").length, attaches, `${v.req.id}: no attach (also none for a close)`);
    assert.ok(!s.f.callsTo("tabs.update").some(([id]) => id === ACT_TAB || id === V.incognitoTab.id), `${v.req.id}: no incognito tab is selected`);
    assert.ok(!s.f.callsTo("tabs.remove").length, `${v.req.id}: no chrome.tabs.remove`);
    assert.ok(!s.f.callsTo("debugger.sendCommand").some(([, m]) => m === "Target.closeTarget" || m === "Page.close"), `${v.req.id}: no close goes to Chrome`);
    assert.ok(s.f.tabs_.some((t) => t.id === ACT_TAB) || !v.setup.startsWith("act window 30"), `${v.req.id}: the act tab stays`);
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

test("a popup of an act tab is an act tab: its scope for the list rules, no bridge.tabScope, no key tab:<id> (its key is acttab:<id>), not in bridge.tabScopes", async () => {
  const s = await setup();
  await s.openAct();
  s.f.tabs_.push({ id: 35, windowId: 36, incognito: true, url: "about:blank" });
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ tabId: 35, sourceTabId: ACT_TAB, sourceFrameId: 0, url: "about:blank" });
  await flush();
  assert.equal(s.r.map.isAct(35), true);
  assert.equal(s.r.map.scopeOf(35), V.scope);
  assert.deepEqual(s.r.map.list(), []);
  assert.ok(!s.evs().some((e) => e.ev === "bridge.tabScope"));
  assert.deepEqual(s.f.storage_.session, { ...V.actWindow.copy, "acttab:35": true }, "no key tab:35; the key acttab:35 (review-ce44 N1)");
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
  delete s.f.impl["windows.get"];
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
  // One call of the act's rules, the merge guard's floor without the act tabs (C5, board ab-v16.99), then the confirmation.
  assert.deepEqual(calls.filter((p) => p.startsWith("declarativeNetRequest.")), ["declarativeNetRequest.updateSessionRules", "declarativeNetRequest.updateSessionRules", "declarativeNetRequest.getSessionRules"], "the act's call, the floor's, then the confirmation");
  const floor = s.f.sessionRules_.find((r) => r.id === 9);
  assert.ok(V.rules[0].condition.tabIds.every((t) => floor.condition.excludedTabIds.includes(t)), "the floor leaves the act tabs out");
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

test("a full replace after a failed start keeps the act's rules (a worker before it can have left them) until the act's end removes them", async () => {
  const f = makeFakeChrome();
  const rules = new SessionRules(f.chrome, () => new Map(), { setTimer: (fn, ms) => (ms === 2000 ? setTimeout(fn, 0) : null), clearTimer: () => {} });
  f.impl["declarativeNetRequest.getSessionRules"] = () => new Promise(() => {}); // the start's removal never ends: unknown
  await rules.start();
  delete f.impl["declarativeNetRequest.getSessionRules"];
  f.sessionRules_ = [...structuredClone(V.rules), { id: 100, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["example.com"], resourceTypes: ["main_frame"], tabIds: [1] } }];
  assert.equal(rules.acting, true, "the act's end must run");
  await rules.replaceAll();
  assert.equal(f.sessionRules_.filter(isActRule).length, V.rules.length, "the act's rules stay");
  assert.ok(!f.sessionRules_.some((r) => r.id === 100), "a left scope rule goes");
  await rules.removeAct();
  await rules.replaceAll();
  assert.equal(f.sessionRules_.filter(isActRule).length, 0, "after the act's end");
  // While this worker's act holds them, they stay too.
  await rules.setAct({ tabIds: [ACT_TAB], sendTo: V.rulesReq.send_to });
  await rules.replaceAll();
  assert.equal(f.sessionRules_.filter(isActRule).length, V.rules.length);
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

// ---- review-ce44 (the fix round) ----

// Every updateSessionRules call in order, applied as Chrome applies it; fail(d) throws for a call.
function recordRules(s, fail = () => null) {
  const log = [];
  s.f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    const err = fail(d);
    if (err) throw new Error(err);
    log.push(structuredClone(d));
    const kept = s.f.sessionRules_.filter((r) => !(d.removeRuleIds ?? []).includes(r.id));
    s.f.sessionRules_ = [...kept, ...structuredClone(d.addRules ?? [])];
  };
  return log;
}
const actRuleOf = (s, id) => s.f.sessionRules_.find((r) => r.id === id);
const OTHER = V.incognitoTab; // the operator's incognito tab 40, in window 41

test("B1: the guard never acts on an incognito tab that is no act tab: no about:blank, no blocked notice, no host leaves the receiver", async () => {
  const s = await setup({ tabs: [REGULAR, OTHER] });
  // A tab that the start's read knew, and one that came after it.
  s.f.chrome.tabs.onCreated.fire({ id: 42, windowId: 41, incognito: true, url: "", pendingUrl: "chrome://newtab/" });
  await flush();
  for (const tabId of [OTHER.id, 42]) {
    s.f.chrome.webNavigation.onBeforeNavigate.fire({ tabId, frameId: 0, url: "https://private.localhost/a" });
    s.f.chrome.webNavigation.onCommitted.fire({ tabId, frameId: 0, url: "https://private.localhost/a" });
    s.f.chrome.webNavigation.onErrorOccurred.fire({ tabId, frameId: 0, url: "https://private2.localhost/b", error: "net::ERR_BLOCKED_BY_CLIENT" });
  }
  await flush();
  assert.deepEqual(s.notices(), [], "no blocked notice");
  assert.ok(!s.f.callsTo("tabs.update").some(([id]) => id === OTHER.id || id === 42), "no about:blank");
  // A tab of the default context still gets the guard (tab 7: the union of the lists).
  s.f.chrome.webNavigation.onBeforeNavigate.fire({ tabId: 7, frameId: 0, url: "https://private.localhost/a" });
  await flush();
  assert.deepEqual(s.notices().map((n) => n.tab), [7]);
});

test("N9 and N5: a client's tabs.create with no windowId opens in a window of the default context while an incognito window is open; a windowId of an incognito window is refused", async () => {
  const s = await setup({ tabs: [REGULAR, OTHER] });
  s.f.impl["tabs.create"] = async (props) => {
    const tab = { id: 70, incognito: props.windowId === OTHER.windowId, windowId: props.windowId ?? OTHER.windowId, ...props };
    s.f.tabs_.push({ id: 70, windowId: tab.windowId, incognito: tab.incognito, url: "about:blank" });
    return tab;
  };
  const res = await s.answer({ id: "c70", op: "tabs.create", args: [{ url: "about:blank" }, V.scope] });
  assert.equal(res.ok, true, "the client's tab opens");
  assert.deepEqual(s.f.callsTo("tabs.create"), [[{ url: "about:blank", windowId: REGULAR.windowId }]], "in the window of the default context");
  assert.equal(s.r.map.scopeOf(70), V.scope);
  const into = await s.answer({ id: "c71", op: "tabs.create", args: [{ url: "about:blank", windowId: OTHER.windowId }, V.scope] });
  assert.equal(into.error, "not an agent window");
  assert.equal(s.f.callsTo("tabs.create").length, 1, "no tab goes into the incognito window");
  // With no incognito tab, tabs.create goes to Chrome as it came, with no other read.
  const plain = await setup();
  const mark = plain.f.calls.length;
  assert.equal((await plain.answer({ id: "p", op: "tabs.create", args: [{ url: "about:blank" }, V.scope] })).ok, true);
  assert.deepEqual(callsSince(plain.f, mark).filter(([p]) => p.startsWith("windows.") || p === "tabs.create"), [["tabs.create", [{ url: "about:blank" }]]]);
});

test("point 2: an act popup joins rules A, B, D and E when it appears, before its scope rule; rule C names the hosts of send_to", async () => {
  const s = await setup();
  await s.openAct();
  assert.equal((await s.main(V.rulesReq)).ok, true);
  const log = recordRules(s);
  s.f.tabs_.push({ id: 35, windowId: 36, incognito: true, url: "about:blank" });
  s.f.chrome.tabs.onCreated.fire({ id: 35, windowId: 36, incognito: true, url: "about:blank" });
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ tabId: 35, sourceTabId: ACT_TAB, sourceFrameId: 0, url: "about:blank" });
  await flush(12);
  for (const id of [10, 11, 13, 14, 15, 16, 17]) assert.deepEqual(actRuleOf(s, id).condition.tabIds, [ACT_TAB, 35], `rule ${id}`);
  assert.equal(Object.hasOwn(actRuleOf(s, 12).condition, "tabIds"), false, "rule C: every tab");
  assert.deepEqual(actRuleOf(s, 12).condition.initiatorDomains, ["staging.example.com", "auth.example.com"], "rule C: the hosts of send_to");
  const joined = log.findIndex((d) => (d.addRules ?? []).some((r) => r.id === 10 && r.condition.tabIds.includes(35)));
  const scoped = log.findIndex((d) => (d.addRules ?? []).some((r) => r.id >= 100 && (r.condition.tabIds ?? []).includes(35)));
  assert.ok(joined >= 0 && scoped > joined, `the act's rules first (call ${joined}), then the scope rule (call ${scoped})`);
  assert.deepEqual(s.f.storage_.session, { ...V.actWindow.copy, "acttab:35": true }, "the copy names the act popup");
  // A replaced act tab joins too.
  s.f.chrome.tabs.onReplaced.fire(37, 35);
  await flush(12);
  assert.deepEqual(actRuleOf(s, 10).condition.tabIds, [ACT_TAB, 35, 37]);
});

test("point 2: act_rules names every act tab; a popup's join that fails closes the popup (fail closed)", async () => {
  const s = await setup();
  await s.openAct();
  s.f.tabs_.push({ id: 35, windowId: 36, incognito: true, url: "about:blank" });
  s.f.targets_.push({ id: "T35", tabId: 35, type: "page", attached: false });
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ tabId: 35, sourceTabId: ACT_TAB, sourceFrameId: 0, url: "about:blank" });
  await flush();
  const res = await s.main(V.rulesReq);
  assert.equal(res.ok, true);
  assert.deepEqual(actRuleOf(s, 10).condition.tabIds, [ACT_TAB, 35], "the popup that came before the rules");
  recordRules(s, (d) => ((d.addRules ?? []).some((r) => r.id === 10 && r.condition.tabIds.includes(38)) ? "Rule count exceeded (test)" : null));
  s.f.tabs_.push({ id: 38, windowId: 36, incognito: true, url: "about:blank" });
  s.f.targets_.push({ id: "T38", tabId: 38, type: "page", attached: false });
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ tabId: 38, sourceTabId: ACT_TAB, sourceFrameId: 0, url: "about:blank" });
  await flush(16);
  assert.ok(!s.f.tabs_.some((t) => t.id === 38), "the popup closed");
  assert.ok(!s.f.sessionRules_.some((r) => r.id >= 100 && (r.condition.tabIds ?? []).includes(38)), "no scope rule names it");
});

test("N1: the worker's start keeps the act's rules 10 to 77 until it has closed the act windows and act tabs of the copy, then removes them", async () => {
  const left = { id: ACT_TAB, windowId: WIN.id, incognito: true, url: "https://staging.example.com/login" };
  const popup = { id: 35, windowId: 36, incognito: true, url: "https://staging.example.com/help" };
  const order = [];
  const s = await setup({
    tabs: [REGULAR, left, popup],
    copy: { "act:30": true, "acttab:35": true },
    beforeStart: (f) => {
      f.sessionRules_ = [...structuredClone(V.rules), { id: 100, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["example.com"], resourceTypes: ["main_frame"], tabIds: [ACT_TAB] } }];
      const update = f.chrome.declarativeNetRequest.updateSessionRules;
      f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
        if ((d.removeRuleIds ?? []).includes(10)) order.push("act rules go");
        const kept = f.sessionRules_.filter((r) => !(d.removeRuleIds ?? []).includes(r.id));
        f.sessionRules_ = [...kept, ...structuredClone(d.addRules ?? [])];
      };
      void update;
      const send = f.chrome.debugger.sendCommand;
      void send;
      f.impl["debugger.sendCommand"] = async (target, method, params) => {
        if (method !== "Target.closeTarget") return {};
        const t = f.targets_.find((x) => x.id === params.targetId);
        if (t) {
          order.push("close " + t.tabId);
          f.closeTab(t.tabId);
        }
        return { success: true };
      };
    },
  });
  await flush(16);
  assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB || t.id === 35), "both tabs of the left act closed");
  assert.deepEqual(order.slice().sort(), ["act rules go", "close 31", "close 35"]);
  assert.equal(order.at(-1), "act rules go", "the rules go after the closes");
  assert.deepEqual(s.f.sessionRules_.filter(isActRule), []);
  assert.deepEqual(s.f.storage_.session, {}, "no act key is left");
});

test("B3: the act window's fail-closed paths: a failed scope-rule update and a failed key write end the act and answer the error", async () => {
  {
    const s = await setup();
    recordRules(s, (d) => ((d.addRules ?? []).some((r) => r.id >= 100 && (r.condition.tabIds ?? []).includes(ACT_TAB)) ? "Rule failure (test)" : null));
    const res = await s.answer(V.actWindow.req);
    assert.equal(res.error, "Rule failure (test)");
    await flush(8);
    assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB), "the act window closed");
    assert.equal(s.r.map.isAct(ACT_TAB), false);
    assert.deepEqual(s.f.storage_.session, {});
  }
  {
    const s = await setup();
    s.f.impl["storage.session.set"] = async (items) => {
      if (Object.keys(items).some((k) => k.startsWith("act:"))) throw new Error("Quota (test)");
      Object.assign(s.f.storage_.session, items);
    };
    const res = await s.answer(V.actWindow.req);
    assert.equal(res.error, "Quota (test)");
    await flush(8);
    assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB), "the act window closed");
    assert.equal(s.r.map.isAct(ACT_TAB), false);
  }
});

test("B3: a link change or a sweep during windows.create ends the act: the window closes", async () => {
  for (const during of ["link", "sweep"]) {
    const s = await setup();
    let open;
    const gate = new Promise((r) => (open = r));
    const create = s.f.impl["windows.create"];
    s.f.impl["windows.create"] = async (data) => {
      await gate;
      return create(data);
    };
    s.send({ ...V.actWindow.req, id: "d-" + during });
    await flush();
    if (during === "link") s.port().fireMessage({ t: "link", up: true });
    else await s.set({ ...V.setScopes, scopes: { "my-repo": null } });
    await flush();
    open();
    await flush(16);
    assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB), `${during}: the act window closed`);
    assert.equal(s.r.map.isAct(ACT_TAB), false, during);
    assert.deepEqual(s.f.storage_.session, {}, `${during}: no act key`);
    const res = s.port().posted.filter((m) => m.t === "res" && m.id === "d-" + during);
    if (during === "sweep") assert.deepEqual(res.map((m) => m.error), ["no list for this scope"]);
    else assert.deepEqual(res, [], "the old link's answer is dropped");
  }
});

test("B3 and N6: act_end answers rules not removed when the rules' removal fails (they stay); a new act window then answers rules not removed too", async () => {
  const s = await setup();
  await s.openAct();
  assert.equal((await s.main(V.rulesReq)).ok, true);
  recordRules(s, (d) => ((d.removeRuleIds ?? []).includes(10) && !(d.addRules ?? []).length ? "Rule failure (test)" : null));
  assert.deepEqual(await s.main(V.endReq), { t: "res", id: V.endReq.id, ok: false, error: "rules not removed" });
  assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB), "the tab closed first");
  assert.equal(s.f.sessionRules_.filter(isActRule).length, V.rules.length, "the rules stay");
  const res = await s.answer({ ...V.actWindow.req, id: "again" });
  assert.equal(res.error, "rules not removed", "not another private window is open: no tab stays");
});

test("N2: act_end also closes an incognito tab whose opener is an act tab, before its navigation target came", async () => {
  const s = await setup();
  await s.openAct();
  s.f.tabs_.push({ id: 44, windowId: 45, incognito: true, openerTabId: ACT_TAB, url: "about:blank" });
  s.f.targets_.push({ id: "T44", tabId: 44, type: "page", attached: false });
  const res = await s.main(V.endReq);
  assert.deepEqual(res.data, { closed: 2 });
  assert.ok(!s.f.tabs_.some((t) => t.id === 44));
});

test("N10: act_cookies never reads the store of the default context", async () => {
  const s = await setup();
  await s.openAct();
  s.f.cookieStores_ = [{ id: "0", tabIds: [7, ACT_TAB] }];
  s.f.cookies_ = structuredClone(V.cookies);
  assert.deepEqual(await s.main(V.cookiesReq), { t: "res", id: V.cookiesReq.id, ok: false, error: "no cookie store" });
  assert.equal(s.f.callsTo("cookies.getAll").length, 0);
});

test("B1, each layer alone: the removal queue's own check, both checks of debugger.attach, and a replaced incognito tab", async () => {
  const s = await setup({ tabs: [REGULAR, OTHER] });
  // The removal queue checks the tab again when its item starts (the bridge's check is the first layer).
  const op = { stale: () => false, expired: false };
  await assert.rejects(s.r.removals.removeTab(OTHER.id, op), { message: "not an agent tab" });
  assert.equal(s.f.callsTo("debugger.attach").length, 0, "no attach for a close");
  // The map knows tab 40 as incognito, although tabs.get no longer says so: the first check refuses it.
  s.f.impl["tabs.get"] = async (id) => ({ id, windowId: 41, url: "about:blank" });
  assert.equal((await s.answer({ id: "a40", op: "debugger.attach", args: [OTHER.id] })).error, "not an agent tab");
  delete s.f.impl["tabs.get"];
  // A tab that the map does not know (no tabs.onCreated came): the read of the tab refuses it.
  s.f.tabs_.push({ id: 46, windowId: 41, incognito: true, url: "about:blank" });
  assert.equal((await s.answer({ id: "a46", op: "debugger.attach", args: [46] })).error, "not an agent tab");
  assert.equal(s.f.callsTo("debugger.attach").length, 0);
  // A replaced incognito tab: the added tab is incognito too (the guard never acts on it).
  s.f.chrome.tabs.onReplaced.fire(47, OTHER.id);
  await flush();
  s.f.chrome.webNavigation.onBeforeNavigate.fire({ tabId: 47, frameId: 0, url: "https://private.localhost/r" });
  await flush();
  assert.deepEqual(s.notices(), []);
  assert.equal((await s.answer({ id: "u47", op: "tabs.update", args: [47, { active: true }] })).error, "not an agent tab");
});

test("point 2: no scope rule names an act popup before its join of the act's rules, also one that an earlier change writes after the popup came", async () => {
  const s = await setup();
  await s.openAct();
  assert.equal((await s.main(V.rulesReq)).ok, true);
  let open;
  const gate = new Promise((r) => (open = r));
  let held = false;
  const log = [];
  s.f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    if (!held && (d.addRules ?? []).some((r) => r.id >= 100 && (r.condition.tabIds ?? []).includes(60))) {
      held = true;
      await gate; // the chain is busy with the rule of a client's new tab 60
    }
    log.push(structuredClone(d));
    const kept = s.f.sessionRules_.filter((r) => !(d.removeRuleIds ?? []).includes(r.id));
    s.f.sessionRules_ = [...kept, ...structuredClone(d.addRules ?? [])];
  };
  s.f.impl["tabs.create"] = async (props) => ({ id: 60, windowId: 1, ...props });
  s.send({ t: "req", id: "c60", op: "tabs.create", args: [{ url: "about:blank" }, V.scope] });
  await flush();
  // A change of the same list comes before the popup (tab 7 gets the scope through a replace), then the popup.
  s.f.chrome.tabs.onReplaced.fire(61, 60);
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ tabId: 35, sourceTabId: ACT_TAB, sourceFrameId: 0, url: "about:blank" });
  await flush();
  open();
  await flush(16);
  const joined = log.findIndex((d) => (d.addRules ?? []).some((r) => r.id === 10 && r.condition.tabIds.includes(35)));
  const first = log.findIndex((d) => (d.addRules ?? []).some((r) => r.id >= 100 && (r.condition.tabIds ?? []).includes(35)));
  assert.ok(joined >= 0, "the popup joined");
  assert.ok(first > joined, `no scope rule names the popup before its join (join ${joined}, scope ${first})`);
});

test("N1: the worker's start ends a left act itself, also when no link comes up (the native host does not answer)", async () => {
  const f = makeFakeChrome();
  f.setTabs([{ ...REGULAR }, { id: ACT_TAB, windowId: WIN.id, incognito: true, url: "https://staging.example.com/login" }]);
  f.targets_ = f.tabs_.map((t) => ({ id: "T" + t.id, tabId: t.id, type: "page", attached: false }));
  f.storage_.session = { "act:30": true };
  f.sessionRules_ = structuredClone(V.rules);
  const { receiver: receiverOf } = await import("../agent/receiver.js");
  const r = receiverOf(f.chrome);
  await r.startup();
  await flush(16);
  assert.ok(!f.tabs_.some((t) => t.id === ACT_TAB), "the left act tab closed");
  assert.deepEqual(f.sessionRules_.filter(isActRule), [], "then the act's rules went");
  assert.deepEqual(f.storage_.session, {});
});

// ---- review-ce44b and the daemon lead's P1 ----

// A start of the receiver with the act's rules of a worker before it (ids 10 to 77) in Chrome. Each close of
// Target.closeTarget and each removal of the act's rules goes into order. closable(tabId): the close works.
async function leftActStart({ tabs, copy = null, closable = () => true, beforeStart = () => {}, scopes = V.setScopes }) {
  const order = [];
  const s = await setup({
    tabs: [REGULAR, ...tabs],
    copy,
    scopes,
    beforeStart: (f) => {
      f.sessionRules_ = structuredClone(V.rules);
      f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
        if ((d.removeRuleIds ?? []).includes(10)) order.push("act rules go");
        const kept = f.sessionRules_.filter((r) => !(d.removeRuleIds ?? []).includes(r.id));
        f.sessionRules_ = [...kept, ...structuredClone(d.addRules ?? [])];
      };
      f.impl["debugger.sendCommand"] = async (target, method, params) => {
        if (method !== "Target.closeTarget") return {};
        const t = f.targets_.find((x) => x.id === params.targetId);
        if (t && closable(t.tabId)) {
          order.push("close " + t.tabId);
          f.closeTab(t.tabId);
        }
        return { success: true };
      };
      f.impl["tabs.remove"] = async (id) => {
        if (!closable(id)) throw new Error("No tab with id: " + id);
        order.push("close " + id);
        f.closeTab(id);
      };
      return beforeStart(f);
    },
  });
  return { s, order };
}

test("P1: at a start with the act's rules present, every incognito tab closes first (also a left act tab whose key never reached the copy), then the rules go", async () => {
  const left = { id: ACT_TAB, windowId: WIN.id, incognito: true, url: "https://staging.example.com/login" };
  const nokey = { id: 35, windowId: 36, incognito: true, url: "https://staging.example.com/help" };
  const { s, order } = await leftActStart({ tabs: [left, nokey], copy: { "act:30": true } });
  await flush(16);
  assert.ok(!s.f.tabs_.some((t) => t.incognito), "no incognito tab is open");
  assert.deepEqual(order.slice().sort(), ["act rules go", "close 31", "close 35"]);
  assert.equal(order.at(-1), "act rules go", "the rules go after every incognito tab closed");
  assert.ok(s.f.tabs_.some((t) => t.id === 7), "a tab of the default context stays");
  assert.deepEqual(s.f.storage_.session, {});
});

test("P1: a start whose read of the copy fails still closes every incognito tab before the act's rules go", async () => {
  const left = { id: ACT_TAB, windowId: WIN.id, incognito: true, url: "https://staging.example.com/login" };
  const { s, order } = await leftActStart({
    tabs: [left],
    copy: { "act:30": true },
    beforeStart: (f) => {
      f.impl["storage.session.get"] = async () => {
        throw new Error("read failed (test)");
      };
    },
  });
  await flush(16);
  assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB), "the left act tab closed");
  assert.deepEqual(order, ["close 31", "act rules go"]);
});

test("P1: when an incognito tab does not close at the start, the act's rules stay (fail closed); the next link change tries again", async () => {
  const left = { id: ACT_TAB, windowId: WIN.id, incognito: true, url: "https://staging.example.com/login" };
  let closable = false;
  // No set_scopes at the start: it would wait in the removal queue behind the start's close, whose timers this test fires.
  const { s, order } = await leftActStart({ tabs: [left], closable: () => closable, scopes: null });
  await flush(16);
  for (let i = 0; i < 6; i++) await s.fire(2000);
  assert.ok(s.f.tabs_.some((t) => t.id === ACT_TAB), "the tab stays");
  assert.equal(s.f.sessionRules_.filter(isActRule).length, V.rules.length, "the rules stay");
  assert.ok(!order.includes("act rules go"));
  closable = true;
  s.port().fireMessage({ t: "link", up: true });
  await flush(16);
  for (let i = 0; i < 3; i++) await s.fire(2000);
  assert.ok(!s.f.tabs_.some((t) => t.id === ACT_TAB), "the next link change closed it");
  assert.equal(order.at(-1), "act rules go");
  assert.deepEqual(s.f.sessionRules_.filter(isActRule), []);
});

test("R2: the guard reads a tab that it does not know before it acts: an incognito tab whose navigation came before its tabs.onCreated gets no about:blank and no blocked", async () => {
  const s = await setup();
  s.f.tabs_.push({ id: 48, windowId: 49, incognito: true, url: "https://private.localhost/a" });
  s.f.chrome.webNavigation.onBeforeNavigate.fire({ tabId: 48, frameId: 0, url: "https://private.localhost/a" });
  s.f.chrome.webNavigation.onErrorOccurred.fire({ tabId: 48, frameId: 0, url: "https://private.localhost/a", error: "net::ERR_BLOCKED_BY_CLIENT" });
  await flush(12);
  assert.deepEqual(s.notices(), [], "no blocked");
  assert.ok(!s.f.callsTo("tabs.update").some(([id]) => id === 48), "no about:blank");
  assert.equal(s.r.map.isIncognito(48), true, "the read told the map");
  // A tab of the default context that the guard reads is still sent away, with its notice.
  s.f.tabs_.push({ id: 50, windowId: 1, url: "about:blank" });
  s.f.chrome.webNavigation.onBeforeNavigate.fire({ tabId: 50, frameId: 0, url: "https://private.localhost/b" });
  await flush(12);
  assert.deepEqual(s.notices().map((n) => n.tab), [50]);
  assert.ok(s.f.callsTo("tabs.update").some(([id, p]) => id === 50 && p.url === "about:blank"));
});

test("R2: an incognito tab that the map does not know (a start whose read failed): tabs.remove (its item's own read) and tabs.update (a read of the tab) refuse it, with no attach and no close", async () => {
  const s = await setup();
  s.f.tabs_.push({ id: 48, windowId: 49, incognito: true, url: "https://private.localhost/a" });
  s.f.targets_.push({ id: "T48", tabId: 48, type: "page", attached: false });
  assert.equal(s.r.map.isIncognito(48), false);
  assert.equal((await s.answer({ id: "rm48", op: "tabs.remove", args: [48] })).error, "not an agent tab");
  assert.equal((await s.answer({ id: "up48", op: "tabs.update", args: [48, { active: true }] })).error, "not an agent tab");
  assert.ok(s.f.tabs_.some((t) => t.id === 48), "the tab stays");
  assert.equal(s.f.callsTo("debugger.attach").length, 0, "no attach for a close");
  assert.ok(!s.f.callsTo("tabs.update").some(([id]) => id === 48));
  assert.ok(!s.f.callsTo("debugger.sendCommand").some(([, m]) => m === "Target.closeTarget"));
  // A tab of the default context is still closed and selected.
  s.f.targets_.push({ id: "T7", tabId: 7, type: "page", attached: false });
  assert.equal((await s.answer({ id: "up7", op: "tabs.update", args: [7, { active: true }] })).ok, true);
});

test("R2: downloads.search leaves an incognito download out, and downloads.cancel of one gets not an agent download", async () => {
  const s = await setup();
  const items = [{ id: 3, incognito: false, state: "in_progress" }, { id: 4, incognito: true, state: "in_progress" }];
  s.f.impl["downloads.search"] = async (q) => structuredClone(items.filter((d) => q.id === undefined || d.id === q.id));
  assert.deepEqual((await s.answer({ id: "ds", op: "downloads.search", args: [{}] })).data, [items[0]]);
  assert.equal((await s.answer({ id: "dc4", op: "downloads.cancel", args: [4] })).error, "not an agent download");
  assert.deepEqual(s.f.callsTo("downloads.cancel"), [], "no cancel goes to Chrome");
  assert.equal((await s.answer({ id: "dc3", op: "downloads.cancel", args: [3] })).ok, true);
  assert.deepEqual(s.f.callsTo("downloads.cancel"), [[3]]);
});
