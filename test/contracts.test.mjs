// Contracts C4 (the allowlists and the hello), C10 (the bridge) and C11 (the
// endpoint): docs/protocol.md is the master, and test/vectors/bridge.json,
// endpoint.json, scopes.json and hello.json are its shared vectors. The
// receiver, the relay and the daemon check their code against the same
// vectors. These tests keep the vectors and the text in step; the small
// reference rules below follow the text, so a vector that breaks a rule fails
// here first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHANNELS, MAX_TO_DAEMON, PART_BYTES, ChannelJoiner, splitParts } from "../agent/wire.js";
import { NEW_TAB_WAIT_MS, RETRY_AFTER_MS, RETRY_START_MS, RULE_QUIET_MS } from "../agent/popups.js";
import { normalizeEntry } from "../shared/domains.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const protocol = read("docs/protocol.md");
const bridge = JSON.parse(read("test/vectors/bridge.json"));
const endpoint = JSON.parse(read("test/vectors/endpoint.json"));
const scopesV = JSON.parse(read("test/vectors/scopes.json"));
const helloV = JSON.parse(read("test/vectors/hello.json"));
const blockedV = JSON.parse(read("test/vectors/blocked.json"));

// The text of one contract: from its "### Cn." heading to the next "### ".
function section(name) {
  const start = protocol.indexOf(`\n### ${name}. `);
  assert.ok(start >= 0, `docs/protocol.md has a section ${name}`);
  const next = protocol.indexOf("\n### ", start + 1);
  return protocol.slice(start, next < 0 ? undefined : next);
}
const C4 = section("C4");
const C5 = section("C5");
const C10 = section("C10");
const C11 = section("C11");

// The rows of the Markdown table under a header line: first cell (a code span) -> the other cells.
function table(text, header) {
  const lines = text.split("\n");
  const at = lines.indexOf(header);
  assert.ok(at >= 0, `the table ${header}`);
  const rows = new Map();
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("| ")) break;
    const cells = line.slice(2, -2).split(" | ").map((c) => c.trim());
    const m = /^`([^`]+)`$/.exec(cells[0]);
    assert.ok(m, `the first cell is one code span: ${line}`);
    rows.set(m[1], cells.slice(1));
  }
  return rows;
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
// Whether a contract's text says s, whatever its line breaks.
const flat = (t) => t.replace(/\s+/g, " ");
const says = (text, s) => flat(text).includes(flat(s));

const opByName = new Map(bridge.ops.map((o) => [o.op, o]));
const evByName = new Map(bridge.events.map((e) => [e.ev, e]));
const K = bridge.constants;

// ---- C4: the allowlists (set_scopes) and the hello ----

// C4's rules for set_scopes. The relay applies the same rules to its allowlist line (C10, C11).
const NAME = new RegExp(scopesV.pattern);
// A valid name (C4): a string that matches the scope pattern. A field that must name a list and
// holds neither a valid name nor null (nor "*" for operator) counts 1 in refused and applies as null.
const validName = (v) => typeof v === "string" && NAME.test(v);
const normalized = (e) => {
  const r = normalizeEntry(e);
  return r.ok && r.entry === e;
};
function applySetScopes(msg) {
  let refused = 0;
  const lists = {};
  if (isObj(msg.lists)) {
    for (const [name, v] of Object.entries(msg.lists)) {
      if (!NAME.test(name) || !Array.isArray(v)) {
        refused += 1 + (Array.isArray(v) ? v.length : 0); // the list, and each of its entries
        continue;
      }
      const ok = v.filter(normalized);
      refused += v.length - ok.length;
      lists[name] = ok;
    }
  } else refused += 1;
  const scopes = {};
  if (isObj(msg.scopes)) {
    for (const [scope, v] of Object.entries(msg.scopes)) {
      if (!NAME.test(scope)) refused += 1; // applies as absent
      else if (!(v === null || validName(v))) {
        refused += 1;
        scopes[scope] = null; // no list, no fall-back to default
      } else scopes[scope] = v;
    }
  } else refused += 1;
  let def = null;
  if (validName(msg.default)) def = msg.default;
  else if (msg.default !== null) refused += 1; // also a missing default
  if (!isObj(msg.scopes)) def = null; // no scope gets default while the scopes are not known
  let operator = null;
  if (Object.hasOwn(msg, "operator") && msg.operator !== null) {
    const o = msg.operator;
    if (o === "*") operator = "*";
    else if (validName(o)) operator = Object.hasOwn(lists, o) ? o : null;
    else refused += 1;
  }
  // A scope's list: its scopes entry when it has one (no fall-back), else default.
  const listOf = (scope) => {
    const name = Object.hasOwn(scopes, scope) ? scopes[scope] : def;
    return name !== null && Object.hasOwn(lists, name) ? name : null;
  };
  return { lists, scopes, default: def, operator, refused, listOf };
}
// The relay's allowlist line (C11): C4's rules, the roots with --peer-check, and a line with a
// roots field that a relay without --peer-check applies as no line at all.
// An item of roots: an object with an integer pid from 2 and an integer start from 0, both at most
// 2^53 - 1 (Number.isSafeInteger); its other fields are ignored.
const isRoot = (r) => isObj(r) && Number.isSafeInteger(r.pid) && r.pid > 1 && Number.isSafeInteger(r.start) && r.start >= 0;
function applyLine(line, peerCheck) {
  if (!peerCheck && Object.hasOwn(line, "roots")) return { failClosed: true };
  const a = applySetScopes(line);
  let roots = null;
  if (peerCheck) {
    roots = {};
    if (isObj(line.roots)) {
      for (const [scope, list] of Object.entries(line.roots)) {
        if (NAME.test(scope) && Array.isArray(list)) roots[scope] = list.filter(isRoot).map(({ pid, start }) => ({ pid, start }));
      }
    }
  }
  return { ...a, roots };
}
const applied = (a) => ({ lists: a.lists, scopes: a.scopes, default: a.default, operator: a.operator });

test("C4 states the set_scopes request and answer, and the receiver's hello with features", () => {
  assert.ok(C4.includes('`{"t":"req","id":"<id>","op":"set_scopes","lists":{"<list>":["a.example"]},"scopes":{"<scope>":"<list>"},"default":"<list>"}`'));
  assert.ok(C4.includes('`{"rules":<scope rules in force>,"closed":<tabs closed>,"refused":<entries, list names and scopes refused>}`'));
  assert.ok(C4.includes("The daemon waits 10 s for `ping` and `set_scopes`"));
  assert.ok(C4.includes("`" + JSON.stringify({ ...helloV.hello, version: "<manifest version>" }) + "`"), "C4 shows the hello");
  assert.deepEqual(helloV.hello.features, ["scopes"]);
  assert.deepEqual(helloV.hello.channels, CHANNELS);
  assert.ok(C4.includes("`test/vectors/hello.json`") && C4.includes("`test/vectors/scopes.json`"), "C4 names the vectors");
});

test("the rollout: each side meets the other's old form and fails closed, with C4's texts", () => {
  for (const { hello } of helloV.oldHellos) assert.ok(!(hello.features ?? []).includes("scopes"), "an old receiver's hello names no scopes");
  const old = helloV.toOldReceiver;
  assert.deepEqual(old.req.domains, [], "an empty list: the old receiver blocks every site");
  assert.ok(C4.includes("`" + JSON.stringify({ ...old.req, id: "<id>" }) + "`"), "C4 shows the old request");
  assert.ok(C4.includes(`"${old.browserPage}"`), "C4 shows the Browser page text");
  const { req, res } = helloV.fromOldDaemon;
  assert.equal(req.op, "set_allowlist");
  assert.deepEqual(Object.keys(res).sort(), ["error", "id", "ok", "t"], "channel main: no ch");
  assert.equal(res.id, req.id);
  assert.equal(res.ok, false);
  assert.ok(C4.includes("`" + JSON.stringify({ ...res, id: "<id>" }) + "`"), "C4 shows the answer");
});

// ---- C4 and C5: blocked and the guard (part 1c, board ab-v16.33) ----

// The host that C5's guard judges: an http:/https: URL's, a blob: URL's inner origin's (when that is
// http:/https:); null for any other URL and for a blob: URL of an opaque origin.
function guardHostOf(url) {
  let m = /^blob:(.*)$/.exec(url);
  const raw = m ? m[1] : url;
  m = /^(https?):\/\/([^/:?#]+)(:[0-9]+)?([/?#]|$)/.exec(raw);
  return m ? m[2].toLowerCase() : null;
}
// C5's covered set of the vector's tab, by the last set_scopes (null: none since the worker's start):
// "*" (every host), a list of entries, or null (no host).
function coveredSet(v) {
  if (v.tab.restore) return [v.tab.restore]; // the restore tab of a running import: its domain only
  if (v.in === null || v.tab.orphan) return null;
  const a = applySetScopes(v.in);
  if (v.tab.scope) {
    const name = a.listOf(v.tab.scope);
    return name === null ? null : a.lists[name];
  }
  if (v.tab.marked) return a.operator === "*" ? "*" : a.operator === null ? null : a.lists[a.operator];
  return [...new Set(Object.values(a.lists).flat())]; // a tab of no scope: the union of the lists
}
const coversHost = (entry, host) => host === entry || host.endsWith("." + entry);

test("each guard vector follows C5's guard: the host that it judges and the covered set of its tab", () => {
  const kinds = new Set();
  for (const v of blockedV.guard) {
    const keys = Object.keys(v.tab);
    assert.ok(keys.length <= 1 && keys.every((k) => ["scope", "marked", "orphan", "restore"].includes(k)), `${v.note}: one kind of tab`);
    kinds.add(keys[0] ?? "none");
    if (v.tab.scope) assert.ok(NAME.test(v.tab.scope), v.note);
    if (v.tab.restore) assert.equal(normalizeEntry(v.tab.restore).entry, v.tab.restore, v.note);
    const host = guardHostOf(v.url);
    assert.equal(host, v.host, `${v.note}: the host`);
    const set = coveredSet(v);
    const blocks = host !== null && !(set === "*" || (set !== null && set.some((e) => coversHost(e, host))));
    assert.equal(blocks, v.blocks, v.note);
  }
  assert.deepEqual([...kinds].sort(), ["marked", "none", "orphan", "restore", "scope"], "every kind of tab");
  const has = (f) => blockedV.guard.some(f);
  assert.ok(has((v) => v.url.startsWith("blob:") && v.blocks), "a blob: URL of another site");
  assert.ok(has((v) => v.url.startsWith("blob:null/") && v.host === null), "an opaque blob:");
  assert.ok(has((v) => v.tab.marked && v.in?.operator === "*" && !v.blocks), "a marked tab with *");
  assert.ok(has((v) => v.tab.marked && typeof v.in?.operator === "string" && v.in.operator !== "*" && v.blocks), "a marked tab with a list name");
  assert.ok(has((v) => v.tab.marked && v.in && !Object.hasOwn(v.in, "operator") && v.host !== null && v.blocks), "a marked tab with no operator value");
  assert.ok(has((v) => v.tab.orphan && v.blocks && coveredSet({ ...v, tab: {} }).some((e) => coversHost(e, v.host))), "the orphan set: no host, also one on the union");
  assert.ok(has((v) => v.tab.restore && v.in?.operator === "*" && v.blocks), "the restore tab: its domain only");
  assert.ok(has((v) => v.in && !isObj(v.in.scopes) && v.tab.scope && v.blocks), "a set_scopes that is not applied fails closed for a scope's tab");
  assert.ok(has((v) => v.in === null && v.blocks), "before the first set_scopes");
  for (const s of [
    "The guard judges by the lists of the last `set_scopes`, as the scope rules do, not by the last applied one, as the closing rule does",
    "The host of a `blob:` URL is its inner origin's host. A `blob:` URL of an opaque origin (`blob:null/...`), and `about:`, `data:`, `chrome:` and `file:` URLs, have no host",
    "for the restore tab of a running import its `domain` only (rules 6 and 7), from its mark to the import's end",
    "`test/vectors/blocked.json`",
    // Part 1c's live test: the measures as built.
    "against a warm worker layer 2 did not win, also not for a page's own navigation",
    "its page ran in 0 of 80, and its request reached the site in 80 of 80",
    "Popups of a scope-A page to its own site",
    "Back restored that page from the cache (no request) in 3 of 3 runs, and the guard sent the tab to `about:blank`",
  ]) assert.ok(says(C5, s), `C5 says: ${s}`);
  assert.ok(!says(C5, "reports there (not measured)"), "the back/forward cache is measured now");
  // ab-lead's decisions on PR #23: Q1 from in C4, Q2 the closing rule and the import judge a blob: page by its inner origin, Q3 the fact.
  assert.ok(says(C4, "`from` is the host of the tab's last main-frame commit that C5's guard let stay, so a host that the guard sent away never becomes `from`"), "C4: from");
  assert.ok(says(C5, "closes every tab whose `http:`/`https:` host its list does not cover (a `blob:` page counts by its inner origin's host, as for the guard below"), "C5: the closing rule and blob:");
  assert.ok(says(section("C6"), "Close every tab whose origin equals `origin` (a `blob:` page by its inner origin"), "C6: the import's close and blob:");
  assert.ok(says(C5, "So in the own-page form the worker's page commits and runs its scripts before layer 3 sends it away (80 of 80)"), "C5: the fact of Q3");
  // The operator's decision on ab-7wg (2026-11-06): service workers stay on; C5 states it and its residue, and waits on no answer.
  assert.ok(says(C5, "The operator chose to keep service workers on (board item ab-7wg, 2026-11-06, the recommended option)"), "C5: the decision of ab-7wg");
  assert.ok(says(C5, "- The guard (service workers stay on: the operator chose the design's choice 2 a, board items ab-8zv and ab-7wg; the residue is below)"), "C5: the guard's heading");
  // review-27 notes 2 and 3 (board ab-v16.73): the own-page form as measured (from memory, no request), and the pass-on form of ab-8zv in the residue too.
  assert.ok(says(C5, "so the build stays as it is, with two residues. (1) The own-page form: a worker of another scope's site can answer a navigation of a scope's tab with its own page (no request); that page commits and runs its scripts for some tens of ms (the measures above) before layer 3 sends the tab away, and a client attached to the tab can read it meanwhile."), "C5: the residue of ab-7wg, the own-page form");
  assert.ok(says(C5, "(2) The pass-on form (board item ab-8zv): a worker that passes the navigation on sends its request to its site, with the site's cookies, and the site's answer comes back to the worker; its page did not run (0 of 80, below). Both scopes are the operator's own agents, and no site outside the lists is reached."), "C5: the residue of ab-7wg, the pass-on form");
  for (const s of ["asked the operator again", "this text changes when the answer changes the build", "can replace it with a block of service workers", "from its cache (no request)", "with this residue:"]) assert.ok(!says(C5, s), `C5 no longer says: ${s}`);
});

test("C4's blocked holds from (board ab-v16.33), each notice vector has C4's shape, and C5 states from and the once rule", () => {
  assert.ok(C4.includes('`{"t":"blocked","tab":<tab id>,"host":"<host>","scope":"<scope>","from":"<host>"}`'), "C4 shows blocked with from");
  assert.ok(says(C4, '`"scope":null` for a tab of no scope and `"from":null` for a tab with no listed host'));
  assert.ok(says(C4, "`test/vectors/blocked.json`"), "C4 names the vector");
  const host = (h) => typeof h === "string" && normalizeEntry(h).ok && normalizeEntry(h).entry === h;
  for (const { note, msg } of blockedV.notices) {
    assert.deepEqual(Object.keys(msg), ["t", "tab", "host", "scope", "from"], `${note}: the fields in C4's order`);
    assert.equal(msg.t, "blocked", note);
    assert.ok(Number.isInteger(msg.tab) && msg.tab >= 0, note);
    assert.ok(host(msg.host), `${note}: host`);
    assert.ok(msg.scope === null || NAME.test(msg.scope), `${note}: scope`);
    assert.ok(msg.from === null || host(msg.from), `${note}: from`);
  }
  assert.ok(blockedV.notices.some((n) => n.msg.scope === null && n.msg.from === null), "a notice with both null");
  assert.ok(blockedV.notices.some((n) => n.msg.scope !== null && n.msg.from !== null), "a notice with both");
  for (const s of [
    "`from` is the tab's **last listed host**: the host of its last main-frame commit of an `http:`/`https:` URL (or of a `blob:` URL with such an inner origin) that the guard let stay, so never a host that the guard sent away",
    "A new popup with no such commit takes its opener's (`sourceTabId`, at its `webNavigation.onCreatedNavigationTarget`)",
    "`from` does not say who started the blocked navigation",
    "`scope` is the tab's scope (C10) when the notice goes",
    "A navigation starts at a main-frame `onBeforeNavigate` whose URL is not `about:blank`, and lasts until the next one: a redirect stays in it, and the receiver's own `about:blank` starts none",
  ]) assert.ok(says(C5, s), `C5 says: ${s}`);
});

