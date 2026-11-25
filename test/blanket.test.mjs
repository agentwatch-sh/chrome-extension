// The blanket profile in the receiver (board ab-4wh.2; C4, "The blanket profile"): the hello's feature blanket, a
// local scope's value "*" in a blanket-shaped set_scopes (the public host class, minus the names of "exclude"), its
// rules (two allow rules and a block rule of the excluded names), the guard, the closing rule and the worker
// removal's shrink. The receiver of the blanket Chrome never needs to know its profile: only the service sends "*",
// and only on the blanket Chrome's link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FEATURES } from "../agent/link.js";
import * as scopes from "../agent/scopes.js";
import * as dnr from "../agent/dnr.js";
import { flush, startReceiver } from "./receiver-harness.mjs";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const H = read("./vectors/hello.json");
const S = read("./vectors/scopes.json");
const noFloor = (rules) => rules.filter((r) => r.id !== 9 && r.id !== 89);
const STAR = { lists: {}, scopes: { "web-blanket": "*" }, default: null, operator: null };
const BOX = ["box.example.net", "box"];
const STAR_BOX = { ...STAR, exclude: BOX };
const NOT_BASE = ["localhost", "local", "internal", "home.arpa", "localdomain"];

test("the hello names the feature blanket, as hello.json does", () => {
  assert.ok(FEATURES.includes("blanket"), "FEATURES has blanket");
  assert.deepEqual([...FEATURES], H.hello.features);
});

// The public host class (C4): a name of two labels or more, each label of [a-z0-9_-], whose last label holds a letter
// or "_" (no IP literal); not localhost, local, internal, home.arpa or localdomain, or a name under one of them; and
// not a name of the set_scopes field exclude, or a name under one of them.
const PUBLIC = ["example.com", "a.b.example.com", "xn--80ak6aa92e.com", "example.com.", "my-site.co.uk", "10.0.0.1.example.com", "localhost.example.com", "a_b.example.com", "box.example.org", "notbox.example.net"];
const NOT_PUBLIC = ["127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]", "[fe80::1]", "localhost", "localhost.", "a.localhost", "foo.localhost.", "intranet", "printer.local", "x.local.", "db.internal", "a.internal.", "home.arpa", "router.home.arpa", "b.home.arpa.", "localhost.localdomain", "x.localdomain.", "", "1.2.3", "ex%61mple.com", "a..b.com"];
const EXCLUDED = ["box.example.net", "a.box.example.net", "a.box.example.net.", "box"];

test("isPublicHost gives the public host class of C4, with the names of exclude", () => {
  assert.equal(typeof scopes.isPublicHost, "function", "scopes.js has isPublicHost");
  assert.deepEqual([...scopes.PUBLIC_NOT], NOT_BASE);
  for (const h of PUBLIC) assert.equal(scopes.isPublicHost(h, BOX), true, h);
  for (const h of [...NOT_PUBLIC, ...EXCLUDED]) assert.equal(scopes.isPublicHost(h, BOX), false, JSON.stringify(h));
  assert.equal(scopes.isPublicHost("a.box.example.net"), true, "with no exclude the box's name is of the class");
  for (const x of [null, undefined, 1, ["example.com"]]) assert.equal(scopes.isPublicHost(x), false, String(x));
});

