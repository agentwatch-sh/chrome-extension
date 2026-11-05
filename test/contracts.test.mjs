// Contracts C4 (the allowlists and the hello), C10 (the bridge) and C11 (the
// endpoint): docs/protocol.md is the master, and test/vectors/bridge.json,
// endpoint.json, scopes.json and hello.json are its shared vectors. The
// receiver, the relay and the daemon check their code against the same
// vectors. These tests keep the vectors and the text in step; the small
// reference rules below follow the text, so a vector that breaks a rule fails
// here first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CHANNELS, MAX_TO_DAEMON, PART_BYTES, ChannelJoiner, splitParts } from "../agent/wire.js";
import { normalizeEntry } from "../shared/domains.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const protocol = read("docs/protocol.md");
const bridge = JSON.parse(read("test/vectors/bridge.json"));
const endpoint = JSON.parse(read("test/vectors/endpoint.json"));
const scopesV = JSON.parse(read("test/vectors/scopes.json"));
const helloV = JSON.parse(read("test/vectors/hello.json"));

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
const opByName = new Map(bridge.ops.map((o) => [o.op, o]));
const evByName = new Map(bridge.events.map((e) => [e.ev, e]));
const K = bridge.constants;

// ---- C4: the allowlists (set_scopes) and the hello ----

