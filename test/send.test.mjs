import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../sender/lib/codec.js";
import {
  MAX_SEND_BYTES, buildPayload, sendState, resultText, runSend, fetchTargets,
  domainOptions, domainChoices, readableSites, visibleStatus, queueSend, resumeSend, PENDING_MS,
  BOX_TEXT, MOVED_TEXT, SendStop, boxHosts, isBoxSite, boxGetsCookie, KEEPALIVE_MS, readerTooLargeText,
} from "../sender/send.js";
import { readPageState } from "../sender/read-page.js";
import { onSendClick } from "../sender/popup.js";
import { parseBoxOrigin, addBox, removeBox } from "../sender/options.js";
import { makeFakeChrome } from "./fake-chrome.mjs";

const SECRET = "SENTINEL-not-a-real-value-7f3a";
const BOX = "https://box.example.net";
const TAB = { tabId: 7, url: "https://www.app.localhost/home?x=1", domain: "app.localhost" };

function cookie(over = {}) {
  return {
    name: "sid", value: SECRET + "-sid", domain: ".app.localhost", hostOnly: false, path: "/",
    secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 2000000000,
    storeId: "0", ...over,
  };
}

function reply(status, body) {
  return async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
}

test("buildPayload gives a C2 payload", async () => {
  const f = makeFakeChrome();
  f.cookies_ = [
    cookie(),
    cookie({ name: "other", domain: "other.example" }),
    cookie({ name: "part", partitionKey: { topLevelSite: "https://app.localhost", hasCrossSiteAncestor: false } }),
  ];
  const idb = [
    { name: "small", version: 1, stores: [] },
    { name: "big", version: 2, stores: [{ name: "s", keyPath: null, autoIncrement: false, indexes: [],
      records: [{ key: { t: "j", v: 1 }, value: { t: "j", v: "x".repeat(500) } }] }] },
  ];
  f.pageRead = { storage: { local: { a: "1" }, session: { b: "2" }, idb, caches: [] }, skipped: [] };
  const r = await buildPayload(f.chrome, TAB);
  const p = r.payload;
  assert.equal(p.v, 1);
  assert.equal(p.domain, "app.localhost");
  assert.equal(p.url, TAB.url);
  assert.equal(p.origin, "https://www.app.localhost");
  assert.deepEqual(p.storage.local, { a: "1" });
  assert.equal(p.storage.idb.length, 2);
  // Two reads, the second with partitionKey {}; deduped; out-of-scope dropped.
  const calls = f.callsTo("cookies.getAll");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][0], { domain: "app.localhost" });
  assert.deepEqual(calls[1][0], { domain: "app.localhost", partitionKey: {} });
  assert.deepEqual(p.cookies.map((c) => c.name), ["sid", "part"]);
  for (const c of p.cookies) {
    assert.equal("storeId" in c, false);
    assert.equal(typeof c.hostOnly, "boolean");
  }
  assert.deepEqual(p.cookies[1].partitionKey, { topLevelSite: "https://app.localhost", hasCrossSiteAncestor: false });
  assert.equal(r.bytes, new TextEncoder().encode(JSON.stringify(p)).length);
  assert.equal(r.largest.name, "big");
  assert.ok(r.largest.bytes > 500);
  // The reader is injected after the codec.
  const ex = f.callsTo("scripting.executeScript");
  assert.deepEqual(ex[0][0].files, ["lib/codec.js"]);
  assert.equal(ex[1][0].func, readPageState);
  assert.deepEqual(ex[1][0].target, { tabId: 7 });
  assert.deepEqual(ex[1][0].args, [MAX_SEND_BYTES, "https://www.app.localhost"]);
});

test("buildPayload keeps the key order of the page's IndexedDB values", async () => {
  const f = makeFakeChrome();
  const value = { t: "obj", v: { zeta: { t: "j", v: 1 }, alpha: { t: "obj", v: { b: { t: "j", v: null }, a: { t: "j", v: 2 } } } } };
  f.pageRead = { storage: { local: {}, session: {}, caches: [], idb: [{ name: "d", version: 1, stores: [{
    name: "s", keyPath: null, autoIncrement: false, indexes: [], records: [{ key: { t: "j", v: "k" }, value }] }] }] }, skipped: [] };
  const r = await buildPayload(f.chrome, TAB);
  const got = r.payload.storage.idb[0].stores[0].records[0].value;
  assert.deepEqual(Object.keys(got.v), ["zeta", "alpha"]);
  assert.deepEqual(Object.keys(got.v.alpha.v), ["b", "a"]);
  assert.ok(r.json.indexOf('"zeta"') < r.json.indexOf('"alpha"'));
});

test("buildPayload fails on a page result that is not the reader's JSON string", async () => {
  const f = makeFakeChrome();
  f.impl["scripting.executeScript"] = async (inj) => [{ frameId: 0, result: inj.func ? { storage: {} } : undefined }];
  await assert.rejects(buildPayload(f.chrome, TAB));
});

test("buildPayload drops expirationDate of a session cookie and keeps skipped names", async () => {
  const f = makeFakeChrome();
  f.cookies_ = [cookie({ session: true, expirationDate: undefined })];
  f.pageRead = { storage: { local: {}, session: {}, idb: [], caches: [] }, skipped: ["broken"] };
  const r = await buildPayload(f.chrome, TAB);
  assert.equal("expirationDate" in r.payload.cookies[0], false);
  assert.deepEqual(r.skipped, ["broken"]);
  assert.equal(r.largest, null);
});

test("sendState posts the body with the login cookie", async () => {
  let seen;
  const res = await sendState(async (url, init) => {
    seen = { url, init };
    return { status: 200, ok: true, json: async () => ({ data: { counts: { cookies_set: 2, local: 3, session: 1, idb_databases: 1, idb_records: 9, cache_entries: 4, errors: [] } } }) };
  }, { box: BOX, user: "a b", body: '{"v":1}', domain: "app.localhost" });
  assert.equal(seen.url, BOX + "/api/browser/send?user=a%20b");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.credentials, "include");
  assert.equal(seen.init.redirect, "error");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.equal(seen.init.body, '{"v":1}');
  assert.equal(res.kind, "ok");
  assert.equal(res.text, "Sent app.localhost to box.example.net: 2 cookies, 4 storage keys, 1 databases (9 records), 4 cache entries.");
});

