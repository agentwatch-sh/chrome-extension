// The operator's own tabs in the receiver (part 1d, board ab-v16.34; choice 3 of the per-scope design,
// the operator's answer 'Any site' in ab-dm6): the operator mark of a tab that starts at Chrome's New
// Tab page, that no page opened and that no bridge op created (C10, each tab's scope); a popup of a
// marked tab is marked too; the mark's life (it stays at a link change and at tabs.onReplaced, it goes
// at the worker's start); the marked-tab rule 8 with "*", or the marked tabs in the named list's
// tabIds, none with null (C5); the closing rule and the retry for marked tabs, and the tab's list that
// the guard reads; the tab checks and the eager attach skip a marked tab (C10); the operator field of
// set_scopes (C4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MARKED_RULE_ID, markedRule, scopeRules } from "../agent/dnr.js";
import { HOLD_MAX_MS } from "../agent/hold.js";
import { NEW_TAB_URL } from "../agent/receiver.js";
import { RETRY_AFTER_MS } from "../agent/popups.js";
import { parseScopes } from "../agent/scopes.js";
import { TOMBSTONE_MS } from "../agent/tabmap.js";
import { flush, startReceiver } from "./receiver-harness.mjs";

const B = JSON.parse(readFileSync(new URL("./vectors/bridge.json", import.meta.url), "utf8"));
const NAV_TARGET = B.eventVectors.find((v) => v.chrome && v.chrome[0] === "webNavigation.onCreatedNavigationTarget");
const BLOCKED = "net::ERR_BLOCKED_BY_CLIENT";

const blank = (id, windowId = 1) => ({ id, windowId, url: "about:blank" });
const page = (id, url, windowId = 1) => ({ id, windowId, url });
const ruleIds = (f) => f.sessionRules_.map((r) => r.id).sort((a, b) => a - b);
const ruleOf = (f, id) => f.sessionRules_.find((r) => r.id === id);
const tabIdsOf = (f, id) => ruleOf(f, id)?.condition.tabIds;
const updates = (f) => f.callsTo("declarativeNetRequest.updateSessionRules").map(([d]) => d);
const evNames = (s, from) => s.evs().slice(from).map((e) => `${e.ev}:${e.tabId ?? e.tab?.id ?? e.details?.tabId ?? e.addedTabId}`);
const created = (s, tabId, from = 0) => s.evs().slice(from).filter((e) => e.ev === "tabs.onCreated" && e.tab.id === tabId);

// Tab 7 has scope md-lead (list md: a.example); list ops (o.example) is a list of the operator's own.
const LISTS = { md: ["a.example"], ops: ["o.example"] };
const scopesWith = (operator, more = {}) => ({ lists: LISTS, scopes: { "md-lead": "md" }, default: null, operator, ...more });

async function setup({ operator = "*", eager = false, tabs = [blank(7)], copy = { "tab:7": "md-lead" }, scopes, beforeStart, targets = [] } = {}) {
  const s = await startReceiver({ tabs, copy, targets, scopes: scopes === undefined ? scopesWith(operator) : scopes, beforeStart });
  let now = 1000;
  s.r.clock.now = () => now;
  s.advance = (ms) => {
    now += ms;
  };
  if (eager) await s.answer({ id: "on", op: "bridge.attachNew", args: [true] });
  return s;
}

// The operator's Ctrl+T or Ctrl+N in the live view: Chrome's tabs.onCreated gives url "" and pendingUrl
// chrome://newtab/ (measured on Chromium 156; openerTabId names the active tab for Ctrl+T).
function operatorTab(s, id, { windowId = 1, opener = 7, fields = { url: "", pendingUrl: NEW_TAB_URL } } = {}) {
  s.f.tabs_.push({ id, windowId, ...fields });
  s.f.targets_.push({ id: "T" + id, tabId: id, type: "page", attached: false });
  s.f.chrome.tabs.onCreated.fire({ id, windowId, active: true, openerTabId: opener, ...fields });
}

