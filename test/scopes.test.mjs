// The allowlists per scope in the receiver (part 1a, board ab-v16.31): set_scopes by C4's rules,
// the scope rules of C5, the worker removal, the closing rule and the sweep, the tab-to-scope map
// and its copy, the hello's features and the answer to an old daemon's set_allowlist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseScopes, shrinks } from "../agent/scopes.js";
import { mainOps, SET_ALLOWLIST_GONE } from "../agent/allowlist.js";
import { scopeRules } from "../agent/dnr.js";
import { REMOVAL_WAIT_MS } from "../agent/removals.js";
import { RESTORE_MAX_MS, TOMBSTONE_MS } from "../agent/tabmap.js";
import { ReceiverLink } from "../agent/link.js";
import { Bridge } from "../agent/bridge.js";
import { receiver } from "../agent/receiver.js";
import { makeFakeChrome } from "./fake-chrome.mjs";
import { callsSince, flush, startReceiver } from "./receiver-harness.mjs";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const S = read("./vectors/scopes.json");
const H = read("./vectors/hello.json");
const B = read("./vectors/bridge.json");
const applied = (a) => ({ lists: a.lists, scopes: a.scopes, default: a.default, operator: a.operator });
const blank = (id, windowId = 1) => ({ id, windowId, url: "about:blank" });
const ruleIds = (f) => f.sessionRules_.map((r) => r.id).sort((a, b) => a - b);
const tabIdsOf = (f, id) => f.sessionRules_.find((r) => r.id === id)?.condition.tabIds;

// ---- C4: set_scopes by its rules, the hello, the rollout ----

test("each set_scopes vector applies in the receiver by C4's rules, with its count in refused and each scope's list", () => {
  for (const v of [...S.cases, ...S.raw.map((r) => ({ ...r, in: JSON.parse(r.json) }))]) {
    const a = parseScopes(v.in);
    assert.deepEqual(applied(a), v.applies, v.note);
    assert.equal(a.refused, v.refused, `${v.note}: refused`);
    for (const [scope, list] of Object.entries(v.listOf ?? {})) assert.equal(a.listOf(scope), list, `${v.note}: the list of ${scope}`);
  }
  assert.equal(parseScopes({ lists: {}, scopes: {} }).applied, true);
  assert.equal(parseScopes({ lists: [], scopes: {} }).applied, false);
  assert.equal(parseScopes({ lists: {}, scopes: "x" }).applied, false);
  assert.equal(parseScopes(null).refused, 3, "a request with none of the fields");
});

test("the hello names the feature scopes (hello.json), and an old daemon's set_allowlist gets the vector's ok:false and applies nothing", async () => {
  const f = makeFakeChrome();
  f.manifest = { version: H.hello.version };
  const link = new ReceiverLink(f.chrome, { main: mainOps(f.chrome), bridge: async () => null });
  link.start();
  assert.deepEqual(f.ports[0].posted, [H.hello]);
  const { req, res } = H.fromOldDaemon;
  assert.equal(SET_ALLOWLIST_GONE, res.error);
  const { splitParts } = await import("../agent/wire.js");
  for (const p of splitParts(req.id, req)) f.ports[0].fireMessage(p);
  await flush();
  assert.deepEqual(f.ports[0].posted.at(-1), res);
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateSessionRules"), [], "no rule");
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateDynamicRules"), [], "no rule");
  assert.deepEqual(f.callsTo("tabs.query"), [], "no tab closes");
});

// ---- the answer, the scope rules, rule 5 ----

test("set_scopes answers {rules, closed, refused} after the scope rules are in force: one pair per list in use, the tabIds of its tabs", async () => {
  const s = await startReceiver({
    tabs: [blank(7), blank(8), blank(9), blank(3)],
    copy: { "tab:7": "md-lead", "tab:8": "md-worker-2", "tab:9": "vedlo-cron" },
  });
  assert.deepEqual(s.f.sessionRules_, [], "no scope rule before the first set_scopes: every tab is blocked");
  s.sendMain({ t: "req", id: "m1", op: "set_scopes", ...S.cases[0].in, lists: { ...S.cases[0].in.lists, unused: ["u.example"], bad: "x" } });
  await flush();
  assert.deepEqual(s.resOf("m1"), [{ t: "res", id: "m1", ok: true, data: { rules: 4, closed: 0, refused: 1 } }]);
  assert.deepEqual(ruleIds(s.f), [100, 101, 102, 103]);
  assert.deepEqual(s.f.sessionRules_.slice(0, 2), scopeRules(100, ["marketdata.app", "github.com"], [7, 8]));
  assert.deepEqual(s.f.sessionRules_.slice(2), scopeRules(102, ["vedlo.example"], [9]));
  assert.deepEqual(s.f.dynamicRules_.map((r) => r.id), [5], "rule 5; no rule 2 or 4");
  assert.deepEqual(s.f.callsTo("declarativeNetRequest.updateDynamicRules").at(-1)[0].removeRuleIds, [2, 4, 5]);
});

