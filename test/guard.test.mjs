// The guard and blocked in the receiver (part 1c, board ab-v16.33): C5's guard (layers 2 and 3) sends a
// tab to about:blank at a main-frame onBeforeNavigate or onCommitted of an http:/https: URL (or a blob:
// URL with such an inner origin) whose host the tab's covered set does not cover, and sends blocked
// (C4) with the tab's scope and its from, at most once per navigation. The covered set comes from the
// last set_scopes: a scope's list, a marked tab's operator value (Receiver.tabList), the union for a
// tab of no scope, none for the orphan set, the domain for the restore tab of a running import. The
// shared vector: test/vectors/blocked.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guardHost } from "../agent/guard.js";
import { importState } from "../agent/importer.js";
import { Bridge } from "../agent/bridge.js";
import { receiver } from "../agent/receiver.js";
import { parseScopes } from "../agent/scopes.js";
import { makeFakeChrome } from "./fake-chrome.mjs";
import { flush, startReceiver } from "./receiver-harness.mjs";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const V = read("./vectors/blocked.json");
const B = read("./vectors/bridge.json");
const NAV_TARGET = B.eventVectors.find((v) => v.chrome && v.chrome[0] === "webNavigation.onCreatedNavigationTarget");
const BLOCKED = "net::ERR_BLOCKED_BY_CLIENT";

const blank = (id, windowId = 1) => ({ id, windowId, url: "about:blank" });
const LISTS = { lists: { md: ["a.example"], v: ["b.example"] }, scopes: { "md-lead": "md", "v-lead": "v" }, default: null };
const notice = (tab, host, scope, from = null) => ({ t: "blocked", tab, host, scope, from });

const nav = (s, event, tabId, url, more = {}) => s.f.chrome.webNavigation[event].fire({ tabId, frameId: 0, url, ...more });
const blockedByDnr = (s, tabId, url) => nav(s, "onErrorOccurred", tabId, url, { error: BLOCKED });
// The guard's sends to about:blank, per tab.
const blanks = (s, tabId) => s.f.callsTo("tabs.update").filter(([id, props]) => id === tabId && props.url === "about:blank");

// Tab 5 has scope md-lead and tab 6 scope v-lead (from the copy), tab 3 has no scope.
async function setup({ scopes = LISTS, tabs = [blank(5), blank(6), blank(3)], copy = { "tab:5": "md-lead", "tab:6": "v-lead" } } = {}) {
  const s = await startReceiver({ tabs, copy, scopes });
  s.f.autoNavigate = false;
  return s;
}

// ---- the host that the guard judges ----

test("guardHost: an http:/https: URL's host, a blob: URL's inner origin's host; no host for other schemes or an opaque blob:", () => {
  assert.equal(guardHost("https://www.a.example/x?q=1#f"), "www.a.example");
  assert.equal(guardHost("http://a.example:8080/"), "a.example");
  assert.equal(guardHost("http://localhost:8771/"), "localhost");
  assert.equal(guardHost("blob:https://b.example/0d2b8c6e"), "b.example");
  assert.equal(guardHost("blob:http://www.sw.localhost:8771/0d2b8c6e"), "www.sw.localhost");
  for (const u of ["blob:null/0d2b8c6e", "about:blank", "about:srcdoc", "data:text/html,hi", "chrome://newtab/", "file:///etc/hosts", "javascript:void 0", "not a url", "", undefined]) {
    assert.equal(guardHost(u), null, String(u));
  }
});

// ---- the vector: the covered set per tab ----

test("each guard vector of blocked.json: the guard blocks exactly when the host is off the tab's covered set, at onBeforeNavigate and at onCommitted", async () => {
  for (const v of V.guard) {
    for (const event of ["onBeforeNavigate", "onCommitted"]) {
      const s = await setup({ scopes: null, tabs: [blank(3)], copy: null });
      // The set_scopes first, with tab 5 not open (so no sweep or closing rule touches it), then its state.
      if (v.in !== null) await s.set(v.in);
      s.f.tabs_.push(blank(5));
      if (v.tab.scope) s.r.map.set(5, v.tab.scope);
      if (v.tab.marked) s.r.map.mark(5);
      if (v.tab.orphan) s.r.map.addOrphan(5);
      if (v.tab.restore) s.r.att.markRestore(5, v.tab.restore);
      const before = s.notices().length;
      nav(s, event, 5, v.url);
      await flush();
      assert.equal(guardHost(v.url), v.host, `${v.note}: the host`);
      assert.equal(blanks(s, 5).length, v.blocks ? 1 : 0, `${v.note} (${event}): about:blank`);
      const got = s.notices().slice(before);
      if (!v.blocks) {
        assert.deepEqual(got, [], `${v.note} (${event}): no notice`);
        continue;
      }
      assert.deepEqual(got, [notice(5, v.host, v.tab.scope ?? null)], `${v.note} (${event}): the notice`);
    }
  }
});