test("the public rules match the same class as isPublicHost, for each URL form that Chrome gives, also when DNR would not strip a trailing dot", () => {
  assert.equal(typeof dnr.PUBLIC_HOST_FILTER, "string", "dnr.js has PUBLIC_HOST_FILTER");
  const [main, , block] = dnr.publicRules(100, [7], BOX);
  const allowRe = new RegExp(main.condition.regexFilter, "i");
  const blockRe = new RegExp(block.condition.regexFilter, "i");
  const inDomains = (host, list) => list.some((d) => host === d || host.endsWith("." + d));
  const urls = [
    ...PUBLIC.map((h) => `https://${h}/`), ...PUBLIC.map((h) => `http://${h}:8080/path?q=1`),
    ...[...NOT_PUBLIC, ...EXCLUDED].filter((h) => h !== "" && h !== "a..b.com").map((h) => `https://${h}/`),
    "http://0x7f.1/", "http://2130706433/", "http://127.1/", "http://[::1]:8080/", "http://public.example@127.0.0.1/",
    "https://user:pw@example.com/", "https://a.localhost:pw@example.com/", "ftp://example.com/", "https://[::ffff:7f00:1]/",
    "http://x.localdomain:631/", "https://box.example.net:8443/",
  ];
  for (const raw of urls) {
    const u = new URL(raw);
    const want = (u.protocol === "http:" || u.protocol === "https:") && scopes.isPublicHost(u.hostname, BOX);
    // DNR may or may not strip a trailing dot before excludedRequestDomains: the block rule decides both ways.
    for (const host of [u.hostname, u.hostname.replace(/\.$/, "")]) {
      const allowed = allowRe.test(u.href) && !inDomains(host, main.condition.excludedRequestDomains) && !blockRe.test(u.href);
      assert.equal(allowed, want, `${raw} (${u.href}), host read as ${host}`);
    }
  }
  assert.ok(main.condition.regexFilter.length < 2048 && block.condition.regexFilter.length < 2048, "under Chrome's regex size limit");
});

test("publicRules: two allow rules (priority 2) and a block rule of the excluded names (priority 3, every resource type), in the tabs of the scope", () => {
  const [main, frames, block] = dnr.publicRules(100, [7, 8], BOX);
  const domains = [...NOT_BASE, ...BOX];
  assert.deepEqual(main, { id: 100, priority: 2, action: { type: "allow" }, condition: { regexFilter: dnr.PUBLIC_HOST_FILTER, excludedRequestDomains: domains, resourceTypes: ["main_frame"], tabIds: [7, 8] } });
  assert.deepEqual(frames, { id: 101, priority: 2, action: { type: "allow" }, condition: { regexFilter: dnr.PUBLIC_HOST_FILTER, excludedRequestDomains: domains, resourceTypes: ["sub_frame", "object"], tabIds: [7, 8] } });
  assert.equal(block.id, dnr.PUBLIC_BLOCK_RULE_ID);
  assert.equal(dnr.PUBLIC_BLOCK_RULE_ID, 91);
  assert.equal(block.priority, 3);
  assert.deepEqual(block.action, { type: "block" });
  assert.deepEqual(block.condition.tabIds, [7, 8]);
  assert.ok(block.condition.resourceTypes.includes("main_frame") && block.condition.resourceTypes.includes("websocket") && block.condition.resourceTypes.includes("xmlhttprequest"));
  assert.equal(block.condition.regexFilter, dnr.publicBlockFilter(BOX));
});

test("a \"*\" applies only in a blanket-shaped set_scopes (no list, no default, no operator, one scope) and with a good exclude; else it applies as null and counts", () => {
  const set = scopes.parseScopes(STAR_BOX);
  assert.equal(set.refused, 0);
  assert.equal(set.listOf("web-blanket"), "*");
  assert.ok(scopes.isPublicList(set.entriesOf("web-blanket")));
  assert.deepEqual([...set.exclude], BOX);
  assert.equal(set.listOf("web-other"), null);
  assert.deepEqual([...scopes.parseScopes(STAR).exclude], [], "no exclude: none");
  const refusedStar = (msg, why) => {
    const s = scopes.parseScopes(msg);
    const scope = Object.keys(msg.scopes).find((k) => msg.scopes[k] === "*");
    assert.equal(s.listOf(scope), null, `${why}: the * applies as null`);
    assert.equal(s.scopes[scope], null, why);
    return s.refused;
  };
  assert.equal(refusedStar({ lists: { md: ["a.example"] }, scopes: { "web-blanket": "*" }, default: null, operator: null }, "a list"), 1);
  assert.equal(refusedStar({ lists: {}, scopes: { "web-blanket": "*", "md-lead": null }, default: null, operator: null }, "two scopes"), 1);
  assert.equal(refusedStar({ lists: {}, scopes: { "web-blanket": "*" }, default: null, operator: "*" }, "the operator's *"), 1);
  assert.equal(refusedStar({ lists: {}, scopes: { "web-blanket": "*" }, default: "md", operator: null }, "a default"), 1);
  assert.equal(refusedStar({ lists: {}, scopes: { "web-blanket": "*" }, operator: null }, "no default"), 2, "the missing default counts too");
  assert.equal(refusedStar({ lists: {}, scopes: { "linux/web-1": "*" }, default: null, operator: null }, "a remote scope"), 1);
  for (const bad of ["box.example.net", [1], ["Box.example.net"], ["box.example.net."], ["127.0.0.1"], ["a b"], [""], Array(9).fill("a.example"), ["x".repeat(64) + ".example"]]) {
    assert.equal(refusedStar({ ...STAR, exclude: bad }, `exclude ${JSON.stringify(bad).slice(0, 40)}`), 1);
  }
  assert.equal(scopes.parseScopes({ lists: {}, scopes: { "md-lead": null }, default: null, exclude: "bad" }).refused, 0, "an object with no * ignores exclude");
  assert.ok(S.cases.some((c) => c.in.scopes?.["web-blanket"] === "*" && Array.isArray(c.in.exclude)), "scopes.json has the blanket Chrome's set_scopes with exclude");
});