test("a failed rule update fails closed: every scope rule goes, the tabs still close by the new lists, and the answer is ok:false", async () => {
  const s = await startReceiver({ tabs: [{ id: 7, windowId: 1, url: "https://b.example/" }, blank(8)], copy: { "tab:7": "md-lead", "tab:8": "md-lead" }, targets: [{ id: "T7", tabId: 7, type: "page" }] });
  await s.set({ lists: { md: ["b.example"] }, scopes: { "md-lead": "md" }, default: null });
  assert.deepEqual(ruleIds(s.f), [100, 101]);
  s.f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    if (d.addRules && d.addRules.length > 0) throw new Error("Session rule count exceeded.");
    s.f.sessionRules_ = s.f.sessionRules_.filter((r) => !d.removeRuleIds.includes(r.id));
  };
  await assert.rejects(s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null }), /Session rule count exceeded/);
  assert.deepEqual(s.f.sessionRules_, [], "fail closed");
  assert.equal(s.f.tabs_.some((t) => t.id === 7), false, "the closing rule ran with the new lists");
  assert.equal(s.r.map.scopeOf(8), "md-lead", "the map stays");
  delete s.f.impl["declarativeNetRequest.updateSessionRules"];
  // A tab that gets a scope now: the next change is a full replace from the map.
  const made = await s.answer({ id: "c", op: "tabs.create", args: [{ url: "about:blank" }, "md-lead"] });
  assert.equal(made.ok, true);
  assert.deepEqual(tabIdsOf(s.f, 100), [8, made.data.id]);
});

// ---- the worker removal ----

test("the worker removal: at the first set_scopes, and after that only when a scope's list (also the default's and the operator's) loses an entry", async () => {
  const s = await startReceiver({});
  const removals = () => s.f.callsTo("browsingData.remove").length;
  const order = () => s.f.calls.map(([p]) => p).filter((p) => ["declarativeNetRequest.updateSessionRules", "browsingData.remove", "tabs.query"].includes(p));
  const base = { lists: { md: ["a.example", "b.example"], v: ["v.example"] }, scopes: { "md-lead": "md" }, default: null };
  await s.set(base);
  assert.equal(removals(), 1, "the first set_scopes after the worker's start");
  assert.deepEqual(order().slice(-3), ["declarativeNetRequest.updateSessionRules", "browsingData.remove", "tabs.query"], "after the rule update, before the tabs close");
  const steps = [
    [{ ...base, lists: { ...base.lists, md: ["a.example", "b.example", "c.example"] } }, 1, "a list that grows"],
    [{ ...base, lists: { ...base.lists, md: ["a.example", "c.example"] } }, 2, "a list that loses an entry"],
    [{ ...base, lists: { ...base.lists, md: ["a.example", "c.example"], other: ["z.example"] }, scopes: { "md-lead": "md", "md-new": "other" } }, 2, "a new scope"],
    [{ ...base, lists: { md: ["a.example", "c.example"], v: ["v.example"] }, scopes: { "md-lead": "md" } }, 2, "a scope that leaves"],
    [{ ...base, lists: { md: ["a.example", "c.example"], v: ["v.example"] }, scopes: { "md-lead": "md" }, default: "v" }, 2, "a new default list"],
    [{ ...base, lists: { md: ["a.example", "c.example"], v: [] }, scopes: { "md-lead": "md" }, default: "v" }, 3, "the default list loses an entry"],
    [{ lists: { md: ["a.example", "c.example"], v: ["w.example"] }, scopes: { "md-lead": "md" }, default: "v" }, 3, "the default list grows"],
    [{ lists: { md: ["a.example", "c.example"], v: ["w.example"] }, scopes: { "md-lead": "md", "md-x": "md" }, default: "v" }, 4, "a scope that had the default list gets another one that lacks its entry"],
    [{ lists: { md: ["a.example", "c.example"], v: [] }, scopes: { "md-lead": null }, default: "v" }, 5, "md-x had md as its scopes entry and now has the default v"],
    [{ lists: { md: ["a.example"], v: [] }, scopes: { "md-lead": "md" }, default: "v", operator: "*" }, 5, "md-lead had no list; the operator gets *"],
    [{ lists: { md: ["a.example"], v: [] }, scopes: { "md-lead": "md" }, default: "v", operator: "md" }, 6, "the operator: from * to a list"],
    [{ lists: { md: ["a.example"], v: [] }, scopes: { "md-lead": null }, default: "v", operator: "md" }, 6, "a scope whose new list is none"],
  ];
  for (const [msg, want, note] of steps) {
    await s.set(msg);
    assert.equal(removals(), want, note);
  }
  // A failed removal fails the call after the tabs closed; the next call removes again, also one that only grows.
  s.f.impl["browsingData.remove"] = async () => {
    throw new Error("busy");
  };
  await assert.rejects(s.set({ lists: { md: [], v: [] }, scopes: { "md-lead": "md" }, default: "v", operator: "md" }), /service worker removal failed/);
  delete s.f.impl["browsingData.remove"];
  assert.equal(removals(), 7);
  await s.set({ lists: { md: ["a.example", "x.example"], v: [] }, scopes: { "md-lead": "md" }, default: "v" });
  assert.equal(removals(), 8, "owed");
  await s.set({ lists: { md: ["a.example", "x.example", "y.example"], v: [] }, scopes: { "md-lead": "md" }, default: "v" });
  assert.equal(removals(), 8);
  assert.equal(shrinks(undefined, parseScopes({})), true);
});

