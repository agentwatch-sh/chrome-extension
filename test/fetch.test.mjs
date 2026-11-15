// The receiver's part of PageFetch (contracts C4, C5 and C10; board ab-v16.102): the fetch window, the
// fetch window's rules (rule 78 and the blocks of the refused addresses), fetch_end, the hiding, the
// guard's skip, the merge guard's floor, and that an act window and a fetch window never both open.
// The receiver is wired as agent/sw.js wires it (test/receiver-harness.mjs), on the fake chrome,
// against the shared vector test/vectors/fetch.json (and test/vectors/act.json for the act window).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FETCH_BLOCK_FIRST, FETCH_BLOCK_PRIORITY, FETCH_RULE_ID, FETCH_RULE_MAX, FETCH_WORKER_FREE, FLOOR_RULE_ID, REFUSED_ADDRESSES, SessionRules, fetchRules } from "../agent/dnr.js";
import { FEATURES } from "../agent/link.js";
import { callsSince, flush, startReceiver } from "./receiver-harness.mjs";
import { makeFakeChrome } from "./fake-chrome.mjs";

const V = JSON.parse(readFileSync(new URL("./vectors/fetch.json", import.meta.url), "utf8"));
const A = JSON.parse(readFileSync(new URL("./vectors/act.json", import.meta.url), "utf8"));
const WIN = V.fetchWindow.res.data;
const FETCH_TAB = WIN.tabs[0].id; // 61
const ACT_WIN = A.actWindow.res.data;
const ACT_TAB = ACT_WIN.tabs[0].id; // 31
const REGULAR = { id: 7, windowId: 1, url: "https://staging.example.com/home" };
const isFetchRule = (r) => r.id >= FETCH_RULE_ID && r.id <= FETCH_RULE_MAX;
const isActRule = (r) => r.id >= 10 && r.id <= 77;
const fetchRulesIn = (f) => f.sessionRules_.filter(isFetchRule).sort((a, b) => a.id - b.id);

