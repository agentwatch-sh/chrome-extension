// The worker removal at a marked tab's leave (C5; board ab-v16.74, the operator's answer ab-214): the
// receiver records each web origin that a frame of a marked tab commits (the top frame and every
// sub-frame), in memory and in chrome.storage.session; when no marked tab shows an origin any more
// (by webNavigation.getAllFrames) and no list of the last applied set_scopes covers it, it removes that
// origin's service workers with browsingData.remove({origins}, {serviceWorkers: true}). The events:
// a commit of a frame of a marked tab, a marked tab's close or replace, a tab that loses its mark,
// each set_scopes and the worker's start. A removal has REMOVAL_WAIT_MS; a failure logs one line and
// the next event's check removes again. C5's own worker removal of a set_scopes shares the bounded call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NEW_TAB_URL } from "../agent/receiver.js";
import { REMOVAL_WAIT_MS } from "../agent/removals.js";
import { WORKER_KEY, siteOf } from "../agent/workers.js";
import { flush, startReceiver } from "./receiver-harness.mjs";

const B = JSON.parse(readFileSync(new URL("./vectors/bridge.json", import.meta.url), "utf8"));
const NAV_TARGET = B.eventVectors.find((v) => v.chrome && v.chrome[0] === "webNavigation.onCreatedNavigationTarget");

const blank = (id, windowId = 1) => ({ id, windowId, url: "about:blank" });
// Tab 7 has scope md-lead (list md: a.example); list ops is the operator's own, list spare is a list that no scope names.
const LISTS = { md: ["a.example"], ops: ["o.example"], spare: ["s.example"] };
const scopesWith = (operator = "*", more = {}) => ({ lists: LISTS, scopes: { "md-lead": "md" }, default: null, operator, ...more });

const X = "http://www.nolist.localhost:8771"; // a host on no list (sw-marked's case, board ab-v16.73)
const Y = "https://y.example";
const Z = "https://z.example";

async function setup({ tabs = [blank(7), blank(3)], copy = { "tab:7": "md-lead" }, scopes = scopesWith(), beforeStart } = {}) {
  const s = await startReceiver({ tabs, copy, scopes, beforeStart });
  s.f.autoNavigate = false;
  return s;
}

// The operator's Ctrl+T: Chrome's tabs.onCreated names chrome://newtab/ (C10, the operator mark).
function operatorTab(s, id) {
  s.f.tabs_.push({ id, windowId: 1, url: "", pendingUrl: NEW_TAB_URL });
  s.f.chrome.tabs.onCreated.fire({ id, windowId: 1, active: true, url: "", pendingUrl: NEW_TAB_URL });
}

// A frame of tab commits url: Chrome's frames follow (a new document in a frame ends the frames
// under it; one in the top frame ends every other frame), then webNavigation.onCommitted.
function commit(s, tabId, url, { frameId = 0, parentFrameId = -1 } = {}) {
  let frames = s.f.frames_.get(tabId) ?? [];
  frames = frameId === 0 ? [] : frames.filter((x) => x.frameId !== frameId && x.parentFrameId !== frameId);
  frames.push({ frameId, parentFrameId, url, documentLifecycle: "active", frameType: frameId === 0 ? "outermost_frame" : "sub_frame" });
  s.f.frames_.set(tabId, frames);
  const t = s.f.tabs_.find((x) => x.id === tabId);
  if (t && frameId === 0) {
    t.url = url;
    delete t.pendingUrl;
  }
  s.f.chrome.webNavigation.onCommitted.fire({ tabId, frameId, parentFrameId, url, documentLifecycle: "active" });
}

// The calls of the leave's removal (with origins), each as its sorted origins.
const leaves = (s) => s.f.callsTo("browsingData.remove").filter(([d]) => d && d.origins).map(([d, what]) => {
  assert.deepEqual(what, { serviceWorkers: true }, "service workers only");
  assert.deepEqual(Object.keys(d), ["origins"], "the origins only");
  return [...d.origins].sort();
});
const fullRemovals = (s) => s.f.callsTo("browsingData.remove").filter(([d]) => d && !d.origins);
const recorded = (s) => s.r.workers.origins().sort();
const copyKeys = (s) => Object.keys(s.f.storage_.session).filter((k) => k.startsWith(WORKER_KEY)).sort();
const keysOf = (...origins) => origins.map((o) => WORKER_KEY + o).sort();