// Chrome opens a popup of source: tabs.onCreated, then webNavigation.onCreatedNavigationTarget.
function openPopup(s, { id = 9, source = 20, url = "https://z.example/p", navTarget = true } = {}) {
  s.f.tabs_.push({ id, windowId: 1, url: "", pendingUrl: url });
  s.f.targets_.push({ id: "F" + id, tabId: id, type: "page", attached: false });
  s.f.chrome.tabs.onCreated.fire({ id, windowId: 1, url: "", pendingUrl: url, openerTabId: source });
  if (navTarget) navTargetOf(s, id, source, url);
}

function navTargetOf(s, id, source, url = "https://z.example/p") {
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ ...NAV_TARGET.chrome[1][0], sourceTabId: source, tabId: id, url });
}

const nav = (s, event, tabId, url, more = {}) => s.f.chrome.webNavigation[event].fire({ tabId, frameId: 0, url, ...more });
const block = (s, tabId, url, method = "GET") => {
  s.f.chrome.webRequest.onErrorOccurred.fire({ tabId, frameId: 0, type: "main_frame", url, method, error: BLOCKED });
  nav(s, "onErrorOccurred", tabId, url, { error: BLOCKED });
};

// Every updateSessionRules waits until release(): the popup's rule comes late.
function lateRules(s) {
  const waiting = [];
  s.f.impl["declarativeNetRequest.updateSessionRules"] = (d) => new Promise((resolve, reject) => waiting.push({ d, resolve, reject }));
  return async () => {
    delete s.f.impl["declarativeNetRequest.updateSessionRules"];
    for (const w of waiting.splice(0)) {
      s.f.sessionRules_ = [...s.f.sessionRules_.filter((r) => !(w.d.removeRuleIds ?? []).includes(r.id)), ...structuredClone(w.d.addRules ?? [])];
      w.resolve();
    }
    await flush();
  };
}

// ---- the mark ----

test("a tab that starts at chrome://newtab/, that no page opened and that no bridge op created gets the operator mark at its tabs.onCreated: no scope, no key, no bridge.tabScope, not in bridge.tabScopes", async () => {
  const s = await setup();
  assert.equal(NEW_TAB_URL, "chrome://newtab/");
  const before = s.evs().length;
  operatorTab(s, 20);
  assert.equal(s.r.map.isMarked(20), true, "marked in the handler, before any await");
  await s.fire(50);
  assert.equal(s.r.map.scopeOf(20), undefined, "a marked tab has no scope");
  assert.equal(s.f.storage_.session["tab:20"], undefined, "and no key in the copy");
  assert.deepEqual(evNames(s, before), ["tabs.onCreated:20"], "no bridge.tabScope");
  const listed = await s.answer({ id: "ts", op: "bridge.tabScopes", args: [] });
  assert.deepEqual(listed.data, [{ tabId: 7, scope: "md-lead" }], "a marked tab is not in bridge.tabScopes");
  // Also a tab whose url (with no pendingUrl) is the New Tab page.
  operatorTab(s, 21, { fields: { url: NEW_TAB_URL } });
  assert.equal(s.r.map.isMarked(21), true);
});

test("no mark for a tab that starts anywhere else: a URL, about:blank, an empty URL, another chrome: page", async () => {
  const s = await setup();
  const others = [{ url: "", pendingUrl: "https://z.example/" }, { url: "about:blank" }, { url: "" }, { url: "", pendingUrl: "chrome://new-tab-page/" },
    { url: "", pendingUrl: "chrome://newtab/x" }, { url: "chrome://settings/" }];
  others.forEach((fields, i) => operatorTab(s, 30 + i, { fields }));
  await s.fire(50);
  for (let i = 0; i < others.length; i++) assert.equal(s.r.map.isMarked(30 + i), false, JSON.stringify(others[i]));
  assert.equal(ruleOf(s.f, MARKED_RULE_ID), undefined, "no rule 8 while no tab is marked");
});

