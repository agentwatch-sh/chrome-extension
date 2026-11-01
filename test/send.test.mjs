import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../sender/lib/codec.js";
import {
  MAX_SEND_BYTES, buildPayload, sendState, resultText, runSend, fetchTargets,
  chooseDomain, domainChoices, readableSites, visibleStatus, queueSend, resumeSend, PENDING_MS,
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

test("domain choices and the default domain", async () => {
  assert.deepEqual(domainChoices("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
  assert.deepEqual(domainChoices("localhost"), []);
  assert.deepEqual(domainChoices("10.0.0.1"), []);
  const f = makeFakeChrome();
  assert.equal(await chooseDomain(f.chrome, 3, "www.example.co.uk"), "co.uk");
  f.partitionKey = { topLevelSite: "https://example.co.uk", hasCrossSiteAncestor: false };
  assert.equal(await chooseDomain(f.chrome, 3, "www.example.co.uk"), "example.co.uk");
  f.partitionKey = { topLevelSite: "https://elsewhere.org" };
  assert.equal(await chooseDomain(f.chrome, 3, "www.example.co.uk"), "co.uk");
  f.impl["cookies.getPartitionKey"] = async () => { throw new Error("no"); };
  assert.equal(await chooseDomain(f.chrome, 3, "www.example.com"), "example.com");
  assert.deepEqual(f.callsTo("cookies.getPartitionKey")[0][0], { tabId: 3, frameId: 0 });
});

test("fetchTargets", async () => {
  let url;
  let r = await fetchTargets(async (u, init) => {
    url = [u, init.credentials];
    return { status: 200, ok: true, json: async () => ({ data: { box: "b", users: [{ name: "a", supported: true, running: false, password_login: true }] } }) };
  }, BOX);
  assert.deepEqual(url, [BOX + "/api/browser/targets", "include"]);
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

test("readPageState reads storage, leaves out a database that fails", async () => {
  class FakeCryptoKey {}
  let transactions = 0;
  const saved = {};
  const set = (k, v) => {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  };
  const mem = (o) => ({ get length() { return Object.keys(o).length; }, key: (i) => Object.keys(o)[i], getItem: (k) => o[k] ?? null });
  set("localStorage", mem({ a: "1" }));
  set("sessionStorage", mem({ s: "2" }));
  set("indexedDB", {
    databases: async () => [{ name: "good" }, { name: "bad" }],
    open: (name) => {
      const req = {};
      setTimeout(() => {
        if (name === "bad") return req.onerror && req.onerror();
        const store = {
          keyPath: "id", autoIncrement: false, indexNames: ["byA"],
          index: () => ({ name: "byA", keyPath: "a", unique: false, multiEntry: false }),
          getAllKeys: () => { const r = {}; setTimeout(() => { r.result = [1, 2]; r.onsuccess(); }); return r; },
          getAll: () => { const r = {}; setTimeout(() => { r.result = [{ id: 1, a: "v" }, new FakeCryptoKey()]; r.onsuccess(); }); return r; },
        };
        req.result = { name, version: 3, objectStoreNames: ["st"], close() {},
          transaction: () => { transactions++; return { objectStore: () => store }; } };
        req.onsuccess();
      });
      return req;
    },
  });
  set("caches", {
    keys: async () => ["c1"],
    open: async () => ({
      keys: async () => [{ url: "https://x.example/a" }],
      match: async () => ({ status: 200, headers: new Headers({ "content-type": "text/plain" }), arrayBuffer: async () => new TextEncoder().encode("hi").buffer }),
    }),
  });
  try {
    const { storage, skipped } = await readPageState();
    assert.deepEqual(storage.local, { a: "1" });
    assert.deepEqual(storage.session, { s: "2" });
    assert.deepEqual(skipped, ["bad"]);
    assert.equal(storage.idb.length, 1);
    assert.equal(storage.idb[0].name, "good");
    assert.equal(storage.idb[0].version, 3);
    assert.deepEqual(storage.idb[0].stores[0].indexes, [{ name: "byA", keyPath: "a", unique: false, multiEntry: false }]);
    assert.equal(storage.idb[0].stores[0].records[0].key.v, 1);
    // A value the codec cannot carry is tagged; the database stays, nothing is skipped.
    assert.equal(storage.idb[0].stores[0].records.length, 2);
    assert.deepEqual(storage.idb[0].stores[0].records[1].value, { t: "unsupported", c: "FakeCryptoKey" });
    assert.equal(skipped.includes("good"), false);
    // One transaction per store (the "good" database has one store).
    assert.equal(transactions, 1);
    assert.deepEqual(storage.caches, [{ name: "c1", entries: [{ url: "https://x.example/a", status: 200, headers: [["content-type", "text/plain"]], body: "aGk=" }] }]);
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  }
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
