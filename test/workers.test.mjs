// The worker removal of the recorded origins (C5; board ab-v16.74: the operator's answer ab-214, review-30,
// review-30b and ab-lead's decisions): the receiver records each web origin that a frame of any tab
// commits (the top frame and every sub-frame), in memory and in chrome.storage.session, at most
// RECORD_MAX origins. A check reads the frames of the marked tabs (webNavigation.getAllFrames) and
// removes the workers of each recorded origin that no list of the last applied set_scopes covers and
// whose site no marked tab shows (the site rule), with browsingData.remove({origins}, {serviceWorkers:
// true}). The events: each commit and navigation error of a frame of any tab, a marked tab's close or
// replace, a mark change, each set_scopes, the worker's start, and a follow-up check RECHECK_MS after a
// removal. The bound never evicts an origin whose site a marked tab shows; page content never causes a
// removal of every worker (only a list's end does, with excludeOrigins). A removal has
// REMOVAL_WAIT_MS; a failure logs one line and the next event's check removes again. C5's own worker
// removal of a set_scopes shares the bounded call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NEW_TAB_URL } from "../agent/receiver.js";
import { REMOVAL_WAIT_MS } from "../agent/removals.js";
import { RECHECK_MS, WORKER_KEY, siteOf } from "../agent/workers.js";
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