test("a tab that a page opened is no operator tab: a navigation target before its tabs.onCreated, or after the mark (then the mark goes and it takes its opener's scope or none)", async () => {
  const s = await setup();
  // The navigation target first: no mark, the opener's scope.
  s.f.tabs_.push({ id: 22, windowId: 1, url: "", pendingUrl: NEW_TAB_URL });
  navTargetOf(s, 22, 7, NEW_TAB_URL);
  s.f.chrome.tabs.onCreated.fire({ id: 22, windowId: 1, url: "", pendingUrl: NEW_TAB_URL });
  await flush();
  assert.equal(s.r.map.isMarked(22), false);
  assert.equal(s.r.map.scopeOf(22), "md-lead");
  // The mark first, then a navigation target of a tab of scope md-lead: the mark goes.
  operatorTab(s, 23);
  await flush();
  assert.deepEqual(tabIdsOf(s.f, MARKED_RULE_ID), [23]);
  navTargetOf(s, 23, 7, NEW_TAB_URL);
  await flush();
  assert.equal(s.r.map.isMarked(23), false);
  assert.equal(s.r.map.scopeOf(23), "md-lead");
  assert.equal(ruleOf(s.f, MARKED_RULE_ID), undefined, "rule 8 goes with its last marked tab");
  // ... and of a tab of no scope: the mark goes, and the tab has no scope.
  operatorTab(s, 24);
  await flush();
  navTargetOf(s, 24, 3, NEW_TAB_URL);
  await flush();
  assert.equal(s.r.map.isMarked(24), false);
  assert.equal(s.r.map.scopeOf(24), undefined);
  assert.equal(ruleOf(s.f, MARKED_RULE_ID), undefined);
});

test("a tab of a bridge op is never marked, also when Chrome's tabs.onCreated for it comes before the op's answer and names chrome://newtab/", async () => {
  const s = await setup();
  s.f.impl["tabs.create"] = async (props) => {
    const tab = { id: 40, windowId: 1, ...props };
    s.f.tabs_.push({ ...tab });
    s.f.chrome.tabs.onCreated.fire({ id: 40, windowId: 1, url: "", pendingUrl: NEW_TAB_URL });
    return tab;
  };
  const made = await s.answer({ id: "c", op: "tabs.create", args: [{ url: "about:blank" }, "md-lead"] });
  assert.equal(made.ok, true);
  assert.equal(s.r.map.isMarked(40), false, "no bridge op creates a marked tab");
  assert.equal(s.r.map.scopeOf(40), "md-lead");
  assert.deepEqual(tabIdsOf(s.f, 100), [7, 40]);
  assert.equal(ruleOf(s.f, MARKED_RULE_ID), undefined);
  s.f.impl["windows.create"] = async (data) => {
    s.f.chrome.tabs.onCreated.fire({ id: 41, windowId: 2, url: "", pendingUrl: NEW_TAB_URL });
    return { id: 2, ...data, tabs: [{ id: 41, windowId: 2, url: "about:blank" }] };
  };
  const win = await s.answer({ id: "w", op: "windows.create", args: [{ url: "about:blank" }, "md-lead"] });
  assert.equal(win.ok, true);
  assert.equal(s.r.map.isMarked(41), false);
  assert.equal(s.r.map.scopeOf(41), "md-lead");
});

// ---- rule 8, or the named list's tabIds ----

test("with operator \"*\": rule 8 allows every main frame, frame and <object>/<embed> document in the marked tabs, with no host condition; set_scopes counts it in rules", async () => {
  const s = await setup();
  assert.deepEqual(ruleIds(s.f), [100, 101], "no rule 8 while no tab is marked (DNR refuses an empty tabIds)");
  operatorTab(s, 20);
  await flush();
  assert.deepEqual(ruleOf(s.f, MARKED_RULE_ID), markedRule([20]));
  assert.deepEqual(markedRule([20]), {
    id: 8, priority: 2, action: { type: "allow" }, condition: { resourceTypes: ["main_frame", "sub_frame", "object"], tabIds: [20] },
  });
  assert.equal(MARKED_RULE_ID, 8);
  assert.deepEqual(updates(s.f).at(-1), { removeRuleIds: [], addRules: [markedRule([20])] }, "a tab that gets the mark replaces rule 8 only");
  operatorTab(s, 21);
  await flush();
  assert.deepEqual(updates(s.f).at(-1), { removeRuleIds: [8], addRules: [markedRule([20, 21])] });
  s.sendMain({ t: "req", id: "m1", op: "set_scopes", ...scopesWith("*") });
  await flush();
  assert.deepEqual(s.resOf("m1")[0].data, { rules: 3, closed: 0, refused: 0 }, "the scope rules and rule 8");
  assert.deepEqual(updates(s.f).at(-1).removeRuleIds, [100, 101, 8], "a set_scopes replaces every scope rule and rule 8");
  assert.deepEqual(ruleIds(s.f), [8, 100, 101]);
  // The marked tabs close: rule 8 goes with the last one.
  s.f.closeTab(20);
  await flush();
  assert.deepEqual(tabIdsOf(s.f, MARKED_RULE_ID), [21]);
  s.f.closeTab(21);
  await flush();
  assert.deepEqual(updates(s.f).at(-1), { removeRuleIds: [8], addRules: [] });
  assert.deepEqual(ruleIds(s.f), [100, 101]);
});