test("the guard ignores a frame's navigation and an event of no tab", async () => {
  const s = await setup();
  nav(s, "onBeforeNavigate", 5, "https://b.example/", { frameId: 4 });
  nav(s, "onCommitted", 5, "https://b.example/", { frameId: 4 });
  s.f.chrome.webNavigation.onCommitted.fire({ frameId: 0, url: "https://b.example/" });
  s.f.chrome.webNavigation.onBeforeNavigate.fire(undefined);
  await flush();
  assert.deepEqual(s.f.callsTo("tabs.update"), []);
  assert.deepEqual(s.notices(), []);
});

// ---- the two layers and the once rule ----

test("layer 2: a navigation of a tab of a scope to another scope's site is sent to about:blank at onBeforeNavigate, with one blocked (host only, never the path)", async () => {
  const s = await setup();
  nav(s, "onBeforeNavigate", 5, "https://b.example/secret/path?token=x");
  await flush();
  assert.deepEqual(blanks(s, 5), [[5, { url: "about:blank" }]]);
  assert.deepEqual(s.notices(), [notice(5, "b.example", "md-lead")]);
  // The scope of v-lead may open it.
  nav(s, "onBeforeNavigate", 6, "https://b.example/");
  nav(s, "onCommitted", 6, "https://b.example/");
  await flush();
  assert.deepEqual(blanks(s, 6), []);
  assert.equal(s.notices().length, 1);
});

test("layer 3: a worker's page that commits with no request, and a redirect from a host of the list to another scope's site (no new onBeforeNavigate), leave the tab at onCommitted", async () => {
  const s = await setup();
  nav(s, "onBeforeNavigate", 5, "https://a.example/go");
  await flush();
  assert.deepEqual(blanks(s, 5), [], "a host of its list");
  nav(s, "onCommitted", 5, "https://b.example/landing");
  await flush();
  assert.deepEqual(blanks(s, 5), [[5, { url: "about:blank" }]]);
  assert.deepEqual(s.notices(), [notice(5, "b.example", "md-lead")]);
});

test("one navigation sends at most one blocked: the guard at both layers and DNR's block; a new navigation sends again; the receiver's own about:blank starts no navigation", async () => {
  const s = await setup();
  nav(s, "onBeforeNavigate", 5, "https://b.example/");
  await flush();
  // The guard lost the race at onBeforeNavigate: the page commits, and the guard acts again.
  nav(s, "onCommitted", 5, "https://b.example/");
  // The receiver's own about:blank, then DNR's late error of the same navigation.
  nav(s, "onBeforeNavigate", 5, "about:blank");
  nav(s, "onCommitted", 5, "about:blank");
  blockedByDnr(s, 5, "https://b.example/");
  await flush();
  assert.equal(blanks(s, 5).length, 2, "both layers send the tab away");
  assert.deepEqual(s.notices(), [notice(5, "b.example", "md-lead")], "one notice");
  // A new navigation to the same URL is a new navigation.
  nav(s, "onBeforeNavigate", 5, "https://b.example/");
  await flush();
  assert.deepEqual(s.notices(), [notice(5, "b.example", "md-lead"), notice(5, "b.example", "md-lead")]);
  // DNR alone: one notice per navigation.
  nav(s, "onBeforeNavigate", 6, "https://b.example/");
  nav(s, "onCommitted", 6, "https://b.example/");
  nav(s, "onBeforeNavigate", 6, "https://b.example/next");
  await flush();
  blockedByDnr(s, 6, "https://c.example/");
  blockedByDnr(s, 6, "https://c.example/");
  await flush();
  assert.deepEqual(s.notices().slice(2), [notice(6, "c.example", "v-lead", "b.example")]);
});