// ---- the closing rule and the sweep ----

test("the closing rule per list: a tab's http(s) page off its scope's list closes, a tab of no scope by the union; the restore tab and other schemes stay", async () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a.example/" }, // md-lead, on md
    { id: 2, windowId: 1, url: "https://v.example/" }, // md-lead, on vedlo's list only: closes
    { id: 3, windowId: 1, url: "https://v.example/" }, // no scope: the union covers it
    { id: 4, windowId: 1, url: "https://z.example/" }, // no scope, on no list: closes
    { id: 5, windowId: 1, url: "https://z.example/__agentwatch_restore_0123456789abcdef__" }, // the restore tab of a running import
    { id: 6, windowId: 1, url: "chrome://settings/" },
    { id: 8, windowId: 1, url: "about:blank", pendingUrl: "https://z.example/" }, // vedlo-cron: its pending URL counts
  ];
  const s = await startReceiver({ tabs, copy: { "tab:1": "md-lead", "tab:2": "md-lead", "tab:8": "vedlo-cron" }, targets: tabs.map((t) => ({ id: "T" + t.id, tabId: t.id, type: "page" })) });
  s.r.att.markRestore(5);
  const res = await s.set({ lists: { md: ["a.example"], vedlo: ["v.example"] }, scopes: { "md-lead": "md", "vedlo-cron": "vedlo" }, default: null });
  assert.equal(res.closed, 3);
  assert.deepEqual(s.f.tabs_.map((t) => t.id), [1, 3, 5, 6]);
  assert.deepEqual(s.f.callsTo("tabs.remove"), [], "the receiver's close: no chrome.tabs.remove");
  assert.deepEqual(s.f.callsTo("debugger.sendCommand").filter((a) => a[1] === "Target.closeTarget").map((a) => a[2].targetId), ["T2", "T4", "T8"]);
});

test("the sweep: each vector of scopes.json closes the tabs whose scope has no list and the tabs of the orphan set, and none at a set_scopes that is not applied", async () => {
  for (const v of S.sweep) {
    const ids = [...Object.keys(v.map), ...Object.keys(v.orphans ?? {}), ...(v.noScope ?? [])].map(Number);
    const tabs = [...ids.map((id) => blank(id)), blank(99)]; // tab 99: another tab of no scope, so no about:blank opens
    const copy = Object.fromEntries([...Object.entries(v.map), ...Object.entries(v.orphans ?? {})].map(([id, scope]) => ["tab:" + id, scope]));
    const s = await startReceiver({ tabs, copy, targets: tabs.map((t) => ({ id: "T" + t.id, tabId: t.id, type: "page" })) });
    // The orphan set: a sweep item that did not close the tab (its close failed) took it out of its scope.
    if (v.orphans) {
      const keep = Object.keys(v.orphans).map(Number);
      s.f.impl["debugger.getTargets"] = async () => [];
      s.f.impl["tabs.remove"] = async (id) => {
        if (keep.includes(id)) throw new Error("held");
      };
      await s.set({ lists: { other: [] }, scopes: Object.fromEntries(Object.entries(v.map).map(([, sc]) => [sc, "other"])), default: null });
      delete s.f.impl["debugger.getTargets"];
      delete s.f.impl["tabs.remove"];
      for (const id of keep) assert.equal(s.r.map.isOrphan(id), true, v.note);
    }
    const before = s.f.tabs_.map((t) => t.id);
    const res = await s.set(v.in).catch((e) => ({ error: e.message }));
    const closed = before.filter((id) => !s.f.tabs_.some((t) => t.id === id)).sort((a, b) => a - b);
    assert.deepEqual(closed, v.closes, v.note);
    assert.equal(res.closed, v.closes.length, v.note);
    if (!v.applied) assert.equal(s.r.map.reference?.applied ?? true, true, `${v.note}: no reference`);
  }
});

