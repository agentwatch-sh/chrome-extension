// Popups and the retry in the receiver (part 1b, board ab-v16.32): a popup takes its opener's scope
// in webNavigation.onCreatedNavigationTarget (sourceTabId, never openerTabId), bridge.tabScope comes
// before its tabs.onCreated, the retry of a first request that its late rule blocked (and the blocked
// notice that waits for that decision), and the hold of a popup's tabs.onCreated while the eager
// attach is on, with every end condition of C10 (the per-scope design, section 5.2). Also the popup
// cases of the orphan-tabs design: a popup of a tab of the orphan set or of a scope with no list
// closes at once; a popup of an opener that left the map takes its kept scope for TOMBSTONE_MS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Bridge } from "../agent/bridge.js";
import { HOLD_MAX_MS } from "../agent/hold.js";
import { receiver } from "../agent/receiver.js";
import { makeFakeChrome } from "./fake-chrome.mjs";
import { NEW_TAB_WAIT_MS, RETRY_AFTER_MS, RETRY_START_MS, RULE_QUIET_MS } from "../agent/popups.js";
import { TOMBSTONE_MS } from "../agent/tabmap.js";
import { flush, startReceiver } from "./receiver-harness.mjs";

const B = JSON.parse(readFileSync(new URL("./vectors/bridge.json", import.meta.url), "utf8"));
const vectorEv = (pred) => B.eventVectors.find((v) => pred(v.ev, v)).ev;
const TAB_SCOPE_9 = vectorEv((e) => e.ev === "bridge.tabScope" && e.tabId === 9);
const NAV_TARGET = B.eventVectors.find((v) => v.chrome && v.chrome[0] === "webNavigation.onCreatedNavigationTarget");
const POPUP = B.eventVectors.find((v) => v.chrome && v.chrome[0] === "tabs.onCreated" && v.chrome[1][0].id === 9).chrome[1][0];
const BLOCKED = "net::ERR_BLOCKED_BY_CLIENT";
const URL_A = "https://a.example/popup";

const blank = (id, windowId = 1) => ({ id, windowId, url: "about:blank" });
// A blocked notice (C4): the tab's scope when it goes (B.scope: the popup took tab 7's), and its from
// (null: no page of the tab or its opener committed in these tests).
const notice = (tab, host, scope = B.scope, from = null) => ({ t: "blocked", tab, host, scope, from });
const ev = (name, fields) => ({ t: "ev", ch: "bridge", ev: name, ...fields });
const names = (s, from) => s.evs().slice(from).map((e) => (e.ev === "bridge.tabScope" ? `${e.ev}:${e.tabId}:${e.scope}` : `${e.ev}:${e.tabId ?? e.tab?.id ?? e.details?.tabId}`));
const created = (s, tabId, from = 0) => s.evs().slice(from).filter((e) => e.ev === "tabs.onCreated" && e.tab.id === tabId);
const reloads = (s) => s.f.callsTo("tabs.reload");
const paused = (requestId, tabId = 9, url = URL_A) => ({ requestId, request: { url, method: "GET" }, frameId: "F" + tabId, resourceType: "Document" });

// The receiver with the vector's set_scopes (my-repo has list md: a.example; md-gone has none) and a
// fixed clock. Tab 7 has scope my-repo (from the copy), tab 3 has no scope.
async function popupSetup({ eager = false, tabs = [blank(7), blank(3)], copy = { "tab:7": B.scope }, scopes = B.setScopes, targets = [], chromeEdit } = {}) {
  const s = await startReceiver({ tabs, copy, scopes, targets, chromeEdit });
  let now = 1000;
  s.r.clock.now = () => now;
  s.advance = (ms) => {
    now += ms;
  };
  if (eager) await s.answer({ id: "on", op: "bridge.attachNew", args: [true] });
  return s;
}

// Chrome opens a popup of source: tabs.onCreated, then webNavigation.onCreatedNavigationTarget
// (measured: 0 to 1 ms after it), in the same task.
function openPopup(s, { id = 9, source = 7, url = URL_A, opener = source, navTarget = true } = {}) {
  const tab = { ...POPUP, id, openerTabId: opener, pendingUrl: url };
  s.f.tabs_.push({ id, windowId: 1, url: "", pendingUrl: url });
  s.f.targets_.push({ id: "F" + id, tabId: id, type: "page", attached: false });
  s.f.chrome.tabs.onCreated.fire(structuredClone(tab));
  if (navTarget) navTargetOf(s, id, source, url);
  return tab;
}

function navTargetOf(s, id, source, url = URL_A) {
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ ...NAV_TARGET.chrome[1][0], sourceTabId: source, tabId: id, url });
}

const nav = (s, event, tabId, url, more = {}) => s.f.chrome.webNavigation[event].fire({ tabId, frameId: 0, url, ...more });
// webRequest's view of a blocked main-frame request (its method); Chrome sends it before webNavigation's error (measured).
const requestError = (s, tabId, url, method) => s.f.chrome.webRequest.onErrorOccurred.fire({ tabId, frameId: 0, type: "main_frame", url, method, error: BLOCKED });
const block = (s, tabId, url = URL_A, method = "GET") => {
  if (method !== null) requestError(s, tabId, url, method);
  nav(s, "onErrorOccurred", tabId, url, { error: BLOCKED });
};
const closeTab = (s, tabId) => s.f.closeTab(tabId);