// windows.create with incognito gives the fetch window of the vector (or the act window of act.json
// for the act's createData); its tab is open, with a target, so the receiver's close can close it,
// and Chrome lists the off-the-record cookie store "1" (the fake drops it with the last incognito tab).
function incognitoWindows(f, win = WIN) {
  f.impl["windows.create"] = async (data) => {
    if (data.incognito !== true) return { id: 800 + f.calls.length, incognito: false, ...data, tabs: [{ id: 850 + f.calls.length, incognito: false }] };
    const w = structuredClone(f.nextWindow ?? win);
    f.nextWindow = null;
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
  s.openFetch = async (req = V.fetchWindow.req) => {
    const res = await s.answer(req);
    assert.deepEqual(res, { ...V.fetchWindow.res, id: req.id }, "the fetch window");
    return res;
  };
  s.openAct = async () => {
    s.f.nextWindow = ACT_WIN;
    const res = await s.answer(A.actWindow.req);
    assert.deepEqual(res, A.actWindow.res, "the act window");
    return res;
  };
  // A popup of a tab (webNavigation.onCreatedNavigationTarget), open in Chrome with a target.
  s.popup = async (tabId, sourceTabId, windowId = 66) => {
    s.f.tabs_.push({ id: tabId, windowId, incognito: true, url: "about:blank", openerTabId: sourceTabId });
    s.f.targets_.push({ id: "T" + tabId, tabId, type: "page", attached: false });
    s.f.chrome.webNavigation.onCreatedNavigationTarget.fire({ tabId, sourceTabId, sourceFrameId: 0, url: "about:blank" });
    await flush();
  };
  return s;
}

// ---- the fetch window (C10) ----

test("the fetch window: windows.create with incognito and the mark fetch opens an incognito window, also for a scope with no list; its tab has no scope and no copy key tab:<id>, and the fetch window's rules hold for it", async () => {
  const s = await setup();
  const mark = s.f.calls.length;
  await s.openFetch();
  const calls = callsSince(s.f, mark).map(([p]) => p);
  assert.ok(calls.indexOf("extension.isAllowedIncognitoAccess") < calls.indexOf("tabs.query"), "the incognito check first");
  assert.ok(calls.indexOf("tabs.query") < calls.indexOf("windows.create"), "the check of other incognito tabs before the window");
  assert.ok(calls.lastIndexOf("declarativeNetRequest.getSessionRules") > calls.indexOf("windows.create"), "the rules are confirmed by a read");
  assert.deepEqual(s.f.callsTo("windows.create"), [V.fetchWindow.chrome[1]], "Chrome gets incognito true; the scope and the mark stay in the receiver");
  assert.equal(s.r.map.isFetch(FETCH_TAB), true);
  assert.equal(s.r.map.scopeOf(FETCH_TAB), undefined, "no scope: the list does not apply");
  assert.equal(s.r.map.isOrphan(FETCH_TAB), false);
  assert.deepEqual(s.r.map.list(), [], "bridge.tabScopes leaves the fetch tab out");
  assert.deepEqual((await s.answer({ id: "ts", op: "bridge.tabScopes", args: [] })).data, []);
  assert.deepEqual(s.f.storage_.session, V.fetchWindow.copy, "the copy holds the fetch window, not the fetch tab");
  assert.deepEqual(fetchRulesIn(s.f), V.rules, "the fetch window's rules of the vector");
  assert.ok(!s.f.sessionRules_.some((r) => r.id >= 100 && (r.condition.tabIds ?? []).includes(FETCH_TAB)), "no scope rule names the fetch tab");
  assert.ok(!s.evs().some((e) => e.ev === "bridge.tabScope"), "no bridge.tabScope names the fetch tab");
  // A scope that the last set_scopes does not name at all: the same (the window needs no list).
  const t = await setup();
  await t.openFetch({ ...V.fetchWindow.req, id: "other", args: [V.fetchWindow.req.args[0], "a-repo-with-no-entry", "fetch"] });
  assert.equal(t.r.map.isFetch(FETCH_TAB), true);
});

test("the window's own checks: each windowErrors vector gets its error, no window stays open, and no fetch rule or key stays", async () => {
  for (const v of V.windowErrors) {
    const s = await setup({ tabs: [REGULAR, ...(v.setup === "another incognito tab" ? [A.incognitoTab] : [])] });
    if (v.setup === "no incognito access") s.f.incognitoAllowed = false;
    if (v.setup === "no window") s.f.impl["windows.create"] = async () => undefined;
    if (v.setup === "act window") await s.openAct();
    if (v.setup === "rules fail") {
      s.f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
        if ((d.addRules ?? []).some(isFetchRule)) throw new Error("rule refused (test)");
        const kept = s.f.sessionRules_.filter((r) => !(d.removeRuleIds ?? []).includes(r.id));
        s.f.sessionRules_ = [...kept, ...structuredClone(d.addRules ?? [])];
      };
    }
    const before = s.f.callsTo("windows.create").length;
    s.send(v.req);
    await flush(16);
    assert.deepEqual(s.resOf(v.req.id), [{ t: "res", ch: "bridge", id: v.req.id, ok: false, error: v.error }], v.req.id);
    if (v.setup !== "rules fail" && v.setup !== "no window") assert.equal(s.f.callsTo("windows.create").length, before, `${v.req.id}: no window opens`);
    assert.ok(!s.f.tabs_.some((t) => t.id === FETCH_TAB), `${v.req.id}: no fetch tab stays open`);
    assert.equal(s.r.map.isFetch(FETCH_TAB), false, `${v.req.id}: no fetch tab`);
    assert.deepEqual(fetchRulesIn(s.f), [], `${v.req.id}: no fetch rule`);
    assert.ok(!Object.keys(s.f.storage_.session).some((k) => k.startsWith("fetch")), `${v.req.id}: no fetch key`);
    if (v.setup === "act window") assert.ok(s.f.tabs_.some((t) => t.id === ACT_TAB), `${v.req.id}: the act window stays`);
    if (v.setup === "another incognito tab") assert.ok(s.f.tabs_.some((t) => t.id === A.incognitoTab.id), `${v.req.id}: the operator's tab stays`);
  }
});

test("an act window and a fetch window never both open: each refuses while the other is open, also when both ops come in the same moment", async () => {
  const s = await setup();
  await s.openFetch();
  s.f.nextWindow = ACT_WIN;
  assert.equal((await s.answer({ ...A.actWindow.req, id: "act-during-fetch" })).error, "another private window is open");
  assert.ok(s.f.tabs_.some((t) => t.id === FETCH_TAB), "the act does not end the fetch window");
  assert.equal((await s.main(V.endReq)).ok, true);
  await s.openAct();
  assert.equal((await s.answer({ ...V.fetchWindow.req, id: "fetch-during-act" })).error, "another private window is open");
  assert.ok(s.f.tabs_.some((t) => t.id === ACT_TAB), "the fetch does not end the act");
  assert.equal(s.r.map.isFetch(FETCH_TAB), false);
  // Both in the same moment: the second one's check of the incognito tabs comes after the first one's window.
  const t = await setup();
  t.f.impl["windows.create"] = async (data) => {
    const w = structuredClone(data.incognito === true && t.f.calls.filter(([p]) => p === "windows.create").length === 1 ? WIN : ACT_WIN);
    for (const tab of w.tabs) {
      t.f.tabs_.push({ id: tab.id, windowId: w.id, incognito: true, url: "about:blank" });
      t.f.targets_.push({ id: "T" + tab.id, tabId: tab.id, type: "page", attached: false });
    }
    return w;
  };
  t.send({ ...V.fetchWindow.req, id: "both-fetch" });
  t.send({ ...A.actWindow.req, id: "both-act" });
  await flush(24);
  const res = [...t.resOf("both-fetch"), ...t.resOf("both-act")];
  assert.equal(res.length, 2);
  assert.deepEqual(res.map((r) => r.ok), [true, false], "the first one opens");
  assert.equal(res[1].error, "another private window is open");
  assert.equal(t.f.callsTo("windows.create").length, 1, "one window only");
  assert.equal(t.f.tabs_.filter((x) => x.incognito).length, 1);
});