test("DNR's block: a main-frame net::ERR_BLOCKED_BY_CLIENT sends blocked with the host only; another error or a frame's sends nothing", async () => {
  const s = await setup();
  blockedByDnr(s, 3, "https://evil.example/path?q=secret");
  nav(s, "onErrorOccurred", 3, "https://evil.example/", { frameId: 3, error: BLOCKED });
  nav(s, "onErrorOccurred", 4, "https://evil.example/", { error: "net::ERR_FAILED" });
  nav(s, "onErrorOccurred", 4, "not a url", { error: BLOCKED });
  await flush();
  assert.deepEqual(s.notices(), [notice(3, "evil.example", null)]);
  assert.deepEqual(s.f.callsTo("tabs.update"), [], "DNR blocked it already: no about:blank");
});

test("blob: URLs: the guard judges the inner origin's host", async () => {
  const s = await setup();
  nav(s, "onCommitted", 5, "blob:https://b.example/0d2b8c6e");
  await flush();
  assert.deepEqual(blanks(s, 5), [[5, { url: "about:blank" }]]);
  assert.deepEqual(s.notices(), [notice(5, "b.example", "md-lead")]);
  nav(s, "onBeforeNavigate", 5, "blob:https://a.example/0d2b8c6e");
  nav(s, "onCommitted", 5, "blob:https://a.example/0d2b8c6e");
  nav(s, "onCommitted", 5, "blob:null/0d2b8c6e");
  await flush();
  assert.equal(blanks(s, 5).length, 1);
  assert.equal(s.notices().length, 1);
  assert.equal(s.r.guard.from(5), "a.example", "a blob: page of a listed host gives from");
});

test("a failed tabs.update is ignored: the notice still goes", async () => {
  const s = await setup();
  s.f.impl["tabs.update"] = () => {
    throw new Error("No tab with id: 5");
  };
  nav(s, "onBeforeNavigate", 5, "https://b.example/");
  await flush();
  assert.deepEqual(s.notices(), [notice(5, "b.example", "md-lead")]);
});

// ---- the lists that the guard uses ----

test("the guard follows each list change at once: a host that leaves the list is blocked, one that joins it loads", async () => {
  const s = await setup();
  nav(s, "onCommitted", 5, "https://b.example/");
  await flush();
  assert.equal(s.notices().length, 1);
  await s.set({ ...LISTS, lists: { md: ["a.example", "b.example"], v: ["b.example"] } });
  nav(s, "onBeforeNavigate", 5, "https://b.example/");
  nav(s, "onCommitted", 5, "https://b.example/");
  await flush();
  assert.equal(s.notices().length, 1, "b.example joined md");
  await s.set({ ...LISTS, lists: { md: ["c.example"], v: ["b.example"] } });
  nav(s, "onBeforeNavigate", 5, "https://a.example/");
  await flush();
  assert.deepEqual(s.notices().at(-1), notice(5, "a.example", "md-lead", "b.example"), "a.example left md");
});

test("a set_scopes that is not applied: every tab of a scope fails closed (as the scope rules); before the first set_scopes every tab does", async () => {
  const s = await setup({ scopes: null });
  nav(s, "onBeforeNavigate", 5, "https://a.example/");
  nav(s, "onBeforeNavigate", 3, "https://a.example/");
  await flush();
  assert.deepEqual(s.notices(), [notice(5, "a.example", "md-lead"), notice(3, "a.example", null)], "before the first set_scopes");
  await s.set(LISTS);
  await s.set({ ...LISTS, scopes: [] });
  nav(s, "onBeforeNavigate", 5, "https://a.example/");
  nav(s, "onBeforeNavigate", 3, "https://a.example/");
  await flush();
  assert.deepEqual(s.notices().slice(2), [notice(5, "a.example", "md-lead")], "a tab of no scope keeps the union of the lists that apply");
});

test("the guard waits for the restore of the map: a tab of the copy is judged by its scope", async () => {
  const f = makeFakeChrome();
  f.autoNavigate = false;
  f.setTabs([blank(5)]);
  let give;
  f.impl["storage.session.get"] = () => new Promise((r) => (give = r));
  const sent = [];
  void new Bridge(f.chrome, { eventsOpen: () => true, sendEvent: () => true }, { setTimer: () => ({}), clearTimer: () => {} });
  const r = receiver(f.chrome);
  r.notify = (m) => sent.push(m);
  r.map.current = parseScopes(LISTS);
  const started = r.startup();
  nav({ f }, "onBeforeNavigate", 5, "https://b.example/");
  nav({ f }, "onBeforeNavigate", 5, "https://a.example/");
  await flush();
  assert.deepEqual(sent, [], "the check waits for the restore");
  give({ "tab:5": "md-lead" });
  await started;
  await flush();
  assert.deepEqual(sent, [notice(5, "b.example", "md-lead")], "judged by the restored scope: b.example off its list, a.example on it");
});