// A DNR update as the fake makes it (all or nothing).
const applyRules = (rules, { removeRuleIds = [], addRules = [] } = {}) => [...rules.filter((r) => !removeRuleIds.includes(r.id)), ...structuredClone(addRules)];

// Every updateSessionRules waits until release(): the popup's rule comes late.
function lateRules(s) {
  const waiting = [];
  s.f.impl["declarativeNetRequest.updateSessionRules"] = (d) => new Promise((resolve, reject) => waiting.push({ d, resolve, reject }));
  return async (fail = false) => {
    delete s.f.impl["declarativeNetRequest.updateSessionRules"];
    for (const w of waiting.splice(0)) {
      if (fail) {
        w.reject(new Error("Session rule count exceeded."));
        continue;
      }
      s.f.sessionRules_ = applyRules(s.f.sessionRules_, w.d);
      w.resolve();
    }
    await flush();
  };
}

// ---- a popup takes its opener's scope ----

test("a popup takes the scope of its sourceTabId (never openerTabId): in the map in the handler, before the rule update; bridge.tabScope, the event, then its tabs.onCreated; its key and its rule follow", async () => {
  const s = await popupSetup({
    tabs: [blank(7), blank(8), blank(3)],
    copy: { "tab:7": B.scope, "tab:8": "vedlo-x" },
    scopes: { lists: { md: ["a.example"], v: ["b.example"] }, scopes: { [B.scope]: "md", "vedlo-x": "v" }, default: null },
  });
  const before = s.evs().length;
  const rulesBefore = s.f.callsTo("declarativeNetRequest.updateSessionRules").length;
  // Chrome's openerTabId names the active tab (tab 8, another scope); sourceTabId names the opener.
  openPopup(s, { opener: 8 });
  assert.equal(s.r.map.scopeOf(9), B.scope, "the entry is in the map when the handler returns");
  assert.equal(s.f.callsTo("declarativeNetRequest.updateSessionRules").length, rulesBefore, "the rule update comes after the entry");
  await flush();
  assert.deepEqual(s.evs().slice(before), [
    TAB_SCOPE_9,
    NAV_TARGET.ev,
    ev("tabs.onCreated", { tab: { ...POPUP, openerTabId: 8 }, attached: false, held: false }),
  ]);
  assert.equal(s.f.storage_.session["tab:9"], B.scope, "its key is in the copy");
  assert.deepEqual(s.f.sessionRules_.find((r) => r.id === 100).condition.tabIds, [7, 9], "its list's rules name it");
  assert.equal(s.r.map.scopeOf(8), "vedlo-x");
});

test("a popup of a tab of no scope gets no scope: no entry, no key, no bridge.tabScope; it fails closed", async () => {
  const s = await popupSetup();
  const before = s.evs().length;
  openPopup(s, { source: 3 });
  await flush();
  assert.equal(s.r.map.has(9), false);
  assert.equal(Object.hasOwn(s.f.storage_.session, "tab:9"), false);
  assert.deepEqual(names(s, before), ["webNavigation.onCreatedNavigationTarget:9", "tabs.onCreated:9"]);
  assert.equal(s.r.map.isOrphan(9), false, "a tab of no scope, not of the orphan set");
});

test("a popup that closed before its handler ran gets no entry (no stale entry)", async () => {
  const s = await popupSetup();
  openPopup(s, { navTarget: false });
  closeTab(s, 9);
  const before = s.evs().length;
  navTargetOf(s, 9, 7);
  await flush();
  assert.equal(s.r.map.has(9), false);
  assert.equal(Object.hasOwn(s.f.storage_.session, "tab:9"), false);
  assert.equal(s.r.map.isOrphan(9), false);
  assert.equal(s.r.popups.has(9), false, "no popup state for a tab that closed");
  assert.deepEqual(names(s, before), ["webNavigation.onCreatedNavigationTarget:9"]);
});

test("the worker-start exception: before the first applied set_scopes a popup enters the map with its opener's scope and gets its bridge.tabScope", async () => {
  const s = await popupSetup({ scopes: null, copy: { "tab:7": "md-gone" } });
  const before = s.evs().length;
  openPopup(s);
  await flush();
  assert.equal(s.r.map.scopeOf(9), "md-gone");
  assert.deepEqual(names(s, before).slice(0, 1), ["bridge.tabScope:9:md-gone"]);
  // That set_scopes sweeps it with its opener.
  await s.set(B.setScopes);
  assert.equal(s.f.tabs_.some((t) => t.id === 9 || t.id === 7), false);
});

// ---- the orphan-tabs design: popups of the sweep, of the orphan set, of a kept entry ----

