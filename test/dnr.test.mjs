// The DNR rules of the allowlists per scope (contract C5): the scope rules as session rules, the
// import's rules 6 and 7, rule 5, and no rule 2 or 4.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { floorInitiatorRule, floorRule, FLOOR_IDS, FLOOR_INITIATOR_RULE_ID, FLOOR_RULE_ID, headerRule, importRules, scopeRules, SessionRules, TRUSTWORTHY } from "../agent/dnr.js";
import { RESTORE_MAX_MS } from "../agent/tabmap.js";
import { makeFakeChrome } from "./fake-chrome.mjs";

const ID = "abcdefghijklmnopabcdefghijklmnop"; // the fake's chrome.runtime.id

test("the scope rules of one list are C5's: priority 2, main frames by requestDomains and frames by topDomains, the tabIds of its tabs", () => {
  assert.deepEqual(scopeRules(100, ["a.example", "b.example"], [7, 9]), [
    { id: 100, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["a.example", "b.example"], resourceTypes: ["main_frame"], tabIds: [7, 9] } },
    { id: 101, priority: 2, action: { type: "allow" }, condition: { topDomains: ["a.example", "b.example"], resourceTypes: ["sub_frame", "object"], tabIds: [7, 9] } },
  ]);
  assert.deepEqual(importRules("a.example", 31), [
    { id: 6, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["a.example"], resourceTypes: ["main_frame"], tabIds: [31] } },
    { id: 7, priority: 2, action: { type: "allow" }, condition: { topDomains: ["a.example"], resourceTypes: ["sub_frame", "object"], tabIds: [31] } },
  ]);
  assert.deepEqual(headerRule(ID), {
    id: 5,
    priority: 3,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "sec-fetch-site", operation: "set", value: "none" }] },
    condition: { resourceTypes: ["main_frame"], initiatorDomains: [ID], regexFilter: TRUSTWORTHY },
  });
  // Chrome applies a modifyHeaders rule only above the priority of every allow rule that matches.
  assert.ok(headerRule(ID).priority > scopeRules(100, ["a.example"], [1])[0].priority);
});

// Chrome sends Sec-Fetch-* only to a potentially trustworthy URL; the rule
// must not add the header where Chrome sends none.
test("the header rule's regexFilter covers the potentially trustworthy URLs only", () => {
  const re = new RegExp(TRUSTWORTHY);
  for (const u of ["https://a.example/", "https://a.example:8443/x", "http://localhost/", "http://localhost:8771/p",
    "http://www.s1.localhost:8771/p?x=1", "http://127.0.0.1/", "http://127.1.2.3:80/", "http://[::1]:8080/"]) {
    assert.ok(re.test(u), u);
  }
  for (const u of ["http://a.example/", "http://www.plain.test:8771/p", "http://localhost.a.example/", "http://127.0.0.1.a.example/",
    "http://a.example/https://b.example/", "ftp://localhost/", "http://localhostx/"]) {
    assert.ok(!re.test(u), u);
  }
});

// A model as the receiver gives it: list name -> {entries, tabIds}.
function rulesWith(model) {
  const f = makeFakeChrome();
  const m = { current: model };
  const rules = new SessionRules(f.chrome, () => new Map(Object.entries(m.current)));
  // The scope rules' tests read every rule but the merge guard's floor (rules 9 and 89), which its own tests read.
  const session = () => f.sessionRules_.filter((r) => !FLOOR_IDS.includes(r.id)).map((r) => [r.id, r.condition.requestDomains ?? r.condition.topDomains, r.condition.tabIds]);
  return { f, m, rules, session, updates: () => f.callsTo("declarativeNetRequest.updateSessionRules").map(([d]) => d) };
}

test("the worker's start removes dynamic rules 2 and 4 and every session rule; set_scopes writes rule 5 with the removal of 2 and 4", async () => {
  const { f, rules } = rulesWith({});
  f.sessionRules_ = [{ id: 6 }, { id: 8 }, { id: 100 }, { id: 101 }];
  await rules.start();
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateDynamicRules"), [[{ removeRuleIds: [2, 4] }]]);
  // The floor (rules 9 and 89, C5) goes in in the same call, so a worker that starts again leaves no moment without it.
  const floor = [floorRule(["github.com"], []), floorInitiatorRule(["github.com"], [])];
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateSessionRules"), [[{ removeRuleIds: [6, 8, 100, 101, 9, 89], addRules: floor }]]);
  assert.deepEqual(f.sessionRules_, floor);
  await rules.writeHeader();
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateDynamicRules")[1], [{ removeRuleIds: [2, 4, 5], addRules: [headerRule(ID)] }]);
});

