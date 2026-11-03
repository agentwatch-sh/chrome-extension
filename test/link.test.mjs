import { test } from "node:test";
import assert from "node:assert/strict";
import { ReceiverLink, watchBlocked } from "../receiver/link.js";
import { splitParts } from "../receiver/wire.js";
import { makeFakeChrome } from "./fake-chrome.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(handlers = {}) {
  const f = makeFakeChrome();
  const timers = [];
  const setTimer = (fn, ms) => timers.push({ fn, ms });
  const clears = [];
  const link = new ReceiverLink(f.chrome, { ping: async () => ({}), set_allowlist: async () => ({ rules: 1, closed: 0 }), import: async () => ({}), ...handlers }, { setTimer, clearTimer: (h) => clears.push(h) });
  link.start();
  return { f, link, timers };
}
const sendReq = (port, req) => {
  for (const p of splitParts(req.id, req)) port.fireMessage(p);
};

test("connect posts hello and a link up posts hello again", () => {
  const { f } = setup();
  assert.deepEqual(f.callsTo("runtime.connectNative")[0], ["sh.agentwatch.browser"]);
  const port = f.ports[0];
  assert.deepEqual(port.posted, [{ t: "hello", v: 1, version: "0.1.0" }]);
  port.fireMessage({ t: "link", up: true });
  assert.equal(port.posted.length, 2);
  assert.deepEqual(port.posted[1], { t: "hello", v: 1, version: "0.1.0" });
});

test("parts dispatch set_allowlist once and post res ok", async () => {
  const seen = [];
  const { f } = setup({ set_allowlist: async (r) => (seen.push(r), { rules: 1, closed: 2 }) });
  const port = f.ports[0];
  const req = { t: "req", id: "r1", op: "set_allowlist", domains: ["a.example"], pad: "x".repeat(1500000) };
  sendReq(port, req);
  await tick();
  assert.equal(seen.length, 1);
  assert.deepEqual(port.posted.at(-1), { t: "res", id: "r1", ok: true, data: { rules: 1, closed: 2 } });
});

test("a handler error posts res ok:false with the message", async () => {
  const { f } = setup({ ping: async () => { throw new Error("boom"); } });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "r2", op: "ping" });
  await tick();
  assert.deepEqual(port.posted.at(-1), { t: "res", id: "r2", ok: false, error: "boom" });
});

test("an unknown op posts res ok:false", async () => {
  const { f } = setup();
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "r3", op: "nope" });
  await tick();
  assert.equal(port.posted.at(-1).ok, false);
  assert.equal(port.posted.at(-1).id, "r3");
});

test("requests run one at a time in arrival order", async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const { f } = setup({
    ping: async () => { order.push("ping-start"); await gate; order.push("ping-end"); return {}; },
    set_allowlist: async () => { order.push("allow"); return {}; },
  });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "a", op: "ping" });
  sendReq(port, { t: "req", id: "b", op: "set_allowlist", domains: [] });
  await tick();
  assert.deepEqual(order, ["ping-start"]);
  release();
  await tick();
  await tick();
  assert.deepEqual(order, ["ping-start", "ping-end", "allow"]);
  assert.deepEqual(port.posted.filter((m) => m.t === "res").map((m) => m.id), ["a", "b"]);
});

test("a disconnect reconnects after 1 s, 2 s, 4 s ... capped at 30 s; a message resets", () => {
  const { f, timers } = setup();
  const delays = [];
  for (let i = 0; i < 7; i++) {
    f.ports.at(-1).fireDisconnect();
    delays.push(timers.at(-1).ms);
    timers.at(-1).fn();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(f.ports.length, 8);
  f.ports.at(-1).fireMessage({ t: "link", up: true });
  f.ports.at(-1).fireDisconnect();
  assert.equal(timers.at(-1).ms, 1000);
});

test("blocked main-frame navigations post the host only", () => {
  const f = makeFakeChrome();
  const sent = [];
  watchBlocked(f.chrome, (m) => sent.push(m));
  const ev = f.chrome.webNavigation.onErrorOccurred;
  ev.fire({ frameId: 0, tabId: 4, url: "https://evil.example/path?q=secret", error: "net::ERR_BLOCKED_BY_CLIENT" });
  ev.fire({ frameId: 3, tabId: 4, url: "https://evil.example/", error: "net::ERR_BLOCKED_BY_CLIENT" });
  ev.fire({ frameId: 0, tabId: 4, url: "https://evil.example/", error: "net::ERR_FAILED" });
  assert.deepEqual(sent, [{ t: "blocked", tab: 4, host: "evil.example" }]);
});

test("a never-settling handler times out at 9 s and the next request runs", async () => {
  const { f, timers } = setup({ ping: () => new Promise(() => {}) });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "a", op: "ping" });
  sendReq(port, { t: "req", id: "b", op: "set_allowlist", domains: [] });
  await tick();
  assert.equal(timers.at(-1).ms, 9000);
  timers.at(-1).fn();
  await tick();
  await tick();
  assert.deepEqual(port.posted.filter((m) => m.t === "res"), [
    { t: "res", id: "a", ok: false, error: "timeout" },
    { t: "res", id: "b", ok: true, data: { rules: 1, closed: 0 } },
  ]);
});