test("a popup of a tab of the orphan set joins the set and closes at once: no entry, no key, no bridge.tabScope", async () => {
  const s = await popupSetup({ scopes: null, tabs: [blank(7), blank(13), blank(3)], copy: { "tab:7": B.scope, "tab:13": "md-gone" } });
  s.f.impl["debugger.getTargets"] = async () => [];
  s.f.impl["tabs.remove"] = async (id) => {
    if (id === 13) throw new Error("Tab 13 holds a dialog");
    s.f.closeTab(id);
  };
  await s.set(B.setScopes);
  delete s.f.impl["debugger.getTargets"];
  delete s.f.impl["tabs.remove"];
  assert.equal(s.r.map.isOrphan(13), true);
  const before = s.evs().length;
  openPopup(s, { source: 13 });
  await flush();
  assert.equal(s.r.map.has(9), false);
  assert.equal(Object.hasOwn(s.f.storage_.session, "tab:9"), false);
  assert.equal(s.f.tabs_.some((t) => t.id === 9), false, "closed by the receiver's close");
  assert.ok(!s.evs().slice(before).some((e) => e.ev === "bridge.tabScope"));
});

test("a popup of a tab that the sweep closes: during the sweep, and from the closed opener's kept entry, it joins the orphan set and closes", async () => {
  const s = await popupSetup({
    tabs: [blank(7), blank(14), blank(15), blank(3)],
    copy: { "tab:7": B.scope, "tab:14": "md-x", "tab:15": "md-x" },
    scopes: { lists: { md: ["a.example"] }, scopes: { [B.scope]: "md", "md-x": "md" }, default: null },
  });
  // The sweep's query waits: the new object (md-x has no list) is the reference from its rule update on.
  let query;
  s.f.impl["tabs.query"] = () => new Promise((r) => (query = r));
  const swept = s.set(B.setScopes);
  await flush();
  assert.equal(typeof query, "function", "the sweep's item waits for its query");
  const before = s.evs().length;
  openPopup(s, { id: 16, source: 14 });
  await flush();
  assert.equal(s.r.map.has(16), false, "a popup of the ending scope never enters the map");
  assert.equal(s.r.map.isOrphan(16), true);
  delete s.f.impl["tabs.query"];
  query(s.f.tabs_.map((t) => ({ ...t })));
  await swept;
  await flush();
  assert.deepEqual(s.f.tabs_.map((t) => t.id).filter((id) => id >= 14), [], "the sweep closed tabs 14 and 15, and the popup of the orphan set");
  // A popup of tab 14, which the sweep closed a moment ago: its kept entry names md-x, which has no list.
  openPopup(s, { id: 17, source: 14 });
  await flush();
  assert.equal(s.r.map.has(17), false);
  assert.equal(s.f.tabs_.some((t) => t.id === 17), false);
  assert.ok(!s.evs().slice(before).some((e) => e.ev === "bridge.tabScope"));
});

test("a popup of an opener that left the map takes its kept scope for TOMBSTONE_MS, then no scope", async () => {
  const s = await popupSetup();
  closeTab(s, 7); // for example a page that closes itself right after window.open
  const before = s.evs().length;
  openPopup(s, { id: 9, source: 7 });
  await flush();
  assert.equal(s.r.map.scopeOf(9), B.scope);
  assert.deepEqual(names(s, before)[0], `bridge.tabScope:9:${B.scope}`);
  s.advance(TOMBSTONE_MS);
  openPopup(s, { id: 10, source: 7 });
  await flush();
  assert.equal(s.r.map.has(10), false, "after TOMBSTONE_MS the opener's kept entry is gone");
});

// ---- tabs.onCreated while the eager attach is off ----

test("eager attach off: a new tab's tabs.onCreated waits NEW_TAB_WAIT_MS for its navigation target; a navigation target lets it go at once, also one that came first; a tab that closes meanwhile gets none", async () => {
  const s = await popupSetup();
  assert.equal(NEW_TAB_WAIT_MS, 50);
  let before = s.evs().length;
  // A tab that no page opened: its tabs.onCreated comes NEW_TAB_WAIT_MS late.
  s.f.chrome.tabs.onCreated.fire({ id: 20, windowId: 1, url: "", pendingUrl: "chrome://newtab/" });
  await flush();
  assert.deepEqual(s.evs().slice(before), []);
  assert.equal(s.pending(NEW_TAB_WAIT_MS).length, 1);
  await s.fire(NEW_TAB_WAIT_MS);
  assert.deepEqual(s.evs().slice(before), [ev("tabs.onCreated", { tab: { id: 20, windowId: 1, url: "", pendingUrl: "chrome://newtab/" }, attached: false, held: false })]);
  // A tab that closes while its tabs.onCreated waits gets none.
  before = s.evs().length;
  s.f.chrome.tabs.onCreated.fire({ id: 21, windowId: 1, url: "" });
  s.f.chrome.tabs.onRemoved.fire(21, { windowId: 1, isWindowClosing: false });
  await s.fire(NEW_TAB_WAIT_MS);
  assert.deepEqual(names(s, before), ["tabs.onRemoved:21"]);
  // The navigation target first, then tabs.onCreated: it goes at once.
  before = s.evs().length;
  s.f.tabs_.push({ id: 22, windowId: 1, url: "" });
  navTargetOf(s, 22, 7);
  s.f.chrome.tabs.onCreated.fire({ id: 22, windowId: 1, url: "" });
  await flush();
  assert.deepEqual(names(s, before), [`bridge.tabScope:22:${B.scope}`, "webNavigation.onCreatedNavigationTarget:22", "tabs.onCreated:22"]);
  assert.equal(s.pending(NEW_TAB_WAIT_MS).length, 0);
});