// ---- the covered set of each kind of tab, through the events ----

test("a marked tab: with \"*\" no check, with a list name that list, with null none; a popup of a marked tab with \"*\" opens any host (the mark comes before its first navigation)", async () => {
  const s = await setup({ scopes: { ...LISTS, operator: "*" } });
  s.f.tabs_.push({ id: 20, windowId: 1, url: "", pendingUrl: "chrome://newtab/" });
  s.f.chrome.tabs.onCreated.fire({ id: 20, windowId: 1, url: "", pendingUrl: "chrome://newtab/" });
  await flush();
  assert.equal(s.r.map.isMarked(20), true);
  nav(s, "onBeforeNavigate", 20, "https://c.example/");
  nav(s, "onCommitted", 20, "https://c.example/");
  // Its popup: tabs.onCreated, the navigation target (which marks it), then its first navigation.
  s.f.tabs_.push({ id: 21, windowId: 1, url: "", pendingUrl: "https://d.example/" });
  s.f.chrome.tabs.onCreated.fire({ id: 21, windowId: 1, url: "", pendingUrl: "https://d.example/", openerTabId: 20 });
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ ...NAV_TARGET.chrome[1][0], sourceTabId: 20, tabId: 21, url: "https://d.example/" });
  nav(s, "onBeforeNavigate", 21, "https://d.example/");
  nav(s, "onCommitted", 21, "https://d.example/");
  await flush();
  assert.equal(s.r.map.isMarked(21), true);
  assert.deepEqual(s.f.callsTo("tabs.update"), []);
  assert.deepEqual(s.notices(), []);
  await s.set({ ...LISTS, operator: "v" });
  nav(s, "onBeforeNavigate", 20, "https://a.example/");
  nav(s, "onBeforeNavigate", 21, "https://b.example/");
  await flush();
  assert.deepEqual(s.notices(), [notice(20, "a.example", null, "c.example")]);
  // With null the closing rule closes the popup (its page is off every list); tab 20 stays (the fake
  // keeps its New Tab URL), and it may open no host.
  await s.set(LISTS);
  nav(s, "onBeforeNavigate", 20, "https://b.example/next");
  await flush();
  assert.deepEqual(s.notices().at(-1), notice(20, "b.example", null, "c.example"), "null: no host");
});

test("a tab of the orphan set has no host, also one on the union of the lists; a tab of no scope has the union", async () => {
  const s = await setup();
  s.r.map.addOrphan(3);
  nav(s, "onBeforeNavigate", 3, "https://a.example/");
  await flush();
  assert.deepEqual(s.notices(), [notice(3, "a.example", null)]);
  s.f.tabs_.push(blank(4));
  nav(s, "onBeforeNavigate", 4, "https://a.example/");
  nav(s, "onBeforeNavigate", 4, "https://b.example/");
  await flush();
  assert.equal(s.notices().length, 1, "the union covers both");
});

test("a restore tab whose import's domain is not known covers no host (fail closed)", async () => {
  const s = await setup();
  s.r.att.markRestore(3);
  nav(s, "onBeforeNavigate", 3, "https://a.example/");
  await flush();
  assert.deepEqual(s.notices(), [notice(3, "a.example", null)], "not the union of the lists");
  s.r.att.clearRestore(3);
  nav(s, "onBeforeNavigate", 3, "https://a.example/");
  await flush();
  assert.equal(s.notices().length, 1, "after the import: a tab of no scope, the union");
});

test("the restore tab of a running import: its domain only, from its mark to the import's end; then a plain tab of no scope (the union)", async () => {
  const s = await setup();
  const state = {
    domain: "s.example", origin: "https://www.s.example", url: "https://www.s.example/app", cookies: [], storage: {},
  };
  let restoreTab = null;
  s.f.impl["tabs.update"] = async (tabId, props) => {
    if (props.url !== "about:blank") {
      restoreTab = tabId;
      // The restore page: the guard sees its navigation and its commit (no check fails).
      nav(s, "onBeforeNavigate", tabId, props.url);
      nav(s, "onCommitted", tabId, props.url);
      await flush();
      // An off-list host in the restore tab is blocked, also one of the union of the lists.
      nav(s, "onBeforeNavigate", tabId, "https://a.example/");
      await flush();
      s.f.chrome.webNavigation.onCompleted.fire({ tabId, frameId: 0, url: props.url });
    }
    return { id: tabId, ...props };
  };
  s.f.pageResult = { local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] };
  s.f.autoNavigate = true;
  await importState(s.f.chrome, state, {});
  await flush();
  assert.notEqual(restoreTab, null);
  assert.deepEqual(s.notices(), [notice(restoreTab, "a.example", null, "www.s.example")]);
  assert.equal(s.r.att.restoreDomain(restoreTab), null, "the import ended");
  nav(s, "onBeforeNavigate", restoreTab, "https://a.example/");
  await flush();
  assert.equal(s.notices().length, 1, "a plain tab of no scope: the union covers a.example");
});

