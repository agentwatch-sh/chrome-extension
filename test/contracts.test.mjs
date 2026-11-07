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
  // The operator's decision on ab-7wg (2026-11-06): service workers stay on; C5 states it and its residues, and waits on no answer.
  assert.ok(says(C5, "The operator chose to keep service workers on (board item ab-7wg, 2026-11-06, the recommended option)"), "C5: the decision of ab-7wg");
  assert.ok(says(C5, "- The guard (service workers stay on: the operator chose the design's choice 2 a, board items ab-8zv and ab-7wg; the residues are below)"), "C5: the guard's heading");
  // review-27 notes 2 and 3, review-28 B1 (board ab-v16.73): the two residues are those of a worker of another scope's site: the own-page form as
  // measured (from memory, no request) and the pass-on form of ab-8zv; a worker of a host on no list is a case of its own (ab-v16.74).
  assert.ok(says(C5, "so the build stays as it is, with two residues for a worker of another scope's site. (1) The own-page form: such a worker can answer a navigation of a scope's tab with its own page (no request); that page commits and runs its scripts for some tens of ms (the measures above) before layer 3 sends the tab away, and a client attached to the tab can read it meanwhile."), "C5: the residue of ab-7wg, the own-page form");
  assert.ok(says(C5, "(2) The pass-on form (board item ab-8zv): such a worker that passes the navigation on sends its request to its site, with the site's cookies, and the site's answer comes back to the worker; its page does not run (the measure below). In both forms, both scopes are the operator's own agents, and no site outside the lists is reached."), "C5: the residue of ab-7wg, the pass-on form");
  // review-28b notes 1 and 2 (board ab-v16.74): the case of a host on no list with its measured effects, and the build that closes it
  // except while the operator's own tab is on that host (ab-214).
  assert.ok(says(C5, "A worker of a host on no list, registered from a marked tab with `\"*\"`, can also answer a navigation of a scope's tab (measured, board ab-v16.73, receiver 0.3.4: the worker's own page committed and ran in 80 of 80; the cached signed-in page ran in 36 of 40, and its request sent the sign-in cookie in 36 of 36; the client got the page's title in 116 of 116, in the bridge's `tabs.onUpdated`, which the relay sends as `Target.targetInfoChanged`; the client's own init script ran in the page in 58 of 58 and sent the title to the client's own site)."), "C5: the worker of a host on no list, measured (ab-v16.73)");
  assert.ok(says(C5, "From receiver 0.3.5 the receiver removes such a site's workers when no marked tab shows a frame of that site any more (the worker removal of the recorded origins, above; the operator's choice on board item ab-214)"), "C5: the worker of a host on no list, the build (ab-v16.74)");
  for (const s of ["asked the operator again", "this text changes when the answer changes the build", "can replace it with a block of service workers", "from its cache (no request)", "with this residue:", "until that build this case stays open"]) assert.ok(!says(C5, s), `C5 no longer says: ${s}`);
});