// ---- the hold of a popup's tabs.onCreated while the eager attach is on ----

// An eager popup with its hold on: its tabs.onCreated is held.
async function heldPopup(s, opts = {}) {
  const before = s.evs().length;
  const tab = openPopup(s, opts);
  await flush();
  assert.deepEqual(created(s, tab.id, before), [], "its tabs.onCreated is held");
  assert.ok(s.r.att.isBridgeTab(tab.id), "the eager attach attached it and its hold is on");
  return { tab, before };
}

test("the hold: a popup's tabs.onCreated waits until its first document request is allowed (the hold pauses it), and it carries the tab's state of then (tabs.get)", async () => {
  const s = await popupSetup({ eager: true });
  const { before } = await heldPopup(s);
  assert.deepEqual(names(s, before), [`bridge.tabScope:9:${B.scope}`, "webNavigation.onCreatedNavigationTarget:9"], "bridge.tabScope before its tabs.onCreated");
  s.f.tabs_.find((t) => t.id === 9).url = URL_A;
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  await flush();
  assert.deepEqual(created(s, 9, before), [ev("tabs.onCreated", { tab: { id: 9, windowId: 1, url: URL_A, pendingUrl: URL_A }, attached: true, held: true })]);
  assert.deepEqual(s.f.callsTo("tabs.get").at(-1), [9]);
});

test("the hold: a request that the hold paused before the event's hold began ends it at once", async () => {
  const s = await popupSetup({ eager: true });
  let enabled;
  s.f.impl["debugger.sendCommand"] = (t, m) => (m === "Fetch.enable" ? new Promise((r) => (enabled = r)) : Promise.resolve({}));
  const before = s.evs().length;
  openPopup(s);
  await flush();
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  enabled({});
  await flush();
  assert.equal(created(s, 9, before).length, 1);
});

test("the hold: 50 ms from the rule with no main-frame navigation ends it (a popup that stays at about:blank); about:blank does not count; a navigation that started stops that timer", async () => {
  const s = await popupSetup({ eager: true });
  assert.equal(RULE_QUIET_MS, 50);
  let { before } = await heldPopup(s, { url: "about:blank" });
  nav(s, "onBeforeNavigate", 9, "about:blank");
  assert.equal(s.pending(RULE_QUIET_MS).length, 1);
  await s.fire(RULE_QUIET_MS);
  assert.equal(created(s, 9, before).length, 1);
  // A navigation that started before the rule: no timer; HOLD_MAX_MS ends the hold.
  const late = lateRules(s);
  ({ before } = await heldPopup(s, { id: 10 }));
  nav(s, "onBeforeNavigate", 10, URL_A);
  await late();
  assert.equal(s.pending(RULE_QUIET_MS).length, 0, "the navigation stopped the timer");
  await s.fire(HOLD_MAX_MS);
  assert.equal(created(s, 10, before).length, 1);
  // A navigation that starts while the timer runs stops it.
  ({ before } = await heldPopup(s, { id: 11 }));
  assert.equal(s.pending(RULE_QUIET_MS).length, 1);
  nav(s, "onBeforeNavigate", 11, URL_A);
  assert.equal(s.pending(RULE_QUIET_MS).length, 0);
  await s.fire(RULE_QUIET_MS);
  assert.equal(created(s, 11, before).length, 0);
});

test("the hold: a main-frame commit with no network request ends it (a blob: URL), not an about:blank commit", async () => {
  const s = await popupSetup({ eager: true });
  const { before } = await heldPopup(s);
  nav(s, "onBeforeNavigate", 9, URL_A);
  nav(s, "onCommitted", 9, "about:blank");
  await flush();
  assert.equal(created(s, 9, before).length, 0);
  nav(s, "onCommitted", 9, "blob:https://a.example/5c1d");
  await flush();
  assert.equal(created(s, 9, before).length, 1);
});

test("the hold: HOLD_MAX_MS after tabs.onCreated ends it; a popup that closes while held gets no tabs.onCreated (also during its tabs.get)", async () => {
  const s = await popupSetup({ eager: true });
  let { before } = await heldPopup(s);
  nav(s, "onBeforeNavigate", 9, URL_A);
  await s.fire(HOLD_MAX_MS);
  assert.equal(created(s, 9, before).length, 1);
  // Closed while held.
  ({ before } = await heldPopup(s, { id: 10 }));
  closeTab(s, 10);
  s.f.chrome.debugger.onEvent.fire({ tabId: 10 }, "Fetch.requestPaused", paused("h2", 10));
  await s.fire(HOLD_MAX_MS);
  assert.deepEqual(names(s, before).filter((n) => n.split(":")[1] === "10"), [`bridge.tabScope:10:${B.scope}`, "webNavigation.onCreatedNavigationTarget:10", "tabs.onRemoved:10"]);
  // Closed while its release reads the tab.
  ({ before } = await heldPopup(s, { id: 11 }));
  let got;
  s.f.impl["tabs.get"] = () => new Promise((r) => (got = r));
  s.f.chrome.debugger.onEvent.fire({ tabId: 11 }, "Fetch.requestPaused", paused("h3", 11));
  await flush();
  closeTab(s, 11);
  got({ id: 11 });
  await flush();
  assert.equal(created(s, 11, before).length, 0);
});