test("a frame that goes: a sub-frame's own navigation at its commit; a frame that a page script removes after its load (no event) at that tab's next event, not at another tab's", async () => {
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
  commit(s, 21, "https://q.example/"); // an event of another marked tab: tab 20's last read stays
  await flush();
  assert.deepEqual(leaves(s), [[X]], "tab 20's frames are read again only after an event of its own");
  commit(s, 20, "https://p.example/f2", { frameId: 6, parentFrameId: 0 }); // tab 20's next event
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
  assert.deepEqual(held.map((h) => h.q.tabId), [20], "the check reads the frames of the tab with an event (tab 21's last read stays)");
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
  assert.deepEqual(held.map((h) => h.q.tabId), [21], "only the tab with an event (tab 20's last read stays)");
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

// ---- the bound (review-30b B1 and ab-lead's decision: no page content removes a worker of a shown site or of a listed origin) ----

// Every call of browsingData.remove that is no removal of given origins (a removal of every worker, with or without excludeOrigins).
const wide = (s) => s.f.callsTo("browsingData.remove").filter(([d]) => !d || !d.origins);
const removedAny = (s) => new Set(leaves(s).flat());

// Frames of distinct origins of one site (a page that floods the record), as a tab's sub-frames.
function flood(s, tabId, top, n, host = (i) => `https://f${i}.b1.example`) {
  commit(s, tabId, top);
  for (let i = 0; i < n; i++) commit(s, tabId, host(i) + "/tiny", { frameId: 100 + i, parentFrameId: 0 });
}

test("the flood: marked tabs that show frames of more origins than the bound never make the receiver remove a worker of a site that a marked tab shows or of a listed origin; the record stays at the bound", async () => {
  const s = await setup();
  s.r.workers.max = 8;
  operatorTab(s, 20);
  operatorTab(s, 21);
  operatorTab(s, 22);
  await flush();
  commit(s, 20, X + "/home"); // the operator's open page on a host on no list
  commit(s, 7, "https://a.example/own/"); // a listed site's page in a scope's tab
  await flush();
  flood(s, 21, "https://www.b1.example/burst", 12);
  flood(s, 22, "https://www.b2.example/burst", 12, (i) => `https://f${i}.b2.example`);
  await flush();
  commit(s, 7, "https://a.example/again"); // one more event while the floods stay open
  commit(s, 3, "https://u.example/"); // one more new origin, on no list
  await flush();
  assert.deepEqual(wide(s).length, 1, "only C5's removal of every worker at the first set_scopes");
  const gone = removedAny(s);
  for (const o of [X, "https://a.example"]) assert.ok(!gone.has(o), `${o}: kept`);
  for (const o of gone) assert.ok(!/b[12]\.example$/.test(o), `${o}: of a shown site, never removed while shown`);
  assert.ok(gone.has("https://u.example"), "an origin on no list that no marked tab shows still goes");
  assert.ok(recorded(s).length <= 8, "the bound");
  assert.ok(recorded(s).includes(X), "the open page's origin is never evicted");
  // The flood pages leave: their recorded origins go; then the operator's tab leaves X: X goes (the gap after the leave stays closed).
  s.f.closeTab(21);
  s.f.closeTab(22);
  await flush();
  assert.ok([...removedAny(s)].some((o) => /b1\.example$/.test(o)), "the flood's recorded origins go");
  assert.ok(!removedAny(s).has(X));
  commit(s, 20, "https://other.example/");
  await flush();
  assert.ok(removedAny(s).has(X), "X goes at its leave");
  assert.deepEqual(wide(s).length, 1, "still no removal of every worker");
});

test("the flood in a scope's tab: a listed page with frames of many origins on no list removes only those origins, never a shown site's or a listed origin's worker", async () => {
  const s = await setup();
  s.r.workers.max = 6;
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/home");
  flood(s, 7, "https://a.example/burst", 20, (i) => `https://u${i}.example`);
  // Before any check: each new origin evicted the oldest origin on no list (its own removal follows).
  assert.deepEqual(recorded(s), [X, "https://a.example", "https://u16.example", "https://u17.example", "https://u18.example", "https://u19.example"].sort());
  await flush();
  const gone = removedAny(s);
  for (let i = 0; i < 20; i++) assert.ok(gone.has(`https://u${i}.example`), `u${i}: removed`);
  assert.ok(!gone.has(X) && !gone.has("https://a.example"));
  assert.deepEqual(wide(s).length, 1);
  assert.ok(recorded(s).length <= 6);
});

test("a listed origin that the bound evicts: no removal of every worker while its list is in force; at its list's end one removal of every worker that excludes the shown origins and the listed origins of the record; a failed one is retried at the next check", async () => {
  const s = await setup();
  s.r.workers.max = 3;
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/home");
  commit(s, 7, "https://a.example/"); // listed (md)
  commit(s, 3, "https://o.example/"); // listed (ops)
  await flush();
  commit(s, 3, "https://s.example/"); // listed (spare): the bound evicts a.example, the oldest listed origin
  await flush();
  assert.deepEqual(recorded(s), [X, "https://o.example", "https://s.example"].sort());
  assert.deepEqual(wide(s).length, 1, "nothing while md is in force");
  await s.set(scopesWith("*", { lists: { ...LISTS, spare: ["s.example", "t.example"] } })); // a.example's entry stays
  await flush();
  assert.deepEqual(wide(s).length, 1, "nothing: a.example's entry stays");
  // md loses a.example (C5's own removal of every worker runs for that shrink, with {}); the list's end owes the excluding one.
  s.f.impl["browsingData.remove"] = async (d) => {
    if (d && d.excludeOrigins) throw new Error("busy");
  };
  const log = quietWarn();
  try {
    await s.set(scopesWith("*", { lists: { md: ["b.example"], ops: ["o.example"], spare: ["s.example"] } }));
    await flush();
    const failed = wide(s).filter(([d]) => d && d.excludeOrigins);
    assert.equal(failed.length, 1, "the list end's removal ran and failed");
    delete s.f.impl["browsingData.remove"];
    commit(s, 3, "https://s.example/again"); // the next event (an origin of the record: no eviction)
    await flush();
  } finally {
    log.restore();
  }
  const excluding = wide(s).filter(([d]) => d && d.excludeOrigins);
  assert.equal(excluding.length, 2, "retried at the next check");
  assert.deepEqual([...excluding[1][0].excludeOrigins].sort(), ["https://o.example", "https://s.example", X].sort(), "the shown origin and the recorded listed origins");
  assert.deepEqual(excluding[1][1], { serviceWorkers: true });
  commit(s, 3, "https://s.example/next");
  await flush();
  assert.equal(wide(s).filter(([d]) => d && d.excludeOrigins).length, 2, "once");
});

test("a record full of origins of shown sites: a new origin of a shown site is not recorded (the residue), one on no list goes at once, and nothing removes a shown site's worker", async () => {
  const s = await setup();
  s.r.workers.max = 3;
  operatorTab(s, 20);
  await flush();
  flood(s, 20, "https://www.b1.example/", 2); // www, f0, f1: three origins of one shown site
  await flush();
  assert.deepEqual(recorded(s), ["https://f0.b1.example", "https://f1.b1.example", "https://www.b1.example"]);
  commit(s, 20, "https://f9.b1.example/tiny", { frameId: 199, parentFrameId: 0 });
  commit(s, 3, "https://u.example/");
  await flush();
  assert.deepEqual(recorded(s), ["https://f0.b1.example", "https://f1.b1.example", "https://www.b1.example"], "f9 is not recorded");
  assert.deepEqual(leaves(s), [["https://u.example"]]);
  assert.deepEqual(wide(s).length, 1);
});

test("a marked tab's commit makes its site shown at once: before any check the bound evicts no origin of that site", async () => {
  const s = await setup();
  s.r.workers.max = 3;
  operatorTab(s, 20);
  await flush();
  // All before a check: the page and two frames of its site, then a fourth origin of that site.
  commit(s, 20, "https://www.b1.example/");
  commit(s, 20, "https://f0.b1.example/tiny", { frameId: 100, parentFrameId: 0 });
  commit(s, 20, "https://f1.b1.example/tiny", { frameId: 101, parentFrameId: 0 });
  commit(s, 20, "https://f2.b1.example/tiny", { frameId: 102, parentFrameId: 0 });
  assert.deepEqual(recorded(s), ["https://f0.b1.example", "https://f1.b1.example", "https://www.b1.example"], "the oldest origins of the shown site stay");
  await flush();
  assert.deepEqual(leaves(s), []);
});

// review-30b note 4: the lists at removal time, not at the check's start.
test("a set_scopes during the check's frame read that puts an origin on a list: that check does not remove it", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/");
  await flush();
  const held = [];
  s.f.impl["webNavigation.getAllFrames"] = (q) => new Promise((resolve) => held.push({ q, resolve }));
  commit(s, 20, "about:blank");
  await flush();
  assert.equal(held.length, 1);
  await s.set(scopesWith("*", { lists: { ...LISTS, spare: ["s.example", "nolist.localhost"] } }));
  delete s.f.impl["webNavigation.getAllFrames"];
  held[0].resolve([{ frameId: 0, parentFrameId: -1, url: "about:blank", documentLifecycle: "active" }]);
  await flush();
  assert.deepEqual(leaves(s), [], "X is listed now");
});

// review-30b note 2: a page can register its worker after the check of its own commit.
test("a removed origin gets a follow-up check RECHECK_MS later: a worker that its page registered after the first check goes too; then the origin is forgotten", async () => {
  const s = await setup();
  commit(s, 7, "https://a.example/");
  commit(s, 7, "https://cdn.u.example/f", { frameId: 2, parentFrameId: 0 }); // a frame on no list in a listed page
  await flush();
  assert.deepEqual(leaves(s), [["https://cdn.u.example"]]);
  await s.fire(RECHECK_MS);
  assert.deepEqual(leaves(s), [["https://cdn.u.example"], ["https://cdn.u.example"]], "the follow-up check");
  await s.fire(RECHECK_MS);
  assert.deepEqual(leaves(s).length, 2, "once");
  // An origin shown or listed at the follow-up check stays.
  operatorTab(s, 20);
  await flush();
  commit(s, 7, "https://cdn.v.example/f", { frameId: 3, parentFrameId: 0 });
  await flush();
  commit(s, 20, "https://cdn.v.example/");
  await flush();
  await s.fire(RECHECK_MS);
  assert.deepEqual(leaves(s), [["https://cdn.u.example"], ["https://cdn.u.example"], ["https://cdn.v.example"]], "shown at the follow-up: kept");
});

// ---- review-30c B2: the list end's excludeOrigins, the own check and the shown sites ----

const excluding = (s) => s.f.callsTo("browsingData.remove").filter(([d]) => d && d.excludeOrigins).map(([d]) => [...d.excludeOrigins].sort());
// A session end: md-lead's list goes (no shrink, so C5's own removal of every worker does not run).
const SESSION_END = { lists: { ops: ["o.example"], spare: ["s.example"] }, scopes: { "md-lead": null }, default: null, operator: "*" };

test("the list end's removal of every worker keeps a shown origin that the full record could not hold (excludeOrigins)", async () => {
  const s = await setup();
  s.r.workers.max = 3;
  operatorTab(s, 20);
  await flush();
  commit(s, 7, "https://a.example/"); // listed (md)
  commit(s, 20, "https://www.b1.example/");
  commit(s, 20, "https://f0.b1.example/t", { frameId: 100, parentFrameId: 0 });
  await flush();
  commit(s, 20, "https://f1.b1.example/t", { frameId: 101, parentFrameId: 0 }); // evicts a.example (listed)
  commit(s, 20, "https://f2.b1.example/t", { frameId: 102, parentFrameId: 0 }); // no room: not recorded (residue 1)
  await flush();
  assert.ok(!recorded(s).includes("https://f2.b1.example"));
  await s.set(SESSION_END);
  await flush();
  const e = excluding(s);
  assert.equal(e.length, 1, "one list-end removal");
  assert.ok(e[0].includes("https://f2.b1.example"), "the shown origin out of the record is kept: " + JSON.stringify(e[0]));
});

test("the list end's removal of every worker keeps a recorded origin of a shown site that no frame shows at that time (excludeOrigins: a first-party worker needs its exact origin)", async () => {
  const s = await setup();
  s.r.workers.max = 3;
  operatorTab(s, 20);
  await flush();
  commit(s, 7, "https://a.example/"); // listed (md)
  commit(s, 20, "https://www.b1.example/");
  commit(s, 20, "https://api.b1.example/t", { frameId: 100, parentFrameId: 0 });
  await flush();
  commit(s, 20, "about:blank", { frameId: 100, parentFrameId: 0 }); // api.b1 shows nothing now; its site is still shown
  await flush();
  commit(s, 3, "https://s.example/"); // listed (spare): evicts a.example (the record: www.b1, api.b1, s)
  await flush();
  assert.ok(recorded(s).includes("https://api.b1.example"));
  await s.set(SESSION_END);
  await flush();
  const e = excluding(s);
  assert.equal(e.length, 1, "one list-end removal");
  assert.ok(e[0].includes("https://api.b1.example"), "the recorded origin of the shown site is kept: " + JSON.stringify(e[0]));
});

test("an evicted origin whose site a marked tab shows by the time of its own check keeps its workers", async () => {
  const s = await setup();
  s.r.workers.max = 2;
  operatorTab(s, 20);
  await flush();
  commit(s, 3, "https://u.example/");
  await flush();
  // The frame reads wait, so that the evictions and the marked tab's commits come before the own checks.
  const held = [];
  s.f.impl["webNavigation.getAllFrames"] = (q) => new Promise((resolve) => held.push({ q, resolve }));
  commit(s, 3, "https://v.example/");
  commit(s, 3, "https://w.example/");
  commit(s, 3, "https://x.example/"); // evicts the oldest free origin
  const evicted = ["https://v.example", "https://w.example"].filter((o) => !recorded(s).includes(o));
  assert.ok(evicted.length > 0, "an origin was evicted");
  // A marked tab now shows the site of each of them.
  commit(s, 20, "https://www.v.example/");
  commit(s, 20, "https://www.w.example/f", { frameId: 5, parentFrameId: 0 });
  delete s.f.impl["webNavigation.getAllFrames"];
  for (const h of held) h.resolve(structuredClone(s.f.frames_.get(h.q.tabId) ?? []));
  await flush(20);
  const gone = removedAny(s);
  for (const o of ["https://v.example", "https://w.example"]) assert.ok(!gone.has(o), `${o}: kept while a marked tab shows its site; removals: ${JSON.stringify(leaves(s))}`);
});

test("a site that the marked tabs left is not shown any more for the bound: a new origin of it that finds no room gets its own check and goes", async () => {
  const s = await setup();
  s.r.workers.max = 3;
  operatorTab(s, 20);
  await flush();
  commit(s, 20, "https://www.k.example/");
  await flush();
  commit(s, 20, "https://www.b1.example/"); // the tab leaves k: the check removes www.k.example
  await flush();
  commit(s, 20, "https://f0.b1.example/t", { frameId: 100, parentFrameId: 0 });
  commit(s, 20, "https://f1.b1.example/t", { frameId: 101, parentFrameId: 0 });
  await flush();
  assert.deepEqual(recorded(s), ["https://f0.b1.example", "https://f1.b1.example", "https://www.b1.example"]);
  commit(s, 3, "https://api.k.example/"); // a tab of no scope, no room
  await flush();
  assert.ok(removedAny(s).has("https://api.k.example"), "api.k.example had its own check: " + JSON.stringify(leaves(s)));
});

// review-30c B3 d: each removal's follow-up comes RECHECK_MS after that removal, not at an earlier removal's timer.
test("each removal arms its own follow-up timer of RECHECK_MS, also while an earlier one runs", async () => {
  const s = await setup();
  commit(s, 3, "https://u1.example/");
  await flush();
  assert.equal(s.pending(RECHECK_MS).length, 1, "the timer of u1's removal");
  commit(s, 3, "https://u2.example/");
  await flush();
  assert.deepEqual(leaves(s), [["https://u1.example"], ["https://u2.example"]]);
  assert.equal(s.pending(RECHECK_MS).length, 2, "u2's removal has its own timer");
  // The first timer: u1's follow-up only.
  const [t1] = s.pending(RECHECK_MS);
  t1.cleared = true;
  t1.fn();
  await flush();
  assert.deepEqual(leaves(s).slice(2), [["https://u1.example"]]);
  await s.fire(RECHECK_MS);
  assert.deepEqual(leaves(s).slice(3), [["https://u2.example"]], "u2's follow-up at its own timer");
});

// review-30c B1: the CPU work of a check grows linearly with the shown origins; the bound refuses an origin in O(1).
test("a check with 3000 shown origins and a full record does work linear in the origins, reads no frames of a marked tab with no event, and the bound refuses each origin with one step", async () => {
  const s = await setup();
  operatorTab(s, 20);
  operatorTab(s, 21);
  operatorTab(s, 22);
  await flush();
  for (const [tab, sub] of [[20, "b1"], [21, "b2"], [22, "b3"]]) flood(s, tab, `https://www.${sub}.example/burst`, 1000, (i) => `https://f${i}.${sub}.example`);
  await flush(20);
  assert.equal(recorded(s).length, 1000, "the bound");
  const w0 = s.r.workers.stats.work;
  const m0 = s.r.workers.stats.room;
  const r0 = s.f.callsTo("webNavigation.getAllFrames").length;
  commit(s, 7, "https://a.example/next"); // one more check, after an event of a tab that is not marked
  await flush(20);
  assert.equal(s.f.callsTo("webNavigation.getAllFrames").length - r0, 0, "no marked tab had an event: its last frame read stays (no new read)");
  const work = s.r.workers.stats.work - w0;
  assert.ok(work > 0 && work <= 4 * (3003 + 1000), `one check's work: ${work}`);
  // Each origin that the full record refuses costs one step of the bound.
  const m1 = s.r.workers.stats.room;
  commit(s, 20, "https://f9999.b1.example/t", { frameId: 9999, parentFrameId: 0 });
  assert.equal(s.r.workers.stats.room - m1, 1, "one step for a refused origin");
  assert.ok(m1 - m0 <= 2003 + 1, `the check's learning: ${m1 - m0} steps`);
  await flush(20);
  assert.deepEqual(wide(s).length, 1);
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
