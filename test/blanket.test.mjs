// The blanket profile in the receiver (board ab-4wh.2; C4, "The blanket profile"): the hello's feature blanket, a
// local scope's value "*" in set_scopes (the public host class), its two scope rules, the guard, the closing rule and
// the worker removal's shrink. The receiver of the blanket Chrome never needs to know its profile: only the service
// sends "*", and only on the blanket Chrome's link.
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

test("the hello names the feature blanket, as hello.json does", () => {
  assert.ok(FEATURES.includes("blanket"), "FEATURES has blanket");
  assert.deepEqual([...FEATURES], H.hello.features);
});

// The public host class (C4): a name of two labels or more that is no IP literal, not localhost or a name under it,
// and not local, internal or home.arpa or a name under one of them.
const PUBLIC = ["example.com", "a.b.example.com", "xn--80ak6aa92e.com", "example.com.", "my-site.co.uk", "10.0.0.1.example.com", "localhost.example.com", "a_b.example.com"];
const NOT_PUBLIC = ["127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]", "[fe80::1]", "localhost", "a.localhost", "intranet", "printer.local", "db.internal", "home.arpa", "router.home.arpa", "", "1.2.3"];

test("isPublicHost gives the public host class of C4", () => {
  assert.equal(typeof scopes.isPublicHost, "function", "scopes.js has isPublicHost");
  for (const h of PUBLIC) assert.equal(scopes.isPublicHost(h), true, h);
  for (const h of NOT_PUBLIC) assert.equal(scopes.isPublicHost(h), false, JSON.stringify(h));
  for (const x of [null, undefined, 1, ["example.com"]]) assert.equal(scopes.isPublicHost(x), false, String(x));
});

test("the public rules' regexFilter and excluded domains match the same class as isPublicHost, for each URL form that Chrome gives", () => {
  assert.equal(typeof dnr.PUBLIC_HOST_FILTER, "string", "dnr.js has PUBLIC_HOST_FILTER");
  const re = new RegExp(dnr.PUBLIC_HOST_FILTER, "i");
  const excluded = (host) => dnr.PUBLIC_NOT.some((d) => host === d || host.endsWith("." + d));
  const urls = [
    ...PUBLIC.map((h) => `https://${h}/`), ...PUBLIC.map((h) => `http://${h}:8080/path?q=1`),
    ...NOT_PUBLIC.filter((h) => h !== "").map((h) => `https://${h}/`), "http://0x7f.1/", "http://2130706433/", "http://127.1/",
    "https://user:pw@example.com/", "https://a.localhost:pw@example.com/", "ftp://example.com/", "https://[::ffff:7f00:1]/",
  ];
  for (const raw of urls) {
    const u = new URL(raw);
    const rule = re.test(u.href) && !excluded(u.hostname.replace(/\.$/, ""));
    assert.equal(rule, (u.protocol === "http:" || u.protocol === "https:") && scopes.isPublicHost(u.hostname), `${raw} (${u.href})`);
  }
  assert.ok(dnr.PUBLIC_HOST_FILTER.length < 2048, "under Chrome's regex size limit");
});

test("a local scope's \"*\" applies by C4 (scopes.json): its list is \"*\", and its entries are the public class", () => {
  const set = scopes.parseScopes(STAR);
  assert.equal(set.refused, 0);
  assert.equal(set.listOf("web-blanket"), "*");
  assert.equal(set.entriesOf("web-blanket"), scopes.PUBLIC_LIST);
  assert.equal(set.listOf("web-other"), null);
  const remote = scopes.parseScopes({ lists: {}, scopes: { "linux/web-1": "*" }, default: null });
  assert.equal(remote.refused, 1, "a remote scope's * counts");
  assert.equal(remote.listOf("linux/web-1"), null, "and applies as null");
  assert.ok(S.cases.some((c) => c.in.scopes?.["web-blanket"] === "*"), "scopes.json has the blanket Chrome's set_scopes");
});