test("the hold: only a popup whose hold is on; held:false and a tab that no page opened get their tabs.onCreated when the eager attach ends", async () => {
  const s = await popupSetup({ eager: true });
  s.f.impl["debugger.sendCommand"] = async (t, m) => {
    if (m === "Fetch.enable") throw new Error("No tab with given id 9.");
    return {};
  };
  let before = s.evs().length;
  openPopup(s);
  await flush();
  assert.deepEqual(created(s, 9, before).map((e) => [e.attached, e.held]), [[true, false]]);
  delete s.f.impl["debugger.sendCommand"];
  before = s.evs().length;
  s.f.tabs_.push({ id: 12, windowId: 1, url: "" });
  s.f.chrome.tabs.onCreated.fire({ id: 12, windowId: 1, url: "" });
  await flush();
  assert.deepEqual(created(s, 12, before).map((e) => [e.attached, e.held]), [[true, true]]);
});

test("the hold: a link change drops a held tabs.onCreated (the new relay reads the tabs from the ops)", async () => {
  const s = await popupSetup({ eager: true });
  const { before } = await heldPopup(s);
  s.port().fireMessage({ t: "link", up: true });
  await flush();
  await s.answer({ id: "i2", op: "bridge.info", args: [] });
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  await s.fire(HOLD_MAX_MS);
  assert.equal(created(s, 9, before).length, 0);
});

// ---- the retry ----

test("the retry: the first request of a covered host that the late rule blocked gets one tabs.reload, at the later of the rule's end and the error plus 50 ms; no blocked notice; the held tabs.onCreated waits for the retry's request", async () => {
  assert.equal(RETRY_AFTER_MS, 50);
  const s = await popupSetup({ eager: true });
  const late = lateRules(s);
  const { before } = await heldPopup(s);
  nav(s, "onBeforeNavigate", 9, URL_A);
  block(s, 9);
  await flush();
  s.advance(10);
  await late();
  assert.deepEqual(reloads(s), [], "not before the error plus 50 ms");
  assert.equal(s.pending(40).length, 1, "the reload waits 40 ms more");
  await s.fire(40);
  assert.deepEqual(reloads(s), [[9]]);
  assert.equal(created(s, 9, before).length, 0, "still held");
  nav(s, "onBeforeNavigate", 9, URL_A);
  s.f.chrome.debugger.onEvent.fire({ tabId: 9 }, "Fetch.requestPaused", paused("h1"));
  await flush();
  assert.equal(created(s, 9, before).length, 1, "the retry's request is in the hold");
  // The reload's navigation started: the hold keeps its request, and RETRY_START_MS sends nothing.
  await s.fire(RETRY_START_MS);
  nav(s, "onCommitted", 9, URL_A);
  await flush();
  assert.deepEqual(s.notices(), [], "no blocked notice for a retried request");
  assert.deepEqual(reloads(s), [[9]], "one reload");
});

test("the retry: a rule that ends more than 50 ms after the error reloads at its end; an error after the rule reloads 50 ms after the error", async () => {
  const s = await popupSetup();
  const late = lateRules(s);
  openPopup(s);
  await flush();
  block(s, 9);
  s.advance(70);
  await late();
  assert.deepEqual(reloads(s), [[9]], "at the rule's end");
  const t = await popupSetup();
  openPopup(t);
  await flush();
  block(t, 9);
  await flush();
  assert.deepEqual(reloads(t), []);
  await t.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(t), [[9]]);
  assert.deepEqual([...s.notices(), ...t.notices()], []);
});

test("no retry: a host off the list (the notice at the rule's end, which ends the hold), a failed rule update, a popup of no scope, a tab that is no popup", async () => {
  const s = await popupSetup({ eager: true });
  const late = lateRules(s);
  let { before } = await heldPopup(s);
  block(s, 9, "https://b.example/x");
  await flush();
  assert.deepEqual(s.notices(), [], "the notice waits for the decision");
  await late();
  assert.deepEqual(s.notices(), [notice(9, "b.example")]);
  assert.equal(created(s, 9, before).length, 1, "the decision to send blocked ends the hold");
  // A failed rule update: the tab is not under its list.
  const fail = lateRules(s);
  openPopup(s, { id: 10 });
  await flush();
  block(s, 10);
  await fail(true);
  assert.deepEqual(s.notices().at(-1), notice(10, "a.example"));
  // A popup of no scope: the notice at once; its hold ends.
  ({ before } = await heldPopup(s, { id: 11, source: 3 }));
  block(s, 11);
  await flush();
  assert.deepEqual(s.notices().at(-1), notice(11, "a.example", null), "a tab of no scope: scope null");
  assert.equal(created(s, 11, before).length, 1);
  // A tab that is no popup: the notice at once.
  block(s, 7);
  assert.deepEqual(s.notices().at(-1), notice(7, "a.example"));
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
});