test("sendState reads counts at the top level and counts problems", async () => {
  const res = await sendState(reply(200, { cookies_set: 1, local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: ["x: y", "z: w"] }),
    { box: BOX, user: "u", body: "{}", domain: "d.example" });
  assert.match(res.text, /1 cookies, 0 storage keys, 0 databases \(0 records\), 0 cache entries, 2 problems\.$/);
});

test("sendState result texts", async () => {
  const go = (status, body) => sendState(reply(status, body), { box: BOX, user: "u", body: "{}", domain: "d.example" });
  let r = await go(403, { error_code: "password_login_required" });
  assert.match(r.text, /^Log in to box\.example\.net with your password, then send again\./);
  assert.equal(r.link, BOX + "/login?next=/browser");
  r = await go(403, { data: { error_code: "password_login_required" } });
  assert.equal(r.link, BOX + "/login?next=/browser");
  r = await go(401, {});
  assert.equal(r.text, "Log in to box.example.net first.");
  assert.equal(r.link, BOX + "/login?next=/browser");
  r = await go(413, {});
  assert.equal(r.text, "The box refused the send: it is too large.");
  r = await go(409, { error_code: "browser_unsupported" });
  assert.equal(r.text, "This box's agentwatch has no agent browser yet.");
  r = await go(500, { error: SECRET });
  assert.equal(r.text, "The box refused the send (HTTP 500).");
  assert.equal(r.kind, "refused");
  r = await sendState(async () => { throw new TypeError(SECRET); }, { box: BOX, user: "u", body: "{}", domain: "d.example" });
  assert.equal(r.text, "Cannot reach box.example.net.");
  assert.ok(!JSON.stringify(r).includes(SECRET));
  // A body that is not JSON does not break the result.
  r = await sendState(async () => ({ status: 502, ok: false, json: async () => { throw new Error(SECRET); } }),
    { box: BOX, user: "u", body: "{}", domain: "d.example" });
  assert.equal(r.text, "The box refused the send (HTTP 502).");
  assert.equal(resultText({ kind: "unreachable" }, BOX), "Cannot reach box.example.net.");
});

function setup(f, extra = {}) {
  f.storage_.local.boxes = [BOX];
  f.cookies_ = [cookie()];
  f.tabs_ = [{ id: TAB.tabId, windowId: 1, url: TAB.url }];
  Object.assign(f, extra);
}

test("runSend refuses a body over the limit and names the largest database", async () => {
  const f = makeFakeChrome();
  setup(f);
  const huge = "x".repeat(MAX_SEND_BYTES);
  f.pageRead = { storage: { local: { k: huge }, session: {}, caches: [], idb: [
    { name: "tiny", version: 1, stores: [] },
    { name: "heavy", version: 1, stores: [{ name: "s", keyPath: null, autoIncrement: false, indexes: [],
      records: [{ key: { t: "j", v: 1 }, value: { t: "j", v: "y".repeat(2 * 1048576) } }] }] },
  ] }, skipped: [] };
  let posted = false;
  await runSend(f.chrome, async () => { posted = true; return { status: 200, ok: true, json: async () => ({}) }; },
    { ...TAB, box: BOX, user: "u" });
  assert.equal(posted, false);
  const last = f.storage_.session.lastSend;
  assert.equal(last.state, "error");
  assert.match(last.text, /^This site's state is too large to send \(\d+\.\d MiB; the limit is 32 MiB\)\. The largest part is the database "heavy" \(2\.\d MiB\)\.$/);
  assert.ok(!last.text.includes("xxxx"));
});

test("runSend reads, sends and writes progress to lastSend", async () => {
  const f = makeFakeChrome();
  setup(f);
  f.pageRead = { storage: { local: {}, session: {}, idb: [], caches: [] }, skipped: ["bad db"] };
  const states = [];
  f.chrome.storage.onChanged.addListener((c) => states.push(c.lastSend.newValue.state));
  let body;
  await runSend(f.chrome, async (u, init) => {
    body = JSON.parse(init.body);
    return { status: 200, ok: true, json: async () => ({ counts: { cookies_set: 1, local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] } }) };
  }, { ...TAB, box: BOX, user: "u" });
  assert.deepEqual(states, ["reading", "sending", "done"]);
  assert.equal(body.domain, "app.localhost");
  const last = f.storage_.session.lastSend;
  assert.equal(last.state, "done");
  assert.match(last.text, /^Sent app\.localhost to box\.example\.net: 1 cookies/);
  assert.match(last.text, /Left out: bad db\.$/);
});

test("runSend refuses an unknown box, a bad domain and an unreadable page", async () => {
  const f = makeFakeChrome();
  setup(f);
  const never = async () => { throw new Error("no post"); };
  await runSend(f.chrome, never, { ...TAB, box: "https://evil.example", user: "u" });
  assert.equal(f.storage_.session.lastSend.state, "error");
  await runSend(f.chrome, never, { ...TAB, domain: "other.example", box: BOX, user: "u" });
  assert.equal(f.storage_.session.lastSend.state, "error");
  f.impl["scripting.executeScript"] = async () => { throw new Error(SECRET); };
  await runSend(f.chrome, never, { ...TAB, box: BOX, user: "u" });
  const last = f.storage_.session.lastSend;
  assert.equal(last.state, "error");
  assert.ok(!JSON.stringify(last).includes(SECRET));
});

// Chrome closes the popup when it shows its permission dialog, and a message
// from the closing popup to a stopped worker is lost (both measured on
// Chromium 156). So the popup writes the send to storage.session in the same
// task as the permission request, and the worker runs it when
// storage.onChanged or permissions.onAdded wakes it.
const OK_REPLY = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, data: { counts: {
  cookies_set: 1, local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] } } }) });