test("a left fetch window ends before the next one (a crash of the service left it): its tab closes by the receiver's close, its rules and its key go", async () => {
  const s = await setup();
  await s.openFetch();
  s.f.nextWindow = { ...WIN, id: 63, tabs: [{ ...WIN.tabs[0], id: 64, windowId: 63 }] };
  const res = await s.answer({ ...V.fetchWindow.req, id: "second" });
  assert.equal(res.ok, true, "the second fetch window");
  assert.deepEqual(s.f.callsTo("debugger.sendCommand").filter(([, m]) => m === "Target.closeTarget").map(([t]) => t.tabId), [FETCH_TAB], "the left fetch tab closed, with no beforeunload");
  assert.ok(!s.f.tabs_.some((t) => t.id === FETCH_TAB));
  assert.deepEqual(fetchRulesIn(s.f), fetchRules([64]), "the rules name the new fetch tab only");
  assert.deepEqual(s.f.storage_.session, { "fetch:63": true });
  assert.equal(s.r.map.isFetch(64), true);
  assert.equal(s.r.map.isFetch(FETCH_TAB), false);
});

test("the fail-closed paths of windows.create: a rule that the read does not hold, a failed key write and a link change during the op end the fetch window", async () => {
  // The read does not hold a rule: rules not held, and the window closes.
  const s = await setup();
  s.f.impl["declarativeNetRequest.getSessionRules"] = async () => structuredClone(s.f.sessionRules_.filter((r) => r.id !== FETCH_BLOCK_FIRST));
  s.send(V.fetchWindow.req);
  await flush(16);
  assert.equal(s.resOf(V.fetchWindow.req.id)[0].error, "rules not held");
  assert.ok(!s.f.tabs_.some((t) => t.id === FETCH_TAB));
  assert.deepEqual(fetchRulesIn(s.f), []);
  // The key's write fails: its error, and the window closes.
  const k = await setup();
  k.f.impl["storage.session.set"] = async () => {
    throw new Error("quota (test)");
  };
  k.send(V.fetchWindow.req);
  await flush(16);
  assert.equal(k.resOf(V.fetchWindow.req.id)[0].error, "quota (test)");
  assert.ok(!k.f.tabs_.some((t) => t.id === FETCH_TAB));
  assert.deepEqual(fetchRulesIn(k.f), []);
  // A link change during the op: the window ends too.
  const l = await setup();
  let release;
  l.f.impl["windows.create"] = (data) => new Promise((resolve) => {
    release = () => {
      const w = structuredClone(WIN);
      l.f.tabs_.push({ id: FETCH_TAB, windowId: w.id, incognito: true, url: "about:blank" });
      l.f.targets_.push({ id: "T" + FETCH_TAB, tabId: FETCH_TAB, type: "page", attached: false });
      resolve({ ...w, ...data, tabs: w.tabs, id: w.id });
    };
  });
  l.send(V.fetchWindow.req);
  await flush(8);
  l.port().fireMessage({ t: "link", up: true });
  await flush(8);
  release();
  await flush(24);
  assert.ok(!l.f.tabs_.some((t) => t.id === FETCH_TAB), "no fetch window survives a link change");
  assert.deepEqual(fetchRulesIn(l.f), []);
  assert.ok(!Object.keys(l.f.storage_.session).some((k2) => k2.startsWith("fetch")));
});

// ---- fetch_end (C4) ----