test("a tab of the sweep that its item does not close leaves the map and the copy and joins the orphan set; the answer waits for the key removal, and a failed one gives ok:false and is tried again", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(8), blank(3)], copy: { "tab:7": "md-old", "tab:8": "md-old" }, targets: [{ id: "T8", tabId: 8, type: "page" }] });
  // Tab 7 has no target, and its fallback is held (a beforeunload dialog): it stays pending.
  s.f.impl["tabs.remove"] = () => new Promise(() => {});
  let failKey = true;
  s.f.impl["storage.session.remove"] = async (keys) => {
    if (failKey) throw new Error("quota");
    for (const k of typeof keys === "string" ? [keys] : keys) delete s.f.storage_.session[k];
  };
  const p = s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null });
  await flush();
  assert.equal(s.pending(REMOVAL_WAIT_MS).length, 1, "the item waits for tab 7's close");
  await s.fire(REMOVAL_WAIT_MS);
  await assert.rejects(p, /copy key removal failed/);
  assert.equal(s.r.map.has(7), false);
  assert.equal(s.r.map.isOrphan(7), true);
  assert.equal(s.r.removals.isPending(7), true, "the close is still pending");
  assert.deepEqual(s.r.map.list(), []);
  assert.deepEqual(s.f.storage_.session, { "tab:7": "md-old", "tab:8": "md-old" }, "the key removals failed (also tab 8's at its close)");
  // The next set_scopes removes the keys again, and its sweep closes tab 7 again.
  failKey = false;
  delete s.f.impl["tabs.remove"];
  s.f.targets_.push({ id: "T7", tabId: 7, type: "page" });
  const res = await s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md", "md-old": "md" }, default: null });
  assert.deepEqual(res, { rules: 0, closed: 1, refused: 0 });
  assert.deepEqual(s.f.storage_.session, {});
  assert.deepEqual(s.f.tabs_.map((t) => t.id), [3]);
});

test("a sweep item whose window rule fails closes no tab, and the sweep's tabs join the orphan set; the closing rule's tabs stay in their scope", async () => {
  const s = await startReceiver({ tabs: [blank(7), { id: 8, windowId: 1, url: "https://z.example/" }], copy: { "tab:7": "md-old", "tab:8": "md-lead" } });
  s.f.impl["tabs.create"] = async () => {
    throw new Error("no window");
  };
  const res = await s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null });
  assert.equal(res.closed, 0);
  assert.equal(s.r.map.isOrphan(7), true);
  assert.equal(s.r.map.scopeOf(8), "md-lead");
  assert.equal(s.f.tabs_.length, 2);
});