function quietWarn() {
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(" "));
  return { logged, restore: () => (console.warn = warn) };
}

// ---- which origins ----

test("every tab's commits record their web origins (the top frame and each sub-frame, a blob: page by its inner origin) in memory and in the copy; other schemes record nothing", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/sw-reg");
  commit(s, 20, Y + "/frame", { frameId: 5, parentFrameId: 0 });
  commit(s, 20, "blob:https://b2.example/0d2b8c6e", { frameId: 6, parentFrameId: 0 });
  commit(s, 20, Z + "/inner", { frameId: 9, parentFrameId: 5 });
  for (const [id, u] of [[7, "about:blank"], [8, "about:srcdoc"], [10, "data:text/html,x"], [11, "blob:null/0d2b8c6e"], [12, "chrome-error://chromewebdata/"]]) commit(s, 20, u, { frameId: id, parentFrameId: 0 });
  // A tab of a scope (a listed origin), a tab of no scope and no mark (an origin on no list).
  commit(s, 7, "https://a.example/");
  commit(s, 7, "https://cdn.a.example/f", { frameId: 3, parentFrameId: 0 });
  commit(s, 3, "https://u.example/");
  await flush();
  const want = [X, Y, "https://b2.example", Z, "https://a.example", "https://cdn.a.example"].sort();
  assert.deepEqual(recorded(s), want, "u.example went: on no list, and no marked tab shows its site");
  assert.deepEqual(copyKeys(s), keysOf(...want), "the copy, one key per origin");
  assert.deepEqual(leaves(s), [["https://u.example"]], "every origin of the marked tab is still shown; a.example is listed");
});

// review-30 B2: a sub-frame's origin joins the record at its commit, not only at the check's frame read.
test("a sub-frame that commits an origin and goes before the check reads the frames: that origin is recorded at its commit, and the leave removes it", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  commit(s, 20, "https://p.example/");
  await flush();
  // Frame 5 commits X, then Y, before any check runs: no frame read ever shows X.
  commit(s, 20, X + "/frame", { frameId: 5, parentFrameId: 0 });
  commit(s, 20, Y + "/frame", { frameId: 5, parentFrameId: 0 });
  await flush();
  assert.deepEqual(leaves(s), [[X]]);
  assert.deepEqual(recorded(s), ["https://p.example", Y].sort());
});

test("the record does not depend on the operator value: a marked tab with a list name or with null records its commits too", async () => {
  for (const operator of ["ops", null]) {
    const s = await setup({ scopes: scopesWith(operator) });
    operatorTab(s, 20);
    await flush();
    commit(s, 20, "https://o.example/");
    commit(s, 20, X + "/", { frameId: 4, parentFrameId: 0 });
    await flush();
    assert.deepEqual(recorded(s), [X, "https://o.example"].sort(), String(operator));
  }
});

// ---- the leave events ----

test("the top frame leaves: the old page's origins (its sub-frames too) go in one browsingData.remove({origins}, {serviceWorkers: true}), and the record and the copy drop them", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/sw-reg");
  commit(s, 20, Y + "/f", { frameId: 5, parentFrameId: 0 });
  await flush();
  assert.deepEqual(leaves(s), []);
  commit(s, 20, X + "/other"); // the same origin: it stays shown, its sub-frame goes
  await flush();
  assert.deepEqual(leaves(s), [[Y]]);
  commit(s, 20, Z + "/");
  await flush();
  assert.deepEqual(leaves(s), [[Y], [X]]);
  assert.deepEqual(recorded(s), [Z]);
  assert.deepEqual(copyKeys(s), keysOf(Z));
  commit(s, 20, "about:blank");
  await flush();
  assert.deepEqual(leaves(s), [[Y], [X], [Z]], "a page of no origin shows none");
  assert.deepEqual(recorded(s), []);
  assert.deepEqual(copyKeys(s), []);
});