test("fetch_end: every fetch tab closes (also a popup in another window) before the fetch window's rules go; the key leaves the copy", async () => {
  const s = await setup();
  await s.openFetch();
  await s.popup(62, FETCH_TAB);
  const order = [];
  s.f.impl["debugger.sendCommand"] = async (target, method, params) => {
    const t = s.f.targets_.find((x) => x.id === params?.targetId);
    if (method === "Target.closeTarget") order.push("close " + (t && t.tabId));
    if (method === "Target.closeTarget" && t) s.f.closeTab(t.tabId);
    return method === "Target.closeTarget" ? { success: true } : {};
  };
  s.f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    if ((d.removeRuleIds ?? []).includes(FETCH_RULE_ID) && !(d.addRules ?? []).length) order.push("rules");
    const kept = s.f.sessionRules_.filter((r) => !(d.removeRuleIds ?? []).includes(r.id));
    s.f.sessionRules_ = [...kept, ...structuredClone(d.addRules ?? [])];
  };
  const res = await s.main(V.endReq);
  assert.deepEqual(res, { ...V.endRes, data: { closed: 2 } });
  assert.deepEqual(order.slice().sort(), ["close 61", "close 62", "rules"]);
  assert.equal(order.at(-1), "rules", "the rules go after the tabs closed");
  assert.deepEqual(fetchRulesIn(s.f), []);
  assert.deepEqual(s.f.storage_.session, {}, "no fetch key");
  assert.deepEqual(await s.main({ ...V.endReq, id: "again" }), { t: "res", id: "again", ok: true, data: { closed: 0 } }, "no fetch window: nothing to end");
  // The vector's answer: one fetch tab (Chrome never gives a closed tab's id again: a new window and tab).
  s.f.nextWindow = { ...WIN, id: 63, tabs: [{ ...WIN.tabs[0], id: 64, windowId: 63 }] };
  assert.equal((await s.answer({ ...V.fetchWindow.req, id: "reopen" })).ok, true);
  assert.deepEqual(await s.main({ ...V.endReq, id: "end2" }), { ...V.endRes, id: "end2" });
});

test("fetch_end: while a tab of the fetch stays open, the rules stay and the answer is fetch not closed", async () => {
  const s = await setup();
  await s.openFetch();
  s.f.impl["debugger.sendCommand"] = async () => ({ success: true }); // Chrome drops the close
  s.f.impl["tabs.remove"] = async () => {
    throw new Error("No tab with id");
  };
  s.sendMain(V.endReq);
  await flush(12);
  await s.fire(2000);
  await s.fire(2000);
  assert.deepEqual(s.resOf(V.endReq.id), [{ t: "res", id: V.endReq.id, ok: false, error: "fetch not closed" }]);
  assert.deepEqual(fetchRulesIn(s.f), V.rules, "the rules stay");
});

test("a link change ends the fetch window: its tab closes and its rules go; with none open, it makes no chrome call for the fetch", async () => {
  const s = await setup();
  await s.openFetch();
  s.port().fireMessage({ t: "link", up: true });
  await flush(16);
  assert.ok(!s.f.tabs_.some((t) => t.id === FETCH_TAB), "the fetch tab closed");
  assert.deepEqual(fetchRulesIn(s.f), []);
  assert.deepEqual(s.f.storage_.session, {});
  const mark = s.f.calls.length;
  s.port().fireMessage({ t: "link", up: true });
  await flush(16);
  assert.ok(!callsSince(s.f, mark).some(([p, a]) => p === "declarativeNetRequest.updateSessionRules" && (a.removeRuleIds ?? []).includes(FETCH_RULE_ID)), "no removal of fetch rules");
});

