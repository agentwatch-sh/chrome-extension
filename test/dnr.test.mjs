import { test } from "node:test";
import assert from "node:assert/strict";
import { allowRule, applyAllowlist } from "../receiver/dnr.js";
import { makeFakeChrome } from "./fake-chrome.mjs";

test("allowRule is C5 rule 2", () => {
  assert.deepEqual(allowRule(["a.example", "b.example"]), {
    id: 2,
    priority: 2,
    action: { type: "allow" },
    condition: { requestDomains: ["a.example", "b.example"], resourceTypes: ["main_frame"] },
  });
  assert.equal(allowRule([]), null);
});

test("applyAllowlist updates the rule and closes uncovered tabs", async () => {
  const f = makeFakeChrome();
  f.setTabs([
    { id: 1, windowId: 1, url: "https://x.a.example/p" },
    { id: 2, windowId: 1, url: "https://a.example/" },
    { id: 3, windowId: 1, url: "https://c.example/" },
    { id: 4, windowId: 1, url: "chrome://settings" },
    { id: 5, windowId: 1, url: "about:blank", pendingUrl: "https://c.example/new" },
  ]);
  const r = await applyAllowlist(f.chrome, ["a.example", "b.example"]);
  assert.deepEqual(r, { rules: 1, closed: 2, refused: 0 });
  const [args] = f.callsTo("declarativeNetRequest.updateDynamicRules");
  assert.deepEqual(args[0].removeRuleIds, [2]);
  assert.equal(args[0].addRules.length, 1);
  assert.deepEqual(f.callsTo("tabs.remove").map((a) => a[0]).sort(), [3, 5]);
  assert.equal(f.callsTo("tabs.create").length, 0);
});

test("an empty list adds no rule", async () => {
  const f = makeFakeChrome();
  const r = await applyAllowlist(f.chrome, []);
  assert.deepEqual(r, { rules: 0, closed: 0, refused: 0 });
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateDynamicRules")[0][0], { removeRuleIds: [2], addRules: [] });
});

test("about:blank opens before the last tab of a window closes", async () => {
  const f = makeFakeChrome();
  f.setTabs([
    { id: 1, windowId: 7, url: "https://c.example/" },
    { id: 2, windowId: 8, url: "https://c.example/" },
    { id: 3, windowId: 8, url: "https://a.example/" },
  ]);
  const r = await applyAllowlist(f.chrome, ["a.example"]);
  assert.deepEqual(r, { rules: 1, closed: 2, refused: 0 });
  assert.deepEqual(f.callsTo("tabs.create"), [[{ windowId: 7, url: "about:blank", active: false }]]);
  const order = f.calls.map(([p]) => p);
  assert.ok(order.indexOf("tabs.create") < order.indexOf("tabs.remove"));
});

test("chrome:// tabs are never touched, even alone in a window", async () => {
  const f = makeFakeChrome();
  f.setTabs([{ id: 1, windowId: 1, url: "chrome://newtab/" }]);
  const r = await applyAllowlist(f.chrome, ["a.example"]);
  assert.deepEqual(r, { rules: 1, closed: 0, refused: 0 });
  assert.equal(f.callsTo("tabs.remove").length, 0);
});

test("invalid entries are refused and counted; the valid ones apply, never an older wider rule", async () => {
  for (const bad of ["EVIL.example", "https://x.example", "nodot", 5, null, "a.example."]) {
    const f = makeFakeChrome();
    f.setTabs([
      { id: 1, windowId: 1, url: "https://a.example/" },
      { id: 2, windowId: 1, url: "https://evil.example/" },
    ]);
    const r = await applyAllowlist(f.chrome, ["a.example", bad]);
    assert.deepEqual(r, { rules: 1, closed: 1, refused: 1 }, String(bad));
    const [[update]] = f.callsTo("declarativeNetRequest.updateDynamicRules");
    assert.deepEqual(update.removeRuleIds, [2]);
    assert.deepEqual(update.addRules.map((x) => x.condition.requestDomains), [["a.example"]]);
    assert.deepEqual(f.callsTo("tabs.remove").map((a) => a[0]), [2]);
    assert.deepEqual(Object.keys(r), ["rules", "closed", "refused"]); // no entry is echoed
  }
  // Only invalid entries: the old rule goes, and no new one comes.
  const f = makeFakeChrome();
  const r = await applyAllowlist(f.chrome, ["EVIL.example", "x"]);
  assert.deepEqual(r, { rules: 0, closed: 0, refused: 2 });
  assert.deepEqual(f.callsTo("declarativeNetRequest.updateDynamicRules")[0][0], { removeRuleIds: [2], addRules: [] });
  // A list that is not an array blocks everything.
  const g = makeFakeChrome();
  g.setTabs([{ id: 1, windowId: 1, url: "https://a.example/" }, { id: 2, windowId: 1, url: "chrome://newtab/" }]);
  assert.deepEqual(await applyAllowlist(g.chrome, "a.example"), { rules: 0, closed: 1, refused: 1 });
  assert.deepEqual(g.callsTo("declarativeNetRequest.updateDynamicRules")[0][0], { removeRuleIds: [2], addRules: [] });
});