// C4's rules for set_scopes. The relay applies the same rules to its allowlist line (C10, C11).
const NAME = new RegExp(scopesV.pattern);
const HEX64 = /^[0-9a-f]{64}$/;
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
// The relay's allowlist line (C11): C4's rules, the keys with --keys, and a line with a keys
// field that a relay without --keys applies as no line at all.
function applyLine(line, keysOn) {
  if (!keysOn && Object.hasOwn(line, "keys")) return { failClosed: true };
  const a = applySetScopes(line);
  let keys = null;
  if (keysOn) {
    keys = {};
    if (isObj(line.keys)) {
      for (const [scope, h] of Object.entries(line.keys)) if (NAME.test(scope) && typeof h === "string" && HEX64.test(h)) keys[scope] = h;
    }
  }
  return { ...a, keys };
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

test("each allowlist line vector applies by C4's rules and C11's keys", () => {
  for (const v of scopesV.lines) {
    const a = applyLine(v.line, v.keysOn);
    if (v.failClosed) {
      assert.deepEqual(a, { failClosed: true }, v.note);
      continue;
    }
    assert.equal(a.failClosed, undefined, v.note);
    assert.deepEqual(a.keys, v.keys, v.note);
  }
  const has = (f) => scopesV.lines.some(f);
  assert.ok(has((v) => v.keysOn && !Object.hasOwn(v.line, "keys")), "keys on, a line with no keys field");
  assert.ok(has((v) => v.keysOn && Object.hasOwn(v.line, "keys") && !isObj(v.line.keys)), "keys that is not an object");
  assert.ok(has((v) => v.keysOn && isObj(v.line.keys) && Object.values(v.line.keys).some((h) => !(typeof h === "string" && HEX64.test(h)))), "a bad hash");
  assert.ok(has((v) => !v.keysOn && v.failClosed), "a relay without --keys and a line with keys");
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
      // Today's receiver (before part 1a) calls chrome.tabs.remove: the plain test of test/bridge.test.mjs uses it.
      assert.deepEqual(v.chromeToday, ["tabs.remove", [req.args[0]]], `${req.id}: today's chrome call`);
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

test("the daemon's allowlist line is the confirmed set_scopes object; keys only for the relay", () => {
  const lines = bridge.daemonLines.filter((l) => l.t === "allowlist");
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    assert.ok(!Object.hasOwn(l, "domains"), "the one list is gone");
    for (const k of ["lists", "scopes", "default"]) assert.ok(Object.hasOwn(l, k), k);
    assert.equal(applySetScopes(l).refused, 0, "the daemon sends only valid objects");
    if (isObj(l.keys)) for (const [scope, h] of Object.entries(l.keys)) assert.ok(NAME.test(scope) && HEX64.test(h), scope);
  }
  assert.ok(lines.some((l) => isObj(l.keys)) && lines.some((l) => !Object.hasOwn(l, "keys")), "a line with keys and one without");
  assert.ok(C10.includes("the\n    receiver never sees the keys") || C10.includes("the receiver never sees the keys"));
});

// ---- C10 and C5: the orphan-tabs rules (board ab-v16.41) ----

// Whether a contract's text says s, whatever its line breaks.
const flat = (t) => t.replace(/\s+/g, " ");
const says = (text, s) => flat(text).includes(flat(s));

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
    "The pending closes live in the worker's memory only", "the close of a new tab whose rule update failed", "a restore tab that came after its step's deadline"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  assert.ok(says(C5, "The sweep closes a tab with a pending close again, by the receiver's close"), "C5: the sweep does not skip a held tab");
  // review-17b: B1 (pending from the start of the close), N1 (the chain), N2 (step 3), N3 (a tab that the sweep cannot close leaves its scope).
  for (const s of ["a close is pending from the moment its item starts it (for the receiver's close, from the moment it joins the tab's chain; for a client's `Page.close`, from its send) until the tab's `tabs.onRemoved`, or until it fails and the tab stays (after the fallback too)",
    "a late `Page.close` answer with no error leaves the close pending, and a late error ends it", "also one that still waits in the tab's chain, or is still in its attach",
    // review-17c: the chain op ends before a held fallback (note 1); the orphan set in C10 (T11, T12, T13); a new entry's limit (note 5).
    "The op ends when the command answered, or when the fallback called `chrome.tabs.remove`; the close stays pending outside the chain",
    "a tab of the sweep leaves its scope at the end of the item, into the orphan set", "the sweep takes such a tab out of its scope into the orphan set",
    "The limits of a tab that a sweep item does not close", "a window rule that failed or came late, with no close and no dialog", "the held `chrome.tabs.remove` call does not end",
    "The limit of a new entry", "the end of a sweep item that did not close the tab", "The receiver's close is one op of the tab's chain of attaches",
    "only when it made one: never the bridge's attachment", "lists no target for the tab", "it never detaches the attach of a receiver's close that runs"]) {
    assert.ok(says(C10, s), `C10 says: ${s}`);
  }
  // review-17c B1: both cases, the orphan set, the true limits.
  for (const s of ["A tab that the sweep's item does not close leaves its scope at the end of that item", "The item's window rule failed or came late (C10): then no close starts, and no dialog opens",
    "The receiver keeps its id in the **orphan set**, in memory", "the guard and the closing rule treat it as a tab with no list", "Each later sweep item closes it again by the receiver's close, whatever its URL",
    "after a dismiss the page stays, and the held `chrome.tabs.remove` call does not end", "After a worker start the orphan set is gone", "its key leaves the copy (the answer waits for that removal, C4)",
    "The relay drops it from its model at its next `allowlist` line", "except a tab of the orphan set"]) {
    assert.ok(says(C5, s), `C5 says: ${s}`);
  }
  assert.ok(!says(C5, "The case needs a failed attach, a `beforeunload` handler and a user activation of the page; its limit is a tab of no scope that stays open until someone answers its dialog"), "C5: the old, wrong limit is gone");
  // review-17c notes 3 and 4, and the C4 nits (T18).
  assert.ok(says(C4, "the copy's key removals of the sweep have ended"), "C4: the answer waits for the key removals");
  assert.ok(says(C4, "after an answer that came later than 10 s (C10, the bound of a `set_scopes` answer), the receiver's new rules are in force"), "C4: a late answer");
  assert.ok(says(C4, "After an `ok: false` of a failed worker removal (C5)"), "C4: an ok:false of a failed worker removal");
  assert.ok(says(C11, "at a line whose `scopes` and `lists` are objects, it also drops from its model each tab of a scope that the line gives no list"), "C11: the relay drops the tabs of a scope with no list");
  assert.ok(says(C11, "A tab that still waits for its `bridge.tabScope` (up to `TAB_SCOPE_WAIT_MS`) has no scope yet, and it stays"), "C11: a popup that waits for its scope stays");
  assert.ok(says(bridge.windowRuleNote, "a close is pending from the moment its item starts it"), "the windowRuleNote has the same definition");
  // review-17b N7 and review-17c note 7: no sentence lets the sweep, the closing rule or a later item skip a tab with a
  // pending close (also a paraphrase: "skips", "never closes ... again").
  for (const [name, text] of [["C5", C5], ["C10", C10]]) {
    for (const sentence of flat(text).split(/(?<=\.)\s+/)) {
      const skips = /\b(skips?|skipped|neither does)\b/i.test(sentence) || /\bnever close[sd]?\b[^.]*\bagain\b/i.test(sentence);
      assert.ok(!(skips && /pending close/i.test(sentence)), `${name}: no rule skips a tab with a pending close: ${sentence}`);
    }
  }
  assert.ok(says(C11, "while Chrome's own `Target.closeTarget` does not"), "C11: today's relay's Target.closeTarget runs beforeunload");
});

// C5's sweep: at an applied set_scopes (scopes and lists are objects), every tab of the map whose scope has no list.
function sweepOf(msg, map) {
  if (!isObj(msg.scopes) || !isObj(msg.lists)) return { applied: false, closes: [] };
  const a = applySetScopes(msg);
  const closes = Object.entries(map).filter(([, scope]) => a.listOf(scope) === null).map(([id]) => Number(id));
  return { applied: true, closes: closes.sort((x, y) => x - y) };
}