test("a frame that goes: a sub-frame's own navigation at its commit; a frame that a page script removes (no event) at the next event's check", async () => {
  const s = await setup();
  operatorTab(s, 20);
  operatorTab(s, 21);
  await flush();
  commit(s, 20, "https://p.example/");
  commit(s, 20, X + "/frame", { frameId: 5, parentFrameId: 0 });
  await flush();
  commit(s, 20, Y + "/frame", { frameId: 5, parentFrameId: 0 });
  await flush();
  assert.deepEqual(leaves(s), [[X]], "the sub-frame left X");
  // A page script removes the frame: Chrome sends no event; getAllFrames no longer lists it.
  s.f.frames_.set(20, s.f.frames_.get(20).filter((x) => x.frameId !== 5));
  await flush();
  assert.deepEqual(leaves(s), [[X]], "no event, no check");
  commit(s, 21, "https://q.example/"); // any later event of a marked tab
  await flush();
  assert.deepEqual(leaves(s), [[X], [Y]]);
});

test("the tab closes: its origins go", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/");
  await flush();
  s.f.closeTab(20);
  await flush();
  assert.deepEqual(leaves(s), [[X]]);
  assert.deepEqual(recorded(s), []);
});

// review-30 B1: Chrome sends webNavigation.onErrorOccurred, not onCommitted, for a navigation that ends on an error page.
test("the top frame leaves for an error page (onErrorOccurred, no commit): its origins go; an error of a sub-frame or of another tab starts a check too", async () => {
  const s = await setup();
  operatorTab(s, 20);
  operatorTab(s, 21);
  await flush();
  commit(s, 20, X + "/");
  commit(s, 21, Y + "/");
  await flush();
  // A typing error: the connection is refused, and the tab shows Chrome's error page.
  s.f.frames_.set(20, [{ frameId: 0, parentFrameId: -1, url: "chrome-error://chromewebdata/", documentLifecycle: "active" }]);
  s.f.chrome.webNavigation.onErrorOccurred.fire({ tabId: 20, frameId: 0, url: "http://www.down.localhost:8798/err", error: "net::ERR_CONNECTION_REFUSED" });
  await flush();
  assert.deepEqual(leaves(s), [[X]]);
  // A sub-frame of tab 21 that leaves Y for an error page.
  commit(s, 21, "https://q.example/");
  commit(s, 21, Y + "/f", { frameId: 4, parentFrameId: 0 });
  await flush();
  s.f.frames_.set(21, [{ frameId: 0, parentFrameId: -1, url: "https://q.example/", documentLifecycle: "active" }, { frameId: 4, parentFrameId: 0, url: "chrome-error://chromewebdata/", documentLifecycle: "active" }]);
  s.f.chrome.webNavigation.onErrorOccurred.fire({ tabId: 21, frameId: 4, url: "https://down.example/", error: "net::ERR_NAME_NOT_RESOLVED" });
  await flush();
  assert.deepEqual(leaves(s), [[X], [Y]]);
  // An error of a tab of a scope (DNR's block) starts a check too: here the retry of a failed removal.
  s.f.impl["browsingData.remove"] = async () => {
    throw new Error("busy");
  };
  const log = quietWarn();
  try {
    commit(s, 21, "https://r.example/");
    await flush();
    delete s.f.impl["browsingData.remove"];
    assert.ok(recorded(s).includes("https://q.example"), "the failed removal kept q.example");
    s.f.chrome.webNavigation.onErrorOccurred.fire({ tabId: 7, frameId: 0, url: "https://z.example/", error: "net::ERR_BLOCKED_BY_CLIENT" });
    await flush();
    assert.ok(!recorded(s).includes("https://q.example"), "the error's check removed it");
  } finally {
    log.restore();
  }
});

test("the tab loses its mark (a page's navigation target names its opener): its origins go", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/");
  await flush();
  // A navigation target that names tab 7 (scope md-lead) as the source: tab 20 is no operator tab.
  s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ ...NAV_TARGET.chrome[1][0], sourceTabId: 7, tabId: 20, url: X + "/" });
  await flush();
  assert.equal(s.r.map.isMarked(20), false);
  assert.deepEqual(leaves(s), [[X]]);
});