// review-20 Q2 (C4, C5): at a set_scopes that is not applied, the closing rule judges each tab by the
// last applied object, so one bad message never closes every live session's page; the scope rules still
// go as C4 says (new navigations fail closed). A tab of the orphan set has no list in any object.
test("a set_scopes that is not applied (a bad scopes or lists field) sweeps nothing and is no reference; its rules fail closed, and its closing rule judges each tab by the last applied object", async () => {
  for (const bad of [{ lists: { md: ["a.example"] }, scopes: ["md-lead"], default: "md" }, { lists: "x", scopes: { "md-lead": "md" }, default: null }]) {
    const tabs = [
      blank(7), // md-lead, about:blank
      { id: 8, windowId: 1, url: "https://a.example/" }, // md-lead, on md
      { id: 9, windowId: 1, url: "https://a.example/" }, // md-lead; it goes to z.example below
      { id: 5, windowId: 1, url: "https://a.example/" }, // no scope: the last applied union covers it
      { id: 13, windowId: 1, url: "https://a.example/old" }, // the orphan set: no list
      blank(3),
    ];
    const s = await startReceiver({ tabs, copy: { "tab:7": "md-lead", "tab:8": "md-lead", "tab:9": "md-lead" }, targets: tabs.map((t) => ({ id: "T" + t.id, tabId: t.id, type: "page" })) });
    await s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null });
    s.r.map.addOrphan(13);
    s.f.tabs_.find((t) => t.id === 9).url = "https://z.example/"; // a page that left md (after the last set_scopes)
    const ref = s.r.map.reference;
    const res = await s.set(bad);
    assert.equal(res.refused, 1, JSON.stringify(bad));
    assert.equal(s.r.map.reference, ref, "the last applied set_scopes stays the reference");
    assert.deepEqual(s.f.sessionRules_, [], "C4's reading gives no scope a list: the scope rules go");
    const open = s.f.tabs_.map((t) => t.id);
    assert.deepEqual(open, [7, 8, 5, 3], `${JSON.stringify(bad)}: no sweep; tabs 8 and 5 stay by the last applied lists; tab 9 left md; tab 13 has no list`);
    assert.equal(res.closed, 2);
    assert.equal(s.r.map.scopeOf(8), "md-lead", "the map stays");
  }
  // A bad first set_scopes after the worker's start: no object applied yet, so the closing rule closes nothing.
  const t = await startReceiver({ tabs: [{ id: 8, windowId: 1, url: "https://a.example/" }, blank(3)], copy: { "tab:8": "md-lead" } });
  const res = await t.set({ lists: { md: ["a.example"] }, scopes: "md-lead", default: null });
  assert.equal(res.closed, 0);
  assert.equal(t.r.map.reference, null);
});

// review-20 B1 (C10's window rule): when the sweep item's query fails or comes late, the item closes no
// tab, and the tabs of the ended scope still leave their scope into the orphan set.
test("a sweep item whose tabs.query fails or comes late closes no tab, and the ended scope's tabs leave the map and the copy into the orphan set", async () => {
  for (const kind of ["fails", "late"]) {
    const s = await startReceiver({ tabs: [blank(7), blank(8), blank(3)], copy: { "tab:7": "md-old", "tab:8": "md-lead" }, targets: [{ id: "T7", tabId: 7, type: "page" }] });
    await s.set({ lists: { md: ["a.example"] }, scopes: { "md-old": "md", "md-lead": "md" }, default: null });
    s.f.impl["tabs.query"] = kind === "fails" ? async () => { throw new Error("busy"); } : () => new Promise(() => {});
    const p = s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null });
    await flush();
    if (kind === "late") await s.fire(REMOVAL_WAIT_MS);
    const res = await p;
    delete s.f.impl["tabs.query"];
    assert.equal(res.closed, 0, kind);
    assert.equal(s.r.map.has(7), false, `${kind}: tab 7 left its scope`);
    assert.equal(s.r.map.isOrphan(7), true, kind);
    assert.equal(s.r.map.scopeOf(8), "md-lead", `${kind}: a scope with a list keeps its tab`);
    assert.deepEqual(s.f.storage_.session, { "tab:8": "md-lead" }, `${kind}: the copy`);
    // A later session of the same name never gets the tab, and the next sweep closes it.
    const later = await s.set({ lists: { md: ["a.example"] }, scopes: { "md-old": "md", "md-lead": "md" }, default: null });
    assert.deepEqual(s.r.map.list(), [{ tabId: 8, scope: "md-lead" }], kind);
    assert.equal(later.closed, 1, kind);
    assert.equal(s.f.tabs_.some((t) => t.id === 7), false, kind);
  }
});

// review-20 B2 (probe P2): a set_scopes whose new rules are in force but whose answer is ok:false moves
// no "last" of the worker removal; so the worker removal is owed to the next set_scopes.
test("a set_scopes that answers ok:false with its rules in force (a failed key removal) owes the worker removal to the next one", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(8), blank(3)], copy: { "tab:7": "md-lead", "tab:8": "md-old" }, targets: [{ id: "T8", tabId: 8, type: "page" }] });
  const removals = () => s.f.callsTo("browsingData.remove").length;
  await s.set({ lists: { md: ["a.example"], o: [] }, scopes: { "md-lead": "md", "md-old": "o" }, default: null });
  assert.equal(removals(), 1);
  // S2: md gains z.example; md-old ends (its tab 8 closes) and its key removal fails.
  s.f.impl["storage.session.remove"] = async () => {
    throw new Error("quota");
  };
  await assert.rejects(s.set({ lists: { md: ["a.example", "z.example"] }, scopes: { "md-lead": "md" }, default: null }), /copy key removal failed/);
  delete s.f.impl["storage.session.remove"];
  assert.deepEqual(s.f.sessionRules_.find((r) => r.id === 100).condition.requestDomains, ["a.example", "z.example"], "S2's rules are in force");
  // S3: z.example leaves md. Against S1 nothing shrinks, but z.example's workers may exist.
  await s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null });
  assert.equal(removals(), 2, "the owed removal ran");
  await s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null });
  assert.equal(removals(), 2, "and is no longer owed");
});