test("the retry once per tab: a retried request that is blocked again sends blocked, with no second retry; a later block of a popup that loaded sends blocked at once", async () => {
  const s = await popupSetup({ eager: true });
  const { before } = await heldPopup(s);
  nav(s, "onBeforeNavigate", 9, URL_A);
  block(s, 9);
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), [[9]]);
  nav(s, "onBeforeNavigate", 9, URL_A);
  block(s, 9);
  await flush();
  assert.deepEqual(s.notices(), [notice(9, "a.example")], "blocked again");
  assert.equal(created(s, 9, before).length, 1, "the decision ends the hold");
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), [[9]], "no second retry");
  // A popup whose first request loaded: no retry later.
  openPopup(s, { id: 10 });
  await flush();
  nav(s, "onBeforeNavigate", 10, URL_A);
  nav(s, "onCommitted", 10, URL_A);
  block(s, 10, "https://a.example/next");
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(s.notices().at(-1), notice(10, "a.example", B.scope, "a.example"), "from: the host of the page that the tab committed");
  assert.deepEqual(reloads(s), [[9]]);
});

test("the retry that starts no request sends blocked: no onBeforeNavigate of the URL within 1 s, or another error; a late onBeforeNavigate changes nothing", async () => {
  const s = await popupSetup({ eager: true });
  const { before } = await heldPopup(s);
  nav(s, "onBeforeNavigate", 9, URL_A);
  block(s, 9);
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), [[9]]);
  assert.deepEqual(s.notices(), []);
  assert.equal(RETRY_START_MS, 1000);
  await s.fire(RETRY_START_MS);
  assert.deepEqual(s.notices(), [notice(9, "a.example")]);
  assert.equal(created(s, 9, before).length, 1, "the decision ends the hold");
  nav(s, "onBeforeNavigate", 9, URL_A);
  nav(s, "onCommitted", 9, URL_A);
  await flush();
  assert.equal(s.notices().length, 1);
  // Another error of the reload's navigation.
  openPopup(s, { id: 10 });
  await flush();
  nav(s, "onBeforeNavigate", 10, URL_A);
  block(s, 10);
  await s.fire(RETRY_AFTER_MS);
  nav(s, "onBeforeNavigate", 10, URL_A);
  nav(s, "onErrorOccurred", 10, URL_A, { error: "net::ERR_CACHE_MISS" });
  await flush();
  assert.deepEqual(s.notices().at(-1), notice(10, "a.example"));
  await s.fire(RETRY_START_MS);
  assert.equal(s.notices().length, 2);
});

test("a popup that closes while its retry waits gets no reload; one that leaves its scope gets the notice in place of the reload", async () => {
  const s = await popupSetup();
  openPopup(s);
  await flush();
  block(s, 9);
  closeTab(s, 9);
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices(), []);
  // Its scope ends while the reload waits: the sweep closes it (the close fails: it joins the orphan set).
  openPopup(s, { id: 10 });
  await flush();
  block(s, 10);
  s.f.impl["debugger.getTargets"] = async () => [];
  s.f.impl["tabs.remove"] = async () => {
    throw new Error("held");
  };
  await s.set({ lists: B.setScopes.lists, scopes: { "md-gone": null }, default: null });
  delete s.f.impl["debugger.getTargets"];
  delete s.f.impl["tabs.remove"];
  assert.equal(s.r.map.isOrphan(10), true);
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices(), [notice(10, "a.example", null)], "scope: the tab's scope when the notice goes (the orphan set: none)");
});

test("a page that commits while the retry waits: the first request stays blocked, its notice goes, and no reload comes", async () => {
  const s = await popupSetup();
  const late = lateRules(s);
  openPopup(s);
  await flush();
  block(s, 9);
  nav(s, "onBeforeNavigate", 9, "https://a.example/other");
  nav(s, "onCommitted", 9, "https://a.example/other");
  await flush();
  assert.deepEqual(s.notices(), [notice(9, "a.example")]);
  await late();
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.equal(s.notices().length, 1);
});

// The lead's decision on PR #21's question 1: Chrome's tabs.reload of a blocked POST opens its "Confirm
// Form Resubmission" dialog, which waits for a person. So the retry reloads a GET only (the method from
// webRequest), and a form that posts into a new tab fails closed with its notice, with no dialog.
test("the retry reloads a GET only: a blocked POST (a form into a new tab) gets no reload and sends its notice at the decision, which ends the hold", async () => {
  const s = await popupSetup({ eager: true });
  const late = lateRules(s);
  const { before } = await heldPopup(s);
  nav(s, "onBeforeNavigate", 9, URL_A);
  block(s, 9, URL_A, "POST");
  await flush();
  assert.deepEqual(s.notices(), [], "the notice waits for the decision at the rule's end");
  await late();
  assert.deepEqual(s.notices(), [notice(9, "a.example")]);
  assert.equal(created(s, 9, before).length, 1, "the decision ends the hold at once");
  await s.fire(RETRY_AFTER_MS);
  await s.fire(RETRY_START_MS);
  assert.deepEqual(reloads(s), [], "no reload: no dialog");
  assert.equal(s.notices().length, 1);
  // The GET of a form (or a link, window.open) keeps its retry.
  openPopup(s, { id: 10 });
  await flush();
  block(s, 10, URL_A + "?q=1", "GET");
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), [[10]]);
});