test("the worker's start keeps the fetch window's rules 78 to 86 until every incognito tab closed (the copy's fetch window and fetch popup, and a tab whose key never came), then removes them", async () => {
  const left = { id: FETCH_TAB, windowId: WIN.id, incognito: true, url: "https://www.example.com/a" };
  const popup = { id: 62, windowId: 66, incognito: true, url: "https://www.example.com/b" };
  const nokey = { id: 65, windowId: 67, incognito: true, url: "https://www.example.com/c" };
  const order = [];
  const s = await setup({
    tabs: [REGULAR, left, popup, nokey],
    copy: { "fetch:60": true, "fetchtab:62": true, "tab:7": A.scope },
    beforeStart: (f) => {
      f.sessionRules_ = [...structuredClone(fetchRules([FETCH_TAB, 62]))];
      f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
        if ((d.removeRuleIds ?? []).includes(FETCH_RULE_ID)) order.push("fetch rules go");
        const kept = f.sessionRules_.filter((r) => !(d.removeRuleIds ?? []).includes(r.id));
        f.sessionRules_ = [...kept, ...structuredClone(d.addRules ?? [])];
      };
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
  assert.ok(!s.f.tabs_.some((t) => t.incognito), "no incognito tab is open");
  assert.ok(s.f.tabs_.some((t) => t.id === 7), "a tab of the default context stays");
  assert.deepEqual(order.slice().sort(), ["close 61", "close 62", "close 65", "fetch rules go"]);
  assert.equal(order.at(-1), "fetch rules go", "the rules go after the closes");
  assert.deepEqual(fetchRulesIn(s.f), []);
  assert.deepEqual(s.f.storage_.session, { "tab:7": A.scope }, "no fetch key is left");
});

test("a full replace after a failed start keeps the fetch window's rules until the fetch's end removes them; a full replace while a fetch window holds them keeps them", async () => {
  const f = makeFakeChrome();
  const rules = new SessionRules(f.chrome, () => new Map(), { setTimer: (fn, ms) => (ms === 2000 ? setTimeout(fn, 0) : null), clearTimer: () => {} });
  f.impl["declarativeNetRequest.getSessionRules"] = () => new Promise(() => {}); // the start's removal never ends: unknown
  await rules.start();
  delete f.impl["declarativeNetRequest.getSessionRules"];
  f.sessionRules_ = [...structuredClone(V.rules), { id: 100, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["example.com"], resourceTypes: ["main_frame"], tabIds: [1] } }];
  assert.equal(rules.fetching, true, "the fetch's end must run");
  await rules.replaceAll();
  assert.deepEqual(f.sessionRules_.filter(isFetchRule), V.rules, "the fetch window's rules stay");
  assert.ok(!f.sessionRules_.some((r) => r.id === 100), "a left scope rule goes");
  await rules.removeFetch();
  await rules.replaceAll();
  assert.deepEqual(f.sessionRules_.filter(isFetchRule), [], "after the fetch's end");
  assert.deepEqual(await rules.setFetch([FETCH_TAB]), V.rules.map((r) => r.id));
  await rules.replaceAll();
  assert.deepEqual(f.sessionRules_.filter(isFetchRule), V.rules);
  // The start of a worker that found them keeps them too.
  const g = makeFakeChrome();
  g.sessionRules_ = structuredClone(V.rules);
  const r2 = new SessionRules(g.chrome, () => new Map());
  await r2.start();
  assert.equal(r2.fetching, true);
  assert.deepEqual(g.sessionRules_.filter(isFetchRule), V.rules, "the start's removal leaves ids 78 to 86");
});

// ---- the fetch tabs: popups, hiding, the guard, the sweep, the floor ----

test("a popup of a fetch tab is a fetch tab: no scope, no bridge.tabScope, its key fetchtab:<id>, and it joins the rules' tabIds; so is a popup of one that closed a moment before; a join that fails closes it", async () => {
  const s = await setup();
  await s.openFetch();
  await s.popup(62, FETCH_TAB);
  assert.equal(s.r.map.isFetch(62), true);
  assert.equal(s.r.map.scopeOf(62), undefined);
  assert.equal(s.r.map.isOrphan(62), false);
  assert.deepEqual(s.r.map.list(), []);
  assert.ok(!s.evs().some((e) => e.ev === "bridge.tabScope"));
  assert.deepEqual(s.f.storage_.session, { ...V.fetchWindow.copy, "fetchtab:62": true });
  for (const r of fetchRulesIn(s.f)) assert.deepEqual(r.condition.tabIds, r.id >= FETCH_BLOCK_FIRST + REFUSED_ADDRESSES.length ? [-1] : [FETCH_TAB, 62], `rule ${r.id}`);
  // A popup of a fetch tab that closed a moment before is a fetch tab too.
  s.f.closeTab(62);
  await flush();
  await s.popup(68, 62);
  assert.equal(s.r.map.isFetch(68), true, "a kept fetch tab's popup");
  // A join that fails closes the popup.
  s.f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    if ((d.addRules ?? []).some(isFetchRule)) throw new Error("rule refused (test)");
    const kept = s.f.sessionRules_.filter((r) => !(d.removeRuleIds ?? []).includes(r.id));
    s.f.sessionRules_ = [...kept, ...structuredClone(d.addRules ?? [])];
  };
  await s.popup(69, FETCH_TAB);
  await flush(16);
  assert.ok(!s.f.tabs_.some((t) => t.id === 69), "the popup whose join failed closed");
  // The replaced tab of a fetch tab is a fetch tab.
  s.f.chrome.tabs.onReplaced.fire(70, FETCH_TAB);
  await flush();
  assert.equal(s.r.map.isFetch(70), true);
  assert.equal(s.r.map.isFetch(FETCH_TAB), false);
});

test("no client acts on a fetch tab or a fetch window: tabs.update, tabs.remove and Page.close get not an agent tab; windows.update and tabs.create into it get not an agent window; debugger.attach takes it (the service's own session); the eager attach skips it", async () => {
  const s = await setup();
  assert.equal((await s.answer({ id: "eager", op: "bridge.attachNew", args: [true] })).ok, true);
  await s.openFetch();
  s.f.chrome.tabs.onCreated.fire({ id: FETCH_TAB, windowId: WIN.id, incognito: true, url: "", pendingUrl: "about:blank" });
  await flush();
  assert.deepEqual(s.f.callsTo("debugger.attach"), [], "no eager attach");
  assert.equal((await s.answer({ id: "u", op: "tabs.update", args: [FETCH_TAB, { active: true }] })).error, "not an agent tab");
  assert.equal((await s.answer({ id: "rm", op: "tabs.remove", args: [FETCH_TAB] })).error, "not an agent tab");
  assert.equal((await s.answer({ id: "wu", op: "windows.update", args: [WIN.id, { left: 0 }] })).error, "not an agent window");
  assert.equal((await s.answer({ id: "tc", op: "tabs.create", args: [{ url: "about:blank", windowId: WIN.id }, A.scope] })).error, "not an agent window");
  assert.deepEqual((await s.answer({ id: "att", op: "debugger.attach", args: [FETCH_TAB] })).data, { already: false });
  assert.equal((await s.answer({ id: "pc", op: "debugger.sendCommand", args: [{ tabId: FETCH_TAB }, "Page.close", {}] })).error, "not an agent tab");
  assert.ok(s.f.tabs_.some((t) => t.id === FETCH_TAB), "the fetch tab stays");
  assert.equal(s.f.callsTo("windows.update").length, 0);
  assert.ok(!s.f.callsTo("tabs.update").some(([id]) => id === FETCH_TAB));
});

