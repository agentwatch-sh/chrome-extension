// The receiver as agent/sw.js wires it, on the fake chrome, for the per-scope tests: the link, the
// bridge, the worker's start (the removal of every session rule and the restore of the map from its
// copy) before the native port connects, then a link up. The timers are fake: a test fires one by
// hand (fire(ms)). This file holds no test.
import assert from "node:assert/strict";
import { Bridge } from "../agent/bridge.js";
import { ReceiverLink } from "../agent/link.js";
import { mainOps, setScopes } from "../agent/allowlist.js";
import { receiver } from "../agent/receiver.js";
import { PART_BYTES, splitParts } from "../agent/wire.js";
import { makeFakeChrome } from "./fake-chrome.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));
export const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};

// tabs: the open tabs; copy: chrome.storage.session; scopes: a set_scopes to apply after the link up.
// chromeEdit(f): changes the fake chrome before the receiver is built (for example a withheld permission).
export async function startReceiver({ tabs = [], copy = null, targets = [], scopes = null, beforeStart = () => {}, chromeEdit = () => {} } = {}) {
  const f = makeFakeChrome();
  chromeEdit(f);
  f.manifest = { version: "0.3.0" };
  f.setTabs(structuredClone(tabs));
  f.targets_ = structuredClone(targets);
  if (copy) f.storage_.session = structuredClone(copy);
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (t) => {
    if (t) t.cleared = true;
  };
  const link = new ReceiverLink(f.chrome, { main: mainOps(f.chrome), bridge: (req) => bridge.handle(req) }, { onLinkChange: () => bridge.reset(), setTimer, clearTimer });
  const bridge = new Bridge(f.chrome, link, { setTimer, clearTimer, navigator: { userAgent: "UA" } });
  // The blocked notices, as agent/sw.js wires them (the guard, DNR's blocks, a popup's retry).
  receiver(f.chrome).notify = (msg) => link.send(msg);
  await beforeStart(f);
  void bridge.reset();
  const r = receiver(f.chrome);
  await r.startup();
  link.start();
  const port = () => f.ports.at(-1);
  port().fireMessage({ t: "link", up: true });
  await flush();
  // A bridge request, so the link carries bridge events (C10).
  const send = (req) => {
    for (const p of splitParts(req.id, req, PART_BYTES, "bridge")) port().fireMessage(p);
  };
  const sendMain = (req) => {
    for (const p of splitParts(req.id, req, PART_BYTES)) port().fireMessage(p);
  };
  const resOf = (id) => port().posted.filter((m) => m.t === "res" && m.id === id);
  const answer = async (req) => {
    send({ t: "req", ...req });
    await flush();
    const got = resOf(req.id);
    assert.equal(got.length, 1, `${req.id}: exactly one res`);
    return got[0];
  };
  const evs = () => port().posted.filter((m) => m.t === "ev");
  const notices = () => port().posted.filter((m) => m.t === "blocked");
  const pending = (ms) => timers.filter((t) => !t.cleared && t.ms === ms);
  // Fires every pending timer of ms (once), then lets the promises run.
  const fire = async (ms) => {
    for (const t of pending(ms)) {
      t.cleared = true;
      t.fn();
    }
    await flush();
  };
  await answer({ id: "open", op: "bridge.info", args: [] });
  if (scopes) await setScopes(f.chrome, scopes);
  await flush();
  return { f, r, link, bridge, timers, port, send, sendMain, resOf, answer, evs, notices, pending, fire, set: (msg) => setScopes(f.chrome, msg) };
}

// The chrome calls since mark, without the port's posts and the reads of lastError.
export const callsSince = (f, mark) => f.calls.slice(mark).filter(([p]) => p !== "port.postMessage" && p !== "runtime.lastError");