test("a full replace: two rules for each list with an entry and an open tab, ids from 100, in one call", async () => {
  const { m, rules, session, updates } = rulesWith({
    md: { entries: ["a.example"], tabIds: [7, 8] },
    vedlo: { entries: ["v.example"], tabIds: [9] },
    empty: { entries: [], tabIds: [10] }, // an empty list has no rule: its tabs can open about:blank only
    unused: { entries: ["u.example"], tabIds: [] },
  });
  assert.equal(await rules.replaceAll(), 4);
  assert.deepEqual(session(), [[100, ["a.example"], [7, 8]], [101, ["a.example"], [7, 8]], [102, ["v.example"], [9]], [103, ["v.example"], [9]]]);
  // The next one replaces every scope rule in one call.
  m.current = { vedlo: { entries: ["v.example", "w.example"], tabIds: [9] } };
  assert.equal(await rules.replaceAll(), 2);
  assert.deepEqual(updates().at(-1).removeRuleIds, [100, 101, 102, 103]);
  assert.deepEqual(session(), [[100, ["v.example", "w.example"], [9]], [101, ["v.example", "w.example"], [9]]]);
});

test("a tab that gets or loses a scope replaces only its list's two rules; a new list takes free ids", async () => {
  const { m, rules, session, updates } = rulesWith({ md: { entries: ["a.example"], tabIds: [7] }, vedlo: { entries: ["v.example"], tabIds: [9] } });
  await rules.replaceAll();
  m.current.md = { entries: ["a.example"], tabIds: [7, 8] };
  await rules.replaceLists(["md"]);
  assert.deepEqual(updates().at(-1), { removeRuleIds: [100, 101], addRules: scopeRules(100, ["a.example"], [7, 8]) });
  // md loses its last tab: its rules go; vedlo keeps its own.
  m.current.md = { entries: ["a.example"], tabIds: [] };
  await rules.replaceLists(["md"]);
  assert.deepEqual(updates().at(-1), { removeRuleIds: [100, 101], addRules: [] });
  assert.deepEqual(session().map(([id]) => id), [102, 103]);
  m.current.other = { entries: ["o.example"], tabIds: [11] };
  await rules.replaceLists(["other", null]);
  assert.deepEqual(session().map(([id]) => id), [102, 103, 100, 101], "the lowest free pair");
  const calls = updates().length;
  await rules.replaceLists([null, "nolist"]);
  assert.equal(updates().length, calls, "nothing to change: no call");
});

test("a failed update fails closed: a remove-only call takes every scope rule out, and the next change is a full replace", async () => {
  const { f, m, rules, session, updates } = rulesWith({ md: { entries: ["a.example"], tabIds: [7] }, vedlo: { entries: ["v.example"], tabIds: [9] } });
  await rules.replaceAll();
  await rules.addImport("i.example", 31);
  let fail = true;
  f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    if (fail && d.addRules && d.addRules.length > 0) throw new Error("Session rule count exceeded.");
    f.sessionRules_ = f.sessionRules_.filter((r) => !d.removeRuleIds.includes(r.id)).concat(d.addRules ?? []);
  };
  m.current.md = { entries: ["a.example"], tabIds: [7, 8] };
  await assert.rejects(rules.replaceLists(["md"]), /Session rule count exceeded/);
  assert.deepEqual(updates().at(-1), { removeRuleIds: [100, 101, 102, 103] }, "the remove-only call");
  assert.deepEqual(session().map(([id]) => id), [6, 7], "every tab of every scope is blocked; the import's rules stay");
  fail = false;
  await rules.replaceLists(["md"]);
  assert.deepEqual(session().map(([id]) => id), [6, 7, 100, 101, 102, 103], "a full replace from the map");
  // The import's rules go by their own call.
  await rules.removeImport();
  assert.deepEqual(updates().at(-1), { removeRuleIds: [6, 7] });
});