test("with a list name: the marked tabs join that list's two scope rules, also a list that only marked tabs use; no rule 8", async () => {
  const s = await setup({ operator: "ops" });
  operatorTab(s, 20);
  await flush();
  assert.equal(ruleOf(s.f, MARKED_RULE_ID), undefined);
  assert.deepEqual(ruleIds(s.f), [100, 101, 102, 103]);
  assert.deepEqual(s.f.sessionRules_.filter((r) => r.id >= 102), scopeRules(102, ["o.example"], [20]), "a list that only marked tabs use has its two rules");
  // The operator's list is a list of a scope too: its tabs and the marked tabs share the two rules.
  s.sendMain({ t: "req", id: "m1", op: "set_scopes", ...scopesWith("md") });
  await flush();
  assert.deepEqual(s.resOf("m1")[0].data, { rules: 2, closed: 0, refused: 0 });
  assert.deepEqual(s.f.sessionRules_, scopeRules(100, ["a.example"], [7, 20]));
  // A marked tab that closes replaces only its list's two rules.
  s.f.closeTab(20);
  await flush();
  assert.deepEqual(updates(s.f).at(-1), { removeRuleIds: [100, 101], addRules: scopeRules(100, ["a.example"], [7]) });
});

test("with null, with no operator field, with a valid name that is not in lists, and with a bad value (refused 1): the marked tabs have no rule", async () => {
  const s = await setup({ operator: null });
  operatorTab(s, 20);
  await flush();
  assert.deepEqual(ruleIds(s.f), [100, 101]);
  for (const [msg, refused] of [[{ lists: LISTS, scopes: { "md-lead": "md" }, default: null }, 0], [scopesWith("gone"), 0], [scopesWith("all sites"), 1], [scopesWith(["*"]), 1]]) {
    const r = await s.set(msg);
    assert.equal(r.refused, refused, JSON.stringify(msg.operator));
    assert.equal(r.rules, 2);
    assert.deepEqual(ruleIds(s.f), [100, 101], JSON.stringify(msg.operator));
  }
  assert.equal(parseScopes(scopesWith("all sites")).operator, null);
});

test("before the first set_scopes after the worker's start a marked tab has no rule (no operator value yet); the first one writes rule 8", async () => {
  const s = await setup({ scopes: null });
  operatorTab(s, 20);
  await flush();
  assert.deepEqual(s.f.sessionRules_, []);
  assert.equal(s.r.map.isMarked(20), true);
  const r = await s.set(scopesWith("*"));
  assert.equal(r.rules, 3);
  assert.deepEqual(tabIdsOf(s.f, MARKED_RULE_ID), [20]);
});

test("each set_scopes replaces rule 8 in full by its operator value: \"*\" to a list, to null, and back", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  await s.set(scopesWith("ops"));
  assert.deepEqual(ruleIds(s.f), [100, 101, 102, 103]);
  assert.deepEqual(tabIdsOf(s.f, 102), [20]);
  await s.set(scopesWith(null));
  assert.deepEqual(ruleIds(s.f), [100, 101]);
  await s.set(scopesWith("*"));
  assert.deepEqual(ruleIds(s.f), [8, 100, 101]);
  assert.deepEqual(tabIdsOf(s.f, MARKED_RULE_ID), [20]);
});