test("listCovers: a \"*\" scope's list covers the public class minus exclude; the operator's \"*\" covers every host", () => {
  const list = scopes.parseScopes(STAR_BOX).entriesOf("web-blanket");
  for (const h of PUBLIC) assert.equal(scopes.listCovers(list, h), true, h);
  for (const h of [...NOT_PUBLIC, ...EXCLUDED]) assert.equal(scopes.listCovers(list, h), false, h);
  assert.equal(scopes.listCovers(scopes.ANY, "127.0.0.1"), true, "the operator's *");
  assert.equal(scopes.listCovers(null, "example.com"), false);
  assert.equal(scopes.listCovers(["example.com"], "a.example.com"), true);
});

test("the worker removal's shrink: \"*\" to a list shrinks, \"*\" to \"*\" does not, a list to \"*\" only for a host outside the class, a new exclude name shrinks", () => {
  const star = scopes.parseScopes(STAR);
  const list = scopes.parseScopes({ lists: { md: ["a.example"] }, scopes: { "web-blanket": "md" }, default: null });
  const local = scopes.parseScopes({ lists: { md: ["printer.local"] }, scopes: { "web-blanket": "md" }, default: null });
  const boxList = scopes.parseScopes({ lists: { md: ["a.box.example.net"] }, scopes: { "web-blanket": "md" }, default: null });
  assert.equal(scopes.shrinks(star, list), true);
  assert.equal(scopes.shrinks(star, scopes.parseScopes(STAR)), false);
  assert.equal(scopes.shrinks(list, star), false, "a.example is of the class");
  assert.equal(scopes.shrinks(local, star), true, "printer.local is not");
  assert.equal(scopes.shrinks(star, scopes.parseScopes(STAR_BOX)), true, "exclude gained names");
  assert.equal(scopes.shrinks(scopes.parseScopes(STAR_BOX), star), false, "exclude lost names");
  assert.equal(scopes.shrinks(boxList, scopes.parseScopes(STAR_BOX)), true, "a list's host that exclude takes out");
});

const ids = (s) => noFloor(s.f.sessionRules_).map((r) => r.id).sort((a, b) => a - b);

test("set_scopes with \"*\": the scope's tabs get the public rules (the answer counts three), a new tab joins them, and the last tab's close removes all three", async () => {
  const s = await startReceiver({
    tabs: [{ id: 7, windowId: 1, url: "about:blank" }, { id: 8, windowId: 1, url: "about:blank" }, { id: 3, windowId: 1, url: "about:blank" }],
    copy: { "tab:7": "web-blanket", "tab:8": "web-blanket" },
  });
  const res = await s.set(STAR_BOX);
  assert.deepEqual(res, { rules: 3, closed: 0, refused: 0 });
  assert.deepEqual(noFloor(s.f.sessionRules_), dnr.publicRules(100, [7, 8], BOX));
  assert.ok(!noFloor(s.f.sessionRules_).some((r) => r.id === dnr.MARKED_RULE_ID), "no rule 8");
  const tab = await s.answer({ id: "c1", op: "tabs.create", args: [{ url: "about:blank" }, "web-blanket"] });
  assert.equal(tab.ok, true);
  await flush();
  assert.deepEqual(noFloor(s.f.sessionRules_), dnr.publicRules(100, [7, 8, tab.data.id], BOX));
  for (const id of [7, 8, tab.data.id]) {
    s.f.tabs_ = s.f.tabs_.filter((t) => t.id !== id);
    s.f.chrome.tabs.onRemoved.fire(id, { windowId: 1, isWindowClosing: false });
    await flush();
    if (id === 7) assert.deepEqual(noFloor(s.f.sessionRules_), dnr.publicRules(100, [8, tab.data.id], BOX), "a tab's close leaves the others in the three rules");
  }
  assert.deepEqual(ids(s), [], "the last tab's close removes the two allow rules and the block rule");
});

