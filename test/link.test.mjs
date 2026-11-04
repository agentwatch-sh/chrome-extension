import { test } from "node:test";
import assert from "node:assert/strict";
import { ReceiverLink, watchBlocked } from "../receiver/link.js";
import { PART_BYTES, MAX_TO_DAEMON, splitParts } from "../receiver/wire.js";
import { makeFakeChrome } from "./fake-chrome.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(handlers = {}, bridge = {}) {
  const f = makeFakeChrome();
  const timers = [];
  const setTimer = (fn, ms) => timers.push({ fn, ms });
  const clears = [];
  const main = { ping: async () => ({}), set_allowlist: async () => ({ rules: 1, closed: 0 }), import: async () => ({}), ...handlers };
  const link = new ReceiverLink(f.chrome, { main, bridge }, { setTimer, clearTimer: (h) => clears.push(h) });
  link.start();
  return { f, link, timers };
}
const sendReq = (port, req, ch) => {
  for (const p of splitParts(req.id, req, PART_BYTES, ch)) port.fireMessage(p);
};
const HELLO = { t: "hello", v: 2, version: "0.1.0", channels: ["main", "bridge"] };
const resOf = (port) => port.posted.filter((m) => m.t === "res");
const byId = (list) => list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

test("connect posts hello and a link up posts hello again; the hello names the channels", () => {
  const { f } = setup();
  assert.deepEqual(f.callsTo("runtime.connectNative")[0], ["sh.agentwatch.browser"]);
  const port = f.ports[0];
  assert.deepEqual(port.posted, [{ t: "hello", v: 2, version: "0.1.0", channels: ["main", "bridge"] }]);
  port.fireMessage({ t: "link", up: true });
  assert.equal(port.posted.length, 2);
  assert.deepEqual(port.posted[1], { t: "hello", v: 2, version: "0.1.0", channels: ["main", "bridge"] });
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
  assert.deepEqual(port.posted, [HELLO], "the notices wait for the link");
  port.fireMessage({ t: "link", up: true });
  assert.deepEqual(port.posted[1], HELLO);
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
  assert.deepEqual(port.posted, [HELLO, { t: "res", id: "p", ok: true, data: {} }]);
  port.fireMessage({ t: "link", up: true });
  assert.deepEqual(port.posted.slice(2), [HELLO, { t: "blocked", tab: 2, host: "early.example" }]);
});

// ---- the bridge channel ----

const gated = () => {
  let release;
  const gate = new Promise((r) => (release = r));
  return { gate, release };
};

test("a bridge request is answered while the parts of a main import are unfinished, and the import still joins", async () => {
  const seen = [];
  const { f } = setup({ import: async (r) => (seen.push(r.id), { cookies_set: 1 }) }, { call: async (r) => ({ echo: r.x }) });
  const port = f.ports[0];
  const imp = splitParts("i1", { t: "req", id: "i1", op: "import", state: {}, pad: "s".repeat(1500000) });
  assert.equal(imp.length, 3);
  port.fireMessage(imp[0]);
  sendReq(port, { t: "req", id: "b1", op: "call", x: 5, pad: "b".repeat(800000) }, "bridge");
  await tick();
  assert.deepEqual(resOf(port), [{ t: "res", ch: "bridge", id: "b1", ok: true, data: { echo: 5 } }]);
  port.fireMessage(imp[1]);
  port.fireMessage(imp[2]);
  await tick();
  assert.deepEqual(seen, ["i1"], "the bridge parts never dropped the import's parts");
  assert.deepEqual(resOf(port).at(-1), { t: "res", id: "i1", ok: true, data: { cookies_set: 1 } });
});

test("a bridge request is answered while a main import runs; the main channel still runs one at a time", async () => {
  const order = [];
  const { gate, release } = gated();
  const { f } = setup({
    import: async () => { order.push("import-start"); await gate; order.push("import-end"); return {}; },
    ping: async () => { order.push("ping"); return {}; },
  }, { call: async () => { order.push("call"); return {}; } });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "i", op: "import", state: {} });
  sendReq(port, { t: "req", id: "p", op: "ping" });
  await tick();
  sendReq(port, { t: "req", id: "b", op: "call" }, "bridge");
  await tick();
  assert.deepEqual(order, ["import-start", "call"], "the bridge call ran; the main ping waits behind the import");
  assert.deepEqual(resOf(port), [{ t: "res", ch: "bridge", id: "b", ok: true, data: {} }]);
  release();
  await tick();
  await tick();
  assert.deepEqual(order, ["import-start", "call", "import-end", "ping"]);
  assert.deepEqual(resOf(port).map((m) => m.id), ["b", "i", "p"]);
});