test("the tab is replaced: the added tab takes the mark, so an origin that it shows stays; the removed tab's other origins go; a page of the added tab that no commit named joins the record", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/");
  commit(s, 20, Y + "/f", { frameId: 5, parentFrameId: 0 });
  await flush();
  s.f.tabs_.push({ id: 30, windowId: 1, url: X + "/" });
  s.f.frames_.set(30, [{ frameId: 0, parentFrameId: -1, url: X + "/", documentLifecycle: "active" }, { frameId: 6, parentFrameId: 0, url: Z + "/f", documentLifecycle: "active" }]);
  s.f.tabs_ = s.f.tabs_.filter((t) => t.id !== 20);
  s.f.frames_.delete(20);
  s.f.chrome.tabs.onReplaced.fire(30, 20);
  await flush();
  assert.equal(s.r.map.isMarked(30), true);
  assert.deepEqual(leaves(s), [[Y]]);
  assert.deepEqual(recorded(s), [X, Z].sort());
  s.f.closeTab(30);
  await flush();
  assert.deepEqual(leaves(s), [[Y], [X, Z].sort()]);
});

// ---- an origin still shown ----

test("an origin that a marked tab still shows keeps its workers: in another marked tab, in a sub-frame of another page; a page in the back/forward cache or one that is going does not count", async () => {
  const s = await setup();
  operatorTab(s, 20);
  operatorTab(s, 21);
  await flush();
  commit(s, 20, X + "/a");
  commit(s, 21, X + "/b");
  await flush();
  commit(s, 20, Y + "/");
  await flush();
  assert.deepEqual(leaves(s), [], "tab 21 still shows X");
  commit(s, 21, "https://p.example/");
  commit(s, 21, X + "/frame", { frameId: 4, parentFrameId: 0 });
  await flush();
  assert.deepEqual(leaves(s), [], "X in a sub-frame of tab 21");
  // Tab 21's page goes into the back/forward cache, and its old document is going: neither shows X.
  s.f.frames_.set(21, [
    { frameId: 0, parentFrameId: -1, url: Z + "/", documentLifecycle: "active" },
    { frameId: 40, parentFrameId: -1, url: "https://p.example/", documentLifecycle: "cached" },
    { frameId: 41, parentFrameId: 40, url: X + "/frame", documentLifecycle: "cached" },
    { frameId: 42, parentFrameId: -1, url: X + "/old", documentLifecycle: "pending_deletion" },
  ]);
  s.f.chrome.webNavigation.onCommitted.fire({ tabId: 21, frameId: 0, parentFrameId: -1, url: Z + "/", documentLifecycle: "active" });
  await flush();
  assert.deepEqual(leaves(s), [[X, "https://p.example"].sort()]);
  assert.deepEqual(recorded(s), [Y, Z].sort());
});

test("an origin that a marked tab commits while a check reads the frames is shown: that check does not remove it", async () => {
  const s = await setup();
  operatorTab(s, 20);
  operatorTab(s, 21);
  await flush();
  commit(s, 20, X + "/");
  await flush();
  // The next check's frame reads wait.
  const held = [];
  s.f.impl["webNavigation.getAllFrames"] = (q) => new Promise((resolve) => held.push({ q, resolve }));
  commit(s, 20, Y + "/"); // tab 20 leaves X
  await flush();
  assert.deepEqual(held.map((h) => h.q.tabId).sort(), [20, 21], "the check reads the frames");
  commit(s, 21, X + "/again"); // tab 21 commits X during the read
  delete s.f.impl["webNavigation.getAllFrames"];
  // The reads answer with the state before that commit.
  for (const h of held.splice(0)) h.resolve([{ frameId: 0, parentFrameId: -1, url: h.q.tabId === 20 ? Y + "/" : "about:blank", documentLifecycle: "active" }]);
  await flush();
  assert.deepEqual(leaves(s), [], "X committed during the read: shown");
  assert.deepEqual(recorded(s), [X, Y].sort());
});