test("a start whose removal failed: the next full replace removes the rules that a worker before it left", async () => {
  const { f, rules, session } = rulesWith({ md: { entries: ["a.example"], tabIds: [7] } });
  f.sessionRules_ = [{ id: 100, condition: {} }, { id: 101, condition: {} }, { id: 104, condition: {} }];
  f.impl["declarativeNetRequest.getSessionRules"] = async () => {
    throw new Error("not yet");
  };
  await rules.start();
  delete f.impl["declarativeNetRequest.getSessionRules"];
  assert.equal(await rules.replaceAll(), 2);
  assert.deepEqual(session(), [[100, ["a.example"], [7]], [101, ["a.example"], [7]]]);
});

// review-20 note 3: a time limit on the removal at the worker's start; a late one fails closed (the
// next full replace removes every rule of the scheme), with a log line.
test("a removal at the start that has not ended in time fails closed: the start goes on, and the next full replace removes the old rules", { timeout: 5000 }, async () => {
  const f = makeFakeChrome();
  const timers = [];
  const clock = { setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.at(-1)), clearTimer: () => {} };
  const rules = new SessionRules(f.chrome, () => new Map([["md", { entries: ["a.example"], tabIds: [7] }]]), clock);
  f.sessionRules_ = [{ id: 100, condition: {} }, { id: 102, condition: {} }];
  let hang = true;
  f.impl["declarativeNetRequest.updateSessionRules"] = (d) => {
    if (hang) return new Promise(() => {});
    f.sessionRules_ = f.sessionRules_.filter((r) => !d.removeRuleIds.includes(r.id)).concat(d.addRules ?? []);
    return Promise.resolve();
  };
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(" "));
  try {
    const started = rules.start();
    await new Promise((r) => setTimeout(r, 0));
    timers.find((t) => t.ms === RESTORE_MAX_MS).fn();
    await started;
    assert.ok(logged.some((l) => /session rules/.test(l)), "a log line");
  } finally {
    console.warn = warn;
  }
  hang = false;
  assert.equal(await rules.replaceAll(), 2);
  assert.deepEqual(f.sessionRules_.map((r) => r.id).filter((id) => !FLOOR_IDS.includes(id)), [100, 101]);
});

// review-20 note 4: after a failed removal at the start, the next full replace also removes rules 6 and 7
// when no import runs (an import's own rules stay).
test("after a failed removal at the start, a full replace removes rules 6 and 7 when no import runs", async () => {
  for (const importing of [false, true]) {
    const { f, rules } = rulesWith({ md: { entries: ["a.example"], tabIds: [7] } });
    f.sessionRules_ = [{ id: 6, condition: {} }, { id: 7, condition: {} }, { id: 100, condition: {} }];
    let fail = true;
    f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
      if (fail) throw new Error("no");
      f.sessionRules_ = f.sessionRules_.filter((r) => !d.removeRuleIds.includes(r.id)).concat(structuredClone(d.addRules ?? []));
    };
    await rules.start();
    fail = false;
    if (importing) await rules.addImport("i.example", 31);
    await rules.replaceAll();
    assert.deepEqual(f.sessionRules_.map((r) => r.id).filter((id) => !FLOOR_IDS.includes(id)).sort((a, b) => a - b), importing ? [6, 7, 100, 101] : [100, 101], `an import runs: ${importing}`);
  }
});

// review-20b probe N1: the start's late read of the session rules (after RESTORE_MAX_MS) removes
// nothing: the next full replace removes those rules, and its own rules stay.
test("a late read of the session rules at the start removes nothing after its time limit; the full replace's rules stay", { timeout: 5000 }, async () => {
  const f = makeFakeChrome();
  const timers = [];
  const clock = { setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.at(-1)), clearTimer: () => {} };
  const rules = new SessionRules(f.chrome, () => new Map([["md", { entries: ["a.example"], tabIds: [7] }], ["ops", { entries: ["b.example"], tabIds: [8] }]]), clock);
  f.sessionRules_ = [{ id: 100, condition: {} }, { id: 101, condition: {} }]; // a worker before this one left them
  let release;
  const old = structuredClone(f.sessionRules_);
  f.impl["declarativeNetRequest.getSessionRules"] = () => {
    if (!release) return new Promise((res) => (release = () => res(old)));
    return Promise.resolve(structuredClone(f.sessionRules_));
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const started = rules.start();
    await new Promise((r) => setTimeout(r, 0));
    timers.find((t) => t.ms === RESTORE_MAX_MS).fn();
    await started;
  } finally {
    console.warn = warn;
  }
  assert.equal(await rules.replaceAll(), 4);
  const now = () => f.sessionRules_.filter((r) => !FLOOR_IDS.includes(r.id)).map((r) => [r.id, r.condition.tabIds]);
  assert.deepEqual(now(), [[100, [7]], [101, [7]], [102, [8]], [103, [8]]]);
  release(); // the start's late read answers now, with the old worker's ids
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(now(), [[100, [7]], [101, [7]], [102, [8]], [103, [8]]], "the late part of the start removed nothing");
});