// ---- from ----

test("from: the tab's last listed host; a commit that the guard sends away, about:blank and a frame do not change it; a new tab has none", async () => {
  const s = await setup();
  assert.equal(s.r.guard.from(5), null);
  nav(s, "onCommitted", 5, "https://www.a.example/one");
  await flush();
  assert.equal(s.r.guard.from(5), "www.a.example");
  nav(s, "onCommitted", 5, "https://b.example/worker-page");
  nav(s, "onCommitted", 5, "about:blank");
  nav(s, "onCommitted", 5, "https://a.example/frame", { frameId: 2 });
  await flush();
  assert.equal(s.r.guard.from(5), "www.a.example");
  assert.deepEqual(s.notices(), [notice(5, "b.example", "md-lead", "www.a.example")]);
  nav(s, "onBeforeNavigate", 5, "https://c.example/");
  blockedByDnr(s, 5, "https://c.example/");
  await flush();
  assert.deepEqual(s.notices().at(-1), notice(5, "c.example", "md-lead", "www.a.example"), "from at about:blank: the last listed host");
  assert.equal(s.notices().length, 2);
});

test("from: a new popup with no commit takes its opener's; its own commit replaces it; tabs.onReplaced carries it; tabs.onRemoved ends it", async () => {
  const s = await setup();
  nav(s, "onCommitted", 5, "https://a.example/");
  await flush();
  s.f.tabs_.push({ id: 9, windowId: 1, url: "", pendingUrl: "https://c.example/" });
  s.f.chrome.tabs.onCreated.fire({ id: 9, windowId: 1, url: "", pendingUrl: "https://c.example/", openerTabId: 5 });
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ ...NAV_TARGET.chrome[1][0], sourceTabId: 5, tabId: 9, url: "https://c.example/" });
  await flush();
  assert.equal(s.r.map.scopeOf(9), "md-lead");
  assert.equal(s.r.guard.from(9), "a.example");
  nav(s, "onBeforeNavigate", 9, "https://c.example/");
  await flush();
  assert.deepEqual(s.notices(), [notice(9, "c.example", "md-lead", "a.example")]);
  nav(s, "onCommitted", 9, "https://sub.a.example/");
  await flush();
  assert.equal(s.r.guard.from(9), "sub.a.example");
  // Chrome replaces tab 9 by tab 10: the added tab takes its from (and its scope).
  s.f.tabs_.push(blank(10));
  s.f.chrome.tabs.onReplaced.fire(10, 9);
  await flush();
  assert.equal(s.r.guard.from(10), "sub.a.example");
  assert.equal(s.r.guard.from(9), null);
  s.f.closeTab(10);
  await flush();
  assert.equal(s.r.guard.from(10), null);
  // A popup of a tab with no listed host has none.
  s.f.tabs_.push({ id: 11, windowId: 1, url: "" });
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ ...NAV_TARGET.chrome[1][0], sourceTabId: 6, tabId: 11, url: "https://d.example/" });
  await flush();
  assert.equal(s.r.guard.from(11), null);
});

test("scope in blocked is the tab's scope when the notice goes: null for a tab of no scope", async () => {
  const s = await setup();
  nav(s, "onBeforeNavigate", 3, "https://c.example/");
  nav(s, "onBeforeNavigate", 6, "https://c.example/");
  await flush();
  assert.deepEqual(s.notices(), [notice(3, "c.example", null), notice(6, "c.example", "v-lead")]);
});

test("the notices of a tab keep a bounded record: many blocked navigations each send one notice", async () => {
  const s = await setup();
  for (let i = 0; i < 40; i++) {
    nav(s, "onBeforeNavigate", 5, `https://b.example/${i}`);
    nav(s, "onCommitted", 5, `https://b.example/${i}`);
  }
  await flush();
  assert.equal(s.notices().length, 40);
});