test("an origin that a marked tab commits while its removal runs stays recorded (and in the copy), so its later leave removes it again", async () => {
  const s = await setup();
  operatorTab(s, 20);
  operatorTab(s, 21);
  await flush();
  commit(s, 20, X + "/");
  await flush();
  let give;
  s.f.impl["browsingData.remove"] = () => new Promise((resolve) => (give = resolve));
  commit(s, 20, "about:blank");
  await flush();
  assert.equal(typeof give, "function", "the removal of X runs");
  commit(s, 21, X + "/again"); // the operator opens X again during the removal
  await flush();
  delete s.f.impl["browsingData.remove"];
  give();
  await flush();
  assert.deepEqual(recorded(s), [X]);
  assert.deepEqual(copyKeys(s), keysOf(X));
  commit(s, 21, "about:blank");
  await flush();
  assert.deepEqual(leaves(s), [[X], [X]]);
  assert.deepEqual(recorded(s), []);
});

test("a tab that gets the mark while a check reads the frames (tabs.onReplaced): that check removes nothing, and the next one reads the new tab's frames", async () => {
  const s = await setup();
  operatorTab(s, 20);
  operatorTab(s, 21);
  await flush();
  commit(s, 20, X + "/");
  await flush();
  const held = [];
  s.f.impl["webNavigation.getAllFrames"] = (q) => new Promise((resolve) => held.push({ q, resolve }));
  commit(s, 21, "about:blank");
  await flush();
  assert.deepEqual(held.map((h) => h.q.tabId).sort(), [20, 21]);
  // Tab 20 is replaced by tab 30, which shows X; the reads answer with the old state.
  s.f.tabs_ = s.f.tabs_.filter((t) => t.id !== 20);
  s.f.frames_.delete(20);
  s.f.tabs_.push({ id: 30, windowId: 1, url: X + "/" });
  s.f.chrome.tabs.onReplaced.fire(30, 20);
  delete s.f.impl["webNavigation.getAllFrames"];
  for (const h of held.splice(0)) h.resolve(h.q.tabId === 20 ? null : [{ frameId: 0, parentFrameId: -1, url: "about:blank", documentLifecycle: "active" }]);
  await flush();
  assert.equal(s.r.map.isMarked(30), true);
  assert.deepEqual(leaves(s), [], "tab 30 shows X");
  assert.ok(s.f.callsTo("webNavigation.getAllFrames").some(([q]) => q.tabId === 30), "the next check read tab 30");
});

// ---- the site rule (review-30 B3 b; ab-lead's decision) ----

test("siteOf: the scheme and the last two labels of the host, the port dropped; an IP address or a host of one or two labels as it is", () => {
  assert.equal(siteOf("http://www.pp.localhost:8799"), "http://pp.localhost");
  assert.equal(siteOf("http://www.pp.localhost:8797"), "http://pp.localhost");
  assert.equal(siteOf("https://login.a.example"), "https://a.example");
  assert.equal(siteOf("https://a.example"), "https://a.example");
  assert.notEqual(siteOf("http://a.example"), siteOf("https://a.example"), "the scheme counts");
  assert.equal(siteOf("https://x.y.example.co.uk"), "https://co.uk", "no public suffix list: wider than the registrable domain");
  assert.equal(siteOf("http://localhost:8771"), "http://localhost");
  assert.equal(siteOf("http://127.0.0.1:8771"), "http://127.0.0.1");
  assert.equal(siteOf("http://[::1]:8771"), "http://[::1]");
});

// review-30's probe 2: Chrome's origin filter also removes every partitioned worker whose top-level site is the origin's site.
test("an origin whose site a marked tab shows in any frame keeps its workers: the same site on another port or subdomain, also in a sub-frame; when no marked tab shows the site, every origin of it goes", async () => {
  const s = await setup();
  operatorTab(s, 20);
  operatorTab(s, 21);
  await flush();
  const R = "http://www.pp.localhost:8799";
  const P = "http://www.pp.localhost:8797";
  const W3 = "http://www.nolist3.localhost:8797";
  commit(s, 20, R + "/r1");
  commit(s, 21, P + "/embed");
  commit(s, 21, W3 + "/sw-reg", { frameId: 5, parentFrameId: 0 });
  await flush();
  commit(s, 20, "https://other.example/"); // tab 20 leaves R; tab 21 shows P, of R's site
  await flush();
  assert.deepEqual(leaves(s), [], "R stays: its removal would also remove W3's partitioned worker under P's site");
  // Tab 21 shows the site only in a sub-frame now.
  commit(s, 21, "https://q.example/");
  commit(s, 21, "http://login.pp.localhost:8797/frame", { frameId: 6, parentFrameId: 0 });
  await flush();
  assert.deepEqual(leaves(s), [[W3]], "R and P stay (a frame of their site); W3's own site is not shown");
  commit(s, 21, "https://q.example/next");
  await flush();
  assert.deepEqual(leaves(s), [[W3], ["http://login.pp.localhost:8797", P, R].sort()]);
});