test("a failed rule update fails closed: the remove-only call takes rule 8 out too, the marks stay, and the next update is a full replace with rule 8", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  assert.deepEqual(ruleIds(s.f), [8, 100, 101]);
  s.f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    if (d.addRules && d.addRules.length > 0) throw new Error("Session rule count exceeded.");
    s.f.sessionRules_ = s.f.sessionRules_.filter((r) => !d.removeRuleIds.includes(r.id));
  };
  operatorTab(s, 21);
  await flush();
  assert.deepEqual(updates(s.f).at(-1), { removeRuleIds: [100, 101, 8] }, "the remove-only call");
  assert.deepEqual(s.f.sessionRules_, []);
  assert.equal(s.r.map.isMarked(20), true);
  assert.equal(s.r.map.isMarked(21), true);
  delete s.f.impl["declarativeNetRequest.updateSessionRules"];
  operatorTab(s, 22);
  await flush();
  assert.deepEqual(ruleIds(s.f), [8, 100, 101], "a full replace from the map and the marks");
  assert.deepEqual(tabIdsOf(s.f, MARKED_RULE_ID), [20, 21, 22]);
});

// ---- popups and replaced tabs ----

test("a popup of a marked tab is marked (sourceTabId): no scope, no key, no bridge.tabScope; its popup too; rule 8 names them", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  const before = s.evs().length;
  openPopup(s, { id: 9, source: 20 });
  assert.equal(s.r.map.isMarked(9), true, "marked in the handler");
  await flush();
  assert.equal(s.r.map.scopeOf(9), undefined);
  assert.equal(s.f.storage_.session["tab:9"], undefined);
  assert.deepEqual(evNames(s, before), ["webNavigation.onCreatedNavigationTarget:9", "tabs.onCreated:9"], "no bridge.tabScope");
  assert.deepEqual(tabIdsOf(s.f, MARKED_RULE_ID), [20, 9]);
  openPopup(s, { id: 10, source: 9 });
  await flush();
  assert.equal(s.r.map.isMarked(10), true);
  assert.deepEqual(tabIdsOf(s.f, MARKED_RULE_ID), [20, 9, 10]);
  // A popup of an agent tab never gets the mark.
  openPopup(s, { id: 11, source: 7, url: "https://a.example/p" });
  await flush();
  assert.equal(s.r.map.isMarked(11), false);
  assert.equal(s.r.map.scopeOf(11), "md-lead");
});

test("a popup of a marked tab that closed a moment before takes its kept mark for TOMBSTONE_MS, then no mark and no scope", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  s.f.closeTab(20);
  await flush();
  s.advance(TOMBSTONE_MS - 1);
  openPopup(s, { id: 9, source: 20 });
  await flush();
  assert.equal(s.r.map.isMarked(9), true);
  operatorTab(s, 21);
  await flush();
  s.f.closeTab(21);
  await flush();
  s.advance(TOMBSTONE_MS);
  openPopup(s, { id: 12, source: 21 });
  await flush();
  assert.equal(s.r.map.isMarked(12), false);
  assert.equal(s.r.map.scopeOf(12), undefined);
});

test("the mark stays at tabs.onReplaced: the added tab takes it, the removed tab's goes, in one update of rule 8", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  const calls = updates(s.f).length;
  s.f.tabs_.push({ id: 25, windowId: 1, url: "https://z.example/" });
  s.f.chrome.tabs.onReplaced.fire(25, 20);
  await flush();
  assert.equal(s.r.map.isMarked(25), true);
  assert.equal(s.r.map.isMarked(20), false);
  assert.deepEqual(updates(s.f).slice(calls), [{ removeRuleIds: [8], addRules: [markedRule([25])] }]);
  assert.equal(s.r.map.scopeOf(25), undefined);
});

// ---- the mark's life ----

test("the mark, rule 8 and the last operator value stay at a disconnect and at a new daemon connection; a popup after the link change is marked", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  const calls = updates(s.f).length;
  s.port().fireDisconnect();
  await flush();
  s.port().fireMessage({ t: "link", up: true });
  await flush();
  assert.equal(s.r.map.isMarked(20), true);
  assert.deepEqual(tabIdsOf(s.f, MARKED_RULE_ID), [20], "rule 8 stays");
  assert.equal(updates(s.f).length, calls, "no rule update at a link change");
  assert.equal(s.r.map.current.operator, "*", "the last operator value stays");
  openPopup(s, { id: 9, source: 20 });
  await flush();
  assert.equal(s.r.map.isMarked(9), true);
  assert.deepEqual(tabIdsOf(s.f, MARKED_RULE_ID), [20, 9]);
});

