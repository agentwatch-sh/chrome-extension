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
  assert.deepEqual(r, { rules: 1, closed: 2 });
  const [args] = f.callsTo("declarativeNetRequest.updateDynamicRules");
  assert.deepEqual(args[0].removeRuleIds, [2]);
  assert.equal(args[0].addRules.length, 1);
  assert.deepEqual(f.callsTo("tabs.remove").map((a) => a[0]).sort(), [3, 5]);
  assert.equal(f.callsTo("tabs.create").length, 0);
});

test("an empty list adds no rule", async () => {
  const f = makeFakeChrome();
  const r = await applyAllowlist(f.chrome, []);
  assert.deepEqual(r, { rules: 0, closed: 0 });
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
  assert.deepEqual(r, { rules: 1, closed: 2 });
  assert.deepEqual(f.callsTo("tabs.create"), [[{ windowId: 7, url: "about:blank", active: false }]]);
  const order = f.calls.map(([p]) => p);
  assert.ok(order.indexOf("tabs.create") < order.indexOf("tabs.remove"));
});

test("chrome:// tabs are never touched, even alone in a window", async () => {
  const f = makeFakeChrome();
  f.setTabs([{ id: 1, windowId: 1, url: "chrome://newtab/" }]);
  const r = await applyAllowlist(f.chrome, ["a.example"]);
  assert.deepEqual(r, { rules: 1, closed: 0 });
  assert.equal(f.callsTo("tabs.remove").length, 0);
});

test("an invalid or non-normalized entry rejects the request without an echo", async () => {
  for (const bad of ["EVIL.example", "https://x.example", "nodot", 5]) {
    const f = makeFakeChrome();
    await assert.rejects(applyAllowlist(f.chrome, ["a.example", bad]), (e) => {
      assert.equal(e.message, "invalid allowlist entry");
      return true;
    });
    assert.equal(f.callsTo("declarativeNetRequest.updateDynamicRules").length, 0);
  }
  await assert.rejects(applyAllowlist(makeFakeChrome().chrome, "a.example"), /invalid allowlist entry/);
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
  assert.deepEqual(r, { rules: 1, closed: 1 });
});