test("the guard skips a fetch tab: any host, no about:blank and no blocked notice (also for a DNR block); set_scopes never closes it", async () => {
  const s = await setup();
  await s.openFetch();
  const nav = { tabId: FETCH_TAB, frameId: 0, url: "https://www.example.org/article" };
  s.f.chrome.webNavigation.onBeforeNavigate.fire(nav);
  s.f.chrome.webNavigation.onCommitted.fire(nav);
  s.f.chrome.webNavigation.onErrorOccurred.fire({ ...nav, url: "http://127.0.0.1/", error: "net::ERR_BLOCKED_BY_CLIENT" });
  await flush(16);
  assert.ok(!s.f.callsTo("tabs.update").some(([id]) => id === FETCH_TAB), "no about:blank");
  assert.deepEqual(s.notices(), [], "no blocked notice");
  await s.set({ ...V.setScopes, scopes: { "my-repo": "md" }, default: null });
  await flush(16);
  assert.ok(s.f.tabs_.some((t) => t.id === FETCH_TAB), "the sweep leaves the fetch tab");
  // A regular tab of no list still gets the guard (the skip is for the fetch tab only).
  s.f.chrome.webNavigation.onBeforeNavigate.fire({ tabId: 7, frameId: 0, url: "https://www.example.org/x" });
  await flush(16);
  assert.ok(s.f.callsTo("tabs.update").some(([id, p]) => id === 7 && p.url === "about:blank"));
});

test("the merge guard's floor holds for a fetch tab: bridge.mergeGuard cannot make it a guarded tab, and the floor never leaves it out", async () => {
  const s = await setup({ tabs: [REGULAR] });
  await s.openFetch();
  assert.equal((await s.answer({ id: "att", op: "debugger.attach", args: [FETCH_TAB] })).ok, true);
  assert.equal((await s.answer({ id: "att7", op: "debugger.attach", args: [7] })).ok, true);
  assert.equal((await s.answer({ id: "g", op: "bridge.mergeGuard", args: [{ hosts: [], tabs: [7, FETCH_TAB] }] })).ok, true);
  const floor = s.f.sessionRules_.find((r) => r.id === FLOOR_RULE_ID);
  assert.deepEqual(floor.condition.excludedTabIds, [7], "the regular bridge tab is guarded; the fetch tab is not");
  assert.deepEqual(floor.condition.requestDomains, ["github.com"]);
  // Even a guarded set that names a fetch tab leaves it under the floor (the rules' own check).
  const f = makeFakeChrome();
  const rules = new SessionRules(f.chrome, () => new Map());
  await rules.start();
  await rules.setFetch([FETCH_TAB]);
  await rules.setGuard([], [FETCH_TAB, 7]);
  assert.deepEqual(f.sessionRules_.find((r) => r.id === FLOOR_RULE_ID).condition.excludedTabIds, [7]);
});

// ---- the rules (C5) and the hello (C4) ----