test("the mark goes at the worker's start: every session rule goes (rule 8 too), and the tab is then a plain tab of no scope, judged by the union", async () => {
  const s = await setup({
    tabs: [blank(7), page(20, "https://z.example/"), page(21, "https://a.example/")],
    beforeStart: (f) => {
      f.sessionRules_ = [markedRule([20, 21])];
    },
    targets: [{ id: "T20", tabId: 20, type: "page" }],
  });
  assert.equal(s.r.map.isMarked(20), false);
  assert.equal(ruleOf(s.f, MARKED_RULE_ID), undefined);
  assert.deepEqual(s.f.tabs_.map((t) => t.id), [7, 21], "tab 20's page closed: no list of the union covers it");
});

// ---- the closing rule, the sweep and the guard's list ----

test("the closing rule for a marked tab: with \"*\" it never closes; with a list name, that list; with null, its http(s) page closes; the sweep never closes it", async () => {
  const s = await setup({ targets: [] });
  s.f.trackNewTabs = true;
  for (const id of [20, 21, 22, 23]) operatorTab(s, id);
  await flush();
  const at = (id, url) => {
    const t = s.f.tabs_.find((x) => x.id === id);
    t.url = url;
    delete t.pendingUrl;
  };
  at(20, "https://z.example/");
  at(21, "https://o.example/");
  at(22, "https://a.example/");
  at(23, "chrome://new-tab-page-third-party/");
  let r = await s.set(scopesWith("*"));
  assert.equal(r.closed, 0, "\"*\": no marked tab closes, also one off every list");
  r = await s.set(scopesWith("ops"));
  assert.equal(r.closed, 2, "ops: the pages off ops close");
  assert.deepEqual(s.f.tabs_.map((t) => t.id).sort((a, b) => a - b), [7, 21, 23]);
  r = await s.set(scopesWith(null));
  assert.equal(r.closed, 1, "null: the http(s) page closes; the New Tab page stays");
  assert.deepEqual(s.f.tabs_.map((t) => t.id).sort((a, b) => a - b), [7, 23]);
  // An applied set_scopes that gives no scope a list sweeps the agent tab, never the marked tab.
  r = await s.set({ lists: {}, scopes: {}, default: null, operator: null });
  assert.deepEqual(s.f.tabs_.map((t) => t.id), [23]);
});

test("at a set_scopes that is not applied the closing rule judges a marked tab by the last applied operator value; its rule 8 goes by the new one", async () => {
  const s = await setup();
  s.f.trackNewTabs = true;
  operatorTab(s, 20);
  await flush();
  Object.assign(s.f.tabs_.find((x) => x.id === 20), { url: "https://z.example/", pendingUrl: undefined });
  await assert.doesNotReject(s.set({ lists: LISTS, scopes: "md-lead", default: null, operator: null }));
  assert.equal(s.f.tabs_.some((t) => t.id === 20), true, "judged by the last applied \"*\"");
  assert.equal(ruleOf(s.f, MARKED_RULE_ID), undefined, "each new navigation fails closed");
  await s.set(scopesWith(null));
  assert.equal(s.f.tabs_.some((t) => t.id === 20), false);
});

test("the tab's list that the closing rule, the retry and the guard read: \"*\" for a marked tab with \"*\", the named list's entries, none with null", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  const by = (operator) => parseScopes(scopesWith(operator));
  assert.equal(s.r.tabList(20, by("*")), "*");
  assert.deepEqual(s.r.tabList(20, by("ops")), ["o.example"]);
  assert.equal(s.r.tabList(20, by(null)), null);
  assert.deepEqual(s.r.tabList(7, by("*")), ["a.example"], "a tab of a scope: its scope's list");
  assert.deepEqual(s.r.tabList(3, by("*")), ["a.example", "o.example"], "any other tab of no scope: the union");
});

// ---- the tab checks and the eager attach ----