test("an unknown bridge op gets an error res on the bridge channel; the main channel goes on", async () => {
  const { gate, release } = gated();
  const { f } = setup({ import: async () => { await gate; return { cookies_set: 2 }; } });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "i", op: "import", state: {} });
  await tick();
  sendReq(port, { t: "req", id: "b1", op: "nope" }, "bridge");
  sendReq(port, { t: "req", id: "b2", op: "ping" }, "bridge"); // a main op is not a bridge op
  await tick();
  assert.deepEqual(resOf(port), [
    { t: "res", ch: "bridge", id: "b1", ok: false, error: "unknown op" },
    { t: "res", ch: "bridge", id: "b2", ok: false, error: "unknown op" },
  ]);
  release();
  await tick();
  sendReq(port, { t: "req", id: "p", op: "ping" });
  await tick();
  assert.deepEqual(resOf(port).slice(2), [
    { t: "res", id: "i", ok: true, data: { cookies_set: 2 } },
    { t: "res", id: "p", ok: true, data: {} },
  ]);
});

test("a bridge op that is a main op name gets no main handler, and a main res never names a channel", async () => {
  const seen = [];
  const { f } = setup({ ping: async (r) => (seen.push(r.id), {}) }, {});
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "m1", op: "ping" }, "main");
  sendReq(port, { t: "req", id: "m2", op: "ping" });
  sendReq(port, { t: "req", id: "b1", op: "ping" }, "bridge");
  await tick();
  await tick();
  assert.deepEqual(seen, ["m1", "m2"]);
  assert.deepEqual(resOf(port), [
    { t: "res", ch: "bridge", id: "b1", ok: false, error: "unknown op" },
    { t: "res", id: "m1", ok: true, data: {} },
    { t: "res", id: "m2", ok: true, data: {} },
  ]);
});

test("bridge requests do not wait for each other; each res comes when its request ends", async () => {
  const { gate, release } = gated();
  const { f } = setup({}, {
    slow: async () => { await gate; return { n: 1 }; },
    fast: async () => ({ n: 2 }),
    fail: async () => { throw new Error("no tab"); },
  });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "s", op: "slow" }, "bridge");
  sendReq(port, { t: "req", id: "f", op: "fast" }, "bridge");
  sendReq(port, { t: "req", id: "x", op: "fail" }, "bridge");
  await tick();
  assert.deepEqual(byId(resOf(port)), [
    { t: "res", ch: "bridge", id: "f", ok: true, data: { n: 2 } },
    { t: "res", ch: "bridge", id: "x", ok: false, error: "no tab" },
  ], "the two that ended answered; the slow one still runs");
  release();
  await tick();
  assert.deepEqual(resOf(port).at(-1), { t: "res", ch: "bridge", id: "s", ok: true, data: { n: 1 } });
});

test("a bridge request times out at 9 s with an error res on the bridge channel", async () => {
  const { f, timers } = setup({}, { hang: () => new Promise(() => {}) });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "h", op: "hang" }, "bridge");
  await tick();
  assert.equal(timers.at(-1).ms, 9000);
  timers.at(-1).fn();
  await tick();
  assert.deepEqual(resOf(port), [{ t: "res", ch: "bridge", id: "h", ok: false, error: "timeout" }]);
});

test("a part with an unknown channel gets no answer and runs nothing", async () => {
  const seen = [];
  const { f } = setup({ ping: async (r) => (seen.push(r.id), {}) }, { ping: async (r) => (seen.push(r.id), {}) });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "u", op: "ping" }, "other");
  await tick();
  assert.deepEqual(seen, []);
  assert.deepEqual(resOf(port), []);
});

test("a disconnect mutes the in-flight answers of both channels, also on the next connection, and a new connection joins afresh", async () => {
  const { gate, release } = gated();
  const { f, timers } = setup({ ping: async () => { await gate; return {}; } }, { slow: async () => { await gate; return {}; }, call: async () => ({}) });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "m", op: "ping" });
  sendReq(port, { t: "req", id: "s", op: "slow" }, "bridge");
  const half = splitParts("h", { t: "req", id: "h", op: "call", pad: "h".repeat(800000) }, PART_BYTES, "bridge");
  port.fireMessage(half[0]);
  await tick();
  port.fireDisconnect();
  timers.at(-1).fn(); // the reconnect, before the old requests end
  const next = f.ports[1];
  release();
  await tick();
  await tick();
  assert.deepEqual(resOf(port), []);
  assert.deepEqual(resOf(next), [], "the old requests' answers never reach the new connection");
  next.fireMessage(half[1]);
  await tick();
  assert.deepEqual(resOf(next), [], "a part of the old connection never completes a request");
  sendReq(next, { t: "req", id: "c", op: "call" }, "bridge");
  await tick();
  assert.deepEqual(resOf(next), [{ t: "res", ch: "bridge", id: "c", ok: true, data: {} }]);
});