// ---- every tab: a scope's list that ends (ab-lead's decision after review-30) ----

test("a scope's tab's origins stay recorded while a list covers them; the set_scopes that ends that list removes them unless a marked tab shows their site", async () => {
  const s = await setup({ tabs: [blank(7), blank(8), blank(3)], copy: { "tab:7": "md-lead", "tab:8": "v-lead" }, scopes: scopesWith("*", { lists: { ...LISTS, v: ["v.example"] }, scopes: { "md-lead": "md", "v-lead": "v" } }) });
  operatorTab(s, 20);
  await flush();
  commit(s, 8, "https://www.v.example/sw-reg"); // scope v-lead's tab registers a worker on its own site
  commit(s, 8, "https://cdn.v.example/f", { frameId: 2, parentFrameId: 0 });
  commit(s, 7, "https://a.example/");
  commit(s, 20, "https://shop.v.example/"); // the operator's tab on the same site
  await flush();
  assert.deepEqual(leaves(s), []);
  // The session of v-lead ends: its scope has no list, and no list covers v.example any more.
  await s.set(scopesWith("*", { scopes: { "md-lead": "md", "v-lead": null } }));
  await flush();
  assert.equal(fullRemovals(s).length, 1, "no shrink: C5's removal of every worker does not run");
  assert.deepEqual(leaves(s), [], "the marked tab shows v.example's site");
  commit(s, 20, "https://other.example/");
  await flush();
  assert.deepEqual(leaves(s), [["https://cdn.v.example", "https://shop.v.example", "https://www.v.example"]]);
  assert.ok(recorded(s).includes("https://a.example"), "a listed origin stays");
});

test("a scope's tab that commits a page on no list (a worker's page before layer 3): its origin goes at once, unless a marked tab shows its site", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/");
  await flush();
  commit(s, 7, X + "/sw-own/page"); // the gap of board ab-v16.73: kept while the operator's tab is on that site
  commit(s, 7, "http://www.other.localhost:8771/p");
  await flush();
  assert.deepEqual(leaves(s), [["http://www.other.localhost:8771"]]);
  assert.deepEqual(recorded(s), [X]);
});

// ---- the bound ----

test("the bound: a new origin at the limit evicts the oldest listed origin, and the removal of every worker is owed until a list loses an entry that covered it", async () => {
  const s = await setup();
  s.r.workers.max = 3;
  commit(s, 7, "https://a.example/");
  commit(s, 7, "https://www.a.example/");
  commit(s, 3, "https://o.example/");
  await flush();
  assert.deepEqual(recorded(s), ["https://a.example", "https://o.example", "https://www.a.example"]);
  commit(s, 3, "https://s.example/");
  await flush();
  assert.deepEqual(recorded(s), ["https://o.example", "https://s.example", "https://www.a.example"], "a.example, the oldest listed origin, went");
  assert.deepEqual(copyKeys(s), keysOf("https://o.example", "https://s.example", "https://www.a.example"));
  const full = fullRemovals(s).length;
  await s.set(scopesWith("*", { lists: { ...LISTS, spare: ["s.example", "t.example"] } })); // a.example's entry stays
  await flush();
  assert.equal(fullRemovals(s).length, full, "nothing owed yet");
  await s.set(scopesWith("*", { lists: { md: ["b.example"], ops: ["o.example"], spare: ["s.example"] } })); // md loses a.example
  await flush();
  // C5's own removal ran for the shrink of md; the owed one runs once in the next check.
  assert.equal(fullRemovals(s).length, full + 2);
  assert.deepEqual(leaves(s), [["https://www.a.example"]]);
  await s.set(scopesWith("*", { lists: { md: ["b.example"], ops: ["o.example"], spare: ["s.example"] } }));
  await flush();
  assert.equal(fullRemovals(s).length, full + 2, "owed once");
});