test("the bridge never attaches, selects or closes a marked tab: not an agent tab; debugger.sendCommand gets not attached; tabs.get, debugger.detach and bridge.release stay allowed", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  const attaches = s.f.callsTo("debugger.attach").length;
  for (const [id, op, args] of [["a", "debugger.attach", [20]], ["u", "tabs.update", [20, { active: true }]], ["r", "tabs.remove", [20]]]) {
    const res = await s.answer({ id, op, args });
    assert.deepEqual([res.ok, res.error], [false, "not an agent tab"], op);
  }
  const cmd = await s.answer({ id: "c", op: "debugger.sendCommand", args: [{ tabId: 20 }, "Page.enable"] });
  assert.deepEqual([cmd.ok, cmd.error], [false, "not attached"]);
  for (const [id, op] of [["g", "tabs.get"], ["d", "debugger.detach"], ["b", "bridge.release"]]) {
    assert.equal((await s.answer({ id, op, args: [20] })).ok, true, op);
  }
  assert.equal(s.f.callsTo("debugger.attach").length, attaches, "no attach reached Chrome");
  assert.equal(s.f.tabs_.some((t) => t.id === 20), true);
});

test("the eager attach skips a marked tab: no attach, attached:false and held:false", async () => {
  const s = await setup({ eager: true });
  const before = s.evs().length;
  const attaches = s.f.callsTo("debugger.attach").length;
  operatorTab(s, 20);
  await flush();
  assert.deepEqual(created(s, 20, before).map((e) => [e.attached, e.held]), [[false, false]]);
  assert.equal(s.f.callsTo("debugger.attach").length, attaches);
  assert.equal(s.r.att.isBridgeTab(20), false);
});

test("a popup of a marked tab whose eager attach began before its navigation target: the attach ends, its hold ends, it is detached, and its tabs.onCreated says attached:false", async () => {
  const s = await setup({ eager: true });
  operatorTab(s, 20);
  await flush();
  const before = s.evs().length;
  openPopup(s, { id: 9, source: 20 });
  assert.equal(s.f.callsTo("debugger.attach").at(-1)[0].tabId, 9, "the eager attach began at tabs.onCreated");
  await flush();
  assert.equal(s.r.map.isMarked(9), true);
  assert.equal(s.r.att.isBridgeTab(9), false, "a marked tab is never a bridge tab");
  assert.deepEqual(s.f.callsTo("debugger.detach").at(-1), [{ tabId: 9 }]);
  assert.ok(s.f.callsTo("debugger.sendCommand").some(([t, m]) => t.tabId === 9 && m === "Fetch.disable"), "the hold ended");
  assert.deepEqual(created(s, 9, before).map((e) => [e.attached, e.held]), [[false, false]]);
  await s.fire(HOLD_MAX_MS);
  assert.equal(created(s, 9, before).length, 1);
});

// ---- the retry ----

test("the retry of a marked popup: with \"*\" every host is covered (one reload, no notice); with a list name, that list; with null, the notice", async () => {
  for (const [operator, url, reloaded] of [["*", "https://z.example/p", true], ["ops", "https://o.example/p", true], ["ops", "https://z.example/p", false], [null, "https://o.example/p", false]]) {
    const s = await setup({ operator });
    operatorTab(s, 20);
    await flush();
    const late = lateRules(s);
    openPopup(s, { id: 9, source: 20, url });
    await flush();
    block(s, 9, url);
    await flush();
    await late();
    await s.fire(RETRY_AFTER_MS);
    const note = `${operator} ${url}`;
    assert.deepEqual(s.f.callsTo("tabs.reload"), reloaded ? [[9]] : [], note);
    assert.deepEqual(s.notices().map((n) => n.host), reloaded ? [] : [new URL(url).hostname], note);
  }
});

test("a marked popup that closes while its reload waits gets no reload", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await s.fire(50);
  const late = lateRules(s);
  openPopup(s, { id: 9, source: 20 });
  await flush();
  block(s, 9, "https://z.example/p");
  await late();
  assert.equal(s.pending(RETRY_AFTER_MS).length, 1, "the reload is planned");
  s.f.closeTab(9);
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(s.f.callsTo("tabs.reload"), [], "a popup that closed gets no reload");
});