test("listCovers: \"*\" of a scope covers the public class only; the operator's \"*\" covers every host", () => {
  const set = scopes.parseScopes(STAR);
  const list = set.entriesOf("web-blanket");
  for (const h of PUBLIC) assert.equal(scopes.listCovers(list, h), true, h);
  for (const h of NOT_PUBLIC) assert.equal(scopes.listCovers(list, h), false, h);
  assert.equal(scopes.listCovers(scopes.ANY, "127.0.0.1"), true, "the operator's *");
  assert.equal(scopes.listCovers(null, "example.com"), false);
  assert.equal(scopes.listCovers(["example.com"], "a.example.com"), true);
});

test("the worker removal's shrink: from \"*\" to a list shrinks, \"*\" to \"*\" does not, a list to \"*\" shrinks only for a host outside the class", () => {
  const star = scopes.parseScopes(STAR);
  const list = scopes.parseScopes({ lists: { md: ["a.example"] }, scopes: { "web-blanket": "md" }, default: null });
  const local = scopes.parseScopes({ lists: { md: ["printer.local"] }, scopes: { "web-blanket": "md" }, default: null });
  assert.equal(scopes.shrinks(star, list), true);
  assert.equal(scopes.shrinks(star, scopes.parseScopes(STAR)), false);
  assert.equal(scopes.shrinks(list, star), false, "a.example is of the class");
  assert.equal(scopes.shrinks(local, star), true, "printer.local is not");
});

test("set_scopes with \"*\": the scope's tabs get the two public rules (main frames, and frames and object documents), and the answer counts them", async () => {
  assert.equal(typeof dnr.publicRules, "function", "dnr.js has publicRules");
  const s = await startReceiver({
    tabs: [{ id: 7, windowId: 1, url: "about:blank" }, { id: 8, windowId: 1, url: "about:blank" }],
    copy: { "tab:7": "web-blanket", "tab:8": "web-blanket" },
  });
  const res = await s.set(STAR);
  assert.deepEqual(res, { rules: 2, closed: 0, refused: 0 });
  assert.deepEqual(noFloor(s.f.sessionRules_), dnr.publicRules(100, [7, 8]));
  const [main, frames] = dnr.publicRules(100, [7, 8]);
  assert.deepEqual(main, { id: 100, priority: 2, action: { type: "allow" }, condition: { regexFilter: dnr.PUBLIC_HOST_FILTER, excludedRequestDomains: [...dnr.PUBLIC_NOT], resourceTypes: ["main_frame"], tabIds: [7, 8] } });
  assert.deepEqual(frames, { id: 101, priority: 2, action: { type: "allow" }, condition: { regexFilter: dnr.PUBLIC_HOST_FILTER, excludedRequestDomains: [...dnr.PUBLIC_NOT], resourceTypes: ["sub_frame", "object"], tabIds: [7, 8] } });
  assert.deepEqual([...dnr.PUBLIC_NOT], ["localhost", "local", "internal", "home.arpa"]);
  // A new tab of the scope joins the rules; the operator's "*" stays rule 8 apart.
  const tab = await s.answer({ id: "c1", op: "tabs.create", args: [{ url: "about:blank" }, "web-blanket"] });
  assert.equal(tab.ok, true);
  await flush();
  assert.deepEqual(noFloor(s.f.sessionRules_).find((r) => r.id === 100).condition.tabIds, [7, 8, tab.data.id]);
  assert.ok(!noFloor(s.f.sessionRules_).some((r) => r.id === dnr.MARKED_RULE_ID), "no rule 8");
});

test("the guard and the closing rule judge a \"*\" scope's tab by the public class", async () => {
  const s = await startReceiver({
    tabs: [{ id: 7, windowId: 1, url: "https://example.com/" }, { id: 8, windowId: 1, url: "http://10.0.0.1/" }, { id: 9, windowId: 1, url: "http://app.localhost:3000/" }],
    copy: { "tab:7": "web-blanket", "tab:8": "web-blanket", "tab:9": "web-blanket" },
  });
  const res = await s.set(STAR);
  assert.equal(res.closed, 2, "the closing rule closes the tabs on a private address and on a local name");
  assert.deepEqual(s.f.tabs_.map((t) => t.id), [7]);
  assert.equal(s.r.guard.covered(7, "example.org"), true);
  for (const h of ["127.0.0.1", "a.localhost", "intranet", "nas.local", "db.internal", "router.home.arpa"]) assert.equal(s.r.guard.covered(7, h), false, h);
});