test("a tab already gone is not an error and is not counted", async () => {
  const f = makeFakeChrome();
  f.setTabs([
    { id: 1, windowId: 1, url: "https://c.example/" },
    { id: 2, windowId: 1, url: "https://d.example/" },
    { id: 3, windowId: 1, url: "https://a.example/" },
  ]);
  f.chrome.tabs.remove = async (id) => {
    if (id === 1) throw new Error("No tab with id: 1.");
  };
  const r = await applyAllowlist(f.chrome, ["a.example"]);
  assert.deepEqual(r, { rules: 1, closed: 1, refused: 0 });
});

// I1 (measured live: a removed host's service worker answered a link to it,
// past DNR): every service worker goes whenever the list loses an entry.
test("a shrinking list removes every service worker before the tabs close; a growing one does not", async () => {
  const f = makeFakeChrome();
  f.setTabs([{ id: 1, windowId: 1, url: "https://a.example/" }, { id: 2, windowId: 1, url: "https://c.example/" }]);
  const removals = () => f.callsTo("browsingData.remove");
  // The first call after a worker start counts as a shrink.
  await applyAllowlist(f.chrome, ["a.example", "b.example"]);
  assert.deepEqual(removals(), [[{}, { serviceWorkers: true }]]);
  const order = f.calls.map(([p]) => p).filter((p) => ["declarativeNetRequest.updateDynamicRules", "browsingData.remove", "tabs.remove"].includes(p));
  assert.deepEqual(order, ["declarativeNetRequest.updateDynamicRules", "browsingData.remove", "tabs.remove"]);
  // Same list, a longer list: no removal.
  await applyAllowlist(f.chrome, ["a.example", "b.example"]);
  await applyAllowlist(f.chrome, ["a.example", "b.example", "d.example"]);
  assert.equal(removals().length, 1);
  // An entry gone (also one replaced by a wider entry, or by an invalid one): removal.
  await applyAllowlist(f.chrome, ["a.example", "d.example"]);
  assert.equal(removals().length, 2);
  await applyAllowlist(f.chrome, ["a.example", "d.example", "BAD"]);
  assert.equal(removals().length, 2);
  await applyAllowlist(f.chrome, ["example", "a.example"]);
  assert.equal(removals().length, 3);
  // Another worker start (another chrome object) starts with a removal again.
  const g = makeFakeChrome();
  await applyAllowlist(g.chrome, ["a.example"]);
  assert.equal(g.callsTo("browsingData.remove").length, 1);
});

test("a failed service worker removal still closes the tabs, fails the call, and is tried again", async () => {
  const f = makeFakeChrome();
  f.setTabs([{ id: 1, windowId: 1, url: "https://a.example/" }, { id: 2, windowId: 1, url: "https://c.example/" }]);
  f.impl["browsingData.remove"] = async () => { throw new Error("no"); };
  await assert.rejects(applyAllowlist(f.chrome, ["a.example"]), (e) => e.message === "service worker removal failed");
  assert.deepEqual(f.callsTo("tabs.remove").map((a) => a[0]), [2]);
  assert.equal(f.callsTo("declarativeNetRequest.updateDynamicRules").length, 1);
  // The next call, even one that only grows the list, removes again.
  delete f.impl["browsingData.remove"];
  const r = await applyAllowlist(f.chrome, ["a.example", "b.example"]);
  assert.equal(f.callsTo("browsingData.remove").length, 2);
  assert.equal(r.rules, 1);
  await applyAllowlist(f.chrome, ["a.example", "b.example", "e.example"]);
  assert.equal(f.callsTo("browsingData.remove").length, 2);
});
