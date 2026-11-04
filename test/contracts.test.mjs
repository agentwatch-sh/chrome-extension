// Contracts C10 (the bridge) and C11 (the endpoint): docs/protocol.md is the
// master, and test/vectors/bridge.json and test/vectors/endpoint.json are its
// shared vectors. The stage-2 receiver, the stage-3 relay and the stage-4
// daemon check their code against the same vectors. These tests keep the
// vectors and the text in step; the small reference rules below follow the
// text, so a vector that breaks a rule fails here first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHANNELS, MAX_TO_DAEMON, PART_BYTES, ChannelJoiner, splitParts } from "../agent/wire.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const protocol = read("docs/protocol.md");
const bridge = JSON.parse(read("test/vectors/bridge.json"));
const endpoint = JSON.parse(read("test/vectors/endpoint.json"));

// The text of one contract: from its "### Cn." heading to the next "### ".
function section(name) {
  const start = protocol.indexOf(`\n### ${name}. `);
  assert.ok(start >= 0, `docs/protocol.md has a section ${name}`);
  const next = protocol.indexOf("\n### ", start + 1);
  return protocol.slice(start, next < 0 ? undefined : next);
}
const C4 = section("C4");
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
    assert.ok(!["import", "set_allowlist", "ping"].includes(name), name);
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
const webUrl = (u) => u === "about:blank" || (typeof u === "string" && /^https?:\/\/[^/?#\s]+/i.test(u) && URL.canParse(u));
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
    case "newTab":
      return isObj(a) && onlyKeys(a, ["url", "active", "windowId", "index"]) && webUrl(a.url) &&
        (!Object.hasOwn(a, "active") || typeof a.active === "boolean") &&
        ["windowId", "index"].every((k) => !Object.hasOwn(a, k) || (int(a[k]) && a[k] >= 0));
    case "tabUpdate": return isObj(a) && onlyKeys(a, ["active"]) && typeof a.active === "boolean";
    case "newWindow":
      return isObj(a) && onlyKeys(a, ["url", "focused", "left", "top", "width", "height", "state"]) && webUrl(a.url) &&
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
    else assert.ok(Array.isArray(v.chrome) && v.chrome[0].startsWith(req.op.split(".")[0] + "."), `${req.id}: chrome call`);
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
    else assert.ok(argsFit(o, req.args ?? []) && waitFits(req), `${req.id}: only the tab check fails`);
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
const NAVIGATE_OK = (url) => url === "about:blank" || /^(https?|data|blob):/i.test(url);
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
    case "Page.navigate": return !NAVIGATE_OK(params.url ?? "");
    case "Target.createTarget": {
      const ctx = params.browserContextId;
      return (ctx !== undefined && ctx !== endpoint.defaultContext) || !NEW_TAB_OK(params.url);
    }
    default: return null;
  }
}

test("the refusals and passes that depend on the params follow C11's rules", () => {
  for (const r of endpoint.refusals) {
    const hit = paramRefusal(r.method, r.params);
    if (hit !== null) assert.equal(hit, true, `refused: ${r.method} ${JSON.stringify(r.params)}`);
    // A URL refusal names the URL's scheme, or "relative".
    if (/ URLs \(/.test(r.error)) assert.ok(r.error.includes(`browser: ${schemeOf(r.params.url)} URLs (${r.method})`), r.error);
  }
  for (const p of endpoint.passes) {
    assert.notEqual(paramRefusal(p.method, p.params), true, `passes: ${p.method} ${JSON.stringify(p.params)}`);
  }
  assert.ok(endpoint.refusals.some((r) => /^file:/.test(r.params?.url ?? "")), "S12: a file: URL is refused");
  assert.ok(endpoint.refusals.some((r) => schemeOf(r.params?.url ?? "x:") === "relative"), "a relative URL is refused");
  assert.ok(endpoint.passes.some((p) => p.method === "Target.createTarget" && p.params.url === ""), "an empty url is about:blank");
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