test("the sweep: each vector closes the tabs whose scope has no list, and none at a set_scopes that is not applied", () => {
  for (const v of scopesV.sweep) {
    for (const [id, scope] of Object.entries(v.map)) assert.ok(/^\d+$/.test(id) && NAME.test(scope), `${v.note}: ${id} -> ${scope}`);
    assert.deepEqual(sweepOf(v.in, v.map), { applied: v.applied, closes: v.closes }, v.note);
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

// Before the upgrade (C11): the order of the checks, with and without keys.
const answerById = Object.fromEntries(endpoint.upgradeAnswers.map((a) => [a.id, a]));
const closeById = Object.fromEntries(endpoint.closes.filter((c) => c.id).map((c) => [c.id, c]));
const sha256 = (text) => createHash("sha256").update(text, "ascii").digest("hex");
// A valid key: 64 lowercase hex digits, once, in the key query or in the X-Agentwatch-Key header.
function validKey(url, headers) {
  const q = url.searchParams.getAll("key");
  const h = headers["x-agentwatch-key"];
  const hs = h === undefined ? [] : Array.isArray(h) ? h : [h];
  if (q.length + hs.length !== 1) return null;
  const k = q.length === 1 ? q[0] : hs[0];
  return HEX64.test(k) ? k : null;
}
function admit({ keys: keysOn, relay, request }) {
  const headers = request.headers ?? {};
  if (Object.hasOwn(headers, "origin")) return "fromPage"; // 1
  const url = new URL(request.path, "http://relay");
  const m = /^\/devtools\/browser\/([^/]*)$/.exec(url.pathname);
  if (!m || !SCOPE.test(m[1])) return "notFound"; // 2
  const scope = m[1];
  const key = keysOn ? validKey(url, headers) : null;
  if (keysOn && key === null) return "key"; // 3
  if (!relay.link) return "notConnected"; // 4
  if (relay.bridge === 0) return "tooOld";
  if (relay.line === null) return "notConfirmed";
  if (relay.bridge === null) return "notConnected";
  const a = applyLine(endpoint.lines[relay.line], keysOn);
  if (a.failClosed) return "keysWithout";
  if (keysOn && !Object.hasOwn(a.scopes, scope)) return "noList"; // 5
  if (keysOn && a.keys[scope] !== sha256(key)) return "key"; // 6
  if (a.listOf(scope) === null) return "noList"; // 7
  return 101;
}

test("before the upgrade: each check vector gets the answer of C11's order", () => {
  for (const [scope, token] of Object.entries(endpoint.keys.tokens)) {
    assert.ok(HEX64.test(token), scope);
    assert.equal(endpoint.keys.hashes[scope], sha256(token), `${scope}: the hash is SHA-256 of the 64 ASCII characters`);
  }
  const seen = new Set();
  for (const c of endpoint.upgradeChecks) {
    const want = c.answer?.status === 101 ? 101 : c.answer;
    assert.ok(want === 101 || Object.hasOwn(answerById, want), `${c.note}: a known answer`);
    assert.equal(admit(c), want, c.note);
    seen.add(want);
  }
  for (const a of endpoint.upgradeAnswers) assert.ok(seen.has(a.id), `a check vector for ${a.id}`);
  assert.ok(seen.has(101), "a vector of an upgrade");
  const steps = ["1. A request with an `Origin` header", "2. A path or scope that does not match", "3. With keys on, a request with no valid key", "4. The relay is not ready", "5. With keys on, a scope that the last `allowlist` line does not name", "6. With keys on, the hash check", "7. A scope with no list"];
  for (const s of steps) assert.ok(C11.includes(s), `C11 has the step ${s}`);
  assert.ok(C11.includes("in constant time"), "the hash check compares in constant time");
  assert.ok(C11.includes("`upgradeChecks`") && C11.includes("`lineCloses`"), "C11 names the vectors");
});

test("at each allowlist line: each close vector follows C11", () => {
  for (const c of endpoint.lineCloses) {
    const scope = c.connection.scope;
    const a = applyLine(endpoint.lines[c.line], c.keys);
    let got = null;
    if (a.failClosed || (c.keys && !Object.hasOwn(a.scopes, scope)) || a.listOf(scope) === null) got = "noList";
    else if (c.keys && a.keys[scope] !== c.connection.hash) got = "key";
    assert.equal(got, c.close, c.note);
  }
  for (const id of ["noList", "key"]) {
    assert.equal(closeById[id]?.code, 1008, id);
    assert.ok(endpoint.lineCloses.some((c) => c.close === id), `a vector for ${id}`);
  }
  assert.ok(endpoint.lineCloses.some((c) => c.close === null), "a vector of a connection that stays");
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