// Board ab-v16.74 (the operator's answer ab-214; review-30 and ab-lead's decisions): the worker removal of the recorded origins, as
// agent/workers.js builds it; review-28b note 3: the worker removal's sentence on a new scope and a scope with no list.
test("C5 states the worker removal of the recorded origins: every tab's origins, Chrome's origin filter, the site rule, the check, the events, the windows, the bound, the shared call, the residue, the cost and the measure", () => {
  for (const s of [
    "- The worker removal of the recorded origins (board ab-v16.74, receiver 0.3.5; the operator chose on board item ab-214, 2026-11-06, the recommended option: remove such a site's workers when the operator's tab leaves it;",
    "each web origin (`http:`/`https:`, and a `blob:` URL's inner origin) that a frame of any tab commits (`webNavigation.onCommitted`, the top frame and every sub-frame: a frame can register a worker for its own origin): the marked tabs whatever the `operator` value, the tabs of a scope, the restore tab of an import and every other tab",
    "one key per origin (`worker:<origin>`, the value `true`)",
    // review-30 B3.
    "`browsingData.remove({origins: [o]})` removes the worker of `o` itself (its first-party storage key) and every partitioned worker whose top-level site is the site of `o`",
    "It does not remove a worker that a frame of `o` registered under the top-level site of another page.",
    "the receiver never removes the workers of an origin while a marked tab shows a frame of the same site",
    "The site here is the scheme and the last two labels of the host (an IP address, or a host of one or two labels, as it is); the port does not count.",
    "The rule then keeps more workers, never fewer.",
    "a frame of such a host under a page of a listed site, in a scope's tab, got that worker's page in 5 of 5 (review-30; O11: the guard does not check frames)",
    // The check.
    "The receiver reads the frames of each marked tab (`webNavigation.getAllFrames`) and keeps the last read of each one",
    "For each recorded or waiting origin whose site no marked tab shows and that no list of the last applied `set_scopes` covers, the receiver calls `browsingData.remove({origins: [...]}, {serviceWorkers: true})`, in calls of at most 500 origins",
    "every list of `lists` counts, also the `operator` list and a list that no scope names (the listed sites keep their workers, board item ab-7wg)",
    "for example at the end of a session, when its scope's list becomes `null` (the removal of every worker, above, does not run then)",
    // review-30 B1 and note 4.
    "at each commit and at each navigation error (`webNavigation.onErrorOccurred`: a navigation that ends on an error page sends no `onCommitted`; review-30 B1) of a frame of any tab",
    "when a tab loses the mark or gets it at its `tabs.onCreated` or `tabs.onReplaced` (a popup that gets the mark at its navigation target starts no check: its own commits do)",
    // review-30 notes 1 and 2.
    "the removal ends at most about 4 x `REMOVAL_WAIT_MS` (8 s) after the event while each call ends in time",
    "A frame that a page script removes after its load sends no event (before the end of its load Chromium sends `onErrorOccurred`, review-30b note 6): that tab's last read still shows it, so its site stays shown until that tab's next frame event (a commit or a navigation error), its close, its replace or its mark loss. This window has no time limit while that tab has none of these",
    // review-30c B1: the reads, the work and the guard.
    "a check reads a marked tab again only after an event of its frames (a commit or a navigation error) or when it has no read yet, and reuses the last read of the other marked tabs",
    "Every loop of a check pauses (one task) after each 500 items: over frames, the record, the pending set and the follow-ups, and at a list end's removal of every worker over the shown origins before its call and over the parts after it; each removal call of at most 500 origins is a pause too.",
    // review-30e B1: a new mark or a list change stops the check before its next removal call.
    "A tab that gets the mark during the check (at `tabs.onReplaced` it can show an origin that it committed before the mark), or a change of the lists during the check, stops the check before its next removal call: it keeps the due origins, and one more check reads the new tab and decides",
    // review-30e notes 1 and 2.
    "Until that `set_scopes` a worker of a waiting origin stays, and the case of a host on no list stays open for it",
    // review-30f B1, notes 1 and 3.
    "Each stop (a new mark or a list change during the check, above) adds one more check, so while new marks or list changes keep coming during the checks (for example popups of a marked tab), the removal waits; each stop needs a new marked tab id or an applied `set_scopes` during that check",
    "After that call the record and the pending set lose only the origins that it did not keep (their workers are gone), except one that a tab committed again during the call",
    "and of the origins that tabs commit during that check before the call (no read of the check shows them, its loops go over copies of the record and the pending set, and the bound can drop them;",
    "(3) The follow-up sets hold at most 10,000 origins each: beyond 10,000 removed origins in one period of the follow-up timer, the others get no follow-up check",
    // review-30d B3: the shown sites come only from the reads and the marked commits during the check.
    "The version of a read is taken before the read, so an event of that tab during the read makes the read old for the next check",
    "The shown sites come only from these reads and from the sites of the marked tabs' commits during the running check (refused origins too), never from the record",
    // review-30b note 2: the follow-up check.
    "A follow-up check removes each origin of a removal again (unless it is listed or its site shown then), once, `RECHECK_MS` = 5000 ms to 2 x `RECHECK_MS` after that removal: one timer runs at a time",
    "A read that fails or comes late removes nothing: a worker of a shown origin would break the operator's open page. A removal that fails or comes late keeps its origins in the record or the pending set (Chrome can still end it later). Each logs one line with no origin, and the next check removes again; until then the case stays open.",
    // review-30b B1 and ab-lead's decision: the bound, its residue and its cost.
    "no page content, any number of frames or origins in any tab, can make the receiver remove a worker of a site that a marked tab shows, or of an origin that a list covers while that list is in force",
    "At the bound it refuses a new origin; it never evicts one",
    "A refused origin waits in a pending set in memory, at most `PENDING_MAX` = 10,000 origins, and each check handles it with the record's rules",
    "the receiver calls `browsingData.remove({excludeOrigins: [...]}, {serviceWorkers: true})` once: it removes every worker except those of the origins that the marked tabs show, of the recorded and waiting origins of their sites and of the recorded and waiting origins that the remaining lists cover",
    "A removal of every worker comes only from a list's end (and from C5's removal of every worker, above), never from page content.",
    "The residue of the bound, exactly: only beyond 1000 recorded and 10,000 waiting origins at once",
    // review-30c B3: the residue of the bound as the code does it.
    "(2) A new listed origin then loses its worker at the end of a list entry that covered such an origin (its own entry or the entry of another such origin), also when its own list stays in force",
    "The end of a list that covered no such origin removes nothing",
    "until a list end's removal of every worker (2, below: it keeps such an origin only when a marked tab's last read shows that origin itself, or when a tab commits it during that check before the call)",
    "also removes the partitioned workers of the listed third-party frames under that site",
    "about 50 KB at the bound",
    "The removals share one bounded call (`removeWorkers`)",
    // review-30b notes 1 and 3.
    "A frame on no list inside a scope's listed page, of the same site or a third-party one, loses its worker at the next check, so its offline pages and push stop",
    "A marked tab that Chrome discards sends no frame event, so its last read stays, and its sites stay shown until its reload",
    "the answer of a `set_scopes` depends only on its own removal, and the record keeps an origin until its own removal succeeds",
    "the operator's sites on no list lose their service workers when no marked tab shows a frame of their site any more, and the sites of a list lose theirs when no list covers them any more",
    "`test/live/workers.py`",
  ]) assert.ok(says(C5, s), s);
  // review-28b note 3: a new scope loses no entry; the workers of an old list's sites go by the record.
  assert.ok(says(C5, "Three changes do not remove the workers. A new scope: no list of it loses an entry."), "C5: a new scope");
  assert.ok(says(C5, "Those workers stay at this removal; the removal of the recorded origins (below) removes them when no list covers their host any more and no marked tab shows their site"), "C5: a scope with no list");
  assert.ok(!says(C5, "so no tab of them can reach a worker"), "C5 no longer says that no tab can reach such a worker");
  // review-30 note 3: the windows in the guard's sentence.
  assert.ok(says(C5, "so this case stays open only while the operator's own tab is on that site, and then for the windows of that removal: the end of its check (at most about 4 x `REMOVAL_WAIT_MS` while each call ends in time and no stop comes; while new marks or list changes stop its checks, longer), until the next frame event, close, replace or mark loss of the tab whose frame a page script removed (no time limit), until the next event after a failed read or removal, and for an origin that the bound did not keep (the residue of the bound, above)."), "C5: the windows of the case of a host on no list");
  for (const old of ["at a marked tab's leave", "MEASURE_PLACEHOLDER", "at the end of any list", "so the workers of its sites go at the next check", "one frame read of each marked tab for each check", "evicts the oldest", "it pauses (one task) after each 1000 items", "Each removal arms its own follow-up timer", "until the next check after a frame that a page script removes", "A tab that gets the mark during the reads stops the check", "leaves the decision to its own check"]) assert.ok(!says(C5, old), `C5 no longer says: ${old}`);
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
  // The receiver's ops, then the daemon's own ops (board ab-v16.70): rows of the same table, never ops of the receiver.
  const daemonByName = new Map(bridge.daemonOps.map((o) => [o.op, o]));
  assert.deepEqual([...rows.keys()].sort(), [...opByName.keys(), ...daemonByName.keys()].sort());
  for (const name of opByName.keys()) assert.ok(!name.startsWith("daemon."), `${name}: the prefix daemon. is reserved`);
  for (const [name, cells] of rows) {
    const d = daemonByName.get(name);
    if (d) {
      assert.ok(name.startsWith("daemon."), name);
      assert.equal(cells[0], "`[" + d.args.join(", ") + "]`", `${name}: args`);
      assert.equal(cells[1], d.result, `${name}: result`);
      assert.equal(cells[2], d.wait, `${name}: wait`);
      assert.equal(d.inFlightKey, "pointer", `${name}: its own in-flight key`);
      assert.ok(cells[3].startsWith("Nothing: the daemon answers it itself and never forwards it") && cells[3].includes("A receiver that gets one answers `unknown op`."), `${name}: the receiver's part`);
      continue;
    }
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

// ---- C10 and C11: the agent pointer (board ab-v16.70) ----

// The daemon's own ops (C10): a reference of the daemon's checks, in the order of C10's table. The pointer vectors
// must get its answers; the daemon (agentwatch task age-0kh.28) and the relay (board ab-v16.71) test against the
// same vectors.
const PK = bridge.pointerConstants;
const DAEMON_OPS = new Set(bridge.daemonOps.map((o) => o.op));
const POINTER_CHECKS = ["unknown op", "bad args", "no display", "wrong display", "out of bounds", "busy", "not now", "too many moves", "pointer moved", "too late"];
const isInt = (x) => typeof x === "number" && Number.isInteger(x);
const isPoint = (q, keys) => isObj(q) && Object.keys(q).length === keys.length && keys.every((k) => Object.hasOwn(q, k) && isInt(q[k]));
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2; // a distance is Euclidean, in integers
const inside = (q, w, h) => q.x >= 0 && q.x < w && q.y >= 0 && q.y < h;
const MOVE_KEYS = ["at", "from", "path", "width", "height", "notAfter", "views"];
// The arg of daemon.movePointer: exactly its keys, integers, the path's limits, at inside the request's own size, notAfter.
function moveFits(m, now) {
  if (!isObj(m) || Object.keys(m).length !== MOVE_KEYS.length || !MOVE_KEYS.every((k) => Object.hasOwn(m, k))) return false;
  if (!isInt(m.width) || m.width < 1 || !isInt(m.height) || m.height < 1 || !isInt(m.views) || m.views < 0) return false;
  if (!isPoint(m.at, ["x", "y"]) || !inside(m.at, m.width, m.height) || !isPoint(m.from, ["x", "y"])) return false;
  const path = m.path;
  if (!Array.isArray(path) || path.length < 1 || path.length > PK.POINTER_PATH_MAX_POINTS) return false;
  if (!path.every((q) => isPoint(q, ["x", "y", "dt"]) && q.dt >= PK.POINTER_DT_MIN_MS && q.dt <= PK.POINTER_DT_MAX_MS)) return false;
  if (path.reduce((s, q) => s + q.dt, 0) > PK.POINTER_PATH_MAX_MS) return false;
  if (!path.every((q, i) => dist2(i === 0 ? m.from : path[i - 1], q) <= PK.POINTER_STEP_MAX_PX ** 2)) return false;
  return isInt(m.notAfter) && m.notAfter >= 0 && m.notAfter - now <= PK.POINTER_AHEAD_MAX_MS;
}
// How a play that started ends (the world's play): an end position, or a failure or a kill and its answer (null: none).
const PLAY_ENDS = { fails: "no display", timeout: "no display", operatorInput: "not now", unitStop: "no display", linkChange: "disconnected", relayEnd: null, daemonStop: null };
const scriptOf = (path) => [...path.flatMap((q) => [`sleep ${q.dt / 1000}`, `mousemove ${q.x} ${q.y}`]), "getmouselocation"];
// The daemon's answer to a request in a world: { res, read, script }. skip: checks to leave out (for the order checks).
function daemonAnswer(req, w, skip = new Set()) {
  const fails = (name, cond) => !skip.has(name) && cond;
  const res = (body) => (body === null ? null : { t: "res", ch: "bridge", id: req.id, ...body });
  const no = (error, extra = {}) => ({ res: res({ ok: false, error, ...(extra.data ? { data: extra.data } : {}) }), read: extra.read ?? false, script: null });
  if (!DAEMON_OPS.has(req.op)) return no("unknown op");
  const move = req.op === "daemon.movePointer";
  const args = req.args ?? [];
  const m = Array.isArray(args) ? args[0] : undefined;
  if (fails("bad args", !Array.isArray(args) || (move ? !(args.length === 1 && moveFits(m, w.now)) : args.length !== 0))) return no("bad args");
  if (fails("no display", w.xvfb === null || !w.xdotool)) return no("no display");
  if (move && fails("wrong display", m.width !== w.xvfb.width || m.height !== w.xvfb.height)) return no("wrong display");
  if (move && fails("out of bounds", ![m.from, ...m.path].every((q) => inside(q, m.width, m.height)))) return no("out of bounds");
  if (fails("busy", w.xCall)) return no("busy");
  const lv = w.liveView;
  if (move && fails("not now", lv !== null && (m.views !== lv.views || (lv.lastInputMs !== null && lv.lastInputMs < PK.POINTER_VIEW_QUIET_MS)))) return no("not now");
  if (fails("too many moves", move ? w.started.paths >= PK.POINTER_PATHS_PER_S : w.started.reads >= PK.POINTER_READS_PER_S)) return no("too many moves");
  const views = lv?.views ?? 0;
  if (w.pointer === null) return no("no display", { read: true }); // the read failed or did not end in POINTER_READ_MS
  if (!move) return { res: res({ ok: true, data: { x: w.pointer.x, y: w.pointer.y, width: w.xvfb.width, height: w.xvfb.height, views } }), read: true, script: null };
  if (fails("pointer moved", dist2(w.pointer, m.at) > PK.POINTER_NEAR_PX ** 2)) return no("pointer moved", { read: true, data: { x: w.pointer.x, y: w.pointer.y, views } });
  if (fails("too late", w.playAt > m.notAfter)) return no("too late", { read: true });
  const script = scriptOf(m.path);
  if (isObj(w.play)) return { res: res({ ok: true, data: { x: w.play.end.x, y: w.play.end.y, views } }), read: true, script };
  assert.ok(Object.hasOwn(PLAY_ENDS, w.play), `a known end of a play: ${w.play}`);
  return { res: PLAY_ENDS[w.play] === null ? null : res({ ok: false, error: PLAY_ENDS[w.play] }), read: true, script };
}
// A script's lines: a sleep line compares as a number of seconds, every other line as text.
const sameScript = (a, b) => (a === null || b === null ? a === b : a.length === b.length && a.every((l, i) => {
  const s = /^sleep (\d+(?:\.\d+)?)$/.exec(l), t = /^sleep (\d+(?:\.\d+)?)$/.exec(b[i]);
  return s && t ? Number(s[1]) === Number(t[1]) : l === b[i];
}));
const worldOfVector = (v) => ({ ...bridge.pointerWorld, ...(v.world ?? {}) });
const errorOf = (v) => (v.res === null ? "no answer" : v.res.ok ? "ok" : v.res.error);

test("C10 states the daemon's own ops (board ab-v16.70): the prefix, its place, the X calls, both ops, the play, the counts, the kills, the waits, the key and the data rule", () => {
  for (const [name, value] of Object.entries(PK)) assert.ok(C10.includes(`\`${name} = ${value}\``), `C10 has \`${name} = ${value}\``);
  for (const s of [
    // The prefix and its place (aw-lead's answer 1).
    "The prefix `daemon.` is reserved: an op that starts with it is an op that the daemon answers itself. The daemon never forwards a `daemon.` op to the receiver, and it answers an unknown one `unknown op` itself.",
    "Its place in the daemon's handling of a relay line: after the parse and the duplicate-id check (the requests, above), before the link checks, and outside the daemon's queue and `MAX_BYTES_IN_FLIGHT`.",
    "So the daemon answers a `daemon.` op also while the link is down, and no bridge request waits behind it. The daemon does not use its `wait`.",
    "It also drops a line whose `id` still waits for its answer (the duplicate-id check), also the `id` of a `daemon.` op that runs.",
    "Then it answers a `daemon.` op itself, before its link checks (`not connected`, `disconnected`)",
    // The X calls (aw-lead's answer 2 and the build notes of mail mbf51aeb).
    "The X calls run in a task of their own, one at a time, off the read lock of the relay's lines",
    "Each call runs `xdotool` by its absolute path, with no shell and no `--sync`, in an environment of only `DISPLAY=:<N>` and `XAUTHORITY=<the unit's X auth file>`.",
    "Its commands come from the checked integers only: absolute pointer moves and reads of the pointer, never a button, a key or a read of pixels.",
    "The daemon reads a failure from the exit code, not from standard error; a `getmouselocation` whose `x` and `y` it cannot parse is a failure too.",
    "the daemon records it in `unit.json` when it starts the Xvfb, and reads it from X once for an adopted unit; never from the current config",
    "Only the relay's link reaches the ops: no gateway route, CLI verb, socket or receiver message. No client method of C11 reaches a `daemon.` op.",
    // The two ops and their fields.
    "`daemon.pointerAt`, args `[]`: one `xdotool getmouselocation`, with a timeout of `POINTER_READ_MS = 1000`.",
    "`views`, the count of the operator's live-view inputs (0 while there is no live view). The relay sends it as a probe at each link up",
    "`daemon.movePointer`, args `[move]`. `move` is an object with exactly these keys:",
    "`{x, y}` in `0..width-1` and `0..height-1` of the request's `width` and `height`. A relay that does not know the place sends `daemon.pointerAt` first.",
    "The daemon does not play it: the first step is measured from it.",
    "(120 is the parse bound)",
    "so a path holds at most 93 points (93 x 16 = 1488 ms). Each step (from `from` to the first point, then from point to point) is at most `POINTER_STEP_MAX_PX = 50` px",
    "`notAfter`: whole ms on `CLOCK_MONOTONIC`, which every process of the box shares, so a step of the wall clock does not change it.",
    "The relay reads it as `process.hrtime.bigint() / 1000000n` (Linux), never with `performance.now()`",
    "and sends its clock plus `POINTER_START_MS = 300`. The daemon reads its clock as `time.monotonic_ns() // 1000000` (injected for its tests). The daemon starts no path after `notAfter`.",
    "Each number of `move` is an integer: a JSON number with no fraction part (`true` and `false` are no numbers). A distance is Euclidean: two points are at most `d` px apart when `dx*dx + dy*dy <= d*d`, in integers.",
    // The order and the play.
    "The checks, in this order. The first check that fails gives the answer, and the daemon makes no later X call.",
    "`no display` for a failed or killed X call comes at that call: the read (of either op) or the play.",
    "the daemon plays nothing and answers `pointer moved` with `data` `{\"x\":<int>,\"y\":<int>,\"views\":<int>}`, the read position and the current `views`. The daemon keeps no state of the place.",
    "Else it checks `notAfter` against its clock after the read, so a slow read ends in `too late`, never in a late play.",
    "Then it runs one script on `xdotool -` (standard input, one command a line; an argv only if the live check finds that standard input fails): `sleep <dt/1000>` (seconds) and `mousemove <x> <y>` for each point, then `getmouselocation`.",
    "Its timeout is the path's total time plus `POINTER_KILL_MS = 1000`; at the timeout the daemon kills the call and answers `no display`.",
    "The `ok` answer comes after the last point: `{\"x\":<int>,\"y\":<int>,\"views\":<int>}`, the position that the script's `getmouselocation` read.",
    "The counts of `too many moves`: a play counts when it starts, and a read of `daemon.pointerAt` when its X call starts. The read before a play does not count, and the two counts are apart: a play counts only against the plays, and a read only against the reads. A refusal does not count.",
    // The kills (aw-lead's answer 7) and the live view (answers 4 and 5).
    "The daemon kills a playing path at a relay end (the relay's epoch changes: no answer), at a unit stop (`no display`; the kill comes before the unit's stop steps), at a link change (`disconnected`), at its own stop (no answer: the relay's standard input ends), and at the operator's live-view input (`not now`). After a kill or any failed X call the pointer's place is unknown.",
    "The live view, when it exists (it is not built yet; its rows stay): `not now` for an old `views` and for `POINTER_VIEW_QUIET_MS = 10000` after the operator's last live-view input",
    // The waits and the key (aw-lead's answer 6).
    "`daemon.movePointer` has, per request, `POINTER_START_MS` plus the path's total time plus `POINTER_KILL_MS` plus `POINTER_SLACK_MS = 200` (1565 ms for the example above).",
    "The relay sends that `wait`, and waits at most that long with its own timer: then it goes on with no answer, takes the place as unknown, and drops a late answer. No path can still play then",
    "`daemon.movePointer` and `daemon.pointerAt` have the key `pointer` of their own, so the shared key's queue never holds them back.",
    "A `daemon.` op is outside this limit and the daemon's queue: it never goes to the receiver.",
    "The relay sends each op's default wait. The two `daemon.` ops are the exception: the relay sends `POINTER_READ_WAIT_MS` for `daemon.pointerAt` and a wait per request for `daemon.movePointer`, and the daemon uses neither",
    // review-29 notes N2, N5 and the words of aw-lead's (c).
    "`views`: the `views` that the relay last read, an integer of 0 or more (`not now`, below).",
    "`width`, `height`: the screen size that the relay used (the pages' `screen.width` and `screen.height`), 1 or more.",
    "A `daemon.` op gets the daemon's own answer (the daemon's own ops, below), or none when the relay ends or the daemon stops.",
    "For a `daemon.` op the relay's own timer ends the wait",
    // The data rule (aw-lead's answer 9) and the logs.
    "An error `res` of a `daemon.` op may also carry `\"data\"` (an object): `{\"t\":\"res\",\"ch\":\"bridge\",\"id\":\"<id>\",\"ok\":false,\"error\":\"<text>\",\"data\":{...}}`. A reader ignores `data` on an error that it does not know. The daemon sends `data` only with `pointer moved`",
    "No side logs a point of a `daemon.` op",
    "The daemon logs the op, the text and a count: one line for each text a minute, never a point. The relay logs each text at most once in 5 minutes.",
    "The vectors: `daemonOps`, `pointerConstants`, `pointerWorld` and `pointerVectors` in `test/vectors/bridge.json`, and the bad requests b49 and b50",
  ]) assert.ok(says(C10, s), `C10 says: ${s}`);
  // The numbers that the text derives from the constants.
  assert.equal(Math.floor(PK.POINTER_PATH_MAX_MS / PK.POINTER_DT_MIN_MS), 93, "at most 93 points");
  assert.ok(PK.POINTER_PATH_MAX_POINTS >= 93, "the parse bound is above the most points");
  assert.equal(PK.POINTER_READ_WAIT_MS, PK.POINTER_READ_MS + PK.POINTER_SLACK_MS, "the read's wait is its timeout and the slack");
  // The example of the text is the sample of the first move vector, with its wait.
  const example = /`daemon\.movePointer`, args `\[move\]`\. `move` is an object with exactly these keys:\s*```json\s*(\{.*\})\s*```/s.exec(C10);
  assert.ok(example, "C10 shows an example of move");
  const sample = bridge.pointerVectors.find((v) => v.req.op === "daemon.movePointer" && errorOf(v) === "ok");
  assert.deepEqual(JSON.parse(example[1]), sample.req.args[0], "the example is the first move vector's arg");
  assert.equal(sample.req.wait, 1565, "the example's wait");
  // The intro names the build, the design and who builds each side.
  assert.ok(says(protocol, "The agent pointer (board task ab-v16.70; the design: agent-browser `docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md`, board ab-v16.37, first merged at agent-browser `6bb6838`; its build decisions are in agent-browser PR #68, board ab-v16.71) is in C10 and C11."), "the intro");
  assert.ok(says(protocol, "agentwatch builds the daemon side in its task age-0kh.28 (aw-lead), and the relay its side in board ab-v16.71"), "the intro: the sides");
  assert.ok(says(protocol, "Until the daemon side ships, a `daemon.` op goes to the receiver as any op, the receiver answers `unknown op`, and the relay turns its paths off"), "the intro: an older daemon");
});

test("the checks of the daemon's own ops: C10's table has them in the reference's order, and its op and pointer cells agree with the vectors", () => {
  const rows = table(C10, "| Text | Op | When | The pointer |");
  assert.deepEqual([...rows.keys()], POINTER_CHECKS, "the rows are the checks, in their order");
  // Each "When" cell, word for word (review-29 note N1): the reference above follows these cells.
  const WHEN = {
    "unknown op": "an unknown `daemon.` op; also the answer of a daemon from before this build, whose receiver answers it",
    "bad args": "the args are not exactly the fields above (for `daemon.pointerAt`: not `[]`); a limit of the path is broken; `at` is outside `0..width-1` and `0..height-1` of the request's `width` and `height`; or `notAfter` is negative, not an integer, or more than `POINTER_AHEAD_MAX_MS = 2000` ahead of the daemon's clock",
    "no display": "no unit Xvfb (also on the Mac) or no `xdotool`; or an X call failed or was killed",
    "wrong display": "`width` and `height` are not the running Xvfb's size",
    "out of bounds": "`from` or a point is outside `0..width-1` and `0..height-1`",
    "busy": "another X call of the daemon runs (also a playing path)",
    "not now": "the live view exists, and `views` is not its current count or the operator's last live-view input is less than `POINTER_VIEW_QUIET_MS` old; or that input killed the playing path",
    "too many moves": "`POINTER_PATHS_PER_S = 5` plays (move) or `POINTER_READS_PER_S = 10` reads (read) started in the last second",
    "pointer moved": "the read before the play is more than `POINTER_NEAR_PX` px from `at` (with `data`)",
    "too late": "the daemon's clock is past `notAfter` when the play would start, after the read",
  };
  for (const [text, cells] of rows) assert.equal(cells[1], WHEN[text], `${text}: the When cell`);
  const vs = bridge.pointerVectors.map((v) => ({ v, err: errorOf(v) }));
  for (const [text, [op, , pointer]] of rows) {
    assert.ok(["both", "move"].includes(op), `${text}: both or move`);
    if (text === "unknown op") continue; // an unknown daemon. op (below)
    assert.ok(vs.some(({ v, err }) => err === text && v.req.op === "daemon.movePointer"), `${text}: a vector of daemon.movePointer`);
    assert.equal(vs.some(({ v, err }) => err === text && v.req.op === "daemon.pointerAt"), op === "both", `${text}: a vector of daemon.pointerAt only when the row says both`);
    const of = vs.filter(({ err }) => err === text);
    if (pointer === "not moved" || pointer === "not moved by the op") assert.ok(of.every(({ v }) => v.script === null), `${text}: nothing plays`);
    if (pointer === "not moved, or place unknown after a kill") {
      assert.ok(of.some(({ v }) => v.script === null) && of.some(({ v }) => v.script !== null), `${text}: both cases`);
      assert.ok(of.every(({ v }) => v.script === null || worldOfVector(v).play === "operatorInput"), `${text}: only the operator's input kills`);
    }
    if (pointer === "place unknown") assert.ok(of.some(({ v }) => v.script !== null) && of.some(({ v }) => v.read && v.script === null) && of.some(({ v }) => !v.read), `${text}: before an X call, at the read, and at the play`);
  }
  // The unknown daemon. op: also with args that no op takes.
  assert.ok(vs.some(({ v, err }) => err === "unknown op" && v.req.op.startsWith("daemon.") && !DAEMON_OPS.has(v.req.op) && Array.isArray(v.req.args) && v.req.args.length > 1), "unknown op before bad args");
  // A daemon. op at the receiver: the receiver answers unknown op (bridge.test.mjs runs b49 and b50 against it).
  const atReceiver = bridge.badRequests.filter((v) => v.req.op.startsWith("daemon."));
  assert.deepEqual(atReceiver.map((v) => v.req.op).sort(), [...DAEMON_OPS].sort(), "each daemon. op at the receiver");
  for (const v of atReceiver) assert.equal(v.error, "unknown op", v.req.id);
  // The error texts that are not checks: the kills of a play.
  for (const v of bridge.pointerVectors) {
    const err = errorOf(v);
    if (!["ok", "no answer", ...POINTER_CHECKS].includes(err)) assert.ok(err === "disconnected" && C10.includes("`disconnected`"), `${v.req.id}: a text of C10`);
  }
});

test("each pointer vector gets the answer of C10's checks, in their order (board ab-v16.70)", () => {
  const ids = new Set();
  assert.deepEqual(Object.keys(bridge.pointerWorld).sort(), ["liveView", "now", "play", "playAt", "pointer", "started", "xCall", "xdotool", "xvfb"], "the world's keys");
  for (const v of bridge.pointerVectors) {
    const { req } = v;
    assert.ok(!ids.has(req.id), `${req.id}: a unique id`);
    ids.add(req.id);
    assert.ok(typeof v.note === "string" && v.note.length > 0, `${req.id}: a note`);
    for (const k of Object.keys(v.world ?? {})) assert.ok(Object.hasOwn(bridge.pointerWorld, k), `${req.id}: the world key ${k}`);
    assert.equal(req.t, "req", req.id);
    assert.ok(req.op.startsWith("daemon."), `${req.id}: a daemon. op`);
    assert.ok(int(req.wait) && req.wait >= 1 && req.wait <= K.WAIT_MAX_MS, `${req.id}: the relay always sends a wait`);
    const w = worldOfVector(v);
    const want = daemonAnswer(req, w);
    assert.deepEqual(v.res, want.res, `${req.id}: ${v.note}`);
    assert.equal(v.read, want.read, `${req.id}: read`);
    assert.ok(sameScript(v.script, want.script), `${req.id}: script`);
    for (const l of v.script ?? []) assert.ok(/^(sleep \d+\.\d{3}|mousemove \d+ \d+|getmouselocation)$/.test(l), `${req.id}: a script line ${l}`);
    // The wait that the relay sends (C10, the waits and the key), also in a request that the daemon refuses: the sum of
    // the integer dt of its path (0 with no path).
    if (req.op === "daemon.pointerAt") assert.equal(req.wait, PK.POINTER_READ_WAIT_MS, `${req.id}: the read's wait`);
    else {
      const path = Array.isArray(req.args) && isObj(req.args[0]) && Array.isArray(req.args[0].path) ? req.args[0].path : [];
      const total = path.reduce((s, q) => s + (isObj(q) && isInt(q.dt) ? q.dt : 0), 0);
      assert.equal(req.wait, PK.POINTER_START_MS + total + PK.POINTER_KILL_MS + PK.POINTER_SLACK_MS, `${req.id}: the move's wait`);
    }
    // The answers' shapes: data only on ok and with pointer moved.
    if (v.res !== null) {
      const keys = Object.keys(v.res).sort();
      if (v.res.ok) {
        assert.deepEqual(keys, ["ch", "data", "id", "ok", "t"], req.id);
        const result = bridge.daemonOps.find((o) => o.op === req.op).result;
        assert.deepEqual(Object.keys(v.res.data), [...result.matchAll(/"(\w+)":/g)].map((m) => m[1]), `${req.id}: the result of C10's row`);
      } else if (v.res.error === "pointer moved") {
        assert.deepEqual(keys, ["ch", "data", "error", "id", "ok", "t"], req.id);
        assert.deepEqual(Object.keys(v.res.data), ["x", "y", "views"], `${req.id}: the data of pointer moved`);
      } else assert.deepEqual(keys, ["ch", "error", "id", "ok", "t"], `${req.id}: no data on another error`);
    }
  }
});

test("the pointer vectors cover each check, each bound and each order of C10 (board ab-v16.70)", () => {
  const vs = bridge.pointerVectors.map((v) => ({ v, w: worldOfVector(v), m: v.req.args?.[0], err: errorOf(v), move: v.req.op === "daemon.movePointer", read: v.req.op === "daemon.pointerAt" }));
  const has = (f) => vs.some(f);
  const paths = (x) => x.move && isObj(x.m) && Array.isArray(x.m.path);
  const okMove = (f) => has((x) => x.move && x.err === "ok" && f(x.m, x.w));
  // A bad args vector of a move that breaks the rule of f, and only that rule: the repair fix makes it fit.
  const badMove = (f, fix) => has((x) => paths(x) && x.err === "bad args" && f(x.m, x.w) && (!fix || moveFits(fix(structuredClone(x.m), x.w), x.w.now)));
  const total = (m) => m.path.reduce((s, q) => s + q.dt, 0);
  const steps = (m) => m.path.map((q, i) => ({ dx: q.x - (i === 0 ? m.from : m.path[i - 1]).x, dy: q.y - (i === 0 ? m.from : m.path[i - 1]).y }));
  const at = (m) => isPoint(m.at, ["x", "y"]);
  // The points and the times: each limit holds, and one past it is bad args.
  const D = PK.POINTER_DT_MIN_MS;
  assert.ok(okMove((m) => m.path.length === 93 && m.path.every((q) => q.dt === D)), "93 points of 16 ms");
  assert.ok(badMove((m) => m.path.length === 94 && m.path.every((q) => q.dt === D), (c) => ((c.path.length = 93), c)), "94 points of 16 ms");
  assert.ok(badMove((m) => m.path.length > PK.POINTER_PATH_MAX_POINTS, (c) => ((c.path.length = 93), c)), "above the parse bound");
  assert.ok(badMove((m) => m.path.length === 0), "no point");
  assert.ok(okMove((m) => total(m) === PK.POINTER_PATH_MAX_MS), "the total time at its limit");
  assert.ok(badMove((m) => total(m) === PK.POINTER_PATH_MAX_MS + 1, (c) => ((c.path.at(-1).dt -= 1), c)), "the total time 1 ms past it");
  assert.ok(okMove((m) => m.path.some((q) => q.dt === D)) && badMove((m) => m.path.some((q) => q.dt === D - 1), (c) => (c.path.forEach((q) => { if (q.dt === D - 1) q.dt = D; }), c)), "dt at its least, and 1 ms less");
  const DX = PK.POINTER_DT_MAX_MS;
  assert.ok(okMove((m) => m.path.some((q) => q.dt === DX)) && badMove((m) => m.path.some((q) => q.dt === DX + 1), (c) => (c.path.forEach((q) => { if (q.dt === DX + 1) q.dt = DX; }), c)), "dt at its most, and 1 ms more");
  // The steps: Euclidean, from from too.
  const S = PK.POINTER_STEP_MAX_PX;
  assert.ok(okMove((m) => steps(m).some(({ dx, dy }) => dx * dx + dy * dy === S * S && dx !== 0 && dy !== 0)), "a step of exactly 50 px on both axes");
  assert.ok(badMove((m) => { const d = steps(m)[0]; return d !== undefined && d.dx * d.dx + d.dy * d.dy > S * S; }, (c) => ((c.path[0].x -= Math.sign(c.path[0].x - c.from.x)), c)), "a first step (from from) of 51 px");
  assert.ok(badMove((m) => steps(m).some(({ dx, dy }, i) => i > 0 && dx * dx + dy * dy > S * S && Math.abs(dx) <= S && Math.abs(dy) <= S),
    (c) => (c.path.forEach((q, i) => { if (i > 0) { const a = c.path[i - 1]; if (dist2(a, q) > S * S) Object.assign(q, { x: a.x + 30, y: a.y + 40 }); } }), c)), "a later step over 50 px whose axes are each 50 or less");
  // at: inside the request's width and height.
  assert.ok(okMove((m) => m.at.x === m.width - 1 && m.at.y === m.height - 1) && okMove((m) => m.at.x === 0 && m.at.y === 0), "at on the last and the first column and row");
  assert.ok(badMove((m) => at(m) && m.at.x === m.width, (c) => ((c.at.x -= 1), c)) && badMove((m) => at(m) && m.at.y === -1, (c) => ((c.at.y = 0), c)), "at just outside the request's size");
  assert.ok(badMove((m, w) => at(m) && m.at.x >= m.width && m.at.x < w.xvfb.width, (c) => ((c.at.x = c.width - 1), c)), "at inside the display but outside the request's width");
  assert.ok(has((x) => x.err === "wrong display" && x.m.at.x >= x.w.xvfb.width && x.m.at.x < x.m.width), "at inside the request's width but outside the display: wrong display");
  // from and the points: inside the display.
  assert.ok(okMove((m) => m.path.some((q) => q.x === m.width - 1) && m.path.some((q) => q.y === m.height - 1)) && okMove((m) => m.path.some((q) => q.x === 0) && m.path.some((q) => q.y === 0) && m.from.x === 0), "points on the edges");
  const oob = (f) => has((x) => x.err === "out of bounds" && f(x.m));
  assert.ok(oob((m) => m.path.some((q) => q.x === m.width)) && oob((m) => m.path.some((q) => q.y === m.height)) && oob((m) => m.from.x === -1), "a point past each edge, and from");
  // notAfter.
  const A = PK.POINTER_AHEAD_MAX_MS;
  assert.ok(okMove((m, w) => m.notAfter - w.now === A) && badMove((m, w) => m.notAfter - w.now === A + 1, (c) => ((c.notAfter -= 1), c)), "notAfter at its most ahead, and 1 ms more");
  const now = (c, w) => ((c.notAfter = w.now), c);
  assert.ok(badMove((m) => isInt(m.notAfter) && m.notAfter < 0, now) && badMove((m) => typeof m.notAfter === "number" && !Number.isInteger(m.notAfter), now) && badMove((m) => typeof m.notAfter === "string", now), "notAfter negative, a fraction, a string");
  assert.ok(has((x) => x.err === "too late" && x.m.notAfter < x.w.now), "a notAfter in the past is no bad args: too late after the read");
  assert.ok(okMove((m, w) => w.playAt === m.notAfter) && has((x) => x.err === "too late" && x.w.playAt === x.m.notAfter + 1), "the play at notAfter, and 1 ms after it");
  // The read before the play: against at, never from.
  const N = PK.POINTER_NEAR_PX;
  assert.ok(okMove((m, w) => dist2(w.pointer, m.at) === N * N), "the read exactly 2 px from at");
  assert.ok(okMove((m, w) => dist2(w.pointer, m.at) === 1 && dist2(w.pointer, m.from) > 100 * 100), "the read 1 px from at and far from from");
  assert.ok(has((x) => x.err === "pointer moved" && Math.abs(x.w.pointer.x - x.m.at.x) <= N && Math.abs(x.w.pointer.y - x.m.at.y) <= N), "pointer moved: each axis within 2 px, the distance not");
  assert.ok(has((x) => x.err === "pointer moved" && x.v.res.data.views > 0), "pointer moved with the live view's views");
  // The live view, the counts and the other states.
  const Q = PK.POINTER_VIEW_QUIET_MS;
  assert.ok(okMove((m, w) => w.liveView?.lastInputMs === Q) && has((x) => x.err === "not now" && x.m.views === x.w.liveView.views && x.w.liveView.lastInputMs === Q - 1), "the operator's last input 10 s old, and 1 ms less");
  assert.ok(has((x) => x.err === "not now" && x.m.views !== x.w.liveView.views && x.w.liveView.lastInputMs >= Q), "an old views, and nothing else");
  assert.ok(okMove((m, w) => w.liveView === null && m.views !== 0), "no live view: views not compared");
  assert.ok(okMove((m, w) => w.liveView !== null && w.liveView.lastInputMs === null), "a live view with no input yet");
  assert.ok(has((x) => x.read && x.err === "ok" && x.w.liveView !== null && x.w.liveView.lastInputMs < Q), "a read gets no not now");
  assert.ok(okMove((m, w) => w.started.paths === PK.POINTER_PATHS_PER_S - 1) && has((x) => x.move && x.err === "too many moves" && x.w.started.paths === PK.POINTER_PATHS_PER_S), "the 5th play, and the 6th");
  assert.ok(has((x) => x.read && x.err === "ok" && x.w.started.reads === PK.POINTER_READS_PER_S - 1) && has((x) => x.read && x.err === "too many moves" && x.w.started.reads === PK.POINTER_READS_PER_S), "the 10th read, and the 11th");
  for (const [f, name] of [[(w) => w.xvfb === null, "no unit Xvfb"], [(w) => !w.xdotool, "no xdotool"], [(w) => w.pointer === null, "a failed read"]]) {
    for (const op of ["move", "read"]) assert.ok(has((x) => x[op] && x.err === "no display" && f(x.w)), `no display: ${name} (${op})`);
  }
  assert.ok(has((x) => x.err === "wrong display" && x.m.width === x.w.xvfb.width && x.m.height !== x.w.xvfb.height), "wrong display: the height only");
  for (const end of Object.keys(PLAY_ENDS)) assert.ok(has((x) => x.w.play === end && x.v.script !== null), `a play that ends: ${end}`);
  // The shapes of bad args. Each bad args vector of a move with an object arg differs in one key only from the arg of
  // an ok move vector, except the ones above the most points (their only flaw is the count: the repair above).
  const args = (x) => x.v.req.args ?? []; // a request without args has []
  const oks = vs.filter((y) => y.move && y.err === "ok").map((y) => y.m);
  const differ = (m, o) => [...new Set([...MOVE_KEYS, ...Object.keys(m)])].filter((k) => JSON.stringify(m[k]) !== JSON.stringify(o[k]));
  for (const x of vs.filter((y) => y.move && y.err === "bad args" && args(y).length === 1 && isObj(y.m) && !(Array.isArray(y.m.path) && y.m.path.length > 93))) {
    const keys = oks.map((o) => differ(x.m, o)).sort((a, b) => a.length - b.length)[0];
    // The one with two: at outside a request's width that is smaller than the display (its only flaw is at).
    const atOnly = keys.join() === "at,width" && moveFits({ ...x.m, at: { x: x.m.width - 1, y: x.m.at.y } }, x.w.now);
    assert.ok(keys.length === 1 || atOnly, `${x.v.req.id}: one key differs from an ok move (${keys})`);
  }
  const bad = (f) => has((x) => x.err === "bad args" && f(x));
  assert.ok(bad((x) => x.move && args(x).length === 0 && Object.hasOwn(x.v.req, "args")) && bad((x) => x.move && args(x).length === 2) && bad((x) => x.move && args(x).length === 1 && !isObj(x.m)), "no arg, two args, an arg that is not an object");
  assert.ok(bad((x) => x.move && !Object.hasOwn(x.v.req, "args")), "a move with no args key: its args are [] (review-29 B1 item 4)");
  // The integer rule in each field (review-29 B1 item 3): a fraction, and a boolean where the range would pass it.
  const frac = (n) => typeof n === "number" && !Number.isInteger(n);
  for (const [name, f] of [["at", (m) => isObj(m.at) && (frac(m.at.x) || frac(m.at.y))], ["from", (m) => isObj(m.from) && (frac(m.from.x) || frac(m.from.y))],
    ["a point", (m) => m.path.some((q) => isObj(q) && (frac(q.x) || frac(q.y)))], ["dt", (m) => m.path.some((q) => isObj(q) && frac(q.dt))],
    ["width", (m) => frac(m.width)], ["height", (m) => frac(m.height)], ["views", (m) => frac(m.views)], ["notAfter", (m) => frac(m.notAfter)]]) {
    assert.ok(bad((x) => paths(x) && f(x.m)), `a fraction in ${name}`);
  }
  const bool = (n) => typeof n === "boolean";
  // review-29b note R1 (board ab-v16.75): from, width and height too.
  for (const [name, f] of [["at", (m) => isObj(m.at) && (bool(m.at.x) || bool(m.at.y))], ["from", (m) => isObj(m.from) && (bool(m.from.x) || bool(m.from.y))],
    ["a point", (m) => m.path.some((q) => isObj(q) && (bool(q.x) || bool(q.y)))], ["width", (m) => bool(m.width)], ["height", (m) => bool(m.height)],
    ["views", (m) => bool(m.views)], ["notAfter", (m) => bool(m.notAfter)]]) {
    assert.ok(bad((x) => paths(x) && f(x.m)), `a boolean in ${name}`);
  }
  // The rest of review-29 B1: the counts apart (1), the width alone (2), the end read (5), the read's size (6), notAfter 0 (7).
  assert.ok(okMove((m, w) => w.started.reads >= PK.POINTER_READS_PER_S) && has((x) => x.read && x.err === "ok" && x.w.started.paths >= PK.POINTER_PATHS_PER_S), "the plays and the reads count apart");
  assert.ok(has((x) => x.err === "wrong display" && x.m.width !== x.w.xvfb.width && x.m.height === x.w.xvfb.height), "wrong display: the width only");
  assert.ok(okMove((m, w) => isObj(w.play) && (w.play.end.x !== m.path.at(-1).x || w.play.end.y !== m.path.at(-1).y)), "the answer is the end read, not the last point");
  assert.ok(has((x) => x.read && x.err === "ok" && (x.w.xvfb.width !== bridge.pointerWorld.xvfb.width || x.w.xvfb.height !== bridge.pointerWorld.xvfb.height)), "a read of another display size");
  assert.ok(has((x) => x.err === "too late" && x.m.notAfter === 0 && x.v.read), "notAfter 0: no bad args, too late after the read");
  for (const k of ["at", "views"]) assert.ok(bad((x) => paths(x) && !Object.hasOwn(x.m, k)), `a missing ${k}`);
  assert.ok(bad((x) => paths(x) && Object.keys(x.m).some((k) => !MOVE_KEYS.includes(k))), "an extra key");
  assert.ok(bad((x) => paths(x) && x.m.path.some((q) => isObj(q) && Object.keys(q).length > 3)), "a point with an extra key");
  assert.ok(bad((x) => paths(x) && x.m.path.some((q) => typeof q.x === "number" && !Number.isInteger(q.x))), "a fraction in a point");
  assert.ok(bad((x) => paths(x) && typeof x.m.from.y === "number" && !Number.isInteger(x.m.from.y)), "a fraction in from");
  assert.ok(bad((x) => paths(x) && typeof x.m.views === "boolean"), "a boolean where the range would pass it");
  assert.ok(bad((x) => paths(x) && typeof x.m.width === "string") && bad((x) => paths(x) && x.m.width === 0) && bad((x) => paths(x) && x.m.views === -1), "a string width, a width of 0, views below 0");
  assert.ok(bad((x) => x.move && isObj(x.m) && Object.hasOwn(x.m, "path") && !Array.isArray(x.m.path)), "a path that is not a list");
  assert.ok(bad((x) => x.read && Array.isArray(x.v.req.args) && x.v.req.args.length > 0), "daemon.pointerAt with an arg");
  assert.ok(has((x) => x.read && x.err === "ok" && !Object.hasOwn(x.v.req, "args")), "a request without args has []");
  // The order: for each two checks in turn, a vector that breaks both gets the first; without the first, the second.
  for (const [op, checks] of [["daemon.movePointer", POINTER_CHECKS.slice(1)], ["daemon.pointerAt", ["bad args", "no display", "busy", "too many moves"]]]) {
    for (let i = 0; i + 1 < checks.length; i++) {
      const [first, second] = [checks[i], checks[i + 1]];
      const without = (v) => { try { return errorOf({ res: daemonAnswer(v.req, worldOfVector(v), new Set([first])).res }); } catch { return null; } }; // a broken arg can stop the reference
      assert.ok(bridge.pointerVectors.some((v) => v.req.op === op && errorOf(v) === first && without(v) === second), `${op}: ${first} before ${second}`);
    }
  }
});

test("C11 states the pointer at an activation (board ab-v16.70): the paths' states, the step, its waits and limits, the catch-up, the geometry and the fallback", () => {
  for (const s of [
    "The pointer at an activation (board ab-v16.70; the relay builds it in board ab-v16.71).",
    "So, on Linux with one window per page, the relay has the daemon move the X pointer (C10, the daemon's own ops) along a person-shaped path, from the last point of the page under the pointer to the last point of the page that comes forward, before the window comes forward. It does this for every client.",
    "(agent-browser `docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md`, section 3) gives the reasons",
    // The states: the probe, on, off (an older daemon) and unknown; the front page after the paths turn on.
    "They are unknown until the first answer of the probe, `daemon.pointerAt`, which the relay sends at each link up. An answer turns them on, and gives `at`, the display's size and `views`.",
    "`unknown op`, `wrong display` and `not connected` (an older daemon) turn them off until the next link up, and `no display` for 60 s. `busy`, `too many moves`, `disconnected` and the relay's own timer leave them unknown, and the next step that needs them probes again. Each time the paths turn on, the front page is unknown.",
    "While the paths are off, the relay is exactly as the bullets above say: no geometry read, no wait, no catch-up and no path, and `Page.bringToFront` and `Target.activateTarget` go as above.",
    // What it keeps.
    "a wheel event more than 2 px from it, a child session's pointer input and touch input make it unknown",
    "after failed reads of step 1, after a raise that reached its limit or that failed for an input or a `Page.bringToFront`, and after any client's `Browser.setWindowBounds` (below)",
    "a tab holds a CDP button from a `mousePressed` on any of its sessions, its own or a frame's (review-68 B2), until Chrome answered a `mouseReleased` on any of them",
    // The step, its order and its waits.
    "`Page.bringToFront` and `Target.activateTarget` go through it too: they wait for the chain and for their tab's gate, as an input does, and answer after the step.",
    "1. Read the tab and its window (`tabs.get`, `windows.get`).",
    "2. Decide. With the front page known, a page comes under the pointer when it is not the front page, or, for `Target.activateTarget`, when its tab is not active and its window is the front page's window.",
    "With the front page unknown, the focus decides as above, and no path plays.",
    "3. Wait and hold, only when a path can play, all within one `ACTIVATE_MAX_MS = 2000`; at the limit, no path.",
    "No other page's button counts.",
    "Wait for the end of a catch-up that runs in the front page. Then chain the front page's gate on its old gate",
    "Last, wait for the answers of both pages' pointer input that already went to Chrome.",
    "4. Plan.",
    "none is needed when `at` is T. The path follows agent-browser's `src/input.ts` generator from S to T, sampled every 16 ms,",
    "each `dt` at most 250 ms, stretched in time until no step is over 50 px, with a first step of 2 px or more",
    "5. Play: send `daemon.movePointer`, and wait for its answer, at most its wait.",
    "6. Record (the X records). On `ok` the answered position is the last point of both pages",
    "On `pointer moved` the answered position is `at` and the entering page's last point, and the front page's point is unknown.",
    "the relay reads the pointer (`daemon.pointerAt`) and records it as `at` and as the entering page's point, and after a failed path also as the front page's point",
    "7. The raise: bring the page forward, within one `ACTIVATE_MAX_MS`. For an input, `tabs.update` with `{\"active\":true}` when its tab is not active, and `windows.update` with `{\"focused\":true}` when a page comes under the pointer or its window does not have the focus; the client's `Page.bringToFront`; or the `tabs.update` of `Target.activateTarget`. The raise succeeds when its calls answer with no error within the limit. Then open the front page's gate.",
    "8. The input goes. A press's catch-up, if any, runs inside its chain step, from step 6's record.",
    "The limits: one `ACTIVATE_MAX_MS` for steps 1 and 2, one for step 3, 1.2 s for the reads of step 4 (the geometry's `GEOMETRY_WAIT_MS = 200`, and `daemon.pointerAt`), the path's wait (at most 3 s), 1.2 s for the read after a failed path, and one `ACTIVATE_MAX_MS` for step 7",
    "The worst case is about 11.4 s",
    // The catch-up and its bound per tab (review-63d B1, review-63e note E).
    "a move more than 50 px from it, or a press or a wheel more than 2 px from it, the relay first sends CDP `mouseMoved` events (no button)",
    "The relay decides it when the event leaves the tab's gate, against the page's point at that time.",
    "The catch-up runs once after each X record: never between a client's own events, and never while the page holds a button.",
    "A tab has at most `CATCH_UP_MAX_UNANSWERED = 4` catch-up moves without an answer: no catch-up starts while the tab has unanswered catch-up moves, and when a move is due while 4 wait (a page with an open dialog answers none), the catch-up stops and the client's event goes as with the paths off.",
    "A step and a catch-up never overlap on one page.",
    // The geometry read.
    "one `Runtime.evaluate` in the relay's own isolated world, only for a bridge tab, one in flight per tab, with no `Page.enable` or `Runtime.enable` of the relay's own, and with C10's default wait",
    "a geometry is also not usable when a device-metrics override is in force on the tab",
    // No path, the fallback and an older daemon (review-63e note C).
    "When the relay sends no path, that activation is as with the paths off",
    "(the first activation after the relay's start, after a link change, and after the paths turn on)",
    "With an older daemon (`unknown op`, `not connected`) the paths stay off. On the Mac the relay sends no `daemon.` op.",
    // The links from the existing text.
    "With the paths on, the activation has the steps and the limits of the pointer at an activation (below).",
    "With the paths on (Linux), both go through the activation step (the pointer at an activation, below).",
  ]) assert.ok(says(C11, s), `C11 says: ${s}`);
  // The catch-up's bound is per tab, never per catch-up (review-63e note E), and C10's per-tab limit is the 64 it protects.
  assert.ok(!says(C11, "per catch-up"), "no bound per catch-up");
  assert.ok(says(C11, "So the tab's 64 requests in flight (C10) never fill in front of the client's `Page.handleJavaScriptDialog`.") && K.MAX_IN_FLIGHT_PER_TAB === 64, "the 64 of C10");
  assert.equal(endpoint.constants.ACTIVATE_MAX_MS, 2000, "the 2 s of the activation");
  // The step's worst case: 2 + 2 + 1.2 + 3 + 1.2 + 2 s; the path's wait at most the longest move's wait.
  const longest = PK.POINTER_START_MS + PK.POINTER_PATH_MAX_MS + PK.POINTER_KILL_MS + PK.POINTER_SLACK_MS;
  assert.ok(longest <= 3000, "the path's wait is at most 3 s");
  assert.equal(Math.round((3 * endpoint.constants.ACTIVATE_MAX_MS + 2 * PK.POINTER_READ_WAIT_MS + 3000) / 100) / 10, 11.4, "the worst case");
});

// ab-lead's decisions on agent-browser PR #68 (board ab-v16.71), in C11 by board ab-v16.77.
test("C11 states ab-lead's decisions of board ab-v16.71 (board ab-v16.77): the content box, the kept geometry, a jump with no path and the gate rule", () => {
  const has = (list) => { for (const s of list) assert.ok(says(C11, s), `C11 says: ${s}`); };
  // The content box: the tests and the clamp of the path, the clamp of the catch-up, and where it comes from.
  has([
    "No path when S or T is outside the front page's content box (its viewport less its scrollbars, 2 px inside its edges; ab-lead's decision in board ab-v16.71); none is needed when `at` is T.",
    "each point clamped 2 px inside the front page's content box, in whole pixels (a page gets no mouse event over its scrollbars, so a path over one gave an unexplained change live)",
    "each point clamped 2 px inside the page's content box as in step 4 (from the page's kept geometry, else a read, which keeps no geometry; with neither, or with one that fails the read's own rules (below), no clamp), except the event's own point, which stays where the client sent it.",
    "The read also gives the content box: `visualViewport.width` and `height` (the viewport less its scrollbars, at a scale of 1; else `documentElement.clientWidth` and `clientHeight`).",
    "S or T is outside the front page's content box; the path does not fit the limits",
  ]);
  for (const s of ["2 px inside the front page's viewport", "S or T is outside the front page's viewport"]) assert.ok(!says(C11, s), `C11: no ${s}`);
  // The kept geometry: what the relay keeps, who uses it, where it goes, no path without it, and its limit.
  has([
    "Each page's kept geometry: its last usable geometry from the relay's own reads (below).",
    "The kept geometry (ab-lead's decision in board ab-v16.71; review-68 N2). The relay keeps each page's last usable geometry from its own reads.",
    "Step 4 uses it for a page that is no bridge tab (agent-browser's CLI ends its connection after each command, and the relay then detaches its page), and the catch-up uses it before a read.",
    "The relay drops it at every window event that it sees: any client's `Browser.setWindowBounds`; on the page's own session, a client's `Emulation.setDeviceMetricsOverride`, `Emulation.clearDeviceMetricsOverride`, `Emulation.setVisibleSize`, `Emulation.setPageScaleFactor`, `Emulation.setScrollbarsHidden`, `Page.setDeviceMetricsOverride` or `Page.clearDeviceMetricsOverride`; the page's `Page.frameResized`; its `tabs.onReplaced` (the new tab has none) and its `tabs.onRemoved`; and a link change.",
    "When a page that is no bridge tab has no kept geometry, the step sends no path.",
    "A front page whose `document.visibilityState` is `\"hidden\"` has no usable geometry (a page under the pointer is visible), so the step sends no path.",
    "The limit (review-68 N9): a kept geometry can be out of date when its window moves or changes its size, or its content box changes, with no event that the relay sees: a site popup's `window.moveTo` or `window.resizeTo`, the page's own fullscreen change, or a scrollbar that the page got or lost after the read (with no client attached, no `Page.frameResized` reaches the relay).",
    "The path then follows the old rectangle: real moves and hovers only, at points from the pages' input, at most 5 paths a second, over what lies there now.",
    "a geometry is missing or not usable (a hidden front page has no usable geometry);",
  ]);
  // A step with no path can show one jump or one unexplained change.
  has([
    "A page that never had a pointer event then enters with its first pointer event, which is no position change. A page whose point was known or became unknown enters at the X pointer: at most one unexplained change or one jump.",
    "The entry carries the movement from the page's last point when Chrome still has that point as the base of the movement (the page got pointer input since its window last lost the pointer), so it is a jump when the X pointer is more than 100 px from that point",
  ]);
  assert.ok(!says(protocol, "never a jump"), "docs/protocol.md: no 'never a jump'");
  assert.ok(!says(C11, "one unexplained position change at most, or one jump"), "C11: the words of review-68");
  // The gate rule applies only while the front page holds a button.
  has(["When the front page holds a button, wait for its release. The rule \"no path when its tab's next call waits in the activation chain (its gate is set, or becomes set during the wait)\" applies only while the front page holds a button, because only then does the release wait behind this step"]);
  assert.ok(!says(C11, "wait for its release; no path when"), "C11: the gate rule is no rule of every step");
});

// Review-68's rules of agent-browser PR #68 (board ab-v16.71, head b186c06), in C11 by board ab-v16.77.
test("C11 states review-68's rules of agent-browser PR #68 (board ab-v16.77): the world, the kept read, the held button, the front page by a raise, Browser.setWindowBounds in the chain, the limits", () => {
  const has = (list) => { for (const s of list) assert.ok(says(C11, s), `C11 says: ${s}`); };
  has([
    // B1: a world before each read, and its ids.
    "Each read first sends `Page.createIsolatedWorld` on the main frame and evaluates in the context id that it returns; when the evaluate names an unknown context (a navigation between the two calls), the relay sends both once more",
    "Each read replaces the set of the world's ids with its new id.",
    "On the tab's own session only, the relay drops the world's `Runtime.executionContextCreated` (by the world's name, for any id; the id joins the set), and `Runtime.executionContextDestroyed`, `Debugger.scriptParsed` and `Debugger.scriptFailedToParse` of the ids in the set, so no client sees the world. An id that left the set is no longer the relay's: its events go to the client as any page's events (also a `Runtime.executionContextDestroyed` of the relay's old world, of a context that the client never saw created; a client ignores an id that it does not know). `Runtime.executionContextsCleared` empties the set and still goes to the client. An id that stays in the set until the next read can name a page's context after a navigation, and the relay then drops that page's own events of that id (`Runtime.executionContextDestroyed`, `Debugger.scriptParsed` and `Debugger.scriptFailedToParse`).",
    // N2: the rules of a usable geometry, and the kept read.
    "It also gives `document.visibilityState`.",
    "The read's own rules: a geometry is not usable when the ratio or the scale is not 1, the screen size is not the display's, a width or a height of the viewport or of the content box is 4 px or less, or the content box is wider or taller than the viewport.",
    "The relay's rules: a geometry is also not usable when a device-metrics override is in force on the tab (from a client's `Emulation.setDeviceMetricsOverride` or `Page.setDeviceMetricsOverride` on the page's own session until its `Emulation.clearDeviceMetricsOverride` or `Page.clearDeviceMetricsOverride`, or until the tab is detached), when the window is minimized (the entering page's, by step 1's `windows.get`), or when it is a hidden front page. A read in flight gives no geometry.",
    "It keeps a read only when the read is usable as a front page's geometry: the rules above, not hidden, and not minimized when step 1 read the window.",
    "A read keeps or drops the kept geometry only when it answers within `GEOMETRY_WAIT_MS` and no drop event of the page (below) came after the read started (the relay counts each page's drop events): then a read that is not usable, or that fails, drops the kept one. A late answer is dropped and changes nothing. A catch-up's own read changes no kept geometry.",
    // N1: the front page only by a raise that the relay sends.
    "the page of the last activation step that made it the front page (step 6, after the raise of step 7), or a new tab that comes on top, with no raise (a new active tab that opens a window, or that becomes the active tab of the front page's window)",
    "The front page decides, not the focus, and the raise (step 7) sends `windows.update` with `{\"focused\":true}` also to a focused window. With the front page unknown, the focus decides as above, and no path plays. Then a page becomes the front page (and step 6 records it) only when the raise brings a window forward: the `windows.update` of an input whose window does not have the focus, or the client's `Page.bringToFront` (review-68 N1). A raise that only switches the tab (`tabs.update`, also that of `Target.activateTarget`), or an input whose window has the focus, leaves the front page unknown, with no record: a focused window can lie under a newer window.",
    "Each record that maps a display position into a page gives that page an unknown point when the position is outside the page's viewport, or when the page's geometry is missing or not usable (the read's own rules, and no device-metrics override). The entering page is the front page when the raise (step 7) succeeds and either a page came under the pointer (the front page was known) or, with the front page unknown, the raise brought a window forward (step 7; the rule of step 2); a failed `tabs.update` of `Target.activateTarget` gives the client the error and keeps the front page as it was.",
    // N3: activateTarget's tabs.update after failed reads.
    "When the reads fail or reach their limit, the front page is unknown and no path plays: the input goes with no raise, the client's `Page.bringToFront` goes, and `Target.activateTarget` sends its `tabs.update` within one `ACTIVATE_MAX_MS` (review-68 N3).",
    // B2: a held button on any session.
    "a frame's pointer input still makes the page's point unknown",
    // B3: Browser.setWindowBounds in the activation chain.
    "A client's `Browser.setWindowBounds`, with the paths on, waits in the activation chain (review-68 B3): behind every step already in the chain (the path of the step that runs plays at the window's old place), and behind the catch-ups that run in its window's pages; then the front page is unknown, the kept geometry of every page in the relay's model goes (of every window and every scope), and the window changes. Later steps wait behind it. The window's scope check runs first: a call whose window holds no tab of the client's scope gets `Browser window not found` and changes nothing. With the paths off or unknown it goes at once.",
    // The limit of movement 0 (board ab-v16.76).
    "Movement 0 after a page loses the pointer (measured in board ab-v16.71; its follow-up is board ab-v16.76): when another window comes over a page under the pointer, the page gets `mouseout`, and Chrome then gives its next pointer event a movement of 0.",
    "is then an unexplained change when the page's point is no X record; the catch-up covers it only after an X record.",
    "An unexplained change is a pointer event whose position change from the page's last pointer event does not agree with its movement (`movementX`, `movementY`).",
  ]);
  for (const s of ["The entering page is the front page now.", "(in the read, or in the read that gave its kept geometry)", "the world again", "still sets or drops it", "so no client sees the world, and the page's own events reach the client", "(unknown for the front page when it is outside its viewport)", "whose raise the relay sent (step 2)", "or the relay sent the raise (step 2)", "7. Bring the page forward:", "the kept geometries go"]) assert.ok(!says(C11, s), `C11: no ${s}`);
});

// Board ab-v16.71's measure of `xdotool sleep` (the design's section 7.1 at agent-browser 4400370) in C10, by board ab-v16.77.
test("C10 states board ab-v16.71's measure of xdotool sleep (board ab-v16.77)", () => {
  assert.ok(says(C10, "Board ab-v16.71's live check measured how well `xdotool sleep` keeps `dt` (taylor, Chromium 156 in the live test's own Xvfb, six runs; the agent pointer design, section 7.1): the times of the moves that the leaving page saw kept the planned `dt` to within 1 ms (median 0 ms, p90 1 ms over 5132 pairs of moves; at most 5 ms, except once 116 ms under the load of the whole live suite), and one script's start on `xdotool -` costs 20 to 26 ms (median). Standard input works: no argv is needed."), "C10: the measure");
  assert.ok(!says(protocol, "its numbers come here"), "docs/protocol.md: the numbers are in");
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
