// The receiver's native link to the daemon (contract C4).
import { PartJoiner } from "./wire.js";

const HOST_NAME = "sh.agentwatch.browser";
const MAX_DELAY_MS = 30000;
// The daemon waits 10 s (ping, set_allowlist) and 120 s (import); answer just before.
const TIMEOUT_MS = { import: 115000 };
const DEFAULT_TIMEOUT_MS = 9000;
// The native host drops a message while its daemon socket is down, and it says
// {"t":"link","up":true} after each socket connect. So a notice (blocked) waits
// from a disconnect, or from a connect, to the next link up, and follows that
// hello. At most MAX_WAITING wait; the oldest gives way. A hello or a res never
// waits: a res belongs to its connection. The host sends no "down", so a notice
// during a daemon outage of a running host still reaches only the host, which
// drops it.
const MAX_WAITING = 100;

export class ReceiverLink {
  #chrome;
  #handlers;
  #setTimer;
  #clearTimer;
  #generation = 0;
  #port = null;
  #joiner = new PartJoiner();
  #queue = [];
  #running = false;
  #linkUp = false;
  #waiting = [];
  #delay = 1000;

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
    try {
      this.#port.postMessage(msg);
    } catch {
      // The port is closing; onDisconnect schedules the reconnect.
    }
  }

  #hello() {
    this.send({ t: "hello", v: 1, version: this.#chrome.runtime.getManifest().version });
  }

  #connect() {
    const port = this.#chrome.runtime.connectNative(HOST_NAME);
    this.#port = port;
    this.#linkUp = false;
    this.#joiner = new PartJoiner();
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
        this.#linkUp = true;
        this.#hello();
        const waiting = this.#waiting;
        this.#waiting = [];
        for (const m of waiting) this.send(m);
      }
      return;
    }
    if (msg.t === "part") {
      const req = this.#joiner.push(msg);
      if (req && req.t === "req" && typeof req.id === "string") {
        this.#queue.push(req);
        this.#drain();
      }
    }
  }

  #withTimeout(promise, op) {
    let handle;
    const timeout = new Promise((_, reject) => {
      const ms = Object.hasOwn(TIMEOUT_MS, op) ? TIMEOUT_MS[op] : DEFAULT_TIMEOUT_MS;
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
      while (this.#queue.length > 0) {
        const req = this.#queue.shift();
        const gen = this.#generation;
        const reply = (msg) => {
          if (gen === this.#generation) this.send(msg);
        };
        try {
          const handler = Object.hasOwn(this.#handlers, req.op) ? this.#handlers[req.op] : null;
          if (typeof handler !== "function") throw new Error("unknown op");
          const data = await this.#withTimeout(handler(req), req.op);
          reply({ t: "res", id: req.id, ok: true, data });
        } catch (e) {
          reply({ t: "res", id: req.id, ok: false, error: String(e && e.message ? e.message : "request failed") });
        }
      }
    } finally {
      this.#running = false;
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