test("the method fails closed: a blocked request whose method the receiver did not see by the reload's time, or saw for another URL, gets no reload; a POST seen after the error still stops it", async () => {
  const s = await popupSetup();
  openPopup(s);
  await flush();
  block(s, 9, URL_A, null); // no webRequest event
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices(), [notice(9, "a.example")]);
  // A webRequest event of another URL of the tab.
  openPopup(s, { id: 10 });
  await flush();
  requestError(s, 10, "https://a.example/other", "GET");
  block(s, 10, URL_A, null);
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices().at(-1), notice(10, "a.example"));
  // The webRequest event of a POST that comes after webNavigation's error, before the reload.
  openPopup(s, { id: 11 });
  await flush();
  block(s, 11, URL_A, null);
  requestError(s, 11, URL_A, "POST");
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices().at(-1), notice(11, "a.example"));
  // After a GET block, a webRequest event that is not a block, or of a frame, changes nothing: the GET keeps its reload.
  openPopup(s, { id: 12 });
  await flush();
  block(s, 12, URL_A, "GET");
  s.f.chrome.webRequest.onErrorOccurred.fire({ tabId: 12, frameId: 0, type: "main_frame", url: URL_A, method: "POST", error: "net::ERR_ABORTED" });
  s.f.chrome.webRequest.onErrorOccurred.fire({ tabId: 12, frameId: 3, type: "sub_frame", url: URL_A, method: "POST", error: BLOCKED });
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), [[12]]);
  // A method that is neither GET nor POST gets no reload either.
  openPopup(s, { id: 13 });
  await flush();
  block(s, 13, URL_A, "PUT");
  assert.deepEqual(s.notices().at(-1), notice(13, "a.example"), "at the decision, not at the reload's time");
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), [[12]]);
  assert.deepEqual(s.notices().at(-1), notice(13, "a.example"));
});

// ---- review-21's notes: the paths that no test reached ----

test("the navigation-target handler waits for the restore: the popup takes its scope from the restored map; meanwhile its tabs.onCreated waits for that scope, and a block sends its notice at once (no scope known: no retry)", async () => {
  const f = makeFakeChrome();
  f.manifest = { version: "0.3.1" };
  f.setTabs([blank(7), blank(3)]);
  let give;
  f.impl["storage.session.get"] = () => new Promise((r) => (give = r));
  const setTimer = () => ({});
  const clearTimer = () => {};
  const sent = [];
  const link = { eventsOpen: () => true, sendEvent: (ev) => sent.push(ev) > 0 };
  void new Bridge(f.chrome, link, { setTimer, clearTimer });
  const r = receiver(f.chrome);
  r.notify = (m) => sent.push(m);
  const started = r.startup();
  f.tabs_.push({ id: 9, windowId: 1, url: "" });
  // The navigation target first (the eager attach is off), then Chrome's tabs.onCreated.
  f.chrome.webNavigation.onCreatedNavigationTarget.fire({ ...NAV_TARGET.chrome[1][0], sourceTabId: 7, tabId: 9 });
  f.chrome.tabs.onCreated.fire({ id: 9, windowId: 1, url: "" });
  await flush();
  assert.equal(r.map.has(9), false, "the handler waits for the restore");
  assert.deepEqual(sent, [], "no bridge.tabScope, no navigation target and no tabs.onCreated before the popup's scope");
  f.chrome.webNavigation.onErrorOccurred.fire({ tabId: 9, frameId: 0, url: URL_A, error: BLOCKED });
  assert.deepEqual(sent.filter((m) => m.t === "blocked"), [notice(9, "a.example", null)], "no retry for a popup whose scope is not known yet");
  give({ "tab:7": B.scope });
  await started;
  await flush();
  assert.equal(r.map.scopeOf(9), B.scope, "the opener's scope from the restored copy");
  assert.deepEqual(sent.filter((m) => m.t === "ev" && m.ev !== "webNavigation.onErrorOccurred").map((m) => m.ev),
    ["bridge.tabScope", "webNavigation.onCreatedNavigationTarget", "tabs.onCreated"]);
  assert.deepEqual(f.callsTo("tabs.reload"), []);
});

test("the reload's own navigation is the one of the blocked URL: another URL's onBeforeNavigate after the reload does not count, and RETRY_START_MS sends the notice", async () => {
  const s = await popupSetup();
  openPopup(s);
  await flush();
  block(s, 9);
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), [[9]]);
  nav(s, "onBeforeNavigate", 9, "https://a.example/elsewhere");
  await s.fire(RETRY_START_MS);
  assert.deepEqual(s.notices(), [notice(9, "a.example")]);
});

test("the hold: an end condition that came during the eager attach ends the event's hold as soon as it begins (a decision to send blocked)", async () => {
  const s = await popupSetup({ eager: true });
  let attached;
  s.f.impl["debugger.attach"] = () => new Promise((r) => (attached = r));
  const before = s.evs().length;
  openPopup(s);
  await flush();
  block(s, 9, "https://b.example/x"); // a host off the list: the rule has ended, so the decision comes at once
  await flush();
  assert.deepEqual(s.notices(), [notice(9, "b.example")]);
  assert.equal(created(s, 9, before).length, 0, "the eager attach still runs");
  attached();
  await flush();
  assert.deepEqual(created(s, 9, before).map((e) => e.held), [true], "it goes at once, with no timer");
});