// review-20b note 3: the branch of a full replace with no list of the session rules (the read fails at
// the start and again at the replace) removes rules 6, 7 and 8 and every scope id of the scheme.
test("a full replace after a failed start, when the session rules cannot be read, removes rules 6, 7 and 8 and the scheme's ids", async () => {
  const { f, rules, updates } = rulesWith({ md: { entries: ["a.example"], tabIds: [7] } });
  f.impl["declarativeNetRequest.getSessionRules"] = async () => {
    throw new Error("no");
  };
  await rules.start();
  await rules.replaceAll();
  const removed = updates().at(-1).removeRuleIds;
  for (const id of [6, 7, 8, 100, 101, 5099, 10099]) assert.ok(removed.includes(id), String(id));
  assert.ok(!removed.includes(5), "rule 5 is a dynamic rule");
  // During an import, 6 and 7 stay.
  const g = rulesWith({ md: { entries: ["a.example"], tabIds: [7] } });
  g.f.impl["declarativeNetRequest.getSessionRules"] = async () => {
    throw new Error("no");
  };
  await g.rules.start();
  await g.rules.addImport("i.example", 31);
  await g.rules.replaceAll();
  const kept = g.updates().at(-1).removeRuleIds;
  assert.ok(!kept.includes(6) && !kept.includes(7) && kept.includes(8));
});

// review-20b note 3: the end of an import (removeImport) ends its claim on rules 6 and 7.
test("after an import ended, a full replace in the failed-start state removes rules 6 and 7 again", async () => {
  const { f, rules } = rulesWith({ md: { entries: ["a.example"], tabIds: [7] } });
  let fail = true;
  f.impl["declarativeNetRequest.getSessionRules"] = async () => {
    if (fail) throw new Error("no");
    return structuredClone(f.sessionRules_);
  };
  await rules.start();
  fail = false;
  await rules.addImport("i.example", 31);
  await rules.removeImport();
  f.sessionRules_.push({ id: 6, condition: {} }, { id: 7, condition: {} }); // rules of a worker before this one
  await rules.replaceAll();
  assert.deepEqual(f.sessionRules_.map((r) => r.id).filter((id) => !FLOOR_IDS.includes(id)), [100, 101]);
  assert.deepEqual(FLOOR_IDS.map((id) => f.sessionRules_.some((r) => r.id === id)), [true, true], "the floor stays: rules 9 and 89");
});

// ---- the merge guard's floor (C5; board ab-v16.99) ----

