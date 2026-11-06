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
import { WORKER_KEY } from "../agent/workers.js";
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

test("a marked tab's commits record their web origins (the top frame and each sub-frame, a blob: page by its inner origin) in memory and in the copy; other schemes and the commits of other tabs record nothing", async () => {
  const s = await setup();
  operatorTab(s, 20);
  await flush();
  commit(s, 20, X + "/sw-reg");
  commit(s, 20, Y + "/frame", { frameId: 5, parentFrameId: 0 });
  commit(s, 20, "blob:https://b2.example/0d2b8c6e", { frameId: 6, parentFrameId: 0 });
  commit(s, 20, Z + "/inner", { frameId: 9, parentFrameId: 5 });
  for (const [id, u] of [[7, "about:blank"], [8, "about:srcdoc"], [10, "data:text/html,x"], [11, "blob:null/0d2b8c6e"], [12, "chrome-error://chromewebdata/"]]) commit(s, 20, u, { frameId: id, parentFrameId: 0 });
  // A tab of a scope, a tab of no scope and no mark: not the operator's tabs.
  commit(s, 7, "https://a.example/");
  commit(s, 3, "https://u.example/");
  await flush();
  const want = [X, Y, "https://b2.example", Z].sort();
  assert.deepEqual(recorded(s), want);
  assert.deepEqual(copyKeys(s), keysOf(...want), "the copy, one key per origin");
  assert.deepEqual(leaves(s), [], "every origin is still shown");
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

test("no tab ever marked, or nothing recorded: no frame read and no leave removal at a set_scopes, a close or a commit", async () => {
  const s = await setup();
  commit(s, 7, "https://a.example/");
  await s.set(scopesWith("*", { lists: { ...LISTS, md: ["a.example", "c.example"] } }));
  s.f.closeTab(3);
  await flush();
  assert.deepEqual(s.f.callsTo("webNavigation.getAllFrames"), []);
  assert.deepEqual(leaves(s), []);
});