test("the fetch window's rules: rule 78 is rule 8's kind with no host condition; each block refuses every URL of refused and none of allowed, in the fetch tabs and with no tab to another site", () => {
  assert.deepEqual(V.rules, fetchRules([FETCH_TAB]));
  const [allow, ...blocks] = V.rules;
  assert.deepEqual(allow, { id: 78, priority: 2, action: { type: "allow" }, condition: { resourceTypes: ["main_frame", "sub_frame", "object"], tabIds: [FETCH_TAB] } });
  assert.deepEqual(blocks.map((r) => r.id), [79, 80, 81, 82, 83, 84, 85, 86]);
  assert.equal(FETCH_RULE_MAX, 86);
  for (const r of blocks) {
    assert.equal(r.priority, FETCH_BLOCK_PRIORITY);
    assert.equal(r.priority, 6, "above every allow rule");
    assert.deepEqual(r.action, { type: "block" });
    assert.equal(r.condition.isUrlFilterCaseSensitive, true);
    assert.ok(r.condition.resourceTypes.includes("main_frame") && r.condition.resourceTypes.includes("websocket") && r.condition.resourceTypes.length === 15, `rule ${r.id}: every resource type`);
    const tab = r.id < 83;
    assert.deepEqual(r.condition.tabIds, tab ? [FETCH_TAB] : [-1]);
    assert.equal(r.condition.domainType, tab ? undefined : "thirdParty");
    assert.deepEqual(r.condition.excludedInitiatorDomains, tab ? undefined : ["localhost", "local", "internal"], `rule ${r.id}: the local names' workers (review-46 N2)`);
    assert.equal(r.condition.regexFilter, REFUSED_ADDRESSES[(r.id - 79) % 4]);
  }
  // Each pattern is plain RE2 syntax that JavaScript reads the same way (Chromium 156 measured these lists: C5).
  const res = REFUSED_ADDRESSES.map((p) => new RegExp(p));
  for (const u of V.refused) assert.equal(res.filter((re) => re.test(u)).length, 1, `refused by exactly one pattern: ${u}`);
  for (const u of V.allowed) assert.ok(!res.some((re) => re.test(u)), `allowed: ${u}`);
  // Chrome's URL parser writes each refused host as the patterns expect (WHATWG URL: the same canonical form).
  for (const u of V.refused) assert.equal(new URL(u).href, u, `canonical: ${u}`);
  for (const [raw, canon] of [["http://0x7f.1/", "http://127.0.0.1/"], ["http://2130706433/", "http://127.0.0.1/"], ["http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/"], ["http://FOO.LocalHost./", "http://foo.localhost./"], ["http://[0::1]/", "http://[::1]/"]]) {
    assert.equal(new URL(raw).href, canon);
    assert.ok(res.some((re) => re.test(new URL(raw).href)), `refused after the parser: ${raw}`);
  }
  // Each pattern stays short: Chrome refuses a regexFilter above its compiled size limit (2 KB; all four passed isRegexSupported).
  for (const p of REFUSED_ADDRESSES) assert.ok(p.length <= 200, p);
  // A user part that looks like a refused host is no host (review-46 N4): the host ends at a port of digits or the path.
  for (const u of ["http://a.localhost:pw@example.com/", "http://127.0.0.1:x@example.com/"]) {
    assert.ok(V.allowed.includes(u), `the vector holds ${u}`);
    assert.ok(!res.some((re) => re.test(new URL(u).href)), `allowed: ${u}`);
  }
  for (const u of ["http://127.0.0.1:8080/", "http://a.localhost:3000/x", "http://u@10.1.1.1:81/", "http://x.local./"]) assert.ok(res.some((re) => re.test(u)), `refused: ${u}`);
});

test("rules 83 to 86 leave out a worker of a local name (localhost, local, internal): it reaches another local site while a fetch runs; a worker of an IP literal does not (review-46 N2)", () => {
  assert.deepEqual(FETCH_WORKER_FREE, ["localhost", "local", "internal"]);
  const res = REFUSED_ADDRESSES.map((p) => new RegExp(p));
  const host = (o) => new URL(o).hostname;
  const freed = (initiator) => FETCH_WORKER_FREE.some((d) => host(initiator) === d || host(initiator).endsWith("." + d));
  for (const c of V.localWorkers) {
    assert.ok(res.some((re) => re.test(c.url)), `${c.url}: a refused address`);
    assert.notEqual(host(c.url), host(c.initiator), `${c.url}: another site than ${c.initiator}`);
    assert.ok(freed(c.initiator), `${c.initiator}: an excluded initiator, so no rule of 83 to 86 matches`);
  }
  for (const c of V.ipWorkers) {
    assert.ok(res.some((re) => re.test(c.url)) && !freed(c.initiator), `${c.initiator}: the side effect that stays (C5)`);
  }
  // The fetched page's workers: a public initiator is never left out.
  assert.ok(!freed("https://www.example.com") && !freed("https://localhost.example.com"));
});

test("the hello names the feature fetch, and fetch_end is an op of channel main", () => {
  assert.deepEqual(FEATURES, V.features);
  assert.ok(FEATURES.includes("fetch") && FEATURES.includes("act") && FEATURES.includes("scopes"));
  assert.deepEqual(A.features, V.features, "act.json and fetch.json name the same hello");
});

// ---- review-46: the fix round ----

