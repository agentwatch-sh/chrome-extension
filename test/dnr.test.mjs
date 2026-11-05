// The DNR rules of the allowlists per scope (contract C5): the scope rules as session rules, the
// import's rules 6 and 7, rule 5, and no rule 2 or 4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { headerRule, importRules, scopeRules, SessionRules, TRUSTWORTHY } from "../agent/dnr.js";
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
  const session = () => f.sessionRules_.map((r) => [r.id, r.condition.requestDomains ?? r.condition.topDomains, r.condition.tabIds]);
  return { f, m, rules, session, updates: () => f.callsTo("declarativeNetRequest.updateSessionRules").map(([d]) => d) };
}

test("the worker's start removes dynamic rules 2 and 4 and every session rule; set_scopes writes rule 5 with the removal of 2 and 4", async () => {
  const { f, rules } = rulesWith({});
  f.sessionRules_ = [{ id: 6 }, { id: 8 }, { id: 100 }, { id: 101 }];
  await rules.start();
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateDynamicRules"), [[{ removeRuleIds: [2, 4] }]]);
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateSessionRules"), [[{ removeRuleIds: [6, 8, 100, 101] }]]);
  assert.deepEqual(f.sessionRules_, []);
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
test("a removal at the start that has not ended in time fails closed: the start goes on, and the next full replace removes the old rules", async () => {
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
    timers.find((t) => t.ms === 2000).fn();
    await started;
    assert.ok(logged.some((l) => /session rules/.test(l)), "a log line");
  } finally {
    console.warn = warn;
  }
  hang = false;
  assert.equal(await rules.replaceAll(), 2);
  assert.deepEqual(f.sessionRules_.map((r) => r.id), [100, 101]);
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
    assert.deepEqual(f.sessionRules_.map((r) => r.id).sort((a, b) => a - b), importing ? [6, 7, 100, 101] : [100, 101], `an import runs: ${importing}`);
  }
});
