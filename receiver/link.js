// The receiver's native link to the daemon (contract C4). Two channels share it:
// "main" runs its requests one at a time in arrival order (an import can take
// 115 s); "bridge" starts each request as soon as it is joined, so a bridge
// request never waits behind an import or behind another bridge request.
import { CHANNELS, ChannelJoiner, jsonTooLarge } from "./wire.js";

const HOST_NAME = "sh.agentwatch.browser";
const MAX_DELAY_MS = 30000;
// The daemon waits 10 s (ping, set_allowlist) and 120 s (import); answer just before.
// C10 sets the bridge's waits; until then a bridge request gets the default.
const TIMEOUT_MS = { main: { import: 115000 }, bridge: {} };
const DEFAULT_TIMEOUT_MS = 9000;
// The native host drops a message while its daemon socket is down, and it says
// {"t":"link","up":true} after each socket connect. So a notice (blocked) waits
// from a disconnect, or from a connect, to the next link up, and follows that
// hello. At most MAX_WAITING wait; the oldest gives way. A hello or a res never
// waits: a res belongs to its connection. The host sends no "down", so a notice
// during a daemon outage of a running host still reaches only the host, which
// drops it.
const MAX_WAITING = 100;

// The daemon drops the link at a message over MAX_TO_DAEMON (wire.js). So a res
// over it goes as the error "too large", and any other message over it (or a
// res whose error is still too large) is never sent.
function fitForDaemon(msg) {
  if (!jsonTooLarge(msg)) return msg;
  if (msg.t !== "res") return null;
  const fields = { id: msg.id, ok: false, error: "too large" };
  const res = Object.hasOwn(msg, "ch") ? { t: "res", ch: msg.ch, ...fields } : { t: "res", ...fields };
  return jsonTooLarge(res) ? null : res;
}

export class ReceiverLink {
  #chrome;
  #handlers;
  #setTimer;
  #clearTimer;
  #generation = 0;
  #port = null;
  #joiner = new ChannelJoiner();
  #queue = []; // main requests only
  #running = false;
  #linkUp = false;
  #waiting = [];
  #delay = 1000;

  // handlers: {main: {op: (req) => data}, bridge: {op: (req) => data}}.
  constructor(chrome, handlers, { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h) } = {}) {
    this.#chrome = chrome;
    this.#handlers = handlers;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  start() {
    this.#connect();
  }

  send(msg) {
    const notice = msg.t !== "hello" && msg.t !== "res";
    if (notice && (!this.#port || !this.#linkUp)) {
      this.#waiting.push(msg);
      if (this.#waiting.length > MAX_WAITING) this.#waiting.shift();
      return;
    }
    if (!this.#port) return;
    const out = fitForDaemon(msg);
    if (out === null) return;
    try {
      this.#port.postMessage(out);
    } catch {
      // The port is closing; onDisconnect schedules the reconnect.
    }
  }

  #hello() {
    this.send({ t: "hello", v: 2, version: this.#chrome.runtime.getManifest().version, channels: [...CHANNELS] });
  }

  #connect() {
    const port = this.#chrome.runtime.connectNative(HOST_NAME);
    this.#port = port;
    this.#linkUp = false;
    this.#joiner = new ChannelJoiner();
    port.onMessage.addListener((msg) => {
      if (this.#port !== port) return;
      this.#delay = 1000;
      this.#onMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      void this.#chrome.runtime.lastError; // read it, so Chrome logs no unchecked error
      if (this.#port !== port) return;
      this.#port = null;
      this.#generation += 1;
      this.#queue = [];
      const ms = this.#delay;
      this.#delay = Math.min(this.#delay * 2, MAX_DELAY_MS);
      this.#setTimer(() => this.#connect(), ms);
    });
    this.#hello();
  }

  #onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "link") {
      if (msg.up === true) {
        // A new daemon connection: the unfinished parts came from the old one.
        this.#joiner = new ChannelJoiner();
        this.#linkUp = true;
        this.#hello();
        const waiting = this.#waiting;
        this.#waiting = [];
        for (const m of waiting) this.send(m);
      }
      return;
    }
    if (msg.t === "part") {
      const joined = this.#joiner.push(msg);
      if (!joined) return;
      const { ch, req } = joined;
      if (!req || req.t !== "req" || typeof req.id !== "string") return;
      if (ch === "main") {
        this.#queue.push(req);
        this.#drain();
      } else {
        void this.#answer(ch, req);
      }
    }
  }

  #withTimeout(promise, ch, op) {
    let handle;
    const timeout = new Promise((_, reject) => {
      const table = TIMEOUT_MS[ch] ?? {};
      const ms = Object.hasOwn(table, op) ? table[op] : DEFAULT_TIMEOUT_MS;
      handle = this.#setTimer(() => reject(new Error("timeout")), ms);
    });
    const done = Promise.resolve(promise);
    done.catch(() => {}); // a late failure after the timeout is ignored
    return Promise.race([done, timeout]).finally(() => this.#clearTimer(handle));
  }

  async #drain() {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) await this.#answer("main", this.#queue.shift());
    } finally {
      this.#running = false;
    }
  }

  // Runs one request and posts its res; it never rejects. A res names its
  // channel in "ch", except on main, whose res stays as before channels.
  async #answer(ch, req) {
    const gen = this.#generation;
    const reply = (fields) => {
      if (gen === this.#generation) this.send(ch === "main" ? { t: "res", ...fields } : { t: "res", ch, ...fields });
    };
    try {
      const ops = (Object.hasOwn(this.#handlers, ch) && this.#handlers[ch]) || {};
      const handler = Object.hasOwn(ops, req.op) ? ops[req.op] : null;
      if (typeof handler !== "function") throw new Error("unknown op");
      const data = await this.#withTimeout(handler(req), ch, req.op);
      reply({ id: req.id, ok: true, data });
    } catch (e) {
      reply({ id: req.id, ok: false, error: String(e && e.message ? e.message : "request failed") });
    }
  }
}

export function watchBlocked(chrome, send) {
  chrome.webNavigation.onErrorOccurred.addListener((details) => {
    if (details.frameId !== 0 || details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
    let host;
    try {
      host = new URL(details.url).hostname;
    } catch {
      return;
    }
    send({ t: "blocked", tab: details.tabId, host });
  });
}