test("the hold: RULE_QUIET_MS counts from the rule's end, also when the event's hold begins later; a failed rule update arms no timer", async () => {
  const s = await popupSetup({ eager: true });
  let attached;
  s.f.impl["debugger.attach"] = () => new Promise((r) => (attached = r));
  openPopup(s, { url: "about:blank" });
  await flush(); // the rule is in force now
  s.advance(30);
  attached();
  await flush();
  assert.equal(s.pending(RULE_QUIET_MS - 30).length, 1, "20 ms are left of the 50");
  assert.equal(s.pending(RULE_QUIET_MS).length, 0);
  delete s.f.impl["debugger.attach"];
  const fail = lateRules(s);
  const { before } = await heldPopup(s, { id: 10, url: "about:blank" });
  await fail(true);
  assert.equal(s.pending(RULE_QUIET_MS).length, 0, "no rule in force: no timer");
  assert.equal(created(s, 10, before).length, 0);
  await s.fire(HOLD_MAX_MS);
  assert.equal(created(s, 10, before).length, 1, "HOLD_MAX_MS ends it");
});

test("the hold: a main-frame navigation that started before the navigation target stops RULE_QUIET_MS too", async () => {
  const s = await popupSetup({ eager: true });
  const before = s.evs().length;
  openPopup(s, { navTarget: false });
  nav(s, "onBeforeNavigate", 9, URL_A);
  navTargetOf(s, 9, 7);
  await flush();
  assert.ok(s.r.att.isBridgeTab(9));
  assert.equal(s.pending(RULE_QUIET_MS).length, 0);
  assert.equal(created(s, 9, before).length, 0, "still held");
});

test("a replaced popup's state goes: its held tabs.onCreated never comes, and its planned reload neither runs nor sends a notice", async () => {
  const s = await popupSetup({ eager: true });
  const { before } = await heldPopup(s);
  nav(s, "onBeforeNavigate", 9, URL_A);
  block(s, 9);
  await flush();
  s.f.tabs_ = s.f.tabs_.filter((t) => t.id !== 9);
  s.f.tabs_.push({ id: 11, windowId: 1, url: URL_A });
  s.f.chrome.tabs.onReplaced.fire(11, 9);
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices(), []);
  await s.fire(HOLD_MAX_MS);
  assert.equal(created(s, 9, before).length, 0);
  assert.equal(s.r.popups.has(9), false);
});

test("a popup that left its scope before its block gets its notice at the decision, with no reload", async () => {
  const s = await popupSetup();
  openPopup(s, { id: 10 });
  await flush();
  s.f.impl["debugger.getTargets"] = async () => [];
  s.f.impl["tabs.remove"] = async () => {
    throw new Error("held");
  };
  await s.set({ lists: B.setScopes.lists, scopes: { "md-gone": null }, default: null });
  delete s.f.impl["debugger.getTargets"];
  delete s.f.impl["tabs.remove"];
  assert.equal(s.r.map.isOrphan(10), true);
  block(s, 10);
  assert.deepEqual(s.notices(), [notice(10, "a.example", null)], "at once; the orphan set: scope null");
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
});

// review-21 note 3: the method of the block itself counts, not only the tab's last one.
test("the method when the block comes counts too: a blocked POST whose URL a later GET event of the tab names gets no reload", async () => {
  const s = await popupSetup();
  const late = lateRules(s);
  openPopup(s);
  await flush();
  block(s, 9, URL_A, "POST");
  await flush();
  requestError(s, 9, URL_A, "GET"); // before the late rule's end, when the decision comes
  s.advance(RETRY_AFTER_MS);
  await late();
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices(), [notice(9, "a.example")]);
  // No method when the block came (its webRequest event came after webNavigation's error), a GET later: no reload.
  openPopup(s, { id: 11 });
  await flush();
  block(s, 11, URL_A, null);
  requestError(s, 11, URL_A, "GET");
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices().at(-1), notice(11, "a.example"));
  // A GET block, then a POST event of the same URL before the reload: no reload either.
  openPopup(s, { id: 10 });
  await flush();
  block(s, 10, URL_A, "GET");
  requestError(s, 10, URL_A, "POST");
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices().at(-1), notice(10, "a.example"));
});

// review-21 note 5: Chrome can withhold the webRequest permission.
test("with no chrome.webRequest the bridge still starts, logs one line, and the retry fails closed (no reload, the notice)", async () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  let s;
  try {
    s = await popupSetup({ chromeEdit: (f) => delete f.chrome.webRequest });
  } finally {
    console.warn = warn;
  }
  assert.equal(s.resOf("open")[0].ok, true, "the bridge answers");
  assert.deepEqual(warned.filter((w) => /webRequest/.test(w)).length, 1);
  assert.ok(!warned.some((w) => /https?:|a\.example/.test(w)), "the log names no URL and no host");
  openPopup(s);
  await flush();
  block(s, 9, URL_A, null);
  await s.fire(RETRY_AFTER_MS);
  assert.deepEqual(reloads(s), []);
  assert.deepEqual(s.notices(), [notice(9, "a.example")]);
});