test("import gets 115 s", async () => {
  const { f, timers } = setup({ import: () => new Promise(() => {}) });
  sendReq(f.ports[0], { t: "req", id: "i", op: "import", state: {} });
  await tick();
  assert.equal(timers.at(-1).ms, 115000);
});

test("a late result after the timeout is ignored", async () => {
  let late;
  const { f, timers } = setup({ ping: () => new Promise((r) => (late = r)) });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "a", op: "ping" });
  await tick();
  timers.at(-1).fn();
  await tick();
  late({});
  await tick();
  assert.equal(port.posted.filter((m) => m.t === "res").length, 1);
});

test("a disconnect reads lastError, drops queued requests and mutes the in-flight answer", async () => {
  let release;
  const order = [];
  const { f } = setup({
    ping: async (r) => { order.push(r.id); await new Promise((x) => (release = x)); return {}; },
  });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "a", op: "ping" });
  sendReq(port, { t: "req", id: "b", op: "ping" });
  await tick();
  port.fireDisconnect();
  assert.ok(f.callsTo("runtime.lastError").length >= 1);
  release();
  await tick();
  await tick();
  assert.deepEqual(order, ["a"]);
  assert.equal(port.posted.filter((m) => m.t === "res").length, 0);
});

test("a notice waits from a disconnect to the next link up and follows its hello; at most 100 wait", () => {
  const { f, link, timers } = setup();
  f.ports[0].fireMessage({ t: "link", up: true });
  link.send({ t: "blocked", tab: 1, host: "now.example" });
  assert.deepEqual(f.ports[0].posted.at(-1), { t: "blocked", tab: 1, host: "now.example" }, "with the link up, a notice goes at once");
  f.ports[0].fireDisconnect();
  link.send({ t: "blocked", tab: 4, host: "first.example" });
  for (let i = 0; i < 100; i++) link.send({ t: "blocked", tab: i, host: "h" + i + ".example" });
  timers.at(-1).fn(); // the reconnect: the new host has no daemon socket yet, and drops what it gets
  const port = f.ports[1];
  assert.deepEqual(port.posted, [{ t: "hello", v: 1, version: "0.1.0" }], "the notices wait for the link");
  port.fireMessage({ t: "link", up: true });
  assert.deepEqual(port.posted[1], { t: "hello", v: 1, version: "0.1.0" });
  assert.equal(port.posted.length, 102, "two hellos and the 100 newest notices");
  assert.deepEqual(port.posted[2], { t: "blocked", tab: 0, host: "h0.example" }, "the oldest notice gave way");
  assert.deepEqual(port.posted.at(-1), { t: "blocked", tab: 99, host: "h99.example" });
});

test("a notice before the first link up waits for it; a hello and a res never wait", async () => {
  const { f, link } = setup();
  const port = f.ports[0];
  link.send({ t: "blocked", tab: 2, host: "early.example" });
  sendReq(port, { t: "req", id: "p", op: "ping" });
  await tick();
  assert.deepEqual(port.posted, [{ t: "hello", v: 1, version: "0.1.0" }, { t: "res", id: "p", ok: true, data: {} }]);
  port.fireMessage({ t: "link", up: true });
  assert.deepEqual(port.posted.slice(2), [{ t: "hello", v: 1, version: "0.1.0" }, { t: "blocked", tab: 2, host: "early.example" }]);
});