test("review-46 N1: no fetch window opens while Chrome still lists a cookie store other than the default one (after act_end the act's store can stay a moment); with none left it opens; the act window refuses the same way; a failed read refuses", async () => {
  const s = await setup();
  await s.openAct();
  s.f.otrLingers = true;
  assert.equal((await s.main(A.endReq)).ok, true, "act_end");
  assert.ok(!s.f.tabs_.some((t) => t.incognito), "no incognito tab is open");
  assert.ok(s.f.cookieStores_.some((x) => x.id === "1"), "Chrome still lists the act's store");
  const before = s.f.callsTo("windows.create").length;
  assert.equal((await s.answer({ ...V.fetchWindow.req, id: "n1-linger" })).error, "another private window is open");
  assert.equal(s.f.callsTo("windows.create").length, before, "no window opens");
  assert.ok(s.f.callsTo("cookies.getAllCookieStores").length > 0, "the receiver read the stores");
  // Chrome drops the store: the fetch window opens.
  s.f.cookieStores_ = [{ id: "0", tabIds: [7] }];
  s.f.otrLingers = false;
  await s.openFetch({ ...V.fetchWindow.req, id: "n1-open" });
  // The act window the same way: the fetch's store left after fetch_end refuses it.
  s.f.otrLingers = true;
  assert.equal((await s.main(V.endReq)).ok, true, "fetch_end");
  const acts = s.f.callsTo("windows.create").length;
  assert.equal((await s.answer({ ...A.actWindow.req, id: "n1-act" })).error, "another private window is open");
  assert.equal(s.f.callsTo("windows.create").length, acts, "no act window opens");
  // A failed read of the stores refuses too (fail closed).
  s.f.cookieStores_ = [{ id: "0", tabIds: [7] }];
  s.f.impl["cookies.getAllCookieStores"] = async () => {
    throw new Error("read failed (test)");
  };
  assert.equal((await s.answer({ ...V.fetchWindow.req, id: "n1-fail" })).error, "another private window is open");
  assert.equal((await s.answer({ ...A.actWindow.req, id: "n1-act-fail" })).error, "another private window is open");
});

// A worker's start with left rules (the fetch's or the act's) and a left incognito tab 65 that does not
// close: the start's sweep fails and stays owed. Then tab 65 closes, and set_scopes comes.
async function stuckStart(rules) {
  let closable = (id) => id !== 65;
  const s = await setup({
    tabs: [REGULAR, { id: 65, windowId: 67, incognito: true, url: "https://www.example.com/c" }],
    scopes: null,
    beforeStart: (f) => {
      f.sessionRules_ = structuredClone(rules);
      f.impl["debugger.sendCommand"] = async (target, method, params) => {
        if (method !== "Target.closeTarget") return {};
        const t = f.targets_.find((x) => x.id === params.targetId);
        if (t && closable(t.tabId)) f.closeTab(t.tabId);
        return { success: true };
      };
      f.impl["tabs.remove"] = async (id) => {
        if (!closable(id)) throw new Error("No tab with id: " + id);
        f.closeTab(id);
      };
    },
  });
  await flush(16);
  for (let i = 0; i < 6; i++) await s.fire(2000);
  assert.ok(s.f.tabs_.some((t) => t.id === 65), "the left tab stays: the sweep is owed");
  closable = () => true;
  s.f.closeTab(65);
  await flush();
  await s.set(V.setScopes);
  await flush();
  return s;
}

test("review-46 N3: a start's sweep that is still owed never ends the other kind: the fetch's owed sweep leaves an act tab, and the act's owed sweep leaves a fetch tab", async () => {
  const s = await stuckStart(V.rules);
  assert.equal(fetchRulesIn(s.f).length, V.rules.length, "the left fetch rules stay (fail closed)");
  await s.openAct();
  s.send({ ...V.fetchWindow.req, id: "n3-fetch" });
  await flush(16);
  for (let i = 0; i < 3; i++) await s.fire(2000);
  assert.deepEqual(s.resOf("n3-fetch").map((r) => r.error), ["another private window is open"]);
  assert.ok(s.f.tabs_.some((t) => t.id === ACT_TAB), "the act tab stays");
  assert.deepEqual(fetchRulesIn(s.f), [], "the owed end removed the left fetch rules");
  // The other way: the act's owed sweep leaves a fetch tab.
  const t = await stuckStart(A.rules);
  assert.equal(t.f.sessionRules_.filter(isActRule).length, A.rules.length, "the left act rules stay (fail closed)");
  await t.openFetch({ ...V.fetchWindow.req, id: "n3-open" });
  t.send({ ...A.actWindow.req, id: "n3-act" });
  await flush(16);
  for (let i = 0; i < 3; i++) await t.fire(2000);
  assert.deepEqual(t.resOf("n3-act").map((r) => r.error), ["another private window is open"]);
  assert.ok(t.f.tabs_.some((x) => x.id === FETCH_TAB), "the fetch tab stays");
  assert.deepEqual(t.f.sessionRules_.filter(isActRule), [], "the owed end removed the left act rules");
  assert.deepEqual(fetchRulesIn(t.f), V.rules, "the fetch window's rules stay");
});