test("the bound with no listed origin: the oldest origin goes, and the removal of every worker runs at the next check", async () => {
  const s = await setup();
  s.r.workers.max = 2;
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/");
  commit(s, 20, Y + "/", { frameId: 4, parentFrameId: 0 });
  await flush();
  const full = fullRemovals(s).length;
  commit(s, 20, Z + "/", { frameId: 5, parentFrameId: 0 });
  await flush();
  assert.deepEqual(recorded(s), [Y, Z].sort());
  assert.equal(fullRemovals(s).length, full + 1, "X's workers are not known any more: every worker goes");
});

// ---- a listed origin ----

test("an origin that a list of the last applied set_scopes covers keeps its workers (a subdomain, the operator's list, a list that no scope names); it stays recorded, and the set_scopes that takes it off every list removes it", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  for (const u of ["https://www.a.example/", "https://o.example/", "https://s.example/", X + "/"]) commit(s, 20, u);
  commit(s, 20, "about:blank");
  await flush();
  assert.deepEqual(leaves(s), [[X]], "only X: the others are listed");
  assert.deepEqual(recorded(s), ["https://o.example", "https://s.example", "https://www.a.example"]);
  // A set_scopes that is not applied changes no list of the check (its scopes is not an object).
  await s.set({ lists: { md: ["a.example"] }, scopes: [], default: null, operator: "*" });
  await flush();
  assert.deepEqual(leaves(s), [[X]]);
  // The list spare goes: s.example is on no list now. No scope's list lost an entry, so C5's own removal does not run.
  const full = fullRemovals(s).length;
  await s.set(scopesWith("*", { lists: { md: ["a.example"], ops: ["o.example"] } }));
  await flush();
  assert.equal(fullRemovals(s).length, full, "no full removal");
  assert.deepEqual(leaves(s), [[X], ["https://s.example"]]);
  assert.deepEqual(recorded(s), ["https://o.example", "https://www.a.example"]);
});

// ---- the worker's start ----

test("at the worker's start the recorded origins of the copy go (no tab is marked after a start), except one that a tab marked since the start shows; a key that is no origin leaves the copy", async () => {
  const copy = { "tab:7": "md-lead", [WORKER_KEY + X]: true, [WORKER_KEY + Y]: true, [WORKER_KEY + Z]: true, [WORKER_KEY + "not an origin"]: true, [WORKER_KEY + Y + "/path"]: true };
  const s = await setup({
    copy,
    scopes: null,
    beforeStart: (f) => {
      // The operator's Ctrl+T before the restore ends: a marked tab that shows Y.
      f.tabs_.push({ id: 20, windowId: 1, url: Y + "/" });
      f.chrome.tabs.onCreated.fire({ id: 20, windowId: 1, url: "", pendingUrl: NEW_TAB_URL });
    },
  });
  await flush();
  assert.equal(s.r.map.isMarked(20), true);
  assert.deepEqual(leaves(s), [[X, Z].sort()]);
  assert.deepEqual(recorded(s), [Y]);
  assert.deepEqual(copyKeys(s), keysOf(Y));
  assert.equal(s.f.storage_.session["tab:7"], "md-lead", "the map's key stays");
});

test("a start whose copy read fails removes no recorded origin (C5's removal at the first set_scopes removes every worker)", async () => {
  const s = await setup({
    copy: { [WORKER_KEY + X]: true },
    scopes: null,
    beforeStart: (f) => {
      f.impl["storage.session.get"] = async () => {
        throw new Error("no");
      };
    },
  });
  await flush();
  assert.deepEqual(leaves(s), []);
  await s.set(scopesWith());
  assert.equal(fullRemovals(s).length, 1, "the first set_scopes after the start: every worker");
});

// ---- a failed removal ----