// review-20 note 3: a time limit on the worker removal; a late one fails closed (the tabs still close, the
// answer is ok:false, the removal is owed), with a log line.
test("a worker removal that has not ended in REMOVAL_WAIT_MS fails the call after the tabs closed and is owed", async () => {
  const s = await startReceiver({ tabs: [{ id: 8, windowId: 1, url: "https://z.example/" }, blank(3)], copy: { "tab:8": "md-lead" }, targets: [{ id: "T8", tabId: 8, type: "page" }] });
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(" "));
  try {
    s.f.impl["browsingData.remove"] = () => new Promise(() => {});
    const p = s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null });
    await flush();
    await s.fire(REMOVAL_WAIT_MS);
    await assert.rejects(p, /service worker removal failed/);
    assert.equal(s.f.tabs_.some((t) => t.id === 8), false, "the closing rule ran");
    assert.ok(logged.some((l) => /service worker removal/.test(l)), "a log line");
    delete s.f.impl["browsingData.remove"];
    const before = s.f.callsTo("browsingData.remove").length;
    await s.set({ lists: { md: ["a.example", "b.example"] }, scopes: { "md-lead": "md" }, default: null });
    assert.equal(s.f.callsTo("browsingData.remove").length, before + 1, "owed");
  } finally {
    console.warn = warn;
  }
});

// ---- the map, its copy and its restore ----

test("the restore at the worker's start: the session rules go first, the entries of open tabs come back, the keys of the others go, and only then the port connects", async () => {
  let order;
  const s = await startReceiver({
    tabs: [blank(7), blank(9)],
    copy: { "tab:7": "md-lead", "tab:8": "md-lead", "tab:9": "not a scope", other: 1 },
    beforeStart: (f) => {
      f.sessionRules_ = [{ id: 100 }, { id: 8 }];
      order = () => f.calls.map(([p]) => p).filter((p) => ["declarativeNetRequest.updateSessionRules", "storage.session.get", "tabs.query", "storage.session.remove", "runtime.connectNative"].includes(p));
    },
  });
  assert.deepEqual(order().slice(0, 5), ["declarativeNetRequest.updateSessionRules", "storage.session.get", "tabs.query", "storage.session.remove", "runtime.connectNative"]);
  assert.deepEqual(s.r.map.list(), [{ tabId: 7, scope: "md-lead" }]);
  assert.deepEqual(s.f.storage_.session, { "tab:7": "md-lead", other: 1 });
  assert.deepEqual((await s.answer({ id: "ts", op: "bridge.tabScopes", args: [] })).data, [{ tabId: 7, scope: "md-lead" }]);
});

test("a restore whose read fails or does not answer in RESTORE_MAX_MS starts with an empty map and connects anyway; a late read still removes its keys", async () => {
  for (const kind of ["fails", "hangs"]) {
    const f = makeFakeChrome();
    f.setTabs([blank(7)]);
    f.storage_.session = { "tab:7": "md-lead" };
    let late;
    f.impl["storage.session.get"] = kind === "fails" ? async () => { throw new Error("no"); } : () => new Promise((r) => (late = r));
    const timers = [];
    const link = new ReceiverLink(f.chrome, { main: mainOps(f.chrome), bridge: async () => null });
    // eslint-disable-next-line no-new
    new Bridge(f.chrome, link, { setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.at(-1), clearTimer: () => {} });
    const started = receiver(f.chrome).startup().then(() => link.start());
    await flush();
    if (kind === "hangs") {
      assert.equal(f.ports.length, 0, "the port waits for the restore");
      for (const t of timers.filter((x) => x.ms === RESTORE_MAX_MS)) t.fn(); // the start's removal has the same limit
    }
    await started;
    assert.equal(f.ports.length, 1, kind);
    assert.deepEqual(receiver(f.chrome).map.list(), [], kind);
    if (kind === "hangs") {
      late({ "tab:7": "md-lead" });
      await flush();
      assert.deepEqual(f.storage_.session, {}, "the late read's key goes");
    }
  }
});