test("each set_scopes vector applies by C4's rules, with its count in refused", () => {
  assert.equal(scopesV.pattern, endpoint.scope.pattern, "list names and scopes share C11's pattern");
  assert.ok(C4.includes("`" + scopesV.pattern + "`"));
  const vectors = [...scopesV.cases, ...scopesV.raw.map((r) => ({ ...r, in: JSON.parse(r.json) }))];
  for (const v of vectors) {
    const a = applySetScopes(v.in);
    assert.deepEqual(applied(a), v.applies, v.note);
    assert.equal(a.refused, v.refused, `${v.note}: refused`);
    for (const [scope, list] of Object.entries(v.listOf ?? {})) assert.equal(a.listOf(scope), list, `${v.note}: the list of ${scope}`);
  }
  // Each rule of C4 has a vector.
  const has = (f) => scopesV.cases.some(f);
  const lists = (v) => (isObj(v.in.lists) ? v.in.lists : {});
  const scopes = (v) => (isObj(v.in.scopes) ? v.in.scopes : {});
  assert.ok(has((v) => Object.values(lists(v)).some((l) => Array.isArray(l) && l.some((e) => !normalized(e)))), "an entry that is not normalized");
  assert.ok(has((v) => Object.keys(lists(v)).some((n) => !NAME.test(n))), "a list name that does not match");
  assert.ok(has((v) => Object.values(lists(v)).some((l) => !Array.isArray(l))), "a list that is not an array");
  assert.ok(has((v) => Object.values(lists(v)).some((l) => Array.isArray(l) && l.length === 0)), "an empty list");
  assert.ok(has((v) => Object.values(scopes(v)).includes(null)), "a scope with null");
  assert.ok(has((v) => Object.entries(scopes(v)).some(([s, l]) => !NAME.test(s) || !(typeof l === "string" || l === null))), "a scope that applies as absent (a bad name) or as null (a bad value)");
  assert.ok(has((v) => Object.hasOwn(v.in, "lists") && !isObj(v.in.lists)), "lists that is not an object");
  assert.ok(has((v) => Object.hasOwn(v.in, "scopes") && !isObj(v.in.scopes)), "scopes that is not an object");
  assert.ok(has((v) => !Object.hasOwn(v.in, "default")), "a missing default");
  assert.ok(has((v) => Object.hasOwn(v.in, "default") && v.in.default !== null && typeof v.in.default !== "string"), "a bad default");
  assert.ok(has((v) => typeof v.in.default === "string" && !NAME.test(v.in.default)), "a default that is a string but not a valid name");
  assert.ok(has((v) => Object.entries(scopes(v)).some(([s, l]) => NAME.test(s) && l !== null && !validName(l))), "a scope value that is not a valid name");
  assert.ok(has((v) => Object.hasOwn(v.in, "scopes") && !isObj(v.in.scopes) && typeof v.in.default === "string" && v.applies.default === null), "scopes not an object: default applies as null");
  assert.ok(has((v) => [...Object.keys(lists(v)), ...Object.keys(scopes(v))].some((n) => n in Object.prototype)), "names that are properties of a JavaScript object");
  assert.ok(has((v) => typeof v.in.default === "string" && v.listOf && Object.values(v.listOf).includes(v.in.default)), "a scope that gets the default list");
  for (const o of ["*", null]) assert.ok(has((v) => Object.hasOwn(v.in, "operator") && v.in.operator === o), `the operator ${o}`);
  assert.ok(has((v) => typeof v.in.operator === "string" && NAME.test(v.in.operator) && v.applies.operator === null && v.refused === 0), "an operator name that is not in lists");
  assert.ok(has((v) => Object.hasOwn(v.in, "operator") && v.in.operator !== "*" && v.in.operator !== null && !(typeof v.in.operator === "string" && NAME.test(v.in.operator))), "a bad operator");
});

test("each allowlist line vector applies by C4's rules and C11's roots", () => {
  for (const v of scopesV.lines) {
    const a = applyLine(v.line, v.peerCheck);
    if (v.failClosed) {
      assert.deepEqual(a, { failClosed: true }, v.note);
      continue;
    }
    assert.equal(a.failClosed, undefined, v.note);
    assert.deepEqual(a.roots, v.roots, v.note);
  }
  const has = (f) => scopesV.lines.some(f);
  const items = (v) => (isObj(v.line.roots) ? Object.values(v.line.roots).filter(Array.isArray).flat() : []);
  assert.ok(has((v) => v.peerCheck && !Object.hasOwn(v.line, "roots")), "the peer check, a line with no roots field");
  assert.ok(has((v) => v.peerCheck && Object.hasOwn(v.line, "roots") && !isObj(v.line.roots)), "roots that is not an object");
  assert.ok(has((v) => v.peerCheck && isObj(v.line.roots) && Object.keys(v.line.roots).some((s) => !NAME.test(s))), "a scope that does not match");
  assert.ok(has((v) => v.peerCheck && isObj(v.line.roots) && Object.values(v.line.roots).some((l) => !Array.isArray(l))), "a value that is not a list");
  assert.ok(has((v) => v.peerCheck && items(v).some((r) => !isRoot(r))), "a bad item");
  for (const [name, f] of [["pid 1", (r) => r?.pid === 1], ["pid 2", (r) => r?.pid === 2 && isRoot(r)], ["start 0", (r) => r?.start === 0 && isRoot(r)], ["start -1", (r) => r?.start === -1],
    ["2^53 - 1", (r) => r?.start === Number.MAX_SAFE_INTEGER && isRoot(r)], ["2^53", (r) => r?.start === 2 ** 53 || r?.pid === 2 ** 53], ["a string pid", (r) => typeof r?.pid === "string"],
    ["a fraction", (r) => Number.isFinite(r?.start) && !Number.isInteger(r.start)], ["another field", (r) => isRoot(r) && Object.keys(r).length > 2]]) {
    assert.ok(has((v) => v.peerCheck && items(v).some(f)), `an item: ${name}`);
  }
  assert.ok(has((v) => !v.peerCheck && v.failClosed && v.line.roots === null), "a relay without --peer-check and roots null");
  assert.ok(has((v) => !v.peerCheck && v.failClosed && isObj(v.line.roots)), "a relay without --peer-check and a line with roots");
  assert.ok(has((v) => Object.hasOwn(v.line, "operator")), "the relay ignores the operator field");
});

// ---- C5: the list per scope ----

test("C5 holds the per-scope block: a tab's list, the scope rules, rules 6 to 8, and no rule 2 or 4", () => {
  for (const s of ["**tab's list**", "**scope rules**", "`updateSessionRules`", "session rule id 6", "session rule id 7", "session rule id 8", "Dynamic rules 2 and 4 are gone", "`MAX_NUMBER_OF_SESSION_RULES`"]) {
    assert.ok(C5.includes(s), `C5 says ${s}`);
  }
});

test("the per-scope rules are the contract in force: no target block and no set_allowlist rule is left", () => {
  assert.ok(!protocol.includes("Target (board ab-v16.23)"), "no target block");
  assert.ok(!/\bC(4|5|6|10|11)'s target\b/.test(protocol), "no reference to a target block");
  for (const [name, text] of [["C5", C5], ["C10", C10], ["C11", C11]]) assert.ok(!text.includes("set_allowlist"), `${name} names no set_allowlist`);
});

// ---- C10: the constants ----

test("C10 states each constant of the bridge vector with its value", () => {
  for (const [name, value] of Object.entries(K)) {
    assert.ok(C10.includes(`\`${name} = ${value}\``), `C10 has \`${name} = ${value}\``);
  }
});

test("the bridge vector's link constants are the receiver's, and the limits fit together", () => {
  assert.equal(K.MAX_TO_DAEMON, MAX_TO_DAEMON);
  assert.equal(K.PART_BYTES, PART_BYTES);
  assert.ok(CHANNELS.includes("bridge"));
  assert.ok(K.WAIT_DEFAULT_MS <= K.WAIT_MAX_MS);
  assert.ok(K.MAX_REQUEST > MAX_TO_DAEMON);
  assert.ok(K.MAX_BYTES_IN_FLIGHT >= K.MAX_REQUEST, "the largest request always fits when nothing is in flight");
  // A result part, base64 and its envelope, stays under the daemon's line limit.
  assert.ok(Math.ceil(K.RESULT_PART_BYTES / 3) * 4 + 256 < MAX_TO_DAEMON);
  assert.equal(K.MAX_RESULT % K.RESULT_PART_BYTES, 0);
  assert.ok(C10.includes(`n above ${K.MAX_RESULT / K.RESULT_PART_BYTES}`), "C10 names the largest part count");
});

test("C4 names the result parts and the limits of C10", () => {
  assert.ok(C4.includes("`MAX_BYTES_IN_FLIGHT`"));
  assert.ok(C4.includes("`MAX_RESULT`"));
  assert.ok(C4.includes('{"t":"part","ch":"bridge"'));
  assert.ok(!C4.includes("`MAX_IN_FLIGHT`"), "no global count of requests in flight");
});

// ---- C10: the ops and the events ----

test("C10's op table names exactly the ops of the vector, with the same args, result and default wait", () => {
  const rows = table(C10, "| Op | Args | Result | Default wait | What the receiver does |");
  assert.deepEqual([...rows.keys()].sort(), [...opByName.keys()].sort());
  for (const [name, cells] of rows) {
    const o = opByName.get(name);
    assert.equal(cells[0], "`[" + o.args.join(", ") + "]`", `${name}: args`);
    assert.equal(cells[1], o.result, `${name}: result`);
    assert.equal(cells[2], "`" + o.defaultWait + "`", `${name}: default wait`);
    // B1: every CDP command waits up to the largest wait by default; the chrome.* ops do not.
    assert.equal(o.defaultWait, name === "debugger.sendCommand" ? "WAIT_MAX_MS" : "WAIT_DEFAULT_MS", name);
  }
});

test("no op reads or writes cookies, the allowlist, the DNR rules or the import", () => {
  for (const name of opByName.keys()) {
    assert.ok(!/^(cookies|declarativeNetRequest|dnr|browsingData|scripting|storage)\./.test(name), name);
    assert.ok(!["import", "set_allowlist", "set_scopes", "ping"].includes(name), name);
  }
});

test("C10's event table names exactly the events of the vector, with the same fields", () => {
  const rows = table(C10, "| Event | Fields | When |");
  assert.deepEqual([...rows.keys()].sort(), [...evByName.keys()].sort());
  for (const [name, cells] of rows) {
    const spec = evByName.get(name);
    for (const f of [...spec.fields, ...spec.optional]) assert.ok(cells[0].includes(`"${f}"`), `${name}: field ${f}`);
  }
});

test("each op names only arg kinds that C10 defines; a name with ? is an optional last arg", () => {
  for (const kind of Object.keys(bridge.kinds)) assert.ok(C10.includes("`" + kind + "`"), `C10 defines the kind ${kind}`);
  for (const o of bridge.ops) {
    assert.ok(Number.isInteger(o.required) && o.required >= 0 && o.required <= o.args.length, o.op);
    for (const kind of o.kinds) assert.ok(Object.hasOwn(bridge.kinds, kind), `${o.op}: kind ${kind}`);
    assert.equal(o.kinds.length, o.args.length, o.op);
    o.args.forEach((a, i) => assert.equal(a.endsWith("?"), i >= o.required, `${o.op}: ${a}`));
  }
});

// The arg check that C10 states: the count, then the kind of each arg.
const int = (x) => Number.isInteger(x);
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
const covered = (host) => bridge.allowlist.some((d) => host === d || host.endsWith("." + d));
// A new tab or window opens at about:blank only (C10, each tab's scope).
const newUrl = (u) => u === "about:blank";
const SCOPE = new RegExp(endpoint.scope.pattern);
function patternFits(p) {
  const m = /^(\*|https?):\/\/(\*\.)?([a-z0-9.-]+)(:\d{1,5})?\/\*$/.exec(String(p));
  return m !== null && covered(m[3]);
}
function kindFits(kind, a) {
  switch (kind) {
    case "id": return int(a) && a >= 0;
    case "object": return isObj(a);
    case "string": return typeof a === "string" && a.length > 0;
    case "method": return typeof a === "string" && a.length > 0 && (!a.startsWith("Target.") || bridge.targetMethods.includes(a));
    case "boolean": return typeof a === "boolean";
    case "target":
      return isObj(a) && int(a.tabId) && a.tabId >= 0 && onlyKeys(a, ["tabId", "sessionId"]) &&
        (!Object.hasOwn(a, "sessionId") || (typeof a.sessionId === "string" && a.sessionId.length > 0));
    case "contentType": return bridge.contentTypes.includes(a);
    case "scope": return typeof a === "string" && SCOPE.test(a);
    case "newTab":
      return isObj(a) && onlyKeys(a, ["url", "active", "windowId", "index"]) && newUrl(a.url) &&
        (!Object.hasOwn(a, "active") || typeof a.active === "boolean") &&
        ["windowId", "index"].every((k) => !Object.hasOwn(a, k) || (int(a[k]) && a[k] >= 0));
    case "tabUpdate": return isObj(a) && onlyKeys(a, ["active"]) && typeof a.active === "boolean";
    case "newWindow":
      return isObj(a) && onlyKeys(a, ["url", "focused", "left", "top", "width", "height", "state"]) && newUrl(a.url) &&
        (!Object.hasOwn(a, "focused") || typeof a.focused === "boolean") &&
        ["left", "top", "width", "height"].every((k) => !Object.hasOwn(a, k) || int(a[k]));
    case "windowUpdate":
      return isObj(a) && Object.keys(a).length > 0 && onlyKeys(a, ["left", "top", "width", "height", "state", "focused"]) &&
        (!Object.hasOwn(a, "focused") || typeof a.focused === "boolean") &&
        ["left", "top", "width", "height"].every((k) => !Object.hasOwn(a, k) || int(a[k]));
    case "contentDetails":
      return isObj(a) && onlyKeys(a, ["primaryPattern", "setting"]) && ["allow", "block"].includes(a.setting) && patternFits(a.primaryPattern);
    default: return false;
  }
}
function argsFit(o, args) {
  if (!Array.isArray(args) || args.length < o.required || args.length > o.args.length) return false;
  return args.every((a, i) => kindFits(o.kinds[i], a));
}

const waitFits = (req) => !Object.hasOwn(req, "wait") || (int(req.wait) && req.wait >= 1 && req.wait <= K.WAIT_MAX_MS);

test("each request vector is a valid bridge request, and its res has the C10 shape", () => {
  assert.ok(bridge.requests.length >= opByName.size, "at least one request per op");
  const seen = new Set();
  for (const v of bridge.requests) {
    const { req, res } = v;
    assert.equal(req.t, "req");
    assert.ok(!Object.hasOwn(req, "ch"), "a request names no channel: its parts do (C4)");
    assert.equal(typeof req.id, "string");
    const o = opByName.get(req.op);
    assert.ok(o, `known op ${req.op}`);
    seen.add(req.op);
    assert.ok(argsFit(o, req.args ?? []), `${req.id}: args fit ${req.op}`);
    assert.ok(waitFits(req), `${req.id}: wait`);
    assert.deepEqual(Object.keys(res).sort(), ["ch", "data", "id", "ok", "t"]);
    assert.equal(res.t, "res");
    assert.equal(res.ch, "bridge");
    assert.equal(res.id, req.id);
    assert.equal(res.ok, true);
    assert.ok(res.data === null || typeof res.data === "object", `${req.id}: data is an object, a list or null`);
    if (o.result === "`null`") assert.equal(res.data, null, `${req.id}: ${req.op} answers null`);
    // The chrome call the receiver makes for it (null: the receiver's own op).
    if (req.op.startsWith("bridge.")) assert.equal(v.chrome, null);
    else if (req.op === "tabs.remove") {
      // The receiver's close of the per-scope build (C10, board ab-v16.41): Target.closeTarget through chrome.debugger.
      assert.deepEqual([v.chrome[0], v.chrome[1][0], v.chrome[1][1], Object.keys(v.chrome[1][2])], ["debugger.sendCommand", { tabId: req.args[0] }, "Target.closeTarget", ["targetId"]], `${req.id}: the receiver's close`);
    } else assert.ok(Array.isArray(v.chrome) && v.chrome[0].startsWith(req.op.split(".")[0] + "."), `${req.id}: chrome call`);
  }
  assert.deepEqual([...seen].sort(), [...opByName.keys()].sort(), "every op has a request vector");
  assert.ok(bridge.requests.some((v) => Object.keys(v.req).some((k) => !["t", "id", "op", "args", "wait"].includes(k))), "a vector with a field that the receiver ignores");
});

test("each bad request vector breaks one C10 rule and gets an error text of C10", () => {
  const kinds = new Set();
  for (const v of bridge.badRequests) {
    const { req, error } = v;
    assert.ok(C10.includes("`" + error + "`"), `C10 names the error \`${error}\``);
    assert.deepEqual(v.res, { t: "res", ch: "bridge", id: req.id, ok: false, error });
    const o = opByName.get(req.op);
    if (error === "unknown op") assert.equal(o, undefined, req.id);
    else if (error === "bad args") assert.ok(!argsFit(o, req.args ?? []), req.id);
    else if (error === "bad wait") assert.ok(argsFit(o, req.args ?? []) && !waitFits(req), req.id);
    else if (error === "no list for this scope") {
      // The scope check of tabs.create and windows.create (board ab-v16.41): the samples' last applied set_scopes gives the scope no list.
      assert.ok(["tabs.create", "windows.create"].includes(req.op), `${req.id}: only tabs.create and windows.create check the scope's list`);
      assert.ok(argsFit(o, req.args) && waitFits(req), `${req.id}: only the scope check fails`);
      assert.equal(applySetScopes(bridge.setScopes).listOf(req.args[1]), null, `${req.id}: the scope has no list`);
    } else assert.ok(argsFit(o, req.args ?? []) && waitFits(req), `${req.id}: only the tab check fails`);
    if (error === "not an agent tab") kinds.add(req.op);
  }
  // S4 and S6: the restore tab and the receiver's own pages are never bridge tabs.
  for (const op of ["debugger.attach", "debugger.detach", "tabs.update", "tabs.remove"]) assert.ok(kinds.has(op), `not an agent tab: ${op}`);
});

test("each event vector is a valid bridge event", () => {
  const seen = new Set();
  for (const v of bridge.eventVectors) {
    const { ev } = v;
    assert.equal(ev.t, "ev");
    assert.equal(ev.ch, "bridge");
    const spec = evByName.get(ev.ev);
    assert.ok(spec, `known event ${ev.ev}`);
    seen.add(ev.ev);
    for (const f of spec.fields) assert.ok(Object.hasOwn(ev, f), `${ev.ev}: field ${f}`);
    for (const k of Object.keys(ev)) assert.ok(["t", "ch", "ev", ...spec.fields, ...spec.optional].includes(k), `${ev.ev}: field ${k} is in C10`);
    if (v.chrome !== null) assert.equal(v.chrome[0], ev.ev, "the chrome event of the same name");
  }
  assert.deepEqual([...seen].sort(), [...evByName.keys()].sort(), "every event has a vector");
});

test("bridge.tooLarge names what the relay needs for its default action", () => {
  const big = bridge.eventVectors.filter((v) => v.ev.ev === "bridge.tooLarge").map((v) => v.ev);
  assert.ok(big.length >= 3);
  for (const ev of big) {
    if (ev.of === "debugger.onEvent") assert.equal(typeof ev.method, "string");
    if (/^Fetch\./.test(ev.method ?? "")) assert.equal(typeof ev.requestId, "string", "a Fetch event names its request");
  }
  for (const m of ["Fetch.requestPaused", "Fetch.authRequired", "Page.javascriptDialogOpening"]) {
    assert.ok(big.some((ev) => ev.method === m), `a vector for ${m}`);
    assert.ok(C10.includes("`" + m + "`"), `C10 names the default action for ${m}`);
  }
  assert.ok(big.some((ev) => typeof ev.sessionId === "string"), "a vector of a child session");
  // The action strings: the vector's note and C10 each carry them, not only the event names.
  const actions = {
    "Fetch.requestPaused": ["Fetch.continueRequest"],
    "Fetch.authRequired": ["Fetch.continueWithAuth", "CancelAuth"],
    "Page.javascriptDialogOpening": ["Page.handleJavaScriptDialog", "accept: false"],
  };
  const c10Actions = {
    "Fetch.requestPaused": ["`Fetch.continueRequest` with the `requestId`"],
    "Fetch.authRequired": ["`Fetch.continueWithAuth`", '{"response":"CancelAuth"}'],
    "Page.javascriptDialogOpening": ["`Page.handleJavaScriptDialog` with", '{"accept":false}'],
  };
  const notes = bridge.eventVectors.filter((v) => v.ev.ev === "bridge.tooLarge");
  for (const [m, strings] of Object.entries(actions)) {
    const v = notes.find((n) => n.ev.method === m);
    for (const str of strings) assert.ok(v.note.includes(str), `the vector note of ${m} names ${str}`);
    for (const str of c10Actions[m]) assert.ok(C10.includes(str), `C10 names ${str} for ${m}`);
  }
});

test("the result parts vector splits and joins as C4 parts do", () => {
  const v = bridge.resultParts;
  assert.equal(v.ch, "bridge");
  assert.ok(v.parts.length > 1);
  assert.deepEqual(splitParts(v.id, v.res, v.part_bytes, "bridge"), v.parts);
  const j = new ChannelJoiner();
  let out = null;
  for (const p of v.parts) out = j.push(p);
  assert.deepEqual(out, { ch: "bridge", req: v.res }, "the joined bytes are the res");
  assert.equal(v.res.t, "res");
  assert.equal(v.res.id, v.id);
});

test("the daemon's answers and lines to the relay are in C10, with their full shape", () => {
  const errors = new Set();
  for (const { res } of bridge.daemonAnswers) {
    assert.deepEqual(Object.keys(res).sort(), ["ch", "error", "id", "ok", "t"]);
    assert.equal(res.t, "res");
    assert.equal(res.ch, "bridge");
    assert.equal(res.ok, false);
    assert.ok(C10.includes("`" + res.error + "`"), res.error);
    errors.add(res.error);
  }
  assert.deepEqual([...errors].sort(), ["disconnected", "not connected", "timeout", "too large"]);
  assert.ok(C10.includes('`{"t":"res","ch":"bridge","id":"<id>","ok":false,"error":"<text>"}`'));
  for (const line of bridge.daemonLines) {
    assert.equal(typeof line.t, "string");
    assert.ok(C10.includes(`\`{"t":"${line.t}"`), `C10 shows a line {"t":"${line.t}"...}`);
    for (const k of Object.keys(line)) assert.ok(C10.includes(`"${k}":`), `C10 shows the field ${k}`);
  }
});

// ---- C10: each tab's scope ----

test("tabs.create and windows.create take the scope arg, and a new tab opens at about:blank only", () => {
  const SCOPED = ["tabs.create", "windows.create"];
  for (const name of SCOPED) {
    const o = opByName.get(name);
    assert.deepEqual([o.kinds.at(-1), o.required, o.args.length], ["scope", 2, 2], `${name}: the scope arg is required`);
  }
  assert.ok(SCOPE.test(bridge.scope));
  for (const v of bridge.requests.filter((x) => SCOPED.includes(x.req.op))) {
    assert.equal(v.req.args[1], bridge.scope, v.req.id);
    assert.deepEqual(v.chrome[1], [v.req.args[0]], `${v.req.id}: the scope goes to the map, not to Chrome`);
  }
  const bad = bridge.badRequests.filter((v) => SCOPED.includes(v.req.op));
  assert.ok(bad.some((v) => v.req.args.length === 1), "no scope arg (an old relay)");
  assert.ok(bad.some((v) => v.req.args.length === 2 && /^https?:/.test(v.req.args[0].url ?? "")), "a site's URL");
  assert.ok(bad.some((v) => v.req.args.length === 2 && !kindFits("scope", v.req.args[1])), "a bad scope");
  assert.ok(bad.some((v) => v.req.op === "windows.create" && Object.hasOwn(v.req.args[0], "tabId")), "no op moves a tab");
  assert.ok(C10.includes("`[createProperties, scope]`") && C10.includes("`[createData, scope]`"));
});

test("bridge.tabScope: its vectors name a tab and a scope, and C10 gives its order", () => {
  const evs = bridge.eventVectors.filter((v) => v.ev.ev === "bridge.tabScope");
  assert.ok(evs.length >= 2, "a popup and a replaced tab");
  for (const v of evs) {
    assert.equal(v.chrome, null, "the receiver's own event");
    assert.ok(int(v.ev.tabId) && v.ev.tabId >= 0);
    assert.ok(SCOPE.test(v.ev.scope));
  }
  assert.ok(C10.includes("Before the popup's `tabs.onCreated`, and before the replaced tab's `tabs.onReplaced`"));
});

test("the daemon's allowlist line is the confirmed set_scopes object; roots only for the relay", () => {
  const lines = bridge.daemonLines.filter((l) => l.t === "allowlist");
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    assert.ok(!Object.hasOwn(l, "domains"), "the one list is gone");
    assert.ok(!Object.hasOwn(l, "keys"), "no keys");
    for (const k of ["lists", "scopes", "default"]) assert.ok(Object.hasOwn(l, k), k);
    assert.equal(applySetScopes(l).refused, 0, "the daemon sends only valid objects");
    if (Object.hasOwn(l, "roots")) {
      assert.ok(isObj(l.roots));
      for (const [scope, list] of Object.entries(l.roots)) assert.ok(NAME.test(scope) && Array.isArray(list) && list.every(isRoot) && list.length > 0, scope);
    }
  }
  assert.ok(lines.some((l) => isObj(l.roots)) && lines.some((l) => !Object.hasOwn(l, "roots")), "a line with roots and one without");
  assert.ok(says(C10, "each live session's roots (C11, the scope's session); the receiver never sees the roots"), "C10: the receiver never sees the roots");
  assert.ok(says(C10, '`"roots":{"<scope>":[{"pid":<pane pid>,"start":<pane start>}]}`'), "C10 shows the roots field");
});