test("set_scopes from \"*\" to a list, and from \"*\" to null: the public rules go with the block rule, and a tab with no list closes", async () => {
  const s = await startReceiver({
    tabs: [{ id: 7, windowId: 1, url: "https://a.example/" }, { id: 3, windowId: 1, url: "about:blank" }],
    copy: { "tab:7": "web-blanket" },
  });
  await s.set(STAR_BOX);
  assert.deepEqual(ids(s), [100, 101, 91].sort((a, b) => a - b));
  const res = await s.set({ lists: { md: ["a.example"] }, scopes: { "web-blanket": "md" }, default: null, operator: null });
  assert.equal(res.rules, 2);
  assert.deepEqual(noFloor(s.f.sessionRules_), dnr.scopeRules(100, ["a.example"], [7]), "\"*\" to a list: the list's pair, no block rule");
  await s.set(STAR);
  assert.deepEqual(ids(s), [91, 100, 101]);
  const gone = await s.set({ lists: {}, scopes: { "web-blanket": null }, default: null, operator: null });
  assert.equal(gone.closed, 1, "\"*\" to null: the tab closes at the sweep");
  assert.deepEqual(ids(s), [], "no public rule and no block rule");
});

test("a mix with the operator's \"*\" and a remote \"*\" tab: the \"*\" applies as null (M6), so the scope's tab closes", async () => {
  const s = await startReceiver({
    tabs: [{ id: 7, windowId: 1, url: "about:blank" }, { id: 8, windowId: 1, url: "about:blank" }, { id: 3, windowId: 1, url: "about:blank" }],
    copy: { "tab:7": "web-blanket", "tab:8": "linux/web-1" },
  });
  const mix = await s.set({ lists: { md: ["a.example"] }, scopes: { "md-lead": "md", "web-blanket": "*", "linux/web-1": "*" }, default: null, operator: "*" });
  assert.equal(mix.refused, 2, "both * count");
  assert.equal(mix.closed, 2, "both tabs close at the sweep");
  assert.ok(!ids(s).includes(dnr.PUBLIC_BLOCK_RULE_ID), "no block rule");
});

test("the guard and the closing rule judge a \"*\" scope's tab by the public class minus exclude", async () => {
  const s = await startReceiver({
    tabs: [
      { id: 7, windowId: 1, url: "https://example.com/" }, { id: 8, windowId: 1, url: "http://10.0.0.1/" },
      { id: 9, windowId: 1, url: "http://app.localhost:3000/" }, { id: 10, windowId: 1, url: "http://box.example.net/" },
      { id: 11, windowId: 1, url: "http://localhost.localdomain/" },
    ],
    copy: { "tab:7": "web-blanket", "tab:8": "web-blanket", "tab:9": "web-blanket", "tab:10": "web-blanket", "tab:11": "web-blanket" },
  });
  const res = await s.set(STAR_BOX);
  assert.equal(res.closed, 4, "the closing rule closes the tabs on a private address, a local name, the box's name and localdomain");
  assert.deepEqual(s.f.tabs_.map((t) => t.id), [7]);
  assert.equal(s.r.guard.covered(7, "example.org"), true);
  for (const h of ["127.0.0.1", "a.localhost", "intranet", "nas.local", "db.internal", "router.home.arpa", "x.localdomain", "box.example.net", "a.box.example.net"]) {
    assert.equal(s.r.guard.covered(7, h), false, h);
  }
});