test("an event that starts the worker waits for the restore: its handler reads the restored map", async () => {
  const f = makeFakeChrome();
  f.setTabs([blank(7), blank(11)]);
  f.storage_.session = { "tab:7": "md-lead" };
  let give;
  const data = f.storage_.session;
  f.impl["storage.session.get"] = () => new Promise((r) => (give = () => r(structuredClone(data))));
  const link = new ReceiverLink(f.chrome, { main: mainOps(f.chrome), bridge: async () => null });
  const bridge = new Bridge(f.chrome, link);
  void bridge;
  const r = receiver(f.chrome);
  const started = r.startup();
  await flush();
  f.chrome.tabs.onReplaced.fire(11, 7); // Chrome started the worker for this event
  await flush();
  assert.equal(r.map.scopeOf(11), undefined, "the handler waits");
  give();
  await started;
  await flush();
  assert.equal(r.map.scopeOf(11), "md-lead");
  assert.equal(r.map.has(7), false);
  assert.deepEqual(f.storage_.session, { "tab:11": "md-lead" });
});

test("a tab's close drops its entry and sends tabs.onRemoved before any other await; its key and its list's rules follow", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(8)], copy: { "tab:7": "md-lead", "tab:8": "md-lead" } });
  await s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null });
  assert.deepEqual(tabIdsOf(s.f, 100), [7, 8]);
  let seen = null;
  const r = s.r;
  const emit = r.emit;
  r.emit = (name, fields) => {
    if (name === "tabs.onRemoved") seen = r.map.has(7);
    emit(name, fields);
  };
  s.f.chrome.tabs.onRemoved.fire(7, { windowId: 1, isWindowClosing: false });
  assert.equal(seen, false, "the entry went before the event, in the same turn");
  assert.deepEqual(s.evs().at(-1), { t: "ev", ch: "bridge", ev: "tabs.onRemoved", tabId: 7, removeInfo: { windowId: 1, isWindowClosing: false } });
  await flush();
  assert.deepEqual(s.f.storage_.session, { "tab:8": "md-lead" });
  assert.deepEqual(tabIdsOf(s.f, 100), [8]);
});

test("the map, the scope rules and the copy stay at each disconnect and each new daemon connection", async () => {
  const s = await startReceiver({ tabs: [blank(7)], copy: { "tab:7": "md-lead" } });
  await s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md" }, default: null });
  const mark = s.f.calls.length;
  s.port().fireMessage({ t: "link", up: true });
  s.port().fireDisconnect();
  await flush();
  assert.deepEqual(s.r.map.list(), [{ tabId: 7, scope: "md-lead" }]);
  assert.deepEqual(ruleIds(s.f), [100, 101]);
  assert.ok(!callsSince(s.f, mark).some(([p]) => p.startsWith("declarativeNetRequest.") || p.startsWith("storage.")), "no rule and no key changes");
});

// ---- tabs.onReplaced and the kept entries ----

test("tabs.onReplaced: the added tab takes the removed tab's scope, and bridge.tabScope comes right before the receiver's tabs.onReplaced", async () => {
  const s = await startReceiver({ tabs: [blank(9), blank(3)], copy: { "tab:9": B.scope } });
  await s.set(B.setScopes);
  const before = s.evs().length;
  s.f.chrome.tabs.onReplaced.fire(11, 9);
  await flush();
  const want = B.eventVectors.find((v) => v.ev.ev === "bridge.tabScope" && v.ev.tabId === 11).ev;
  assert.deepEqual(s.evs().slice(before), [want, { t: "ev", ch: "bridge", ev: "tabs.onReplaced", addedTabId: 11, removedTabId: 9 }]);
  assert.deepEqual(s.r.map.list(), [{ tabId: 11, scope: B.scope }]);
  assert.deepEqual(s.f.storage_.session, { "tab:11": B.scope });
  assert.deepEqual(tabIdsOf(s.f, 100), [11]);
});