// ---- C10 and C5: the orphan-tabs rules (board ab-v16.41) ----

test("the samples' last applied set_scopes: the union of its lists is the allowlist, and the samples' scope has a list", () => {
  const a = applySetScopes(bridge.setScopes);
  assert.equal(a.refused, 0, "the daemon sends only valid objects");
  assert.deepEqual([...new Set(Object.values(a.lists).flat())].sort(), [...bridge.allowlist].sort());
  assert.notEqual(a.listOf(bridge.scope), null, bridge.scope);
  const noList = bridge.badRequests.filter((v) => v.error === "no list for this scope");
  for (const op of ["tabs.create", "windows.create"]) assert.ok(noList.some((v) => v.req.op === op), `a no-list vector for ${op}`);
  assert.ok(noList.some((v) => Object.hasOwn(bridge.setScopes.scopes, v.req.args[1])), "a scope named null");
  assert.ok(noList.some((v) => !Object.hasOwn(bridge.setScopes.scopes, v.req.args[1])), "a scope that it does not name");
  assert.ok(C10.includes("`no list for this scope`"));
});

test("bridge.tabScopes: C10 states the op, its place in the steps of the link up, and its vector lists tabs and scopes", () => {
  const o = opByName.get("bridge.tabScopes");
  assert.deepEqual([o.args, o.required, o.defaultWait], [[], 0, "WAIT_DEFAULT_MS"]);
  const v = bridge.requests.find((r) => r.req.op === "bridge.tabScopes");
  assert.ok(Array.isArray(v.res.data) && v.res.data.length > 0, "a list");
  for (const e of v.res.data) {
    assert.deepEqual(Object.keys(e).sort(), ["scope", "tabId"]);
    assert.ok(int(e.tabId) && e.tabId >= 0 && SCOPE.test(e.scope), JSON.stringify(e));
  }
  assert.equal(new Set(v.res.data.map((e) => e.tabId)).size, v.res.data.length, "one item for each tab");
  for (const s of ["**steps of the link up**", "2. In the per-scope build only", "When `bridge.tabScopes` fails or times out", "Today's relay (before part 2) runs steps 1, 3 (the list only) and 4"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  assert.ok(says(C11, "the steps of the link up (C10, \"The daemon and the relay\") are done"), "C11's readiness waits for the steps of the link up");
});

// C10's window rule: the receiver first opens about:blank when no tab stays open other than the item's tabs and the
// tabs with a pending close.
const guardOf = (v) => !v.open.some((t) => !v.closes.includes(t) && !v.pending.includes(t));

test("the window rule: each vector follows C10's rule, also for a pending close (board ab-v16.43)", () => {
  for (const v of bridge.windowRule) {
    assert.ok(v.closes.every((t) => v.open.includes(t)), `${v.note}: an item closes open tabs`);
    assert.equal(guardOf(v), v.guard, v.note);
  }
  const has = (f) => bridge.windowRule.some(f);
  assert.ok(has((v) => v.guard && v.pending.length === 0 && v.open.length === 1), "the browser's only tab");
  assert.ok(has((v) => v.guard && v.pending.some((t) => v.open.includes(t))), "a pending close that is still open counts as closed");
  assert.ok(has((v) => !v.guard && v.pending.length > 0), "a pending close and a tab that stays");
  assert.ok(has((v) => v.closes.length > 1 && v.guard) && has((v) => v.closes.length > 1 && !v.guard), "an item with several closes");
  assert.ok(has((v) => v.guard && v.closes.some((t) => v.pending.includes(t))), "a later item closes a pending tab again (review-17 M1)");
  for (const s of ["**removal queue**", "**window rule**", "**pending close**", "`REMOVAL_WAIT_MS = 2000`", "a client's `Page.close`", "`windowRule`",
    // review-17: the receiver's close (H1), the fallback, a pending close closed again (M1), the gate and the link change (M4),
    // the limits of the item's calls (L1), the bound of the answer (L2), a child session's Page.close (L3), the memory-only limit (L5).
    "The **receiver's close**", "`Target.closeTarget` with the tab's target id", "`Detached while handling command.`", "The fallback: when the attach",
    "a later item that closes the tab (also a `tabs.remove` or an import's close) closes it again, by the receiver's close", "The gate opens at each of these ends", "drops every bridge request that waits in the queue or at a gate",
    "The query and that tab each have a limit of `REMOVAL_WAIT_MS`", "The bound of a `set_scopes` answer", "A `Page.close` on a child session of the tab",
    "The pending closes live in the worker's memory only", "the close of a new tab of `tabs.create` or `windows.create` whose scope lost its list during the op (a tab of the orphan set too) or whose rule update failed", "a restore tab that came after its step's deadline"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  assert.ok(says(C5, "The sweep closes a tab with a pending close again, by the receiver's close"), "C5: the sweep does not skip a held tab");
  // Board ab-v16.63: the dropped close (a no-error answer with no tabs.onRemoved) gets the fallback; its numbers.
  for (const s of ["The **dropped close** (board ab-v16.63, receiver 0.3.4)", "a `Target.closeTarget` that reaches Chrome shortly before the tab's navigation commits answers `{\"success\":true}`, and the tab stays open with no `tabs.onRemoved`",
    "no `tabs.onRemoved` of the tab came `REMOVAL_WAIT_MS` after that answer, the command counts as failed, and the fallback runs", "when the command fails and the tab stays, or at a dropped close (above)",
    "The fallback of a dropped close is one more op of the tab's chain", "a failed fallback then ends the close `REMOVAL_WAIT_MS` after that answer",
    "A dropped close ends at its fallback, about `REMOVAL_WAIT_MS` after the command's answer, so after the item's wait", "Chrome answered `{\"success\":true}` in 1 to 3 ms each time"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  assert.ok(says(C5, "that needs a failed attach or a dropped close (C10)"), "C5: the dropped close can lead to a held fallback");
  // review-17b: B1 (pending from the start of the close), N1 (the chain), N2 (step 3), N3 (a tab that the sweep cannot close leaves its scope).
  for (const s of ["a close is pending from the moment its item starts it (for the receiver's close, from the moment it joins the tab's chain; for a client's `Page.close`, from its send) until the tab's `tabs.onRemoved`, or until it fails and the tab stays (after the fallback too, and, when the receiver sent a `Target.closeTarget` command, only after that command also answered",
    "a late `Page.close` answer with no error leaves the close pending, and a late error ends it", "also one that still waits in the tab's chain, or is still in its attach",
    // review-17c: the chain op ends before a held fallback (note 1); the orphan set in C10 (T11, T12, T13); a new entry's limit (note 5).
    "The op ends when the command answered, or when the fallback called `chrome.tabs.remove`;", "The close stays pending outside the chain (below), so a held fallback never stops the tab's chain",
    "a tab of the sweep leaves its scope at the end of the item, into the orphan set", "the sweep takes such a tab out of its scope into the orphan set",
    "The limits of a tab that a sweep item does not close", "a window rule that failed or came late, with no close and no dialog", "the held `chrome.tabs.remove` call does not end",
    "The limit of a new entry", "the end of a sweep item that did not close the tab", "The receiver's close is one op of the tab's chain of attaches",
    "only when it made one: never the bridge's attachment", "lists no target for the tab", "it never detaches the attach of a receiver's close that runs"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  // review-17c B1: both cases, the orphan set, the true limits.
  for (const s of ["A tab that the sweep's item does not close leaves its scope at the end of that item", "The item's window rule failed or came late (C10): then no close starts, and no dialog opens",
    "The receiver keeps the tab's id in the **orphan set**, in memory", "the guard and the closing rule treat it as a tab with no list", "Each later sweep item closes it again by the receiver's close, whatever its URL",
    "after a dismiss the page stays, and the held `chrome.tabs.remove` call does not end", "After a worker start the orphan set is gone", "its key leaves the copy. The answer waits for that removal",
    "The relay drops it from its model at its next `allowlist` line whose `scopes` and `lists` are objects", "except a tab of the orphan set"]) {
    assert.ok(says(C5, s), `C5 says: ${s}`);
  }
  assert.ok(!says(C5, "The case needs a failed attach, a `beforeunload` handler and a user activation of the page; its limit is a tab of no scope that stays open until someone answers its dialog"), "C5: the old, wrong limit is gone");
  // review-17c notes 3 and 4, and the C4 nits (T18).
  assert.ok(says(C4, "the copy's key removals of the sweep have ended"), "C4: the answer waits for the key removals");
  assert.ok(says(C4, "after an answer that came later than 10 s (C10, the bound of a `set_scopes` answer), the receiver's new rules are in force"), "C4: a late answer");
  assert.ok(says(C4, "After an `ok: false` of a failed worker removal (C5)"), "C4: an ok:false of a failed worker removal");
  assert.ok(says(C11, "at a line whose `scopes` and `lists` are objects, it also drops from its model each tab of a scope that the line gives no list"), "C11: the relay drops the tabs of a scope with no list");
  assert.ok(says(C11, "A tab that still waits for its `bridge.tabScope` (up to `TAB_SCOPE_WAIT_MS`) has no scope yet, and it stays"), "C11: a popup that waits for its scope stays");
  // review-17d N4: each orphan-set text that part 1a builds from, and the full windowRuleNote.
  for (const [name, text, list] of [
    ["C5", C5, ["a tab of the orphan set (the sweep, below) has no list, so its `http:`/`https:` page closes", "but every host for a tab of the orphan set",
      "Rule 2 counts only an `ok` in time (C4: the daemon wrote its line)", "its next `allowlist` line whose `scopes` and `lists` are objects",
      "a removal that fails, or that has not ended within `REMOVAL_WAIT_MS`, makes the answer `ok: false`", "but the queue item does not",
      "a popup of a tab of the set, and the added tab of a `tabs.onReplaced` of a tab of the set",
      "as the removed tab of a `tabs.onReplaced`"]],
    ["C10", C10, ["a tab of the orphan set (C5, the sweep), and the operator's own tabs", "The sweep never closes a tab of no scope, except a tab of the orphan set",
      "`set_scopes` sweeps again, also the tabs of the orphan set", "The orphan set lives in memory too", "After a worker start such a tab is a plain tab of no scope",
      "never enters the map (review-17d): it joins the orphan set at once", "gets no key in the copy and no `bridge.tabScope`", "The orphan set spreads as the mark does",
      "whose id leaves the set", "a popup or a replaced tab whose scope has no list never enters the map: it is in the orphan set from the start",
      "a window rule that failed or came late (case 2)", "a command that has not answered within `REMOVAL_WAIT_MS` counts as failed, and the fallback runs",
      "and for the copy's key removals of the sweep", "it writes no entry, the new tab joins the orphan set"]],
    ["C11", C11, ["At a line whose `scopes` or `lists` is not an object it drops no tab"]],
    ["C4", C4, ["answered `ok` in time (within the 10 s, so the daemon wrote its `allowlist` line", "answered `ok` in time to a `set_scopes` that holds it",
      "A key removal that fails, or that has not ended within `REMOVAL_WAIT_MS`"]],
  ]) {
    for (const s of list) assert.ok(says(text, s), `${name} says: ${s}`);
  }
  assert.ok(!says(C10, "stays in its scope until the next applied `set_scopes`"), "C10: the false limit of a new entry is gone");
  // review-17e: B1 (rule 2's split and its restart gate), the second layer, N1 to N7, and the mutations that no test caught
  // (M3, M8, M10, M11, M12, M13, M15, M19, M32, M33).
  for (const [name, text, list] of [
    ["C4", C4, ["sends the second after the `ok` in time of the first", "no launch's scope and no name of the file enters a `set_scopes` until the first `set_scopes` of rule 1 is answered `ok` in time",
      "or of a failed key removal (C5, the sweep)", "(C10), makes the answer `ok: false` (C5, the sweep)"]],
    ["C5", C5, ["A tab leaves the set at its `tabs.onRemoved`", "also at its gate after a daemon restart", "from the first applied `set_scopes` after the worker's start on; it never enters the map",
      "a new tab of `tabs.create` or `windows.create` whose scope loses its list during the op"]],
    ["C10", C10, ["and closes in the removal queue by the receiver's close, with the window rule", "leaves it open in no scope, never in the ended scope",
      "also after the opener's own kept entry of its old scope has expired", "or has a kept entry of one (`TOMBSTONE_MS` after its close), joins the set",
      "it joins the orphan set and closes at once", "So neither a close that a dialog holds (case 1) nor a window rule that failed or came late (case 2) leaves it in its old scope, and a later session of the same name never gets it",
      "Before that first applied `set_scopes` the lists are not known yet: such a tab enters the map with its scope", "It also keeps the orphan-set membership of a tab that closed for `TOMBSTONE_MS`",
      "when the receiver sent a `Target.closeTarget` command, only after that command also answered", "a command that has not answered keeps the close pending, also when the fallback failed",
      "`debugger.attach`, `debugger.sendCommand`, `tabs.update` and `tabs.remove` of a tab of the orphan set", "`debugger.detach`, `tabs.get` and `bridge.release`",
      "a tab of the orphan set, not an entry of the map", "the end of a sweep item that did not close it, or a `tabs.onReplaced`"]],
  ]) {
    for (const s of list) assert.ok(says(text, s), `${name} says: ${s}`);
  }
  assert.ok(!says(C10, "also the entry of a popup that closed at once"), "C10: the stale kept-entry phrase is gone (review-17e N2)");
  // The second layer: an op of a tab of the orphan set gets not an agent tab, for each op that gives a client control of a tab.
  const orphanOps = bridge.badRequests.filter((v) => v.perScope && v.error === "not an agent tab").map((v) => v.req.op).sort();
  assert.deepEqual(orphanOps, ["debugger.attach", "debugger.sendCommand", "tabs.remove", "tabs.update"], "a vector for each refused op of an orphan-set tab");
  assert.equal(flat(bridge.windowRuleNote), flat("C10, removals and the last window (board ab-v16.41): one item of the receiver's removal queue. open: the tab ids of its tabs.query; pending: the tabs with a pending close (a close is pending from the moment its item starts it, for the receiver's close from the moment it joins the tab's chain, for a client's Page.close from its send, until the tab's tabs.onRemoved, or until it fails and the tab stays, after the fallback too and, when the receiver sent a Target.closeTarget command, only after that command also answered; a late answer counts as any answer); closes: the tabs that the item closes. guard: the receiver first opens an about:blank tab (not active, in no scope) in the window of the item's last tab, because no tab stays open other than the item's tabs and the pending ones."), "the full windowRuleNote");
  assert.ok(says(bridge.windowRuleNote, "a close is pending from the moment its item starts it"), "the windowRuleNote has the same definition");
  // review-17b N7 and review-17c note 7: no sentence lets the sweep, the closing rule or a later item skip a tab with a
  // pending close (also a paraphrase: "skips", "never closes ... again").
  for (const [name, text] of [["C5", C5], ["C10", C10]]) {
    for (const sentence of flat(text).split(/(?<=\.)\s+/)) {
      const skips = /\b(skips?|skipped|neither does|ignores?|ignored|alone|passes over)\b/i.test(sentence) || /\bnever close[sd]?\b[^.]*\bagain\b/i.test(sentence);
      assert.ok(!(skips && /pending close/i.test(sentence)), `${name}: no rule skips a tab with a pending close: ${sentence}`);
    }
  }
  assert.ok(says(C11, "while Chrome's own `Target.closeTarget` does not"), "C11: today's relay's Target.closeTarget runs beforeunload");
});

// C5's sweep: at an applied set_scopes (scopes and lists are objects), every tab of the map whose scope has no list,
// and every tab of the orphan set, whatever its old scope; never another tab of no scope.
function sweepOf(msg, map, orphans = []) {
  if (!isObj(msg.scopes) || !isObj(msg.lists)) return { applied: false, closes: [] };
  const a = applySetScopes(msg);
  const closes = Object.entries(map).filter(([, scope]) => a.listOf(scope) === null).map(([id]) => Number(id));
  return { applied: true, closes: [...closes, ...orphans].sort((x, y) => x - y) };
}

test("the sweep: each vector closes the tabs whose scope has no list, and none at a set_scopes that is not applied", () => {
  for (const v of scopesV.sweep) {
    for (const [id, scope] of Object.entries(v.map)) assert.ok(/^\d+$/.test(id) && NAME.test(scope), `${v.note}: ${id} -> ${scope}`);
    const orphans = Object.keys(v.orphans ?? {}).map(Number), noScope = v.noScope ?? [];
    for (const t of [...orphans, ...noScope]) assert.ok(!Object.hasOwn(v.map, String(t)), `${v.note}: tab ${t} is in no scope, so not in the map`);
    for (const old of Object.values(v.orphans ?? {})) assert.ok(NAME.test(old), `${v.note}: the old scope ${old}`);
    assert.deepEqual(sweepOf(v.in, v.map, orphans), { applied: v.applied, closes: v.closes }, v.note);
  }
  const has = (f) => scopesV.sweep.some(f);
  const scopes = (v) => (isObj(v.in.scopes) ? v.in.scopes : {});
  assert.ok(has((v) => v.in.default === null && v.closes.some((t) => !Object.hasOwn(scopes(v), v.map[t]))), "a scope that is not named, with default null");
  assert.ok(has((v) => v.closes.some((t) => scopes(v)[v.map[t]] === null)), "a scope named null");
  assert.ok(has((v) => v.closes.some((t) => typeof scopes(v)[v.map[t]] === "string" && !Object.hasOwn(v.in.lists, scopes(v)[v.map[t]]))), "a list that is not in lists");
  assert.ok(has((v) => typeof v.in.default === "string" && Object.values(v.map).some((s) => !Object.hasOwn(scopes(v), s)) && v.closes.length === 0), "a scope that is not named, with a default list, stays");
  assert.ok(has((v) => !v.applied && Object.hasOwn(v.in, "scopes") && !isObj(v.in.scopes)), "scopes not an object: no sweep");
  assert.ok(has((v) => !v.applied && Object.hasOwn(v.in, "lists") && !isObj(v.in.lists)), "lists not an object: no sweep");
  // A refused scopes entry (neither null nor a valid name) applies as null, and its tab closes.
  assert.ok(has((v) => v.applied && v.closes.some((t) => { const e = scopes(v)[v.map[t]]; return e !== undefined && e !== null && !validName(e); })), "a refused entry follows what applies");
  // review-17d N5: an orphan-set tab closes (also when its old scope has a list again), a plain tab of no scope stays, and no sweep
  // at a set_scopes that is not applied closes an orphan-set tab.
  // review-17e N6: the old scope of the orphan-set tab has a list again in that set_scopes, and the tab still closes.
  assert.ok(has((v) => v.applied && Object.entries(v.orphans ?? {}).some(([t, old]) => applySetScopes(v.in).listOf(old) !== null && v.closes.includes(Number(t))) && (v.noScope ?? []).length > 0), "an orphan-set tab whose old scope has a list again closes; a plain tab of no scope stays");
  assert.ok(has((v) => !v.applied && Object.keys(v.orphans ?? {}).length > 0 && v.closes.length === 0), "no sweep of the orphan set at a set_scopes that is not applied");
  for (const s of ["The sweep (board ab-v16.41", "An **applied** `set_scopes`", "at its rule update, before the sweep's `tabs.query`", "`sweep` in `test/vectors/scopes.json`"]) {
    assert.ok(says(C5, s), `C5 says: ${s}`);
  }
});

test("the orphan-tabs rules are in the text: the kept map, its copy and restore, the kept entries, and the daemon's rules", () => {
  for (const s of ["The map stays at each disconnect", "`chrome.storage.session`", "`tab:<id>`", "`TRUSTED_CONTEXTS`", "`RESTORE_MAX_MS = 2000`", "`TOMBSTONE_MS = 10000`", "never goes to `chrome.storage.local`", "A new entry after the sweep (board ab-v16.41)", "drops only a write for a tab that no longer exists"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  assert.ok(says(C5, "keeps every session rule, the map and the marks"), "C5: the scope rules stay at a link change");
  const daemon = C4.slice(C4.indexOf("**The tabs of a session that ended (board ab-v16.41).**"));
  assert.ok(daemon.length > 100, "C4 has the daemon's rules");
  for (let i = 1; i <= 6; i++) assert.ok(daemon.includes(`\n${i}. `), `C4: rule ${i}`);
  for (const s of ["first complete read of its sessions", "a good read of zero sessions sends an empty `scopes`", "splits a merged update", "not at the next `link` up", "`end_scope` stays as it is", "Declined (aw-lead"]) {
    assert.ok(says(daemon, s), `C4 says: ${s}`);
  }
  assert.ok(protocol.includes("The orphan-tabs rules (board task ab-v16.41"), "the intro says which build holds them");
});

// The sentences of a text, whatever their line breaks.
const sentences = (text) => flat(text).split(/(?<=\.)\s+/);

test("review-17f's notes (board ab-v16.48): the daemon's file and gate, the orphan set's ops, and the exceptions", () => {
  const daemon = C4.slice(C4.indexOf("**The tabs of a session that ended (board ab-v16.41).**"));
  // Note 1: the first set_scopes names every live session, except a scope that rule 2 keeps out; no sentence says it
  // without the exception.
  assert.ok(says(daemon, "1. The first `set_scopes` on each connection names every live session, except a scope that rule 2 keeps out: a name of the file of ended scopes, and the scope of a launch while rule 2's gate is shut"), "C4: rule 1's exception");
  assert.ok(says(C4, "names every live session, except a scope that rule 2 keeps out (the tabs of a session that ended, below: a name of the file of ended scopes, and the scope of a launch while rule 2's gate is shut)"), "C4: the set_scopes bullet's exception");
  assert.ok(says(protocol, "the daemon names every live session in its first `set_scopes` on each connection, except a scope that rule 2 of C4 keeps out"), "the intro's exception");
  const live = sentences(protocol).filter((x) => /names every live session/.test(x));
  assert.ok(live.length >= 3, "the three places");
  for (const x of live) assert.ok(/names every live session( in its first `set_scopes` on each connection)?, except a scope that rule 2 (of C4 )?keeps out/.test(x), `the exception: ${x}`);
  // Note 2: the daemon sends its current object again, also when no answer comes, and rule 2 applies to it.
  for (const s of ["When that answer is `ok: false`, comes late, or does not come (no answer within the 10 s, or the link drops before it), the daemon sends its current object again (the live sessions and the lists of that moment), still without a launch's scope and without the names of the file, until one gets an `ok` in time",
    "After a link drop that object is the first `set_scopes` of the next connection", "sends its current object again (agentwatch picks the delay; rule 2 below applies to it too)"]) {
    assert.ok(says(C4, s), `C4 says: ${s}`);
  }
  assert.ok(!says(C4, "sends that object again"), "C4: the old resend of that object is gone");
  // Note 3: aw-lead's file of ended scopes, the restart gate, and the failure modes of the file with their fixes.
  for (const s of ["The **file of ended scopes**: a small file of mode 0600 in the daemon's state folder", "The daemon writes a name into it at the session's end",
    "It prunes the name when a `set_scopes` without the name (with a `default` list: with its `null`), sent after the write, gets an `ok` in time",
    "No `set_scopes` names a scope while its name is in the file, also when a new live session has that name",
    "an old X ends, a new X launches, and the daemon stops before the `ok` in time of the split's first `set_scopes`", "The **restart gate**",
    "after a daemon start no launch's scope and no name of the file enters a `set_scopes` until the first `set_scopes` of rule 1 is answered `ok` in time",
    "The failure modes of the file, and their fixes:", "A lost write:", "So the daemon writes the name first: before its `end_scope`, before its next `set_scopes`, and before a launch can take the name",
    "The write replaces the file in one step (a new file, then a rename), so a stop never leaves half a file",
    "A lost prune:", "the daemon removes a name from the file before any `set_scopes` names it again", "A stop of the box: the file needs no sync to disk",
    "A file that the daemon cannot read or parse at its start", "the daemon counts the name of every live session as a name of the file",
    "No `ok` in time for a long time", "the first `ok` in time prunes them all",
    "The `null` entries are the names of the file of rule 2 (the drop is its prune), so they stay over a daemon restart", "aw-lead chose the file of rule 2, mail me680165"]) {
    assert.ok(says(daemon, s), `C4 says: ${s}`);
  }
  for (const s of ["the rule needs no daemon memory", "The `null` entries live in the daemon's memory only"]) assert.ok(!says(C4, s), `C4: the old text is gone: ${s}`);
  // Note 4: the worker-start exception in each place that says that a listless popup never enters the map or gets no event.
  for (const s of ["Not for a popup or a replaced tab whose scope has no list, from the first applied `set_scopes` after the worker's start on",
    "Before that first applied `set_scopes` such a tab enters the map with its scope and gets its `bridge.tabScope`",
    "From the first applied `set_scopes` after the worker's start on, a popup or a replaced tab whose scope has no list never enters the map",
    "Before that first applied `set_scopes` it enters the map with its scope, and that `set_scopes` sweeps it as any tab of its scope"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  const never = [...sentences(C5), ...sentences(C10)].filter((x) => /never enters the map|Not for a popup or a replaced tab whose scope has no list/.test(x));
  assert.ok(never.length >= 4, "the four places");
  for (const x of never) assert.ok(x.includes("the first applied `set_scopes` after the worker's start"), `the worker-start exception: ${x}`);
  // Note 5: the queue list names the close of a new tab whose scope lost its list during the op.
  const queue = flat(C10.slice(C10.indexOf("Every path by which the receiver closes a tab runs in one queue"), C10.indexOf("One **item** runs at a time")));
  assert.ok(queue.includes("a new tab of `tabs.create` or `windows.create` whose scope lost its list during the op"), "C10: the queue list");
  // Note 6: the order of the two tab errors.
  assert.ok(says(C10, "4. The tab: first `not an agent tab`, then `not attached` (below). So a `debugger.sendCommand` of a tab of the orphan set that is not a bridge tab gets `not an agent tab` (vector b42)"), "C10: the order of the tab errors");
  // Notes 7 and 8: the ops of an orphan-set tab. The refused ops (b41 to b44) and the allowed ops (the request vectors
  // of tab 13) are the text's two lists, of one tab, and together every op that takes a tab.
  const refused = bridge.badRequests.filter((v) => v.perScope && v.error === "not an agent tab");
  const allowed = bridge.requests.filter((v) => v.perScope);
  const tabOf = (v) => (isObj(v.req.args[0]) ? v.req.args[0].tabId : v.req.args[0]);
  assert.deepEqual([...new Set([...refused, ...allowed].map(tabOf))], [13], "one tab of the orphan set");
  const spans = (t) => [...t.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
  const bullet = flat(C10.slice(C10.indexOf("- `not an agent tab`, in the per-scope build")));
  const refusedText = /: ((?:`[^`]+`,? (?:and )?)+)of a tab of the orphan set/.exec(bullet);
  const allowedText = /stay allowed for such a tab: ((?:`[^`]+`,? (?:and )?)+)\(/.exec(bullet);
  assert.ok(refusedText && allowedText, "C10 names both lists");
  assert.deepEqual(refused.map((v) => v.req.op).sort(), spans(refusedText[1]), "the refused vectors are the text's list");
  assert.deepEqual(allowed.map((v) => v.req.op).sort(), spans(allowedText[1]), "the allowed vectors are the text's list");
  assert.deepEqual(allowed.map((v) => v.req.op).sort(), ["bridge.release", "debugger.detach", "tabs.get"]);
  const tabOps = bridge.ops.filter((o) => o.args[0] === "tabId" || o.kinds[0] === "target").map((o) => o.op).sort();
  assert.deepEqual([...refused, ...allowed].map((v) => v.req.op).sort(), tabOps, "each op that takes a tab is refused or allowed, once");
  assert.ok(allowed.some((v) => v.req.op === "debugger.detach" && v.bridgeTab === true && v.chrome[0] === "debugger.detach"), "the relay ends the attachment of a bridge tab of the orphan set");
  assert.ok(allowed.some((v) => v.req.op === "tabs.get" && /^https:/.test(v.res.data.url)), "tabs.get reads the old page's URL");
  for (const s of ["The receiver's own close of such a tab is no bridge op, so the check does not stop it",
    "No connection sees a tab of the orphan set, so this check is a second layer too: an old model entry of the relay, or a client of the same name after a gap of rule 2, still gets no control of it",
    "These are the ops by which a client acts on a tab: it attaches to the tab, sends it a command, selects it or closes it",
    "A tab of the orphan set belongs to no live session, so no client acts on it, and only the receiver closes it (each later sweep item, C5)",
    "The limit of the refused `tabs.remove` (review-17f note 8): a late `end_scope` does not close a tab of the orphan set",
    "it gets `not an agent tab`, and the tab stays open until a later sweep item closes it, at the next applied `set_scopes` (C5), or until someone accepts its dialog",
    "`tabs.get` of such a tab stays allowed, although it reads the URL and the title of the old session's page (review-17f note 7)",
    "`tabs.query`, `debugger.getTargets` and the `tabs.onUpdated` events give the relay the URL and the title of every tab, also of a tab of the orphan set and of a marked tab, and the relay keeps them from the clients"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  assert.ok(!says(C10, "These are the ops that give a client control of a tab"), "C10: the old reason is gone");
  assert.ok(says(scopesV.sweepNote, "whatever their URL and whatever their old scope's list"), "the sweepNote: the orphan set closes whatever its old scope's list");
  // Note 9: the check again right before the send (with review-18 note 4's wording: the call that acts on the tab, and no
  // await between the check and that call).
  for (const s of ["In the per-scope build the orphan-set check runs again right before the `chrome.*` call that acts on the tab, with no `await` between the check and the call",
    "it checks the orphan set again right before the `chrome.*` call that acts on the tab (the call that attaches to it, sends it a command, selects it or closes it; review-18 note 4)",
    "and whose tab joined the orphan set while it waited gets `not an agent tab`, and its call never goes to Chrome",
    "There is no `await` between that check and the call, so the tab cannot join the set between them",
    "The check reads the receiver's memory only, so the requests keep their order",
    "a `debugger.attach` in the tab's chain of attaches, a `tabs.remove` or a `Page.close` in the removal queue, a `debugger.sendCommand` at the gate of a `Page.close`",
    "and each later request of the tab gets the check", "An op of the removal queue gets the check when its item starts"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  // Note 10: the wording of the kept entries and of a pending close with no command.
  assert.ok(!says(C10, "has such an entry takes its scope"), "C10: 'such an entry' is gone");
  assert.ok(says(C10, "A popup whose `sourceTabId` has a kept entry of the map takes that entry's scope (or its mark)"), "C10: the kept entry of the map");
  assert.ok(says(C10, "a close whose attach or `chrome.debugger.getTargets()` failed, or found no target, sent no command"), "C10: a close that sent no command");
});

// The part of C11 from a bold heading to the next bold heading.
function part(text, heading) {
  const start = text.indexOf(`**${heading}`);
  assert.ok(start >= 0, `the part ${heading}`);
  const next = text.indexOf("\n**", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

test("the peer check replaces the key (board ab-v16.50): no key text is left, and the intro, C4 and C10 name the peer check", () => {
  for (const s of ["--keys", "X-Agentwatch-Key", "AGENTWATCH_BROWSER_CRED", '"keys"', "keys on", "Without keys", "without keys", "with keys", "the scope's key", "the key's 403", "the hash check",
    "timingSafeEqual", "?key=", "(ab-v16.35 and ab-v16.36)", "keysWithout", "~/.config/agentwatch/tokens/"]) {
    assert.ok(!says(protocol, s), `docs/protocol.md: no ${s}`);
  }
  for (const v of [endpoint, scopesV, bridge]) assert.ok(!/"keys?"|keysOn|x-agentwatch-key|\?key=/i.test(JSON.stringify(v)), "no key in the vectors");
  // The intro (design 9.1).
  for (const s of ["for example the session's 403 text, or a count in `refused`", "the relay in part 2 (ab-v16.35, and ab-v16.51 for the peer check, which replaces ab-v16.36)",
    "The operator answered the design's choice 1 in ab-dm6 with no key system: the peer check (below) takes the place of the per-scope key",
    "The peer check (board task ab-v16.50; the design: agent-browser `docs/superpowers/specs/2026-11-05-peer-admission-design.md`, board ab-v16.47, sections 9 and 12)",
    "the relay reads the connecting process from the kernel and walks from it to the session's root, its tmux pane's process", "The daemon's `allowlist` line carries each session's roots (C10)",
    "The receiver does not change (C4)", "Until the relay starts with `--peer-check`, the scope stays advisory"]) {
    assert.ok(says(protocol.slice(0, protocol.indexOf("\n### C1. ")), s), `the intro says: ${s}`);
  }
  // C4: no new field; the endpoint in the environment; the end of a session drops its roots (ab-6gs).
  for (const s of ["(only when the operator allowed it: age-4ks, C11, the scope's session)",
    "With the peer check, the `allowlist` line that drops the scope (with 5 b: that names it `null`) also drops its roots, so no process of the ended session connects again, with any scope",
    "`set_scopes` carries no roots: the receiver never sees a pid"]) {
    assert.ok(says(C4, s), `C4 says: ${s}`);
  }
  assert.ok(!says(C4, '"roots"'), "C4: no roots field in set_scopes");
  // C10: the start flag and the line.
  for (const s of ["with `--peer-check` when the peer check is on (C11, the scope's session)",
    "A root change needs no `set_scopes`: the daemon writes a line with the new roots and the last confirmed object at once, after the pane's scope wait and only after the first `ok` on the current connection"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
});

test("C11's socket, URL, answers and closes follow the peer check", () => {
  const url = part(C11, "The socket and the URL.");
  for (const s of ["The URL contains no secret, with or without the peer check", "`agentwatch browser env` prints `PLAYWRIGHT_MCP_CDP_ENDPOINT=<url>`, with no comment lines",
    "keeps it for the session's life, with or without the peer check", "Without the peer check, every process of the daemon's OS user that can open the socket may connect, with any scope",
    "With the peer check, a connection needs its process in the agentwatch session of its scope"]) {
    assert.ok(says(url, s), `C11 says: ${s}`);
  }
  const before = part(C11, "Before the upgrade.");
  for (const s of ["a peer that the relay cannot read (a read at the accept fails, gives no pid, or gives a uid other than the relay's", "a peer that is not in the session of its scope (the session check, below)",
    "`<pid>` is the peer's pid, as the relay read it at the accept", "(the relay's self-test failed: the scope's session, below)",
    "a relay whose self-test failed gives its 503 (`the relay cannot read the program of a connection`); else a peer that it cannot read gets the peer's 403. Both come at once, also while the relay is not ready",
    "a relay without `--peer-check` whose last `allowlist` line has a `roots` field",
    "5. With the peer check, a scope that the last `allowlist` line does not name: the no-list 503. A just-launched session connects again",
    "the peer is alive, and the walk from it reaches a root of the scope that counts; a walk that stops at any other root refuses",
    "Only when the walk reaches no root, on Linux, may the peer's cgroup count: it must be in the pane's scope of a root of the scope. Else the session's 403",
    "With the peer check, that is a named scope whose entry is `null` (also an entry that applies as `null`, C4) or names a list that is not in `lists`", "without the peer check, also a scope that the line does not name while `default` gives no list",
    "With the peer check too, the relay never asks the daemon during an upgrade: it reads the peer at the accept, and step 6 runs in its event loop",
    "A session that is live at the deploy of the peer check gets its root in the daemon's first line after it"]) {
    assert.ok(says(before, s), `C11 says: ${s}`);
  }
  const ends = part(C11, "When a connection ends.");
  for (const s of ["With the peer check, at each `allowlist` line, the relay closes every connection of a scope that still has a list (the same list or another one) but whose root that admitted it (its pid and start, by the walk or by its cgroup) is no longer one of the scope's roots that apply (also at a line with no `roots` field)",
    "A connection keeps its scope until it closes, the line drops the root that admitted it, or the scope ends: the check runs once, at the upgrade"]) {
    assert.ok(says(ends, s), `C11 says: ${s}`);
  }
  assert.ok(says(part(C11, "The scope's list (board ab-v16.23)."), "With the peer check, a scope that the line does not name has no list, whatever `default` says: step 5 gives it the no-list 503 before the session check"), "C11: the scope's list with the peer check");
});

test("C11's scope's session holds the design's rules: the self-test, the peer read, the session check, the line, the defensive root rules, the roots' life and the limit", () => {
  const ses = part(C11, "The scope's session (the peer check; board ab-v16.50).");
  const has = (list) => { for (const s of list) assert.ok(says(ses, s), `C11 says: ${s}`); };
  // The words and the flag.
  has(["The **peer** of a connection is the process that called `connect()` on the client's side", "A **root** is a pair `(pid, start)`: the pid of a session's tmux pane process and the start time of that process",
    "On Linux `start` is field 22 of `/proc/<pid>/stat`", "on the Mac it is `pbi_start_tvsec * 1000000 + pbi_start_tvusec` of `proc_pidinfo`'s `PROC_PIDTBSDINFO`",
    "A process **matches** a root when its pid and its start time are both the root's. A pid alone never matches", "The **walk** goes from the peer to its parent (field 4 of `/proc/<pid>/stat`; `pbi_ppid` on the Mac)",
    "The **pane's scope** (Linux) is the systemd scope `tmux-spawn-<uuid>.scope`", "A cgroup is inherited at a fork and stays at a re-parent",
    "from its start, `agent-browser relay --socket <path> --peer-check`, not from an `allowlist` line"]);
  // The self-test (design 9.4; review-54b note 3).
  has(["a dynamic `import(\"node:ffi\")`, never a static import", "`ERR_UNKNOWN_BUILTIN_MODULE`", "A relay without `--peer-check` never loads `node:ffi`",
    "It makes a folder of mode 0700 with `mkdtemp` next to the endpoint socket", "The socket's path is at most 103 bytes, as the endpoint's; a longer path fails the test",
    "It starts a child process (`process.execPath` with a few lines of script) that connects to that socket and stays until the relay has read the connection",
    "the pid (the child's pid), the uid (the relay's), the peer's parent (the relay's own pid) and the peer's start time (field 22 of `/proc/<pid>/stat`, or `proc_pidinfo` on the Mac: the relay must be able to read it)",
    "and, when `SO_PEERPIDFD` gives a pidfd, the pid that the pidfd names (the `Pid:` line of `/proc/self/fdinfo/<pidfd>`) and a `poll` of that pidfd, which must return 0 (the child lives; review-19 note 5)", "A connection from the relay to itself would not do",
    "a pidfd of the child selects the **pidfd form**; `ENOPROTOOPT` (a kernel before 6.5) selects the **stat form**, which is not a failure; any other error fails the test",
    "The whole test has a time limit, `SELF_TEST_MS = 5000`", "In every path (a pass, a failure, the time limit) the relay stops the child and removes the folder",
    "`relay: the peer check runs (<form>)`, with `<form>` one of `pidfd`, `stat` and `mac`, or `relay: the peer check cannot run: <reason>`",
    "the relay admits no connection, and it answers each upgrade with the 503 `the relay cannot read the program of a connection` (step 3) until it stops: it fails closed"]);
  // The peer read (step 3; review-54b notes 1 and 4).
  has(["`getsockopt(SOL_SOCKET, SO_PEERCRED)` on the accepted socket gives the peer's pid and uid", "In the pidfd form `getsockopt(SOL_SOCKET, SO_PEERPIDFD)` gives a pidfd of the same process",
    "In the stat form the relay reads the peer's start time (field 22) at the accept too, so that the window of a reused pid starts there (review-54b note 4)",
    "`getsockopt(SOL_LOCAL, LOCAL_PEERPID)` gives a pid, `LOCAL_PEERCRED` the uid, and `proc_pidinfo` the peer's start time, read at the accept",
    "The peer's 403 (step 3) is the one answer for every read that fails at the accept (review-54b note 1)",
    "In the pidfd form any error of `SO_PEERPIDFD` is the peer's 403, whatever its code"]);
  // The session check (step 6; review-54b note 2).
  has(["libc `poll` of the pidfd (`POLLIN`, a 0 ms timeout) returns 0 (not readable; 1, readable, means that the peer has exited, and -1, an error, counts as not alive too), the `Pid:` line of its `fdinfo` is the peer's pid (`-1` means that it was reaped), and the peer's `/proc/<pid>/stat` can be read and its state (field 3) is not `Z`",
    "Each of the three counts alone: a process can show the state `Z` before its pidfd polls readable", "and a pidfd can poll readable while the state still shows `R` (both measured, review-54b note 2)",
    "Stat form and the Mac: the pid is still there, its start time is the one of the accept, and its state is not `Z` (on the Mac `pbi_status` is not `SZOMB`)",
    "The walk, from the peer itself (hop 0) to its parent, and on. It stops at the first process that matches a root of the line, of any scope (also a root that does not count, below)",
    "at pid 1; at a pid that has gone, or whose parent is 0; at a parent whose start time is later than its child's (the parent's pid came back during the walk, so it is not the child's parent; the same start time is a fork in the same clock tick, and the walk goes on; review-19 note 7); or after 32 hops (a root at most 32 parents above the peer counts)",
    "When it stops at any other root, the relay refuses it, whatever the cgroup says", "a process whose own walk reaches its own session's root never counts as another session",
    "On Linux only, and only when the walk stopped at no root: the peer's cgroup", "the peer's cgroup is the cgroup of a root of S whose cgroup counts, or a cgroup under it (`<root cgroup>/...`: a path under it, not a longer name with the same start)",
    "The Mac has no cgroups: the walk alone decides there", "Before it admits, the relay checks item 1 again", "it then closes the pidfd with libc `close`, as in every other path"]);
  // The line's rules (design 9.2).
  has(["`\"roots\":{\"<scope>\":[{\"pid\":<pane pid>,\"start\":<pane start>}]}`", "a root that one scope names twice is one root", "A `roots` that is not an object applies as an empty object",
    "An entry whose scope does not match the scope pattern, or whose value is not a list, applies as absent",
    "An item that is not an object with an integer `pid` from 2 to 2^53 - 1 and an integer `start` from 0 to 2^53 - 1 is dropped, and the other items of its list apply", "The other fields of an item are ignored",
    "A scope with no root that applies admits no connection (step 6)", "A relay with `--peer-check` that gets a line with no `roots` field applies the lists, and no scope has a root",
    "A relay started without `--peer-check` that gets a line with a `roots` field (any value) applies no list of that line, as if no line had come: it closes the open connections (1008, no list any more)"]);
  // The defensive root rules.
  has(["so that the usual mistakes of a line (a pid of the tmux server, a pane that two scopes name, a pane with no scope of its own) admit no wrong session",
    "They cannot catch every wrong line: a line that names another session's pane as a scope's root admits that session's processes to the scope, so the daemon must send each session's own pane (review-19 note 3)",
    "a parent that the relay cannot read counts as the same cgroup", "A root of a scope that `scopes` does not name still counts for the defensive root rules",
    "Its open connections closed at the `end_scope` (1000) or close at that line (1008)",
    "When the import, the `dlopen`, a symbol, the listen, the child, the read, a compare or the time limit fails, the relay admits no connection",
    "The design's W2 (the relay asks the daemon over Node's IPC channel) is a later build, only if this test fails on a box that agentwatch runs",
    "a `getsockopt` that fails, no pid (0), a uid other than the relay's, and in the stat form and on the Mac a start time that the relay cannot read",
    "A root counts only while it lives", "A `(pid, start)` that two scopes name counts for neither scope", "A root that is an ancestor of another root (the walk from the other root reaches it, with the walk's own stop rules from its first hop: a parent whose start time is later than the other root's start time is no parent, so it is no ancestor; review-19b note 7) does not count, for the walk or the cgroup",
    "A root's cgroup counts only when its pane has a scope of its own: the cgroup is not the cgroup of the root's parent", "no live root of another scope has the same cgroup, and no other live root's cgroup is under it (a nested scope)",
    "A root whose cgroup does not count still counts for the walk", "At a check the relay reads again only the scope's own roots (one `stat` and one cgroup read each)",
    "its cgroup only while it is the cgroup of the line's read"]);
  // The roots' life (design 9.2 and 10; review-54b notes 5 and 6; ab-6gs).
  has(["The daemon sends the roots of every live session in each `allowlist` line, from the session's first line on",
    "At a launch, the daemon reads the new pane's pid and start (after `tmux new-session`, before the launch line) and does the pane's scope wait (below) before the scope enters its map, so the first line that names the scope carries its root, with the root's own scope cgroup",
    "The daemon does this wait before it sends the first line that carries a new root, at a launch and at a respawn, or it sends that line again after the wait (review-19 note 1)",
    "so a line from before the move gives the root its parent's cgroup (the tmux server's), and the root's cgroup does not count until the next line",
    "the session's 403 ends with `If this session started or restarted just now, connect again in a few seconds.`",
    "The daemon starts the pane's shell first, and types the agent's launch line into it only after the pane is in its own scope",
    "a process that the pane forks before that move stays in the tmux server's cgroup for its life", "with a time limit (agentwatch picks it; a few seconds)",
    "It does not wait on the Mac (no cgroups), nor on a box where the tmux server cannot reach the user's D-Bus", "When the time limit passes, the daemon types the launch line",
    "When a root changes (a respawned pane: a restart, an account swap, a resume), the daemon writes a line with the new root as soon as the new pane is in its own scope (the scope wait above), with the last confirmed object, before the agent starts in the new pane",
    "Such a line comes only after the first `ok` on the current connection (review-19 note 6)", "Before that `ok`, the new root goes into the line that follows it",
    "`tmux respawn-pane -k` gives the pane a new process and a new scope, so the old pane's jobs (in the old scope, under no live root) are refused, also by their cgroup",
    "At a session's end the daemon drops the scope's roots in the line that drops the scope", "Already before that line the pane has ended, so its root matches no process and its cgroup counts for no connection",
    "for its own scope it gets the session's 403 until that line, and after it the no-list 503 (step 5) with 5 a. With 5 b it gets the session's 403 only until the line of C4's rule 3 drops the `null` entry: the line that ends the session names the scope `null` and gives it no root, so step 6 comes before step 7 (review-19 note 2), and after the rule 3 line the scope is unnamed and step 5 gives the no-list 503 (review-19b note 5); for any other scope it gets the session's 403",
    "A session that agentwatch only stops (its agent ends, its pane stays) keeps its pane and its root until agentwatch ends the session",
    "Over a daemon restart the daemon reads the pane of each live session again and sends its roots in its next line"]);
  // What others get, the jobs, the limit, age-4ks.
  has(["What a program that no agentwatch session started gets: the session's 403 (step 6)", "a command of `systemd-run --user` cannot connect",
    "With the walk alone (the Mac; a Linux box whose panes have no scope of their own) `nohup <job> &` in a shell that exits, `setsid -f`, a double fork and `systemd-run` are refused",
    "On Linux with the pane's scope (P2, the operator's ab-6gs answer) such a job is admitted while it stays in the pane's scope; only `systemd-run` and a new tmux pane are refused",
    "It does not stop a hostile process of the same OS user", "run a command through a server that another session left running (`tmux -L <server> run-shell`: by the server's cgroup it then counts as that session)",
    "the check binds a connection to the session whose process connected", "The operator's answer age-4ks (\"env: no\", 2026-11-04) stands",
    "each case gives the peer and a fake process table, so both sides test with a fake peer reader"]);
  assert.ok(!says(ses, "for a moment") && !says(C4, "for a moment"), "review-54b note 6: no 'for a moment' in the rules of the move");
  assert.ok(!says(ses, "so that a wrong line never admits a wrong session"), "review-19 note 3: the old claim is gone");
});

test("review-18's notes (board ab-v16.50): the file of ended scopes, the freed names, note 9's wording, and literal checks", () => {
  const daemon = C4.slice(C4.indexOf("**The tabs of a session that ended (board ab-v16.41).**"));
  // Note 1: a write or a prune write that fails while the daemon runs.
  for (const s of ["A write that fails while the daemon runs (a full disk, a folder that it cannot write; review-18 note 1): the daemon keeps the name in memory as a name of the file, shows the error on the Browser page, and writes the file again at its next change",
    "No launch takes the name until its prune: a stop then loses only a name that no live session has, and rule 1 leaves it out",
    "A prune whose write fails is the same: the name stays a name of the file, in memory and in the file, the daemon shows the error, and no launch takes the name until a write without it succeeds"]) {
    assert.ok(says(daemon, s), `C4 says: ${s}`);
  }
  // Note 2: the unreadable file.
  assert.ok(says(daemon, "the daemon counts the name of every live session as a name of the file, shows the error on the Browser page, and writes the file again with those names before its first `set_scopes` (review-18 note 2). The tabs of every live session then close once (fail closed)"), "C4: the unreadable file");
  // Note 3: a freed name.
  assert.ok(says(daemon, "A freed name (review-18 note 3): when a prune frees the name of a live session (a new X that launched while X was in the file), or when the gate's first `ok` in time lets in the scope of a launch or a name of the file that a live session has, the daemon sends its next `set_scopes` at once, with that scope"), "C4: a freed name");
  // Note 4 is in review-17f's test (note 9). The old wording is gone.
  for (const s of ["right before the op's `chrome.*` call", "The check reads the receiver's memory with no `await`"]) assert.ok(!says(C10, s), `C10: the old wording is gone: ${s}`);
  // Note 5: the late answer sends the current object.
  assert.ok(says(C4, "The answer can come later than the 10 s (C10, the bound of a `set_scopes` answer); the daemon then sends its current object again, as above"), "C4: the late answer");
  assert.ok(!says(C4, "the daemon then sends the object again"), "C4: the old late-answer text is gone");
  // Note 6: the mutations that no test read (review-18 R03, R09 to R16, R18, R19, R22, R34 to R36): literal checks.
  for (const s of ["The new daemon finds X live, but X is in the file, so its first `set_scopes` leaves X out (rule 1)", "Without the file it would name X at once, and the new session X would get the old session's tabs",
    "A stop before the write then leaves no live session of the name, and rule 1 leaves it out", "and the new daemon keeps it out of one more `set_scopes`",
    "No `set_scopes` has named it since the write, so the new session of the name has no tab that could close", "after a browser restart `chrome.storage.session` is empty",
    "the file holds each name once, so it grows only with the names that end in that time", "So a session that ended while the daemon was down, which is in no file, also stays out of one `set_scopes` with an `ok` in time",
    "no agentwatch session launches while the daemon is down", "a missing file holds no name",
    "A scope that ended while the daemon was down is in no file: with 5 b it falls back to the `default` list after the restart, and the sweep does not close its tabs (a limit; with 5 a it does not exist)"]) {
    assert.ok(says(daemon, s), `C4 says: ${s}`);
  }
  for (const s of ["A marked tab is never a bridge tab (a bridge tab that gets the mark is detached: each tab's scope, below), so its check of `debugger.sendCommand` is one more layer",
    "A call that went to Chrome before its tab joined the set runs to its end (what stops a handler, below)",
    "An op of the removal queue gets the check when its item starts: a tab joins the set only at the end of a sweep item (or as a new tab), and one item runs at a time"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  // R03 and R22: no sentence says it in other words without its exception.
  for (const x of sentences(protocol).filter((t) => /(names|lists) every live session/.test(t))) assert.ok(/names every live session( in its first `set_scopes` on each connection)?, except a scope that rule 2 (of C4 )?keeps out/.test(x), `the exception: ${x}`);
  for (const x of [...sentences(C5), ...sentences(C10)].filter((t) => /never enters the map|is never in the map|never gets into the map/.test(t))) assert.ok(x.includes("the first applied `set_scopes` after the worker's start"), `the worker-start exception: ${x}`);
  // R32: the tabs.get vector of tab 13 reads tab 13.
  for (const v of bridge.requests.filter((r) => r.perScope && r.req.op === "tabs.get")) assert.equal(v.res.data.id, v.req.args[0], "tabs.get answers the tab that it reads");
});

test("the bridge vector names all three sides", () => {
  for (const stage of ["stage 2", "stage 3", "stage 4"]) assert.ok(bridge.contract.includes(stage), stage);
});

// ---- C11: the endpoint ----

test("C11 states the scope rule and the one context of the vector, and the vector's scopes follow the rule", () => {
  assert.ok(C11.includes("`" + endpoint.scope.pattern + "`"));
  assert.ok(C11.includes(`"browserContextId":"${endpoint.defaultContext}"`));
  const re = new RegExp(endpoint.scope.pattern);
  for (const s of endpoint.scope.valid) assert.ok(re.test(s), `valid: ${s}`);
  for (const s of endpoint.scope.invalid) assert.ok(!re.test(s), `invalid: ${JSON.stringify(s)}`);
  // Every agentwatch session name is a scope (agentwatch sessions/naming.py).
  const session = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  for (const s of [...endpoint.scope.valid, ...endpoint.scope.invalid]) if (session.test(s)) assert.ok(re.test(s), s);
});

test("C11 states every answer of the endpoint before the upgrade", () => {
  for (const a of endpoint.upgradeAnswers) {
    assert.ok(C11.includes(`${a.status} \`${a.body}\``), `${a.status} ${a.body}`);
  }
  for (const c of endpoint.closes) assert.ok(C11.includes(`${c.code}, \`${c.reason}\``), `${c.code} ${c.reason}`);
});

test("C11 states the relay's constants", () => {
  for (const [name, value] of Object.entries(endpoint.constants)) assert.ok(C11.includes(`\`${name} = ${value}\``), `C11 has \`${name} = ${value}\``);
});

// Before the upgrade (C11): the order of the checks, with and without the peer check.
const answerById = Object.fromEntries(endpoint.upgradeAnswers.map((a) => [a.id, a]));
const closeById = Object.fromEntries(endpoint.closes.filter((c) => c.id).map((c) => [c.id, c]));
// The fake process table of a case: its world, with the case's entries in place of the world's.
function worldOf(c) {
  const w = new Map(endpoint.procs.filter((p) => p.world === c.world).map((p) => [p.pid, p]));
  for (const p of c.procs ?? []) {
    if (p.gone) w.delete(p.pid);
    else w.set(p.pid, p);
  }
  return w;
}
const MAX_HOPS = 32;
const key = (pid, start) => `${pid}:${start}`;
// The walk from pid (hop 0) through its parents: the first process that matches a root of `named`
// (by pid and start), or null when it reaches pid 1, a pid that has gone, a parent 0, a parent whose
// start time is later than its child's (its pid came back), or 32 hops.
function walk(w, pid, named, child = null) {
  // child: the process whose parent pid is the first hop (its start time bounds the parent's).
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const s = w.get(pid);
    if (!s || (child !== null && s.start > child.start)) return null;
    if (named.has(key(pid, s.start))) return key(pid, s.start);
    if (pid === 1 || s.ppid === 0) return null;
    child = s;
    pid = s.ppid;
  }
  return null;
}
// The defensive root rules (C11, the scope's session): which roots of the line count, for the walk
// and for the cgroup, from the stat and the cgroup of each root.
function rootsThatCount(roots, w) {
  const named = new Map();
  for (const [scope, list] of Object.entries(roots)) {
    for (const { pid, start } of list) {
      const k = key(pid, start);
      if (!named.has(k)) named.set(k, { pid, start, scopes: new Set() });
      named.get(k).scopes.add(scope);
    }
  }
  for (const r of named.values()) {
    const s = w.get(r.pid);
    r.live = s !== undefined && s.start === r.start;
    r.cgroup = r.live ? s.cgroup : null;
  }
  const ancestors = new Set();
  for (const r of named.values()) {
    if (!r.live) continue;
    const rest = new Map([...named].filter(([k]) => k !== key(r.pid, r.start)));
    const above = walk(w, w.get(r.pid).ppid, rest, w.get(r.pid)); // the root's parent is compared with the root (review-19b note 7)
    if (above) ancestors.add(above);
  }
  const live = [...named.values()].filter((r) => r.live);
  for (const [k, r] of named) {
    r.scope = r.scopes.size === 1 ? [...r.scopes][0] : null;
    r.counts = r.live && r.scope !== null && !ancestors.has(k);
    const parent = r.live ? w.get(w.get(r.pid).ppid) : undefined;
    r.cgroupCounts = r.counts && typeof r.cgroup === "string" && parent !== undefined && parent.cgroup !== r.cgroup &&
      !live.some((o) => o !== r && [...o.scopes].some((x) => x !== r.scope) && o.cgroup === r.cgroup) &&
      !live.some((o) => o !== r && typeof o.cgroup === "string" && o.cgroup.startsWith(r.cgroup + "/"));
  }
  return named;
}
// Step 3: the peer read at the accept.
function peerRead(c) {
  const p = c.peer;
  if (!p.read || !(Number.isInteger(p.pid) && p.pid > 0) || p.uid !== "own") return false;
  return c.relay.selfTest === "pidfd" ? isObj(p.pidfd) : Number.isInteger(p.start);
}
// Step 6: the session check. The root that admits the connection, or null.
function sessionCheck(c, a, scope) {
  const w = worldOf(c), p = c.peer, form = c.relay.selfTest;
  const alive = () => {
    const s = w.get(p.pid);
    if (!s || s.state === "Z") return false;
    if (form === "pidfd") return p.pidfd.poll === 0 && p.pidfd.fdinfoPid === p.pid; // 1: readable (exited); -1: an error
    return s.start === p.start; // the stat form and the Mac: the start of the accept
  };
  if (!alive()) return null;
  const named = rootsThatCount(a.roots, w);
  const at = walk(w, p.pid, named);
  let admitted = null;
  if (at !== null) {
    const r = named.get(at);
    admitted = r.counts && r.scope === scope ? at : null; // any other root refuses, whatever the cgroup says
  } else if (form !== "mac") {
    const cg = w.get(p.pid).cgroup;
    for (const [k, r] of named) {
      if (r.scope === scope && r.cgroupCounts && typeof cg === "string" && (cg === r.cgroup || cg.startsWith(r.cgroup + "/"))) admitted = k;
    }
  }
  return admitted !== null && alive() ? admitted : null;
}
function admit(c) {
  const headers = c.request.headers ?? {};
  if (Object.hasOwn(headers, "origin")) return "fromPage"; // 1
  const url = new URL(c.request.path, "http://relay");
  const m = /^\/devtools\/browser\/([^/]*)$/.exec(url.pathname);
  if (!m || !SCOPE.test(m[1])) return "notFound"; // 2
  const scope = m[1];
  const relay = c.relay;
  if (c.peerCheck) { // 3
    if (relay.selfTest === "failed") return "cannotRead";
    if (!peerRead(c)) return "peerUnread";
  }
  if (!relay.link) return "notConnected"; // 4
  if (relay.bridge === 0) return "tooOld";
  if (relay.line === null) return "notConfirmed";
  if (relay.bridge === null) return "notConnected";
  const a = applyLine(endpoint.lines[relay.line], c.peerCheck);
  if (a.failClosed) return "rootsWithout";
  if (c.peerCheck && !Object.hasOwn(a.scopes, scope)) return "noList"; // 5
  if (c.peerCheck && sessionCheck(c, a, scope) === null) return "session"; // 6
  if (a.listOf(scope) === null || (relay.ended ?? []).includes(scope)) return "noList"; // 7
  return c.request.upgrade === false ? "notFound" : 101; // 8: a plain request gets no connection
}

test("before the upgrade: each check vector gets the answer of C11's order", () => {
  const seen = new Set();
  for (const c of endpoint.upgradeChecks) {
    const want = c.answer?.status === 101 ? 101 : c.answer;
    assert.ok(want === 101 || Object.hasOwn(answerById, want), `${c.note}: a known answer`);
    assert.equal(admit(c), want, c.note);
    seen.add(want);
  }
  for (const a of endpoint.upgradeAnswers) assert.ok(seen.has(a.id), `a check vector for ${a.id}`);
  assert.ok(seen.has(101), "a vector of an upgrade");
  const steps = ["1. A request with an `Origin` header", "2. A path or scope that does not match", "3. With the peer check, the peer read", "4. The relay is not ready", "5. With the peer check, a scope that the last `allowlist` line does not name", "6. With the peer check, the session check", "7. A scope with no list"];
  for (const s of steps) assert.ok(C11.includes(s), `C11 has the step ${s}`);
  assert.ok(C11.includes("`upgradeChecks`") && C11.includes("`lineCloses`"), "C11 names the vectors");
  assert.equal(answerById.session.body.split("<pid>").length, 2, "the session's 403 holds the peer's pid once");
  for (const list of [endpoint.upgradeAnswers, endpoint.closes.filter((c) => c.id)]) assert.equal(new Set(list.map((x) => x.id)).size, list.length, "each id once");
});

test("the session check: each world is a process table, and each rule of C11 has a vector", () => {
  for (const p of endpoint.procs) {
    assert.ok(["linux", "noScope", "mac"].includes(p.world), p.note);
    assert.ok(Number.isSafeInteger(p.pid) && p.pid > 0 && Number.isSafeInteger(p.ppid) && Number.isSafeInteger(p.start), p.note);
    assert.ok(["S", "R", "Z"].includes(p.state), p.note);
    assert.ok(p.world === "mac" ? p.cgroup === null : typeof p.cgroup === "string" && p.cgroup.startsWith("/"), `${p.note}: a cgroup on Linux only`);
  }
  for (const world of ["linux", "noScope", "mac"]) {
    const pids = endpoint.procs.filter((p) => p.world === world).map((p) => p.pid);
    assert.equal(new Set(pids).size, pids.length, `${world}: each pid once`);
  }
  for (const c of endpoint.upgradeChecks) {
    for (const k of Object.keys(c)) assert.ok(["note", "peerCheck", "relay", "request", "peer", "world", "procs", "answer"].includes(k), `${c.note}: a known field ${k}`);
    for (const k of Object.keys(c.relay)) assert.ok(["link", "bridge", "line", "selfTest", "ended"].includes(k), `${c.note}: a known relay field ${k}`);
    for (const k of Object.keys(c.request)) assert.ok(["path", "headers", "upgrade"].includes(k), `${c.note}: a known request field ${k}`);
    for (const k of Object.keys(c.peer ?? {})) assert.ok(["read", "pid", "uid", "pidfd", "start"].includes(k), `${c.note}: a known peer field ${k}`);
    if (isObj(c.peer?.pidfd)) for (const k of Object.keys(c.peer.pidfd)) assert.ok(["poll", "fdinfoPid"].includes(k), `${c.note}: a known pidfd field ${k} (review-19b note 8)`);
  }
  const checked = endpoint.upgradeChecks.filter((c) => c.peerCheck);
  for (const c of checked) {
    assert.ok(["pidfd", "stat", "mac", "failed"].includes(c.relay.selfTest), `${c.note}: the self-test's result`);
    assert.ok(isObj(c.peer) && ["linux", "noScope", "mac"].includes(c.world), `${c.note}: a peer and a world`);
    assert.equal(c.relay.selfTest === "mac", c.world === "mac", `${c.note}: the Mac's form in the Mac's world`);
    if (c.relay.selfTest === "pidfd") assert.ok(Object.hasOwn(c.peer, "pidfd") && !Object.hasOwn(c.peer, "start"), c.note);
    if (["stat", "mac"].includes(c.relay.selfTest)) assert.ok(Object.hasOwn(c.peer, "start") && !Object.hasOwn(c.peer, "pidfd"), c.note);
  }
  for (const c of endpoint.upgradeChecks.filter((x) => !x.peerCheck)) assert.ok(!Object.hasOwn(c.relay, "selfTest") && !Object.hasOwn(c, "peer"), `${c.note}: no peer read without the peer check`);
  const by = (answer, f) => checked.some((c) => (c.answer?.status === 101 ? 101 : c.answer) === answer && f(c, worldOf(c)));
  const proc = (c, w) => w.get(c.peer.pid);
  const chainTo = (c, w, pid) => { let x = c.peer.pid; for (let i = 0; i <= MAX_HOPS && w.has(x); i++) { if (x === pid) return i; x = w.get(x).ppid; } return -1; };
  // The peer read (step 3).
  assert.ok(by("peerUnread", (c) => !c.peer.read), "SO_PEERCRED fails");
  assert.ok(by("peerUnread", (c) => c.peer.read && c.relay.selfTest === "pidfd" && c.peer.pidfd === null), "SO_PEERPIDFD fails: the same 403 (review-54b note 1)");
  assert.ok(by("peerUnread", (c) => c.peer.pid === 0), "no pid");
  assert.ok(by("peerUnread", (c) => c.peer.uid !== "own"), "another uid");
  for (const form of ["stat", "mac"]) assert.ok(by("peerUnread", (c) => c.relay.selfTest === form && c.peer.start === null), `${form}: no start at the accept`);
  assert.ok(by("peerUnread", (c) => !c.relay.link), "the peer's 403 also while the link is down");
  assert.ok(by("cannotRead", (c) => !c.relay.link) && by("cannotRead", (c) => !c.peer.read), "the self-test's 503 also while not ready, before the peer's 403");
  assert.ok(by("fromPage", (c) => !c.peer.read) && by("notFound", (c) => !c.peer.read) && by("notFound", (c) => c.relay.selfTest === "failed"), "Origin and the 404 come before the peer read");
  // The alive checks (review-54b note 2: each counts alone).
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && proc(c, w)?.state === "Z" && c.peer.pidfd.poll === 0 && c.peer.pidfd.fdinfoPid === c.peer.pid), "Z before the pidfd polls readable");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && c.peer.pidfd.poll === 1 && proc(c, w)?.state !== "Z"), "a readable pidfd while the state is not Z");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && c.peer.pidfd.poll === -1 && c.peer.pidfd.fdinfoPid === c.peer.pid && proc(c, w)?.state !== "Z"), "a poll that returns -1 (review-19 note 5)");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && c.peer.pidfd.poll === 0 && ![-1, c.peer.pid].includes(c.peer.pidfd.fdinfoPid) && proc(c, w)?.state !== "Z"), "an fdinfo pid that is not -1 and not the peer's (review-19 V10)");
  for (const c of checked.filter((x) => x.relay.selfTest === "pidfd" && isObj(x.peer.pidfd))) assert.ok([0, 1, -1].includes(c.peer.pidfd.poll) && Number.isInteger(c.peer.pidfd.fdinfoPid), `${c.note}: poll and fdinfoPid`);
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && c.peer.pidfd.fdinfoPid === -1 && proc(c, w)?.state !== "Z"), "an fdinfo pid of -1");
  for (const form of ["stat", "mac"]) {
    assert.ok(by("session", (c, w) => c.relay.selfTest === form && proc(c, w) && proc(c, w).start !== c.peer.start), `${form}: a start that changed`);
    assert.ok(by("session", (c, w) => c.relay.selfTest === form && proc(c, w)?.state === "Z" && proc(c, w).start === c.peer.start), `${form}: Z`);
  }
  assert.ok(by("session", (c, w) => c.relay.selfTest === "stat" && !proc(c, w)), "stat: the pid has gone by the walk");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && !proc(c, w)), "pidfd: the pid has gone");
  // The walk and the cgroup.
  const scopeOf = (c) => new URL(c.request.path, "http://relay").pathname.split("/").pop();
  assert.ok(by(101, (c) => (applyLine(endpoint.lines[c.relay.line], true).roots[scopeOf(c)] ?? []).some((r) => r.pid === c.peer.pid)), "the pane's process itself (hop 0)");
  assert.ok(by(101, (c, w) => c.world === "mac" && chainTo(c, w, 4000) === MAX_HOPS) && by("session", (c, w) => c.world === "mac" && w.get(c.peer.pid)?.ppid === 4032), "a root at hop 32 counts, at hop 33 not");
  assert.ok(by(101, (c, w) => c.world === "linux" && w.get(proc(c, w)?.ppid)?.note.startsWith("systemd --user")), "the pane's cgroup admits a re-parented peer");
  assert.ok(by("session", (c, w) => c.world === "mac" && w.get(proc(c, w)?.ppid)?.note === "launchd"), "the Mac: no cgroup for a re-parented peer");
  assert.ok(by("session", (c, w) => c.world === "noScope" && proc(c, w)?.ppid === 1144) && by(101, (c) => c.world === "noScope"), "no scope of its own: the walk only");
  assert.ok(by("session", (c, w) => c.world === "noScope" && proc(c, w)?.ppid === 1144 && [...w.values()].filter((p) => p.ppid === 3000).length === 1), "a lone pane in its parent's cgroup: the cgroup does not count");
  assert.ok(by(101, (c, w) => (c.procs ?? []).some((p) => p.pid === 3100 && !p.gone && p.ppid === 3200)), "the walk passes a pid whose start is not the root's");
  assert.ok(by("session", (c, w) => proc(c, w)?.cgroup?.startsWith("/user.slice/user-1001.slice/user@1001.service/app.slice/tmux-spawn-1a2b.scope") && !proc(c, w).cgroup.startsWith("/user.slice/user-1001.slice/user@1001.service/app.slice/tmux-spawn-1a2b.scope/") && proc(c, w).cgroup !== "/user.slice/user-1001.slice/user@1001.service/app.slice/tmux-spawn-1a2b.scope"), "a cgroup name that is no path under the root's");
  assert.ok(by(101, (c, w) => proc(c, w)?.cgroup?.endsWith(".scope/job")), "a cgroup under the root's");
  for (const [answer, line, what] of [["session", "peerSharedRoot", "two scopes name a root"], [101, "peerSharedRoot", "the other root of such a scope counts"], ["session", "peerServerRoot", "an ancestor of another root"], [101, "peerServerRoot", "the root under it counts"],
    ["session", "peerNested", "a nested cgroup"], ["session", "peerNoRoots", "a line with no roots"], ["session", "peerNoLead", "a scope with no root"], [101, "peerLeadTwice", "a root named twice by one scope"], [101, "peerTwoPanes", "a second pane"]]) {
    assert.ok(by(answer, (c) => c.relay.line === line), `${what} (${line})`);
  }
  assert.ok(by("session", (c) => (c.procs ?? []).some((p) => p.pid === 3200 && p.cgroup?.endsWith("tmux-spawn-1a2b.scope"))), "a cgroup that a root of another scope shares");
  // review-19 B1, B2: a shared root from both scopes; an ancestor root's cgroup, for a peer whose walk does not pass it; a walk
  // that stops at a root that does not count, for a peer in the cgroup of a root of the scope that counts.
  const shared = applyLine(endpoint.lines.peerSharedRoot, true).roots;
  const sharedRoot = shared["md-lead"].find((r) => shared["md-worker"].some((o) => o.pid === r.pid && o.start === r.start));
  for (const sc of ["md-lead", "md-worker"]) assert.ok(by("session", (c, w) => c.relay.line === "peerSharedRoot" && scopeOf(c) === sc && chainTo(c, w, sharedRoot.pid) >= 0), `a shared root, from ${sc}`);
  const server = applyLine(endpoint.lines.peerServerRoot, true).roots["md-worker"][0];
  assert.ok(by("session", (c, w) => c.relay.line === "peerServerRoot" && chainTo(c, w, server.pid) < 0 && proc(c, w)?.cgroup === w.get(server.pid).cgroup), "an ancestor root's cgroup admits no one (F2)");
  assert.ok(by("session", (c, w) => c.relay.line === "peerSharedRoot" && scopeOf(c) === "md-worker" && chainTo(c, w, sharedRoot.pid) >= 0 && shared["md-worker"].some((r) => r.pid !== sharedRoot.pid && proc(c, w)?.cgroup === w.get(r.pid).cgroup)), "the walk stops at a root that does not count, whatever the cgroup (F3)");
  assert.ok(by("session", (c) => c.relay.line === "peerUnnamedShares" && Object.keys(applyLine(endpoint.lines.peerUnnamedShares, true).roots).some((sc) => !Object.hasOwn(endpoint.lines.peerUnnamedShares.scopes, sc))), "a root of a scope that scopes does not name counts for the defensive rules (V21)");
  assert.ok(by("session", (c, w) => c.relay.line === "peer" && (c.procs ?? []).some((p) => p.pid === 3100 && !p.gone && p.start === 6000 && !w.has(p.ppid)) && proc(c, w)?.ppid === 1144), "a root whose parent the relay cannot read: no cgroup (V19)");
  assert.ok(by("session", (c, w) => (c.procs ?? []).some((p) => p.pid === proc(c, w)?.ppid && p.start > proc(c, w).start)) && by(101, (c, w) => (c.procs ?? []).some((p) => p.pid === proc(c, w)?.ppid && p.start === proc(c, w).start)), "a parent later than its child stops the walk; the same start does not (note 7)");
  assert.ok(by("session", (c) => c.relay.line === "peerLeadNull" && (c.procs ?? []).some((p) => p.pid === 3100 && p.gone)), "the ended session with 5 b: the session's 403 after the line (note 2)");
  // review-19b note 2: the walk compares each parent with its own child (hop 1 is later than hop 2, the peer is later than both).
  assert.ok(by("session", (c, w) => { const a = proc(c, w), b = w.get(a?.ppid), d = w.get(b?.ppid); return a && b && d && b.start < a.start && d.start > b.start && a.start > d.start; }), "a parent later than its child, though not later than the peer (note 2)");
  // review-19b note 7: the ancestor rule compares a root's parent with the root.
  assert.ok(by(101, (c, w) => { const all = Object.values(applyLine(endpoint.lines[c.relay.line], true).roots).flat(); return all.some((r) => { const x = w.get(r.pid), up = x && w.get(x.ppid); return up && up.start > x.start && all.some((o) => o.pid === x.ppid && o.start === up.start); }); }), "a root whose parent is a root that started later: no ancestor (note 7)");
  // The refusal after end_scope is step 7, and a plain request has the same order.
  assert.ok(checked.some((c) => c.answer === "noList" && (c.relay.ended ?? []).includes(scopeOf(c))) && by("session", (c) => (c.relay.ended ?? []).includes(scopeOf(c))), "an ended scope: step 6 before step 7");
  assert.ok(endpoint.upgradeChecks.some((c) => !c.peerCheck && c.answer === "noList" && (c.relay.ended ?? []).includes(scopeOf(c))), "an ended scope without the peer check");
  for (const answer of ["notFound", "session", "noList"]) assert.ok(checked.some((c) => c.request.upgrade === false && c.answer === answer), `a plain request gets ${answer} with the peer check`);
  assert.ok(endpoint.upgradeChecks.some((c) => !c.peerCheck && c.request.upgrade === false && c.answer === "notFound"), "a plain request that is admitted gets the 404");
  assert.ok(endpoint.upgradeChecks.every((c) => c.request.upgrade !== false || c.answer !== 101), "a plain request never gets an upgrade");
  assert.ok(by("session", (c) => (c.procs ?? []).some((p) => p.pid === 3100 && !p.gone && p.start !== 6000)), "a root pid with another start");
  assert.ok(by("session", (c) => c.peer.pid === 3203 && c.request.path.endsWith("/md-lead")) && by(101, (c) => c.peer.pid === 3203 && c.request.path.endsWith("/md-worker")), "the walk decides over a joined cgroup");
  assert.ok(by(101, (c) => c.peer.pid === 3302 && c.request.path.endsWith("/md-lead")), "the cost: the server path counts as the server's session (review-54)");
  // The roots' life: the session's end (ab-6gs) and a respawn.
  assert.ok(by("session", (c) => c.relay.line === "peer" && (c.procs ?? []).some((p) => p.pid === 3100 && p.gone)), "the session ended, before the line: the session's 403");
  assert.ok(checked.some((c) => c.answer === "noList" && c.relay.line === "peerLeadGone" && c.request.path.endsWith("/md-lead")), "the session ended, after the line: the no-list 503");
  assert.ok(by("session", (c) => c.relay.line === "peerRespawned") && by(101, (c) => c.relay.line === "peerRespawned"), "after a respawn: the old pane's job refused, the new pane's agent admitted");
  // Step 6 comes before step 7, and step 5 before step 6.
  assert.ok(by("session", (c) => c.request.path.endsWith("/md-none")) && checked.some((c) => c.answer === "noList" && c.request.path.endsWith("/md-none")), "step 6 before step 7");
  assert.ok(checked.some((c) => c.answer === "noList" && c.peer.pid === 3500), "step 5 before step 6");
});

test("the refusal after end_scope: each sequence follows C11", () => {
  const ids = new Set(Object.keys(endpoint.lines));
  let admits = 0, refuses = 0;
  for (const c of endpoint.endScopes) {
    let ended = new Set(), line = null;
    for (const st of c.steps) {
      if (st.line !== undefined) {
        assert.ok(ids.has(st.line), `${c.note}: a known line`);
        line = applyLine(endpoint.lines[st.line], c.peerCheck);
        for (const sc of [...ended]) if (Object.hasOwn(line.scopes, sc)) ended.delete(sc); // a line that names it, also with null
      } else if (st.endScope !== undefined) {
        ended.add(st.endScope);
      } else {
        assert.equal(st.restart, true, c.note);
        ended = new Set();
        line = null;
      }
    }
    assert.ok(line !== null, `${c.note}: a line came`);
    const refused = (c.peerCheck && !Object.hasOwn(line.scopes, c.scope)) || ended.has(c.scope) || line.listOf(c.scope) === null;
    assert.equal(refused ? "noList" : "admit", c.answer, c.note);
    if (refused) refuses++; else admits++;
  }
  assert.ok(admits >= 4 && refuses >= 4, "both answers");
  const has = (f) => endpoint.endScopes.some(f);
  assert.ok(has((c) => !c.peerCheck && c.answer === "admit" && c.steps.some((s) => s.line === "plainLeadDropped") && c.steps.some((s) => s.line === "plainLeadNull")), "5 b: the default list admits the scope after the null entry is dropped");
  assert.ok(has((c) => c.peerCheck && c.answer === "noList" && c.steps.some((s) => s.line === "peerLeadGone")), "with the peer check, an unnamed scope gets the no-list 503");
  assert.ok(has((c) => c.answer === "noList" && c.steps.some((s) => s.line === "plainLeadDropped") && !c.steps.some((s) => s.line === "plainLeadNull")), "a line that does not name the scope keeps the refusal");
  assert.ok(has((c) => c.answer === "admit" && c.steps.some((s) => s.restart)) && has((c) => c.answer === "noList" && c.steps.some((s) => s.restart)), "the limit: a restart loses the set; a replayed null entry is safe");
  assert.ok(has((c) => c.answer === "admit" && c.steps.some((s) => s.restart) && c.steps.at(-1).line === "plainLeadDropped"), "the limit: after a restart a line that does not name the scope admits it by default");
  assert.ok(has((c) => c.answer === "admit" && c.steps.some((s) => s.endScope === "md-worker")), "an end_scope of another scope does not touch this one");
});

test("at each allowlist line: each close vector follows C11", () => {
  for (const c of endpoint.lineCloses) {
    const scope = c.connection.scope;
    const a = applyLine(endpoint.lines[c.line], c.peerCheck);
    let got = null;
    if (a.failClosed || (c.peerCheck && !Object.hasOwn(a.scopes, scope)) || a.listOf(scope) === null) got = "noList";
    else if (c.peerCheck && !(Object.hasOwn(a.roots, scope) && a.roots[scope].some((r) => r.pid === c.connection.root.pid && r.start === c.connection.root.start))) got = "root";
    assert.equal(got, c.close, c.note);
    assert.equal(c.connection.root === null, !c.peerCheck, `${c.note}: a root with the peer check only`);
  }
  for (const id of ["noList", "root"]) {
    assert.equal(closeById[id]?.code, 1008, id);
    assert.ok(endpoint.lineCloses.some((c) => c.close === id), `a vector for ${id}`);
  }
  assert.ok(endpoint.lineCloses.some((c) => c.close === null), "a vector of a connection that stays");
  assert.ok(endpoint.lineCloses.some((c) => c.close === null && c.line === "peerSharedRoot"), "an open connection stays when another scope names its root too");
  assert.ok(endpoint.lineCloses.some((c) => c.close === "root" && applyLine(endpoint.lines[c.line], true).roots[c.connection.scope]?.some((r) => r.pid === c.connection.root.pid && r.start !== c.connection.root.start)), "the same pid with another start closes");
});

// Where a call goes (C11's table): the model, Chrome, or a refusal.
function route(session, method, params = {}, child = false) {
  if (session === "root") return endpoint.modelSet.includes(method) ? "the model" : "refused";
  if (method === "Target.setAutoAttach") return "Chrome";
  if (method === "Target.getTargetInfo") return params.targetId === undefined ? "Chrome" : "the model";
  if (method === "Target.detachFromTarget") return child ? "Chrome" : "the model";
  if (/^(Target|Browser)\./.test(method)) return endpoint.pageModelSet.includes(method) ? "the model" : "refused";
  return "Chrome";
}

test("C11's table says where each call of the model's set goes, and the routing vectors agree", () => {
  const rows = table(C11, "| Method | On the root or a browser session | On a page session |");
  assert.deepEqual([...rows.keys()].sort(), [...endpoint.modelSet].sort());
  for (const [method, cells] of rows) {
    assert.equal(cells[0], "the model", method);
    assert.ok(cells[1].startsWith(route("page", method)), `${method}: ${cells[1]}`);
  }
  for (const r of endpoint.routing) assert.equal(route(r.session, r.method, r.params, r.child === true), r.to, `${r.session} ${r.method} ${JSON.stringify(r.params)}`);
  for (const m of endpoint.pageModelSet) assert.ok(endpoint.modelSet.includes(m), m);
});

// A refusal template of C11 as a regular expression: each <placeholder> stands for one word.
const templateRe = (t) =>
  new RegExp("^" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<[a-z]+>/g, "[^ ]+") + "$");

test("C11 states every refusal template, and each refusal vector follows one", () => {
  for (const t of endpoint.templates) assert.ok(C11.includes("`" + t + "`"), `C11 has \`${t}\``);
  const res = endpoint.templates.map(templateRe);
  for (const r of endpoint.refusals) {
    const hits = res.filter((re) => re.test(r.error));
    assert.equal(hits.length >= 1, true, `${r.method}: ${r.error}`);
    assert.ok(["root", "page"].includes(r.session), r.method);
    if (!r.example) assert.ok(C11.includes("`" + r.method + "`") || C11.includes("`" + r.method.split(".")[0] + ".*`"), `C11 names ${r.method}`);
  }
});

// The refusals of C11 that depend on the params (page marks, cookies, URLs, contexts).
const MAIN_WORLD = (name) => typeof name !== "string" || name === "";
const NAVIGATE_OK = (url) => url === "about:blank" || /^(https?|data):/i.test(url) || /^blob:https?:\/\//i.test(url);
const NEW_TAB_OK = (url) => url === undefined || url === "" || url === "about:blank" || /^https?:/i.test(url);
const schemeOf = (url) => /^([a-z][a-z0-9+.-]*:)/i.exec(url)?.[1].toLowerCase() ?? "relative";
const named = (list, re) => Array.isArray(list) && list.some((h) => isObj(h) && re.test(String(h.name)));
// binaryResponseHeaders: base64 of name\0value\0name\0value...
const binaryNamed = (b64, re) => {
  if (typeof b64 !== "string") return false;
  const parts = Buffer.from(b64, "base64").toString("utf8").split("\0");
  return parts.some((p, i) => i % 2 === 0 && re.test(p));
};
const COOKIE = /^cookie$/i;
const SET_COOKIE = /^set-cookie$/i;
// The scope's list of the samples (C11, the refusals): a navigation of the main frame, a new tab, a
// grant with an origin, off the list.
const onList = (host) => endpoint.scopeList.some((d) => host === d || host.endsWith("." + d));
const webHost = (url) => {
  const u = /^blob:/i.test(String(url)) ? String(url).slice(5) : String(url);
  if (!URL.canParse(u)) return null;
  const p = new URL(u);
  return /^https?:$/.test(p.protocol) ? p.hostname : null;
};
const offList = (url) => {
  const h = webHost(url);
  return h !== null && !onList(h);
};
const mainFrame = (params) => params.frameId === undefined || params.frameId === endpoint.mainFrameId;
function paramRefusal(method, params = {}) {
  switch (method) {
    case "Page.addScriptToEvaluateOnNewDocument": return MAIN_WORLD(params.worldName);
    case "Runtime.addBinding": return MAIN_WORLD(params.executionContextName);
    case "Storage.clearDataForOrigin":
    case "Storage.clearDataForStorageKey":
      return String(params.storageTypes ?? "").split(",").map((s) => s.trim()).some((s) => s === "cookies" || s === "all");
    case "Network.setExtraHTTPHeaders": return isObj(params.headers) && Object.keys(params.headers).some((h) => COOKIE.test(h));
    case "Fetch.continueRequest": return named(params.headers, COOKIE);
    case "Fetch.fulfillRequest":
    case "Fetch.continueResponse":
      return named(params.responseHeaders, SET_COOKIE) || binaryNamed(params.binaryResponseHeaders, SET_COOKIE);
    case "Page.navigate": return !NAVIGATE_OK(params.url ?? "") || (mainFrame(params) && offList(params.url ?? ""));
    case "Target.createTarget": {
      const ctx = params.browserContextId;
      return (ctx !== undefined && ctx !== endpoint.defaultContext) || !NEW_TAB_OK(params.url) || offList(params.url ?? "");
    }
    case "Browser.grantPermissions": return params.origin === undefined ? null : offList(params.origin);
    default: return null;
  }
}

test("the refusals and passes that depend on the params follow C11's rules", () => {
  for (const r of endpoint.refusals) {
    const hit = paramRefusal(r.method, r.params);
    if (hit !== null) assert.equal(hit, true, `refused: ${r.method} ${JSON.stringify(r.params)}`);
    // A URL refusal names the URL's scheme, or "relative".
    if (/ URLs \(/.test(r.error)) assert.ok(r.error.includes(`browser: ${schemeOf(r.params.url)} URLs (${r.method})`), r.error);
    // A refusal off the scope's list names the host.
    if (r.error.startsWith("Not allowed: ")) assert.equal(r.error, `Not allowed: ${webHost(r.params.url ?? r.params.origin)} is not on the allowlist`, r.method);
  }
  for (const p of endpoint.passes) {
    assert.notEqual(paramRefusal(p.method, p.params), true, `passes: ${p.method} ${JSON.stringify(p.params)}`);
  }
  assert.ok(endpoint.refusals.some((r) => /^file:/.test(r.params?.url ?? "")), "S12: a file: URL is refused");
  assert.ok(endpoint.refusals.some((r) => schemeOf(r.params?.url ?? "x:") === "relative"), "a relative URL is refused");
  assert.ok(endpoint.passes.some((p) => p.method === "Target.createTarget" && p.params.url === ""), "an empty url is about:blank");
  // The refusals per scope (C11): the main frame, a blob: inner origin, a new tab, and a frame passes.
  const offRefused = endpoint.refusals.filter((r) => r.error.startsWith("Not allowed: "));
  assert.ok(offRefused.some((r) => r.method === "Page.navigate" && r.params.frameId === undefined), "the main frame with no frameId");
  assert.ok(offRefused.some((r) => r.method === "Page.navigate" && r.params.frameId === endpoint.mainFrameId), "the main frame by its frameId");
  assert.ok(offRefused.some((r) => r.method === "Page.navigate" && /^blob:/.test(r.params.url)), "a blob: URL");
  assert.ok(offRefused.some((r) => r.method === "Target.createTarget"), "a new tab");
  assert.ok(endpoint.passes.some((p) => p.method === "Page.navigate" && p.params.frameId !== undefined && !mainFrame(p.params) && offList(p.params.url)), "a frame's navigation passes (O11)");
});

test("every cookie call of C11 is a refusal vector", () => {
  for (const m of endpoint.cookieMethods) {
    assert.ok(C11.includes("`" + m + "`"), `C11 names ${m}`);
    assert.ok(endpoint.refusals.some((r) => r.method === m), `a refusal vector for ${m}`);
  }
});

test("C11 states the limits of the cookie rule", () => {
  for (const s of endpoint.cookieLimits) assert.ok(C11.includes(s), `C11 says: ${s}`);
});

// The cookie marker of C11, at any depth: Cookie and Set-Cookie values and rawCookieLine
// become the marker, the cookie lists [].
const COOKIE_HEADER = /^(cookie|set-cookie)$/i;
const LISTS = ["associatedCookies", "blockedCookies", "exemptedCookies"];
const HEADER_OBJECTS = ["headers", "requestHeaders"];
const HEADER_LISTS = ["headers", "responseHeaders"];
const HEADER_TEXTS = ["headersText", "requestHeadersText"];
const RAW_LINES = ["rawCookieLine"];
function hide(x, marker) {
  if (Array.isArray(x)) return x.map((y) => hide(y, marker));
  if (!isObj(x)) return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (LISTS.includes(k) && Array.isArray(v)) out[k] = [];
    else if (HEADER_OBJECTS.includes(k) && isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([h, s]) => [h, COOKIE_HEADER.test(h) ? marker : s]));
    else if (HEADER_LISTS.includes(k) && Array.isArray(v)) out[k] = v.map((h) => (isObj(h) && COOKIE_HEADER.test(h.name) ? { ...h, value: marker } : h));
    else if (HEADER_TEXTS.includes(k) && typeof v === "string") out[k] = v.replace(/^((?:set-)?cookie):[^\r\n]*/gim, `$1: ${marker}`);
    else if (RAW_LINES.includes(k) && typeof v === "string") out[k] = marker;
    else out[k] = hide(v, marker);
  }
  return out;
}

test("each cookie marker vector follows C11's rule", () => {
  assert.ok(C11.includes("`" + endpoint.cookieMarker + "`"), "C11 names the marker");
  for (const name of [...LISTS, ...HEADER_OBJECTS, ...HEADER_LISTS, ...HEADER_TEXTS, ...RAW_LINES]) {
    assert.ok(C11.includes("`" + name + "`"), `C11 names ${name}`);
  }
  assert.ok(endpoint.cookieHide.length > 0);
  for (const v of endpoint.cookieHide) {
    assert.ok(/^(Network|Fetch|Audits)\./.test(v.method), v.method);
    assert.ok(C11.includes("`" + v.method + "`"), `C11 names ${v.method}`);
    assert.notDeepEqual(v.in, v.out, `${v.method}: the vector hides something`);
    assert.deepEqual(hide(v.in, endpoint.cookieMarker), v.out, v.method);
  }
  for (const m of ["Network.webSocketHandshakeResponseReceived", "Audits.issueAdded"]) {
    assert.ok(endpoint.cookieHide.some((v) => v.method === m), `a vector for ${m}`);
  }
  assert.ok(endpoint.cookieHide.some((v) => Object.hasOwn(v.in, "redirectResponse")), "a vector for redirectResponse");
});

// ---- review-20 (board ab-v16.31): the decisions of ab-lead, in the text of C4, C5, C6 and C10 ----

test("review-20's decisions are the contract: the closing rule at a set_scopes that is not applied, the sweep's tabs at a failed query, the owed worker removal, the import's cookies, a failed copy write, the fallback's detach and the limits of the start", () => {
  const C6 = section("C6");
  const checks = [
    // Q2: one bad message closes no live session's page; its scope rules still fail closed.
    [C4, "Such a `set_scopes` is not applied (C5, the sweep): its scope rules go as this rule says, so each new navigation of an agent tab fails closed, but the receiver sweeps nothing, and its closing rule judges each tab by the last applied `set_scopes`"],
    [C5, "The lists are those of the last applied `set_scopes` (the sweep, below): at a `set_scopes` that is not applied, the closing rule judges each tab by the last applied one, and with no applied one since the worker's start it closes no tab"],
    [C5, "its closing rule judges each tab by the last applied one (the closing rule, above)"],
    // B1: a failed or late query of the sweep's item.
    [C5, "When its `tabs.query` failed or came late, the item picked no tab: the tabs of the sweep are then the tabs of the map whose scope the new object gives no list"],
    // B2 and note 3: the worker removal.
    [C5, "A failed removal, or one that has not ended within `REMOVAL_WAIT_MS` (C10), fails the call (`ok: false`) after the tabs closed, and the receiver logs it; the next call removes again."],
    [C5, "A call that answers `ok: false` for another reason (a failed rule update, rule 5 or key removal) moves no \"last\" either, but its new rules can be in force: so the next call removes the workers too"],
    // Q1 and note 5: the import.
    [C6, "A step that fails after step 1's cookie swap (for example \"write storage\") leaves the swap as it is: the old cookies of `domain` are removed and the sent ones are set, and no cookie goes back."],
    [C6, "so the daemon's Browser page says that the sign-in was sent but that the named step failed"],
    [C6, "A close that has not ended within its item's wait (a page that a dialog holds), or a window rule that fails, fails the step (\"close tabs\")"],
    // Q3, note 2, notes 3 and 4: C10.
    [C10, "A write of its key in the copy that fails is handled as a failed rule update of that tab: the new tab leaves the map, joins the orphan set and closes, and the op answers with the error"],
    [C10, "The late part of such a removal removes nothing more, so it never takes the rules of that full replace"],
    [C6, "after the item the step reads the tabs again (`tabs.query`) and fails too while a tab of the origin is open (a close that ended with an error can leave it open): no cookie is swapped while a page of the origin can be open"],
    [C10, "the fallback then calls `chrome.tabs.remove` at once and ends its own attach only after the command answered, because a detach makes a running command fail"],
    [C10, "The removal of every session rule before the read has `RESTORE_MAX_MS` too: one that fails or has not ended by then fails closed, and the receiver logs it; its next full replace removes every rule of the scheme (the scope rules and rule 8, and rules 6 and 7 when no import runs)"],
  ];
  for (const [text, s] of checks) assert.ok(says(text, s), s);
  // The old wordings are gone.
  assert.ok(!says(C5, "A failed removal fails the call (`ok: false`) after the tabs closed; the next call removes again."));
});

test("part 1b's decisions are the contract (ab-v16.32, PR #21 questions 1 to 4): the retry reloads a GET only, the waits of a held or waiting tabs.onCreated, the retry of the first navigation, the four names", () => {
  const checks = [
    // Q1: no reload for a request that is not a GET, so a form's POST fails closed with no dialog.
    "The retry reloads a GET only (ab-lead, PR #21 question 1). The receiver reads the method of the blocked request from `webRequest.onErrorOccurred` (permission `webRequest`; the receiver only reads it).",
    // review-21 notes 3 and 5: the method when the block comes, and a withheld permission.
    "The method of the tab's last blocked main-frame request of the same URL must be `GET` both when `webNavigation.onErrorOccurred` comes and at the reload's time (review-21 note 3); a request that is not a GET, or whose method the receiver has not seen then, gets no reload.",
    "When Chrome withholds the permission (no `chrome.webRequest`), the bridge still starts and logs one line, every method is unknown, and no popup gets a retry (fail closed; review-21 note 5).",
    "So a form that posts into a new tab fails closed, with no dialog, and its `blocked` notice goes at the decision.",
    "Chrome's `tabs.reload` of a blocked POST opens its \"Confirm Form Resubmission\" dialog in the popup, which waits for a person",
    "Chrome shows no install warning for `webRequest`",
    "one when the request is not a GET or its method is not known",
    "(a host off the list, a popup of no scope, a request that is not a GET, a retry that is blocked again, a retry that starts no request)",
    // Q2: a popup of no scope or of the orphan set waits HOLD_MAX_MS at about:blank.
    "A popup of no scope or of the orphan set has no rule, so `RULE_QUIET_MS` never ends its hold: when it stays at `about:blank`, its `tabs.onCreated` comes `HOLD_MAX_MS` after Chrome's (or never, when it closes first). No session sees such a tab (C11), so that wait holds no client back",
    // Q3: a tab that closes while its tabs.onCreated waits.
    "A tab that closes while its `tabs.onCreated` waits gets none; its `tabs.onRemoved` goes as usual",
    // Q4: the first navigation only.
    "The retry is only for the popup's first navigation (ab-lead, PR #21 question 4): from its first main-frame commit that is not `about:blank` on, a block sends its notice at once and gets no retry, and a page that commits while the retry waits cancels it",
    // The measured delay of bridge.tabScope.
    "and before the popup's `tabs.onCreated` in 500 of 500",
  ];
  for (const s of checks) assert.ok(says(C10, s), s);
  // The four waits have names in C10, with the receiver's values.
  for (const [name, value] of Object.entries({ NEW_TAB_WAIT_MS, RULE_QUIET_MS, RETRY_AFTER_MS, RETRY_START_MS })) {
    assert.ok(C10.includes(`\`${name} = ${value}\``), `C10 has \`${name} = ${value}\``);
  }
  assert.deepEqual([NEW_TAB_WAIT_MS, RULE_QUIET_MS, RETRY_AFTER_MS, RETRY_START_MS], [50, 50, 50, 1000]);
  // The agent package has the permission that C10 names, and the old wordings are gone.
  assert.ok(JSON.parse(read("agent/manifest.json")).permissions.includes("webRequest"));
  for (const old of ["A POST is not sent again", "The packed agent has no `webRequest`", "a POST that Chrome does not send again", "Part 1b's live test measures the delay", "or 50 ms late when none comes"]) {
    assert.ok(!says(C10, old), `gone: ${old}`);
  }
});

// Part 1d (board ab-v16.34): C10 states the operator mark as the receiver builds it, with its measures and its limits,
// and the receiver's New Tab URL is the one that C10 names.
test("C10 states part 1d's operator mark as built: where the mark comes from, what removes it, the eager attach, the measures and the limits", async () => {
  const { NEW_TAB_URL } = await import("../agent/receiver.js");
  assert.ok(says(C10, "a tab that starts at `" + NEW_TAB_URL + "`, that no page opened and that no bridge op created gets the **operator mark**"));
  for (const s of [
    "The receiver builds it from version 0.3.2 (part 1d, board ab-v16.34)",
    "the tab's `pendingUrl`, else its `url`, is exactly `chrome://newtab/`, no `webNavigation.onCreatedNavigationTarget` of the tab came before, and the tab is not in the map",
    "Ctrl+T and Ctrl+N (a new window) give `url` `\"\"` and `pendingUrl` `chrome://newtab/`",
    "a navigation target of the tab that comes after the mark removes it",
    "A tab of `tabs.create` or `windows.create` loses a mark at its entry write",
    "the receiver ends the hold (the held requests continue), detaches the tab, and its `tabs.onCreated` says `\"attached\":false,\"held\":false`. So a marked tab is never a bridge tab",
    "The marks live in memory only, as the orphan set does: the copy holds no mark",
    "a page's `window.open(\"chrome://newtab/\")` opened no tab",
    "CDP key events of Ctrl+T and Ctrl+N (`Input.dispatchKeyEvent` with `nativeVirtualKeyCode` through the bridge, and Playwright's `keyboard.press` through the relay) opened no tab",
    "The first tab of a browser that starts at its New Tab page gets no mark",
    "A program of the operator's OS user that sends X input to the live view's display (Ctrl+T, then a URL) gets a marked tab",
    // review-22: B1, note 3 and note 4.
    "and `debugger.sendCommand` sends no `Target.createTarget` (the kind `method`). So a bridge op never opens a site, a `chrome:`, `file:` or `javascript:` URL, or Chrome's New Tab page",
    "Of the `Target` domain only the methods that the relay sends to Chrome (C11, where each call goes; the vector's `targetMethods`)",
    "a mark that its own `tabs.onCreated` gave it goes first",
    "Measured on Google Chrome 157 too (review-22): Ctrl+T and Ctrl+N give `url` `\"\"` and `pendingUrl` `chrome://newtab/`, with no navigation target",
  ]) assert.ok(says(C10, s), `C10 says: ${s}`);
  for (const m of bridge.targetMethods) assert.ok(says(C10, "`" + m + "`"), `C10 names ${m}`);
  assert.ok(!says(C10, "Google Chrome stable's URL in `tabs.onCreated` of a new tab is not measured"), "measured now");
  assert.ok(!says(C10, "that a page cannot open a `chrome://` page is Chrome's rule, not measured"), "measured now");
  // Part 1d built the mark in 0.3.2; a later part raises the version (part 1c: 0.3.3).
  const [maj, min, pat] = JSON.parse(read("agent/manifest.json")).version.split(".").map(Number);
  assert.ok(maj > 0 || min > 3 || (min === 3 && pat >= 2), "the manifest's version is 0.3.2 or later");
});

// The contract states the operator's answers and the collected notes (board task ab-v16.55).
test("the contract states choices 3 and 6 as decided", () => {
  assert.ok(says(protocol, "and this file states both as decided"), "the intro");
  assert.ok(says(C4, "The operator's own tabs (the design's choice 3, decided in ab-dm6): the tabs that the operator opens in the live view open any site. So the daemon sends `\"operator\":\"*\"` in each `set_scopes`."), "choice 3 in C4");
  assert.ok(says(C4, "A send (C2) adds its site to no list (the design's choice 6, decided in ab-dm6). A sent sign-in joins no repo's list"), "choice 6 in C4");
  assert.ok(says(C4, "So the import (C6) adds the site to no list"), "the import adds the site to no list");
  assert.ok(says(C4, "until the operator adds it to a list in the web viewer"), "only the operator adds the site");
  for (const gone of ["agentwatch decides which list a sent site joins", "its recommendation: no list", "depend on choice 3 of the", "with the design's choice 3"]) assert.ok(!says(protocol, gone), `no open choice: ${gone}`);
});

test("C11 states the refusal after end_scope, its order and the plain request", () => {
  for (const t of [
    "From the `end_scope` on, the relay refuses each new connection of that scope with the no-list 503 (step 7), also over a link change, until a later `allowlist` line names the scope again",
    "also with a `null` entry",
    "without the peer check the `default` list then admits the scope again, and with the peer check step 5 gives it the no-list 503",
    "The relay keeps this set of ended scopes in memory only.",
    "the line that the daemon replays to a restarted relay must not name an ended scope with a list",
    "With the peer check this refusal is step 7 too, after the session check: a process of another session gets the session's 403 first",
    "8. A request that passes steps 1 to 7 and is no WebSocket upgrade (a plain HTTP request)",
    "So a plain request gets the same checks in the same order as an upgrade, and the 404 only when the scope is admitted.",
    "`endScopes` in `test/vectors/endpoint.json`",
  ]) assert.ok(says(C11, t), t);
  assert.ok(says(C4, "From the `end_scope` on, the relay refuses new connections of the scope with the no-list 503 until a later `allowlist` line names it again, also with a `null` entry"), "C4");
  assert.ok(says(C4, "the relay keeps that in memory only, so the line that the daemon replays to a restarted relay must not name an ended scope with a list"), "C4: the limit");
  assert.ok(says(C11, "gets no connection: the 404 of step 2"), "step 8: the 404");
  assert.ok(says(C10, "until a later line names it again (C11)"), "C10");
});

test("C11 holds review-19b's notes", () => {
  assert.ok(says(C11, "The daemon does not hold a respawn for that `ok` (review-19b note 3)"), "note 3");
  assert.ok(says(C11, "the agent gets the 503 of step 4 (`its extension has not confirmed the allowlist`)"), "note 3: step 4");
  assert.ok(says(C11, "the peer's parent (the relay's own pid) and the peer's start time"), "note 4");
  assert.ok(says(C11, "With 5 b it gets the session's 403 only until the line of C4's rule 3 drops the `null` entry"), "note 5");
  assert.ok(says(C11, "after the rule 3 line the scope is unnamed and step 5 gives the no-list 503 (review-19b note 5)"), "note 5: step 5");
  assert.ok(says(C11, "a parent whose start time is later than the other root's start time is no parent, so it is no ancestor; review-19b note 7"), "note 7");
});