test("the popup click asks for the site permission and stores the send before any await", async () => {
  const f = makeFakeChrome();
  const p = onSendClick(f.chrome, { ...TAB, box: BOX, user: "u" });
  const reqs = f.callsTo("permissions.request");
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0][0], { origins: ["*://*.app.localhost/*"] });
  const sets = f.callsTo("storage.session.set");
  assert.equal(sets.length, 1);
  const { at, ...pending } = sets[0][0].pendingSend;
  assert.deepEqual(pending, { ...TAB, box: BOX, user: "u" });
  assert.equal(typeof at, "number");
  const order = f.calls.map(([path]) => path).filter((path) => path === "permissions.request" || path === "storage.session.set");
  assert.deepEqual(order, ["permissions.request", "storage.session.set"]);
  assert.equal(f.callsTo("runtime.sendMessage").length, 0);
  await p;
  assert.ok(f.storage_.session.pendingSend);
});

test("a denied permission, seen by a popup that stayed open, drops the pending send", async () => {
  const f = makeFakeChrome();
  setup(f);
  f.permissionAnswer = false;
  const never = async () => { throw new Error("no post"); };
  await onSendClick(f.chrome, { ...TAB, box: BOX, user: "u" });
  assert.equal(f.storage_.session.pendingSend, undefined);
  const last = f.storage_.session.lastSend;
  assert.deepEqual([last.state, last.text], ["error", "Chrome did not give access to app.localhost."]);
  f.permissions_.origins = ["*://*.app.localhost/*"];
  await resumeSend(f.chrome, never);
  assert.equal(f.storage_.session.lastSend.state, "error");
});

test("a queued send runs at once when Chrome already gives access", async () => {
  const f = makeFakeChrome();
  setup(f);
  f.permissions_.origins = ["*://*.app.localhost/*"];
  let posts = 0;
  const post = async (...a) => { posts += 1; return OK_REPLY(...a); };
  await queueSend(f.chrome, { ...TAB, box: BOX, user: "u" });
  await resumeSend(f.chrome, post);
  assert.equal(posts, 1);
  assert.equal(f.storage_.session.lastSend.state, "done");
  assert.equal(f.storage_.session.pendingSend, undefined);
});

test("a queued send without access waits once; the grant runs it once", async () => {
  const f = makeFakeChrome();
  setup(f);
  let posts = 0;
  const post = async (...a) => { posts += 1; return OK_REPLY(...a); };
  await queueSend(f.chrome, { ...TAB, box: BOX, user: "u" });
  const at = f.storage_.session.pendingSend.at;
  await resumeSend(f.chrome, post); // woken by storage.onChanged
  await resumeSend(f.chrome, post); // an unrelated grant: still no access to the site
  assert.equal(posts, 0);
  const waiting = f.storage_.session.lastSend;
  assert.deepEqual([waiting.state, waiting.text, waiting.domain, waiting.at],
    ["waiting", "Waiting for Chrome's access to app.localhost...", "app.localhost", at]);
  assert.equal(f.callsTo("storage.session.set").filter(([o]) => o.lastSend).length, 1);
  f.permissions_.origins = ["*://*.app.localhost/*"];
  await Promise.all([resumeSend(f.chrome, post), resumeSend(f.chrome, post)]);
  assert.equal(posts, 1);
  assert.equal(f.storage_.session.lastSend.state, "done");
  assert.equal(f.storage_.session.pendingSend, undefined);
});

test("a pending send expires after PENDING_MS", async () => {
  const f = makeFakeChrome();
  setup(f);
  let posts = 0;
  const post = async (...a) => { posts += 1; return OK_REPLY(...a); };
  await queueSend(f.chrome, { ...TAB, box: BOX, user: "u" });
  await resumeSend(f.chrome, post);
  f.permissions_.origins = ["*://*.app.localhost/*"];
  await resumeSend(f.chrome, post, Date.now() + PENDING_MS + 1000);
  assert.equal(posts, 0);
  assert.equal(f.storage_.session.pendingSend, undefined);
  const last = f.storage_.session.lastSend;
  assert.deepEqual(visibleStatus(last, "app.localhost", last.at + PENDING_MS + 1000),
    { state: "error", text: "Chrome did not give access to app.localhost." });
  assert.equal(visibleStatus(last, "app.localhost", last.at + 1000).state, "waiting");
});

// A pending send can wait for Chrome's dialog; by then the tab may show
// another site. The worker reads only a tab that still shows the origin.
test("a pending send whose tab moved to another origin, or closed, ends without a read", async () => {
  for (const tabs of [[{ id: TAB.tabId, windowId: 1, url: "https://evil.example/x" }],
    [{ id: TAB.tabId, windowId: 1, url: TAB.url, pendingUrl: "https://evil.example/x" }],
    [{ id: TAB.tabId, windowId: 1 }], []]) {
    const f = makeFakeChrome();
    setup(f, { tabs_: tabs });
    f.permissions_.origins = ["*://*.app.localhost/*"];
    let posts = 0;
    const post = async (...a) => { posts += 1; return OK_REPLY(...a); };
    await queueSend(f.chrome, { ...TAB, box: BOX, user: "u" });
    await resumeSend(f.chrome, post);
    assert.equal(posts, 0);
    assert.equal(f.callsTo("scripting.executeScript").length, 0);
    assert.equal(f.callsTo("cookies.getAll").length, 0);
    assert.equal(f.storage_.session.pendingSend, undefined);
    const last = f.storage_.session.lastSend;
    assert.deepEqual([last.state, last.text, last.domain], ["error", "The tab moved to another page. Send again.", "app.localhost"]);
  }
});

test("a pending send runs when its tab shows another page of the same origin", async () => {
  const f = makeFakeChrome();
  setup(f, { tabs_: [{ id: TAB.tabId, windowId: 1, url: "https://www.app.localhost/other#x" }] });
  f.permissions_.origins = ["*://*.app.localhost/*"];
  let posts = 0;
  const post = async (...a) => { posts += 1; return OK_REPLY(...a); };
  await queueSend(f.chrome, { ...TAB, box: BOX, user: "u" });
  await resumeSend(f.chrome, post);
  assert.equal(posts, 1);
  assert.deepEqual(f.callsTo("tabs.get"), [[TAB.tabId]]);
  assert.equal(f.storage_.session.lastSend.state, "done");
});

test("a pending send with a bad domain is dropped with an error", async () => {
  const f = makeFakeChrome();
  setup(f);
  const never = async () => { throw new Error("no post"); };
  await queueSend(f.chrome, { ...TAB, domain: "http://x/", box: BOX, user: "u" });
  await resumeSend(f.chrome, never);
  assert.equal(f.storage_.session.pendingSend, undefined);
  assert.equal(f.storage_.session.lastSend.state, "error");
});