test("a link up drops the unfinished parts of both channels: they came from the daemon connection that ended", async () => {
  const seen = [];
  const { f } = setup({ import: async (r) => (seen.push(r.id), {}) }, { call: async (r) => (seen.push(r.id), {}) });
  const port = f.ports[0];
  const imp = splitParts("i", { t: "req", id: "i", op: "import", state: {}, pad: "s".repeat(800000) });
  const br = splitParts("b", { t: "req", id: "b", op: "call", pad: "b".repeat(800000) }, PART_BYTES, "bridge");
  port.fireMessage(imp[0]);
  port.fireMessage(br[0]);
  port.fireMessage({ t: "link", up: true }); // the native host connected to the daemon again
  port.fireMessage(imp[1]);
  port.fireMessage(br[1]);
  await tick();
  assert.deepEqual(seen, []);
  assert.deepEqual(resOf(port), []);
  sendReq(port, { t: "req", id: "i2", op: "import", state: {} });
  sendReq(port, { t: "req", id: "b2", op: "call" }, "bridge");
  await tick();
  assert.deepEqual(seen.sort(), ["b2", "i2"]);
});

test("the waits are per channel: import gets 115 s on main only, every other request 9 s", async () => {
  const never = () => new Promise(() => {});
  const { f, timers } = setup({ import: never, ping: never }, { import: never, call: never });
  const port = f.ports[0];
  sendReq(port, { t: "req", id: "bi", op: "import" }, "bridge");
  sendReq(port, { t: "req", id: "bc", op: "call" }, "bridge");
  sendReq(port, { t: "req", id: "mi", op: "import", state: {} });
  sendReq(port, { t: "req", id: "mp", op: "ping" });
  await tick();
  assert.deepEqual(timers.map((t) => t.ms), [9000, 9000, 115000]);
  timers[2].fn(); // the main import times out, so the main ping starts
  await tick();
  await tick();
  assert.deepEqual(timers.map((t) => t.ms), [9000, 9000, 115000, 9000]);
});

test("a res over 8 MiB goes as ok:false \"too large\" on both channels; one at the limit goes as it is", async () => {
  const atLimit = (res) => "x".repeat(MAX_TO_DAEMON - JSON.stringify(res).length);
  const mainFit = atLimit({ t: "res", id: "m2", ok: true, data: { s: "" } });
  const bridgeFit = atLimit({ t: "res", ch: "bridge", id: "b2", ok: true, data: { s: "" } });
  const { f } = setup(
    { ping: async (r) => ({ s: r.id === "m1" ? mainFit + "x" : mainFit }) },
    { call: async (r) => ({ s: r.id === "b1" ? bridgeFit + "x" : bridgeFit }) },
  );
  const port = f.ports[0];
  for (const id of ["m1", "m2"]) sendReq(port, { t: "req", id, op: "ping" });
  for (const id of ["b1", "b2"]) sendReq(port, { t: "req", id, op: "call" }, "bridge");
  await tick();
  await tick();
  const res = resOf(port);
  assert.deepEqual(byId(res).map((m) => [m.id, m.ok, m.error]), [
    ["b1", false, "too large"], ["b2", true, undefined], ["m1", false, "too large"], ["m2", true, undefined],
  ]);
  assert.deepEqual(res.find((m) => m.id === "m1"), { t: "res", id: "m1", ok: false, error: "too large" });
  assert.deepEqual(res.find((m) => m.id === "b1"), { t: "res", ch: "bridge", id: "b1", ok: false, error: "too large" });
  for (const m of res.filter((x) => x.ok)) assert.equal(new TextEncoder().encode(JSON.stringify(m)).length, MAX_TO_DAEMON);
});

test("a message over 8 MiB that cannot become a short res is never sent", async () => {
  const { f, link } = setup();
  const port = f.ports[0];
  port.fireMessage({ t: "link", up: true });
  const before = port.posted.length;
  link.send({ t: "blocked", tab: 1, host: "h".repeat(MAX_TO_DAEMON) });
  const id = "i".repeat(MAX_TO_DAEMON); // even its error res is too large
  sendReq(port, { t: "req", id, op: "ping" });
  await tick();
  assert.equal(port.posted.length, before);
  sendReq(port, { t: "req", id: "p", op: "ping" });
  await tick();
  assert.deepEqual(port.posted.slice(before), [{ t: "res", id: "p", ok: true, data: {} }], "the link goes on");
});