test("the merge guard's floor is C5's rule 9: a block of every write to the guarded hosts, every resource type, priority 6 above every allow rule", () => {
  assert.deepEqual(floorRule(["github.com"], []), {
    id: 9, priority: 6, action: { type: "block" },
    condition: { requestDomains: ["github.com"], excludedRequestMethods: ["get", "head", "options"], resourceTypes: ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"] },
  });
  assert.deepEqual(floorRule(["github.com", "github-standin.localhost"], [3, 7]).condition.excludedTabIds, [3, 7]);
  assert.ok(!Object.hasOwn(floorRule(["github.com"], []).condition, "excludedTabIds"), "no empty excludedTabIds");
  for (const r of [...scopeRules(100, ["a.example"], [1]), ...importRules("a.example", 1)]) assert.ok(floorRule(["github.com"], []).priority > r.priority);
  assert.ok(floorRule(["github.com"], []).priority > 5, "above the act's allow rules (5)");
});

test("the floor's initiator rule is C5's rule 89: a block of every write to the guarded hosts whose initiator is not a guarded host, every resource type but the main frame, priority 6", () => {
  assert.equal(FLOOR_INITIATOR_RULE_ID, 89);
  assert.deepEqual(FLOOR_IDS, [9, 89]);
  assert.deepEqual(floorInitiatorRule(["github.com", "github-standin.localhost"], []), {
    id: 89, priority: 6, action: { type: "block" },
    condition: {
      requestDomains: ["github.com", "github-standin.localhost"], excludedRequestMethods: ["get", "head", "options"],
      excludedResourceTypes: ["main_frame"], excludedInitiatorDomains: ["github.com", "github-standin.localhost"],
    },
  });
  assert.deepEqual(floorInitiatorRule(["github.com"], [3, 31]).condition.excludedTabIds, [3, 31]);
  assert.ok(!Object.hasOwn(floorInitiatorRule(["github.com"], []).condition, "excludedTabIds"), "no empty excludedTabIds");
  assert.equal(floorInitiatorRule(["github.com"], []).priority, floorRule(["github.com"], []).priority, "the floor's priority, above every allow rule");
});

test("the floor: bridge.mergeGuard's setGuard adds hosts to GitHub's and leaves the guarded tabs out; unguard and a link change take them back; a change that changes nothing writes nothing", async () => {
  const { f, rules } = rulesWith({});
  await rules.start();
  const floor = () => f.sessionRules_.find((r) => r.id === FLOOR_RULE_ID);
  const initiator = () => f.sessionRules_.find((r) => r.id === FLOOR_INITIATOR_RULE_ID);
  const floorCalls = () => f.callsTo("declarativeNetRequest.updateSessionRules").length;
  await rules.setGuard(["github-standin.localhost"], [7, 9]);
  assert.deepEqual([floor().condition.requestDomains, floor().condition.excludedTabIds], [["github.com", "github-standin.localhost"], [7, 9]]);
  // Rule 89 keeps the guarded tabs (board ab-v16.100): the same hosts, as requests and as initiators.
  assert.deepEqual([initiator().condition.requestDomains, initiator().condition.excludedInitiatorDomains], [["github.com", "github-standin.localhost"], ["github.com", "github-standin.localhost"]]);
  assert.equal(Object.hasOwn(initiator().condition, "excludedTabIds"), false, "rule 89 holds the guarded tabs");
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateSessionRules").at(-1)[0].removeRuleIds, [9, 89], "both rules in one call");
  await rules.setGuard([], [9]);
  assert.deepEqual([floor().condition.requestDomains, floor().condition.excludedTabIds], [["github.com"], [9]], "GitHub's host always; a full replace");
  assert.deepEqual(initiator().condition.excludedInitiatorDomains, ["github.com"]);
  const n = floorCalls();
  await rules.setGuard([], [9]);
  assert.equal(floorCalls(), n, "the same floor: no call");
  await rules.unguard([9]);
  assert.equal(Object.hasOwn(floor().condition, "excludedTabIds"), false, "the tab is in the floor again");
  await rules.setGuard([], [4, 5]);
  await rules.unguard(null);
  assert.equal(Object.hasOwn(floor().condition, "excludedTabIds"), false, "a link change: every tab");
  const m = floorCalls();
  await rules.unguard([4]);
  assert.equal(floorCalls(), m, "an unguard that changes nothing: no call");
});

test("the floor leaves the marked tabs and the act tabs out, and takes the act tabs back at the act's end", async () => {
  const f = makeFakeChrome();
  let marked = [20];
  const rules = new SessionRules(f.chrome, () => new Map(), undefined, () => [], () => marked);
  await rules.start();
  const floor = () => f.sessionRules_.find((r) => r.id === FLOOR_RULE_ID);
  const initiator = () => f.sessionRules_.find((r) => r.id === FLOOR_INITIATOR_RULE_ID);
  const both = () => [floor().condition.excludedTabIds, initiator().condition.excludedTabIds];
  assert.deepEqual(both(), [[20], [20]], "the marked tab at the start");
  marked = [20, 21];
  await rules.syncFloor();
  assert.deepEqual(both(), [[20, 21], [20, 21]]);
  f.impl["declarativeNetRequest.getSessionRules"] = async () => structuredClone(f.sessionRules_);
  await rules.setAct({ tabIds: [31], sendTo: ["https://login.example"] });
  assert.deepEqual(both(), [[20, 21, 31], [20, 21, 31]], "the act tab: its sign-in posts to its site");
  await rules.addActTab(32);
  await rules.setGuard([], [5]);
  assert.deepEqual(both(), [[5, 20, 21, 31, 32], [20, 21, 31, 32]], "a guarded tab leaves rule 9 only");
  await rules.removeAct();
  assert.deepEqual(both(), [[5, 20, 21], [20, 21]]);
});

test("the floor at the worker's start: a removal that fails or hangs still leaves the floor written in a call of its own; no floor call comes before the start", async () => {
  const { f, rules } = rulesWith({});
  await rules.setGuard([], [7]);
  assert.equal(f.callsTo("declarativeNetRequest.updateSessionRules").length, 0, "before the start only the start writes the floor");
  f.impl["declarativeNetRequest.getSessionRules"] = async () => { throw new Error("not yet"); };
  await rules.start();
  await new Promise((r) => setTimeout(r, 5));
  const calls = f.callsTo("declarativeNetRequest.updateSessionRules").map(([d]) => d);
  assert.deepEqual(calls.at(-1), { removeRuleIds: [FLOOR_RULE_ID, FLOOR_INITIATOR_RULE_ID], addRules: [floorRule(["github.com"], [7]), floorInitiatorRule(["github.com"], [])] });
});

// ---- the floor's shared vectors (test/vectors/bridge.json: floor; board ab-v16.100) ----

const V = JSON.parse(readFileSync(new URL("./vectors/bridge.json", import.meta.url), "utf8"));

// A model of DNR's match for the conditions of the floor's rules, as Chromium's
// components/url_pattern_index/url_pattern_index.cc decides it: a domain list
// matches a host and its subdomains; a request with no initiator has an opaque
// origin, which matches a rule only when the rule has no initiatorDomains.
const FLOOR_CONDITIONS = ["requestDomains", "excludedRequestMethods", "resourceTypes", "excludedResourceTypes", "excludedInitiatorDomains", "excludedTabIds"];
const domainIs = (host, d) => host === d || host.endsWith("." + d);
function floorMatches(rule, q) {
  const c = rule.condition;
  for (const k of Object.keys(c)) assert.ok(FLOOR_CONDITIONS.includes(k), `the model knows the condition ${k}`);
  const host = new URL(q.url).hostname;
  if (c.requestDomains && !c.requestDomains.some((d) => domainIs(host, d))) return false;
  if (c.excludedRequestMethods?.includes(q.method)) return false;
  if (c.resourceTypes && !c.resourceTypes.includes(q.type)) return false;
  if (c.excludedResourceTypes?.includes(q.type)) return false;
  if (c.excludedTabIds?.includes(q.tabId)) return false;
  if (q.initiator !== null && c.excludedInitiatorDomains?.some((d) => domainIs(new URL(q.initiator).hostname, d))) return false;
  return true;
}

test("the floor's vectors: the receiver's rules 9 and 89 for the vectors' state, and each case blocked by exactly the rules that it names", async () => {
  const { hosts, guarded, marked, act } = V.floor.state;
  const f = makeFakeChrome();
  f.impl["declarativeNetRequest.getSessionRules"] = async () => structuredClone(f.sessionRules_);
  const rules = new SessionRules(f.chrome, () => new Map(), undefined, () => [], () => marked);
  await rules.start();
  await rules.setAct({ tabIds: act, sendTo: ["https://login.example"] });
  await rules.setGuard(hosts.filter((h) => h !== "github.com"), guarded);
  assert.deepEqual(FLOOR_IDS.map((id) => f.sessionRules_.find((r) => r.id === id)), V.floor.rules);
  assert.deepEqual(rules.floorRules(), V.floor.rules);
  const has = (fn) => V.floor.cases.some(fn);
  assert.ok(has((v) => guarded.includes(v.request.tabId) && v.blockedBy.length === 0) && has((v) => guarded.includes(v.request.tabId) && v.blockedBy.includes(89)));
  assert.ok(has((v) => marked.includes(v.request.tabId)) && has((v) => act.includes(v.request.tabId)) && has((v) => v.request.tabId === -1) && has((v) => v.request.initiator === null));
  for (const v of V.floor.cases) {
    const by = V.floor.rules.filter((r) => floorMatches(r, v.request)).map((r) => r.id);
    assert.deepEqual(by, v.blockedBy, v.note);
  }
});