test("the worker resumes a pending send on storage.onChanged and permissions.onAdded only", () => {
  const src = readFileSync(new URL("../sender/sw.js", import.meta.url), "utf8");
  assert.match(src, /chrome\.storage\.onChanged\.addListener/);
  assert.match(src, /chrome\.permissions\.onAdded\.addListener/);
  assert.equal((src.match(/resumeSend\(chrome, fetch\)/g) || []).length, 2);
  assert.doesNotMatch(src, /runtime\.onMessage/);
});

test("domain choices stop at the registrable domain of the partition key", async () => {
  assert.deepEqual(domainChoices("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
  assert.deepEqual(domainChoices("localhost"), []);
  assert.deepEqual(domainChoices("10.0.0.1"), []);
  const f = makeFakeChrome();
  // The key names the registrable domain: nothing above it, so no co.uk.
  f.partitionKey = { topLevelSite: "https://example.co.uk", hasCrossSiteAncestor: false };
  assert.deepEqual(await domainOptions(f.chrome, 3, "www.example.co.uk"),
    { choices: ["www.example.co.uk", "example.co.uk"], chosen: "example.co.uk" });
  f.partitionKey = { topLevelSite: "https://b.github.io" };
  assert.deepEqual(await domainOptions(f.chrome, 3, "a.b.github.io"), { choices: ["a.b.github.io", "b.github.io"], chosen: "b.github.io" });
  f.partitionKey = { topLevelSite: "https://example.com" };
  assert.deepEqual(await domainOptions(f.chrome, 3, "example.com"), { choices: ["example.com"], chosen: "example.com" });
  assert.deepEqual(f.callsTo("cookies.getPartitionKey")[0][0], { tabId: 3, frameId: 0 });
  // No key, a key of another site, or a failed call: the host and its parents
  // down to the fallback, which is the default.
  const fallback = { choices: ["www.example.co.uk", "example.co.uk", "co.uk"], chosen: "co.uk" };
  f.partitionKey = undefined;
  assert.deepEqual(await domainOptions(f.chrome, 3, "www.example.co.uk"), fallback);
  f.partitionKey = { topLevelSite: "https://elsewhere.org" };
  assert.deepEqual(await domainOptions(f.chrome, 3, "www.example.co.uk"), fallback);
  f.impl["cookies.getPartitionKey"] = async () => { throw new Error("no"); };
  assert.deepEqual(await domainOptions(f.chrome, 3, "www.example.co.uk"), fallback);
  assert.deepEqual(await domainOptions(f.chrome, 3, "www.example.com"), { choices: ["www.example.com", "example.com"], chosen: "example.com" });
  assert.deepEqual(await domainOptions(f.chrome, 3, "10.0.0.1"), { choices: [], chosen: "" });
});

test("fetchTargets", async () => {
  let url;
  let r = await fetchTargets(async (u, init) => {
    url = [u, init.credentials, init.redirect];
    return { status: 200, ok: true, json: async () => ({ data: { box: "b", users: [{ name: "a", supported: true, running: false, password_login: true }] } }) };
  }, BOX);
  assert.deepEqual(url, [BOX + "/api/browser/targets", "include", "error"]);
  assert.equal(r.kind, "ok");
  assert.equal(r.users[0].name, "a");
  r = await fetchTargets(reply(401, {}), BOX);
  assert.deepEqual([r.kind, r.text, r.link], ["login", "Log in to box.example.net first.", BOX + "/login?next=/browser"]);
  r = await fetchTargets(async () => { throw new Error("x"); }, BOX);
  assert.equal(r.text, "Cannot reach box.example.net.");
  r = await fetchTargets(reply(200, { users: [{ name: "a", supported: true, running: true, password_login: false }] }), BOX);
  assert.equal(r.users[0].password_login, false);
});

test("readableSites leaves out the box origins", () => {
  assert.deepEqual(readableSites(["*://*.a.example/*", BOX + "/*", "*://*.b.example/*"], [BOX]),
    ["*://*.a.example/*", "*://*.b.example/*"]);
});

test("parseBoxOrigin", () => {
  assert.deepEqual(parseBoxOrigin("https://box.example.net/viewer?x=1#y"), { ok: true, origin: "https://box.example.net" });
  assert.equal(parseBoxOrigin("box.example.net").origin, "https://box.example.net");
  assert.equal(parseBoxOrigin("http://localhost:8081/").origin, "http://localhost:8081");
  assert.equal(parseBoxOrigin("http://a.localhost").ok, true);
  assert.equal(parseBoxOrigin("http://127.0.0.1:9").ok, true);
  assert.equal(parseBoxOrigin("http://box.example.net").ok, false);
  assert.equal(parseBoxOrigin("ftp://box.example.net").ok, false);
  assert.equal(parseBoxOrigin("").ok, false);
  assert.equal(parseBoxOrigin("https://").ok, false);
});

test("addBox asks for the permission first, stores the origin once; removeBox revokes", async () => {
  const f = makeFakeChrome();
  const p = addBox(f.chrome, BOX + "/x");
  assert.deepEqual(f.callsTo("permissions.request")[0][0], { origins: [BOX + "/*"] });
  assert.equal(f.callsTo("storage.local.set").length, 0);
  let r = await p;
  assert.equal(r.ok, true);
  await addBox(f.chrome, BOX);
  assert.deepEqual(f.storage_.local.boxes, [BOX]);
  r = await removeBox(f.chrome, BOX);
  assert.deepEqual(f.storage_.local.boxes, []);
  assert.deepEqual(f.callsTo("permissions.remove")[0][0], { origins: [BOX + "/*"] });
  f.permissionAnswer = false;
  r = await addBox(f.chrome, "https://other.example.net");
  assert.equal(r.ok, false);
  assert.deepEqual(f.storage_.local.boxes, []);
  r = await addBox(f.chrome, "http://box.example.net");
  assert.equal(r.ok, false);
  assert.equal(f.callsTo("permissions.request").length, 3);
});

// ---- the page reader, against fake page globals ----

const PAGE_ORIGIN = "https://www.app.localhost";
const tick = () => new Promise((r) => setTimeout(r, 0));
const mem = (o) => ({ get length() { return Object.keys(o).length; }, key: (i) => Object.keys(o)[i], getItem: (k) => o[k] ?? null });
const cmpKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A fake IndexedDB. dbs: {name: {version, fail?, stores: {storeName: {keyPath,
// autoIncrement, indexes, records: [[key, value], ...]}}}}. `gone` lists
// names that databases() reports but that no longer exist. The log records
// opens, transactions, cursor steps, upgrade aborts and deletes.
function fakeIndexedDB(dbs, { gone = [] } = {}) {
  const log = { opens: [], transactions: 0, cursorSteps: 0, cursors: 0, aborts: [], deletes: [], created: [] };
  const store = (st) => ({
    keyPath: st.keyPath ?? null, autoIncrement: !!st.autoIncrement, indexNames: (st.indexes ?? []).map((i) => i.name),
    index: (n) => st.indexes.find((i) => i.name === n),
    openCursor: (range) => {
      log.cursors += 1;
      const rows = [...st.records].sort((a, b) => cmpKey(a[0], b[0]))
        .filter(([k]) => range === null || (range.lowerOpen ? cmpKey(k, range.lower) > 0 : cmpKey(k, range.lower) >= 0));
      const req = {};
      let i = 0;
      const step = () => setTimeout(() => {
        log.cursorSteps += 1;
        if (i >= rows.length) {
          req.result = null;
        } else {
          const [key, value] = rows[i];
          req.result = { key, primaryKey: key, value, continue: () => { i += 1; step(); } };
        }
        req.onsuccess();
      });
      step();
      return req;
    },
    getAll: () => { throw new Error("the reader reads with a cursor"); },
    getAllKeys: () => { throw new Error("the reader reads with a cursor"); },
  });
  const api = {
    log,
    databases: async () => [...Object.keys(dbs), ...gone].map((name) => ({ name })),
    deleteDatabase: (name) => { log.deletes.push(name); return {}; },
    open: (name, version) => {
      log.opens.push([name, version]);
      const req = {};
      setTimeout(() => {
        const d = dbs[name];
        if (!d) {
          // As in a browser: open() without a version creates the database.
          let aborted = false;
          req.transaction = { abort: () => { aborted = true; log.aborts.push(name); } };
          req.result = { name, version: 1, objectStoreNames: [], close() {} };
          if (req.onupgradeneeded) req.onupgradeneeded();
          if (aborted) return req.onerror && req.onerror();
          log.created.push(name);
          return req.onsuccess();
        }
        if (d.fail) return req.onerror && req.onerror();
        req.result = {
          name, version: d.version, objectStoreNames: Object.keys(d.stores), close() {},
          transaction: (sn) => { log.transactions += 1; return { objectStore: () => store(d.stores[sn]) }; },
        };
        req.onsuccess();
      });
      return req;
    },
  };
  return api;
}

function response(status, bytes, headers = { "content-type": "text/plain" }) {
  return { status, headers: new Headers(headers), body: null, arrayBuffer: async () => bytes.buffer };
}

// Installs the page globals for one test and returns a restore function.
function installPage({ local = {}, session = {}, idb = fakeIndexedDB({}), caches: cacheMap = {}, estimate = null, origin = PAGE_ORIGIN } = {}) {
  const saved = {};
  const set = (k, v) => {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  };
  set("location", { origin });
  set("localStorage", local === null ? null : mem(local));
  set("sessionStorage", mem(session));
  set("indexedDB", idb);
  set("IDBKeyRange", { lowerBound: (lower, lowerOpen) => ({ lower, lowerOpen: !!lowerOpen }) });
  set("navigator", { storage: { estimate: async () => { if (!estimate) throw new Error("none"); return estimate; } } });
  set("caches", {
    keys: async () => Object.keys(cacheMap),
    open: async (name) => ({
      keys: async () => cacheMap[name].map(([url]) => ({ url })),
      match: async (r) => cacheMap[name].find(([url]) => url === r.url)[1],
    }),
  });
  return () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  };
}

async function readWith(page, ...args) {
  const restore = installPage(page);
  try {
    return JSON.parse(await readPageState(...args));
  } finally {
    restore();
  }
}

test("readPageState reads storage with a cursor, leaves out a database that fails", async () => {
  class FakeCryptoKey {}
  const idb = fakeIndexedDB({
    good: { version: 3, stores: { st: { keyPath: "id", indexes: [{ name: "byA", keyPath: "a", unique: false, multiEntry: false }],
      records: [[2, new FakeCryptoKey()], [1, { id: 1, a: "v", _: 0 }]] } } },
    bad: { fail: true },
  });
  const r = await readWith({
    local: { a: "1" }, session: { s: "2" }, idb,
    caches: { c1: [["https://x.example/a", response(200, new TextEncoder().encode("hi"))]] },
  }, MAX_SEND_BYTES, PAGE_ORIGIN);
  const { origin, storage, skipped } = r;
  assert.equal(origin, PAGE_ORIGIN);
  assert.deepEqual(Object.keys(storage.idb[0].stores[0].records[0].value.v), ["id", "a", "_"]);
  assert.deepEqual(storage.local, { a: "1" });
  assert.deepEqual(storage.session, { s: "2" });
  assert.deepEqual(skipped, ["bad"]);
  assert.equal(storage.idb.length, 1);
  assert.equal(storage.idb[0].name, "good");
  assert.equal(storage.idb[0].version, 3);
  assert.deepEqual(storage.idb[0].stores[0].indexes, [{ name: "byA", keyPath: "a", unique: false, multiEntry: false }]);
  // Key order, and each key with its own value (one cursor gives both).
  assert.deepEqual(storage.idb[0].stores[0].records.map((x) => x.key.v), [1, 2]);
  // A value the codec cannot carry is tagged; the database stays, nothing is skipped.
  assert.equal(storage.idb[0].stores[0].records.length, 2);
  assert.deepEqual(storage.idb[0].stores[0].records[1].value, { t: "unsupported", c: "FakeCryptoKey" });
  assert.deepEqual(storage.caches, [{ name: "c1", entries: [{ url: "https://x.example/a", status: 200, headers: [["content-type", "text/plain"]], body: "aGk=" }] }]);
  // Every open names no version and nothing is deleted.
  assert.deepEqual(idb.log.opens, [["good", undefined], ["bad", undefined]]);
  assert.deepEqual(idb.log.deletes, []);
});

test("readPageState reads a large store in batches; the first batch is small", async () => {
  const records = [];
  for (let i = 0; i < 300; i++) records.push([i, "made-up-" + i]);
  const idb = fakeIndexedDB({ d: { version: 1, stores: { s: { records } } } });
  const r = await readWith({ idb }, MAX_SEND_BYTES, PAGE_ORIGIN);
  const got = r.storage.idb[0].stores[0].records;
  assert.equal(got.length, 300);
  assert.deepEqual(got.map((x) => x.key.v), records.map(([k]) => k));
  assert.equal(got[299].value.v, "made-up-299");
  // More than one cursor (one per batch), each in its own transaction.
  assert.ok(idb.log.cursors >= 2, "cursors: " + idb.log.cursors);
  assert.ok(idb.log.transactions >= idb.log.cursors);
});

// I3: the reader stops above the limit; the operator's tab never holds much more.
test("readPageState stops above the limit and names the largest database so far", async () => {
  const SECRET_V = "SENTINEL-not-a-real-value-7f3a";
  const records = [];
  for (let i = 0; i < 1000; i++) records.push([i, SECRET_V + "-" + "x".repeat(200)]);
  const idb = fakeIndexedDB({
    small: { version: 1, stores: { s: { records: [[1, SECRET_V]] } } },
    big: { version: 1, stores: { s: { records } } },
    after: { version: 1, stores: { s: { records: [[1, SECRET_V]] } } },
  });
  const json = JSON.stringify(await readWith({ idb }, 20000, PAGE_ORIGIN));
  const r = JSON.parse(json);
  assert.equal(r.origin, PAGE_ORIGIN);
  assert.equal(r.storage, undefined);
  assert.equal(r.tooLarge.stage, "read");
  assert.ok(r.tooLarge.bytes > 20000);
  assert.equal(r.tooLarge.largest.kind, "database");
  assert.equal(r.tooLarge.largest.name, "big");
  assert.ok(!json.includes("SENTINEL"));
  // It stopped early: far fewer cursor steps than records, and "after" never opened.
  assert.ok(idb.log.cursorSteps < 200, "steps: " + idb.log.cursorSteps);
  assert.deepEqual(idb.log.opens.map(([n]) => n), ["small", "big"]);
  assert.equal(readerTooLargeText(r.tooLarge).startsWith("This site's state is too large to send (more than 32 MiB). The largest part is the database \"big\""), true);
});

test("readPageState counts cache bodies and stops on one that passes the limit", async () => {
  const idb = fakeIndexedDB({ d: { version: 1, stores: { s: { records: [[1, "made-up"]] } } } });
  const big = new Uint8Array(30000);
  const r = await readWith({ idb, caches: { small: [["https://x.example/a", response(200, new Uint8Array(10))]],
    huge: [["https://x.example/b", response(200, big)]] } }, 20000, PAGE_ORIGIN);
  assert.equal(r.tooLarge.stage, "read");
  assert.deepEqual([r.tooLarge.largest.kind, r.tooLarge.largest.name], ["cache", "huge"]);
  assert.match(readerTooLargeText(r.tooLarge), /The largest part is the cache "huge"/);
});

test("readPageState reads a cache body as a stream and stops at the bytes left", async () => {
  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(4096);
  const resp = {
    status: 200, headers: new Headers(),
    body: { getReader: () => ({ read: async () => { pulls += 1; return { done: false, value: chunk }; }, cancel: async () => { cancelled = true; } }) },
    arrayBuffer: async () => { throw new Error("the whole body is never read"); },
  };
  const r = await readWith({ caches: { c: [["https://x.example/s", resp]] } }, 20000, PAGE_ORIGIN);
  assert.equal(r.tooLarge.largest.name, "c");
  assert.ok(pulls <= 5, "pulls: " + pulls);
  assert.equal(cancelled, true);
});

// M6: an opaque entry (status 0) has no bytes the page can read.
test("readPageState leaves out opaque cache entries and counts them in skipped", async () => {
  const r = await readWith({ caches: { v1: [
    ["https://cdn.example/a.js", response(0, new Uint8Array(0), {})],
    ["https://www.app.localhost/b", response(200, new Uint8Array([1]))],
    ["https://cdn.example/c.js", response(0, new Uint8Array(0), {})],
  ] } }, MAX_SEND_BYTES, PAGE_ORIGIN);
  assert.deepEqual(r.storage.caches[0].entries.map((e) => e.url), ["https://www.app.localhost/b"]);
  assert.deepEqual(r.skipped, ["2 opaque entries of cache v1"]);
});

test("readPageState refuses at once when the site's IndexedDB on disk is far above the limit", async () => {
  const idb = fakeIndexedDB({ d: { version: 1, stores: { s: { records: [[1, "made-up"]] } } } });
  let r = await readWith({ idb, estimate: { usage: 1, usageDetails: { indexedDB: 16 * 20000 + 1 } } }, 20000, PAGE_ORIGIN);
  assert.deepEqual(r.tooLarge, { stage: "estimate", bytes: 16 * 20000 + 1, largest: null });
  assert.deepEqual(idb.log.opens, []);
  assert.match(readerTooLargeText(r.tooLarge), /^This site's state is too large to send \(its databases hold 0\.3 MiB; the limit is 32 MiB\)\.$/);
  // Without usageDetails, the whole usage counts.
  r = await readWith({ idb, estimate: { usage: 16 * 20000 + 1 } }, 20000, PAGE_ORIGIN);
  assert.equal(r.tooLarge.stage, "estimate");
  // Cache padding and the file system do not count when Chrome names IndexedDB's own usage.
  r = await readWith({ idb, estimate: { usage: 1e12, usageDetails: { indexedDB: 16 * 20000 } } }, 20000, PAGE_ORIGIN);
  assert.equal(r.tooLarge, undefined);
  assert.equal(r.storage.idb.length, 1);
  // No estimate at all: the read goes on.
  r = await readWith({ idb }, 20000, PAGE_ORIGIN);
  assert.equal(r.storage.idb.length, 1);
});

// M11 through the reader: a small stored value that shares one object many times.
test("readPageState stops on a value whose encoding alone passes the bytes left", async () => {
  let x = { leaf: "made-up" };
  for (let i = 0; i < 40; i++) x = [x, x];
  const idb = fakeIndexedDB({ dag: { version: 1, stores: { s: { records: [[1, x]] } } } });
  const r = await readWith({ idb }, 100000, PAGE_ORIGIN);
  assert.equal(r.tooLarge.stage, "read");
  assert.equal(r.tooLarge.largest.name, "dag");
});

// M9: open() without a version creates a database that is gone by now.
test("a database gone since the listing is not created and not deleted", async () => {
  const idb = fakeIndexedDB({ d: { version: 1, stores: {} } }, { gone: ["vanished"] });
  const r = await readWith({ idb }, MAX_SEND_BYTES, PAGE_ORIGIN);
  assert.deepEqual(idb.log.aborts, ["vanished"]);
  assert.deepEqual(idb.log.created, []);
  assert.deepEqual(idb.log.deletes, []);
  assert.deepEqual(r.storage.idb.map((d) => d.name), ["d"]);
  assert.deepEqual(r.skipped, []);
});

// I4: the reader reports the origin it ran on, and reads nothing on another one.
test("readPageState on another origin reads nothing and returns that origin", async () => {
  const idb = fakeIndexedDB({ d: { version: 1, stores: {} } });
  const r = await readWith({ idb, local: null, origin: "https://api.app.localhost" }, MAX_SEND_BYTES, PAGE_ORIGIN);
  assert.deepEqual(r, { origin: "https://api.app.localhost" });
  assert.deepEqual(idb.log.opens, []);
});

test("the pages hold no inline script and no external resource", () => {
  for (const p of ["popup.html", "options.html"]) {
    const html = readFileSync(new URL("../sender/" + p, import.meta.url), "utf8");
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\bsrc="[a-z-]+\.js"/);
    assert.equal(/<script[^>]*>\s*\S/.test(html.replace(/<script[^>]*src=[^>]*><\/script>/g, "")), false);
    assert.equal(/https?:\/\//.test(html), false);
    assert.equal(/\son[a-z]+=/i.test(html), false);
  }
});

test("lastSend is tagged and the popup shows it only for its domain, stale ones ended", async () => {
  const f = makeFakeChrome();
  setup(f);
  await runSend(f.chrome, async () => ({ status: 401, ok: false, json: async () => ({}) }), { ...TAB, box: BOX, user: "u" });
  const last = f.storage_.session.lastSend;
  assert.equal(last.domain, "app.localhost");
  assert.equal(typeof last.at, "number");
  assert.equal(visibleStatus(last, "app.localhost").text, last.text);
  assert.equal(visibleStatus(last, "other.example"), null);
  assert.equal(visibleStatus(null, "app.localhost"), null);
  const now = Date.now();
  const reading = { state: "reading", text: "Reading...", domain: "a.example", at: now - 4 * 60 * 1000 };
  assert.deepEqual(visibleStatus(reading, "a.example", now), { state: "error", text: "The last send did not finish." });
  assert.equal(visibleStatus({ ...reading, at: now - 60 * 1000 }, "a.example", now).state, "reading");
  assert.equal(visibleStatus({ ...reading, state: "done", at: now - 9e6 }, "a.example", now).state, "done");
});

// ---- C1: the box's own sign-in is never sent ----

test("a send from a box's own tab, or of a domain that covers a box host, is refused before any read", async () => {
  const box = "https://box.example.net";
  for (const [url, domain] of [
    [box + "/viewer?x=1", "box.example.net"], // the tab is the box
    [box + "/viewer", "example.net"], // the domain covers the box host
    ["https://www.example.net/x", "example.net"], // another tab, the same domain
    ["http://box.example.net:9000/", "example.net"], // another port of the box host
  ]) {
    const f = makeFakeChrome();
    f.storage_.local.boxes = [box];
    f.cookies_ = [cookie({ name: "__Host-session", value: SECRET + "-login", domain: "box.example.net", hostOnly: true })];
    f.tabs_ = [{ id: 7, windowId: 1, url }];
    const timers = { setInterval: () => assert.fail("no keepalive"), clearInterval: () => {} };
    let posted = false;
    await runSend(f.chrome, async () => { posted = true; return OK_REPLY(); }, { tabId: 7, url, domain, box, user: "u" }, timers);
    assert.equal(posted, false, url);
    assert.equal(f.callsTo("scripting.executeScript").length, 0, url);
    assert.equal(f.callsTo("cookies.getAll").length, 0, url);
    const last = f.storage_.session.lastSend;
    assert.deepEqual([last.state, last.text], ["error", BOX_TEXT], url);
    assert.equal(BOX_TEXT, "This is an agentwatch box. Its sign-in is never sent.");
    assert.ok(!JSON.stringify(f.calls).includes(SECRET));
  }
});

test("a site next to a box is sent, without any cookie that the box host would receive", async () => {
  const f = makeFakeChrome();
  f.cookies_ = [
    cookie({ name: "keep_host", value: SECRET + "-a", domain: "www.app.localhost", hostOnly: true }),
    cookie({ name: "keep_sub", value: SECRET + "-b", domain: ".www.app.localhost", hostOnly: false }),
    cookie({ name: "box_host", value: SECRET + "-box1", domain: "box.app.localhost", hostOnly: true }),
    cookie({ name: "box_parent", value: SECRET + "-box2", domain: ".app.localhost", hostOnly: false }),
    cookie({ name: "box_exact", value: SECRET + "-box3", domain: ".box.app.localhost", hostOnly: false }),
  ];
  const r = await buildPayload(f.chrome, { ...TAB, boxes: ["https://box.app.localhost:8081"] });
  assert.deepEqual(r.payload.cookies.map((c) => c.name), ["keep_host", "keep_sub"]);
  assert.ok(!r.json.includes(SECRET + "-box"));
  assert.ok(r.json.includes(SECRET + "-a"));
});

test("boxHosts, isBoxSite and boxGetsCookie", () => {
  const hosts = boxHosts(["https://Box.Example.net", "http://localhost:8081", "not a url", "https://b.example.org./"]);
  assert.deepEqual(hosts, ["box.example.net", "localhost", "b.example.org"]);
  assert.equal(isBoxSite("example.net", "www.example.net", hosts), true);
  assert.equal(isBoxSite("box.example.net", "box.example.net", hosts), true);
  assert.equal(isBoxSite("www.example.net", "www.example.net", hosts), false);
  assert.equal(isBoxSite("app.localhost", "www.app.localhost", hosts), false);
  assert.equal(isBoxSite("x.example", "b.example.org.", hosts), true);
  const c = (domain, hostOnly) => ({ domain, hostOnly });
  assert.equal(boxGetsCookie(c("box.example.net", true), hosts), true);
  assert.equal(boxGetsCookie(c("Box.Example.net", true), hosts), true);
  assert.equal(boxGetsCookie(c(".example.net", false), hosts), true);
  assert.equal(boxGetsCookie(c("example.net", true), hosts), false); // host-only of the parent
  assert.equal(boxGetsCookie(c(".sub.box.example.net", false), hosts), false);
  assert.equal(boxGetsCookie(c("www.example.net", true), hosts), false);
  assert.equal(boxGetsCookie(c(".org", false), hosts), true);
});

// ---- I2: the worker stays alive while a send runs ----

function intervalTimers() {
  const t = { list: [] };
  t.setInterval = (fn, ms) => {
    const h = { fn, ms, cleared: false };
    t.list.push(h);
    return h;
  };
  t.clearInterval = (h) => {
    h.cleared = true;
  };
  return t;
}

test("a send calls an extension API every 20 s while the read and the POST run, and stops after", async () => {
  const f = makeFakeChrome();
  setup(f);
  const timers = intervalTimers();
  let during = null;
  await runSend(f.chrome, async () => {
    const [h] = timers.list;
    during = { ms: h.ms, cleared: h.cleared };
    h.fn();
    h.fn();
    await tick();
    return OK_REPLY();
  }, { ...TAB, box: BOX, user: "u" }, timers);
  assert.equal(KEEPALIVE_MS, 20000);
  assert.deepEqual(during, { ms: 20000, cleared: false });
  assert.equal(f.callsTo("runtime.getPlatformInfo").length, 2);
  assert.equal(timers.list.length, 1);
  assert.equal(timers.list[0].cleared, true);
  assert.equal(f.storage_.session.lastSend.state, "done");
});

test("the keepalive stops on a failed read, a failed POST and a failed keepalive call", async () => {
  for (const arrange of [
    (f) => { f.impl["scripting.executeScript"] = async () => { throw new Error(SECRET); }; },
    () => {},
  ]) {
    const f = makeFakeChrome();
    setup(f);
    arrange(f);
    f.impl["runtime.getPlatformInfo"] = async () => { throw new Error("gone"); };
    const timers = intervalTimers();
    await runSend(f.chrome, async () => {
      timers.list[0].fn();
      throw new TypeError(SECRET);
    }, { ...TAB, box: BOX, user: "u" }, timers);
    await tick();
    assert.equal(timers.list.length, 1);
    assert.equal(timers.list[0].cleared, true);
    assert.equal(f.storage_.session.lastSend.state, "error");
    assert.ok(!JSON.stringify(f.storage_.session.lastSend).includes(SECRET));
  }
  // An invalid request starts no keepalive.
  const f = makeFakeChrome();
  setup(f);
  const timers = intervalTimers();
  await runSend(f.chrome, async () => OK_REPLY(), { ...TAB, box: "https://evil.example", user: "u" }, timers);
  assert.equal(timers.list.length, 0);
});

// ---- I4 and I3 through the worker ----

test("a tab that shows another origin when the reader runs stops the send without cookies or a POST", async () => {
  const f = makeFakeChrome();
  setup(f);
  f.pageRead = { origin: "https://api.app.localhost" };
  await assert.rejects(buildPayload(f.chrome, TAB), (e) => e instanceof SendStop && e.message === MOVED_TEXT);
  assert.equal(f.callsTo("cookies.getAll").length, 0);
  let posted = false;
  await runSend(f.chrome, async () => { posted = true; return OK_REPLY(); }, { ...TAB, box: BOX, user: "u" }, intervalTimers());
  assert.equal(posted, false);
  assert.deepEqual([f.storage_.session.lastSend.state, f.storage_.session.lastSend.text], ["error", MOVED_TEXT]);
});

test("the reader's too-large result stops the send with its own text", async () => {
  const f = makeFakeChrome();
  setup(f);
  f.pageRead = { tooLarge: { stage: "read", bytes: MAX_SEND_BYTES + 1, largest: { kind: "database", name: "heavy", bytes: 31 * 1048576 } } };
  let posted = false;
  await runSend(f.chrome, async () => { posted = true; return OK_REPLY(); }, { ...TAB, box: BOX, user: "u" }, intervalTimers());
  assert.equal(posted, false);
  assert.equal(f.callsTo("cookies.getAll").length, 0);
  assert.equal(f.storage_.session.lastSend.text,
    "This site's state is too large to send (more than 32 MiB). The largest part is the database \"heavy\" (31.0 MiB read).");
});

// ---- M3: the C8 error codes ----

test("sendState texts for the agent browser's error codes and a gateway timeout", async () => {
  const go = (status, body) => sendState(reply(status, body), { box: BOX, user: "u", body: "{}", domain: "d.example" });
  const cases = [
    [503, { error_code: "browser_receiver_missing" }, "The agent browser on box.example.net does not answer. Look at its Browser page."],
    [503, { data: { error_code: "browser_start_failed" } }, "The agent browser on box.example.net does not start. Look at its Browser page."],
    [409, { error_code: "browser_disabled" }, "The agent browser is turned off on box.example.net."],
    [400, { error_code: "browser_payload_invalid", error: SECRET }, "The box refused the send as malformed."],
    [504, {}, "The box did not answer in time."],
    [503, { error_code: "something_else" }, "The box refused the send (HTTP 503)."],
  ];
  for (const [status, body, text] of cases) {
    const r = await go(status, body);
    assert.equal(r.text, text, JSON.stringify(body));
    assert.equal(r.link, undefined);
    assert.ok(!JSON.stringify(r).includes(SECRET));
  }
});