test("tabs.onReplaced of a tab whose scope has no list: from the first applied set_scopes on, the added tab joins the orphan set and closes; before it, it enters the map", async () => {
  const s = await startReceiver({ tabs: [blank(9), blank(12), blank(3)], copy: { "tab:9": "md-gone", "tab:12": "md-gone" }, targets: [{ id: "T11", tabId: 11, type: "page" }] });
  // Before the first applied set_scopes the lists are not known: the added tab enters the map.
  s.f.chrome.tabs.onReplaced.fire(13, 12);
  await flush();
  assert.equal(s.r.map.scopeOf(13), "md-gone", "the worker-start exception");
  // A set_scopes that closes nothing of tab 9 (its close fails), then a replace of tab 9.
  s.f.impl["debugger.getTargets"] = async () => [];
  s.f.impl["tabs.remove"] = async (id) => {
    if (id === 9) throw new Error("held");
  };
  await s.set(B.setScopes);
  delete s.f.impl["debugger.getTargets"];
  delete s.f.impl["tabs.remove"];
  assert.equal(s.r.map.isOrphan(9), true);
  s.f.tabs_.push(blank(11));
  const before = s.evs().length;
  s.f.chrome.tabs.onReplaced.fire(11, 9);
  await flush();
  assert.deepEqual(s.evs().slice(before).map((e) => e.ev), ["tabs.onReplaced", "tabs.onRemoved"], "no bridge.tabScope; the added tab closes");
  assert.equal(s.r.map.isOrphan(9), false);
  assert.equal(s.f.tabs_.some((t) => t.id === 11), false);
  // A tab of a scope that now has no list: its replacement never enters the map.
  s.r.map.set(20, "md-gone");
  s.f.tabs_.push(blank(21));
  s.f.targets_.push({ id: "T21", tabId: 21, type: "page" });
  s.f.chrome.tabs.onReplaced.fire(21, 20);
  await flush();
  assert.equal(s.r.map.has(21), false);
  assert.equal(s.f.tabs_.some((t) => t.id === 21), false);
});

// review-20 note 1 (a surviving mutation of TabMap.adopt): with a default list, the scope of a tab of
// the orphan set would fall back to that list; the orphan set wins.
test("tabs.onReplaced of a tab of the orphan set, under a default list: the added tab joins the orphan set and closes", async () => {
  const s = await startReceiver({ tabs: [blank(3), blank(13)], copy: { "tab:13": "md-gone" } });
  s.f.impl["debugger.getTargets"] = async () => [];
  s.f.impl["tabs.remove"] = async (id) => {
    if (id === 13) throw new Error("held");
  };
  await s.set({ lists: { md: ["a.example"] }, scopes: { "md-gone": null }, default: "md" });
  delete s.f.impl["debugger.getTargets"];
  delete s.f.impl["tabs.remove"];
  assert.equal(s.r.map.isOrphan(13), true);
  s.f.tabs_ = s.f.tabs_.filter((t) => t.id !== 13);
  s.f.tabs_.push(blank(14));
  s.f.targets_.push({ id: "T14", tabId: 14, type: "page" });
  const before = s.evs().length;
  s.f.chrome.tabs.onReplaced.fire(14, 13);
  await flush();
  assert.equal(s.r.map.has(14), false);
  assert.ok(!s.evs().slice(before).some((e) => e.ev === "bridge.tabScope"));
  assert.equal(s.f.tabs_.some((t) => t.id === 14), false, "closed");
  assert.deepEqual(s.r.map.adopt(15, { orphan: true }), { orphan: true });
  assert.equal(s.r.map.has(15), false);
});

test("the kept entries: a tab that left the map keeps its scope for TOMBSTONE_MS (for a popup of it, part 1b), the orphan set spreads, and an applied set_scopes that gives the scope a list drops its kept entries", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(8), blank(3)], copy: { "tab:7": "md-lead", "tab:8": "md-old" } });
  let now = 1000;
  s.r.clock.now = () => now;
  s.f.chrome.tabs.onRemoved.fire(7, { windowId: 1, isWindowClosing: false });
  s.f.chrome.tabs.onRemoved.fire(8, { windowId: 1, isWindowClosing: false });
  assert.deepEqual(s.r.map.opener(7), { scope: "md-lead" });
  s.r.map.addOrphan(30);
  assert.deepEqual(s.r.map.opener(30), { orphan: true });
  s.f.chrome.tabs.onRemoved.fire(30, { windowId: 1, isWindowClosing: false });
  assert.deepEqual(s.r.map.opener(30), { orphan: true }, "a kept membership of the orphan set");
  await s.set({ lists: { md: ["a.example"] }, scopes: { "md-old": "md" }, default: null });
  assert.equal(s.r.map.opener(8), null, "md-old has a list again: its kept entry goes");
  assert.deepEqual(s.r.map.opener(7), { scope: "md-lead" }, "md-lead has no list: its kept entry stays");
  assert.deepEqual(s.r.map.adopt(40, s.r.map.opener(7)), { orphan: true }, "a popup of it joins the orphan set");
  now += TOMBSTONE_MS;
  assert.equal(s.r.map.opener(7), null);
  assert.equal(s.r.map.opener(30), null);
});