test("a failed or late removal logs one line with no origin, keeps the origins in the record and the copy, and the next event's check removes them again", { timeout: 5000 }, async () => {
  for (const kind of ["fails", "late"]) {
    const s = await setup();
    const log = quietWarn();
    try {
      operatorTab(s, 20);
      await flush();
      commit(s, 20, X + "/");
      await flush();
      s.f.impl["browsingData.remove"] = kind === "fails" ? async () => {
        throw new Error("busy");
      } : () => new Promise(() => {});
      commit(s, 20, "about:blank");
      await flush();
      if (kind === "late") await s.fire(REMOVAL_WAIT_MS);
      assert.equal(leaves(s).length, 1, kind);
      assert.deepEqual(recorded(s), [X], kind);
      assert.deepEqual(copyKeys(s), keysOf(X), kind);
      assert.equal(log.logged.filter((l) => /service worker removal/.test(l)).length, 1, `${kind}: one log line`);
      assert.ok(!log.logged.some((l) => /nolist|localhost|example/.test(l)), "no origin in the log");
      delete s.f.impl["browsingData.remove"];
      operatorTab(s, 21); // the next event
      await flush();
      assert.deepEqual(leaves(s), [[X], [X]], kind);
      assert.deepEqual(recorded(s), [], kind);
      assert.deepEqual(copyKeys(s), [], kind);
    } finally {
      log.restore();
    }
  }
});

test("a frame read that fails or comes late removes nothing (a shown origin could break the operator's page), logs one line, and the next event's check removes", { timeout: 5000 }, async () => {
  for (const kind of ["fails", "late"]) {
    const s = await setup();
    const log = quietWarn();
    try {
      operatorTab(s, 20);
      operatorTab(s, 21);
      await flush();
      commit(s, 20, X + "/");
      await flush();
      s.f.impl["webNavigation.getAllFrames"] = kind === "fails" ? async () => {
        throw new Error("No frame");
      } : () => new Promise(() => {});
      commit(s, 20, "about:blank");
      await flush();
      if (kind === "late") await s.fire(REMOVAL_WAIT_MS);
      assert.deepEqual(leaves(s), [], kind);
      assert.ok(log.logged.some((l) => /frames/.test(l)), `${kind}: a log line`);
      delete s.f.impl["webNavigation.getAllFrames"];
      commit(s, 21, "about:blank");
      await flush();
      assert.deepEqual(leaves(s), [[X]], kind);
    } finally {
      log.restore();
    }
  }
});

// ---- C5's worker removal of a set_scopes ----

test("C5's worker removal of a set_scopes stays browsingData.remove({}, {serviceWorkers: true}); a failed leave removal does not fail a set_scopes, and a failed C5 removal does not stop a leave removal", async () => {
  const s = await setup();
  assert.deepEqual(fullRemovals(s).map(([d, what]) => [d, what]), [[{}, { serviceWorkers: true }]], "the first set_scopes after the start");
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/");
  await flush();
  // The leave's removal fails; a set_scopes at the same time answers ok.
  s.f.impl["browsingData.remove"] = async (d) => {
    if (d && d.origins) throw new Error("busy");
  };
  const log = quietWarn();
  try {
    commit(s, 20, "about:blank");
    await flush();
    const res = await s.set(scopesWith("*", { lists: { ...LISTS, md: ["a.example", "b.example"] } }));
    assert.equal(res.closed, 0, "the set_scopes answers ok");
    // C5's removal fails (md loses b.example); the leave's removal runs and succeeds.
    s.f.impl["browsingData.remove"] = async (d) => {
      if (!d || !d.origins) throw new Error("busy");
    };
    await assert.rejects(s.set(scopesWith()), /service worker removal failed/);
    await flush();
    assert.deepEqual(recorded(s), [], "the leave's removal ran after that set_scopes");
    assert.deepEqual(leaves(s).at(-1), [X]);
  } finally {
    log.restore();
    delete s.f.impl["browsingData.remove"];
  }
});

test("with no marked tab no frame is read; a listed origin of a scope's tab stays recorded with no removal at a commit, a set_scopes or a close", async () => {
  const s = await setup();
  commit(s, 7, "https://a.example/");
  await s.set(scopesWith("*", { lists: { ...LISTS, md: ["a.example", "c.example"] } }));
  s.f.closeTab(3);
  await flush();
  assert.deepEqual(s.f.callsTo("webNavigation.getAllFrames"), []);
  assert.deepEqual(leaves(s), []);
  assert.deepEqual(recorded(s), ["https://a.example"]);
});
