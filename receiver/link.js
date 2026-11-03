// The receiver's native link to the daemon (contract C4).
import { PartJoiner } from "./wire.js";

const HOST_NAME = "sh.agentwatch.browser";
const MAX_DELAY_MS = 30000;
// The daemon waits 10 s (ping, set_allowlist) and 120 s (import); answer just before.
const TIMEOUT_MS = { import: 115000 };
const DEFAULT_TIMEOUT_MS = 9000;
// Messages sent while the link is down (blocked notices) wait for the next connection; the oldest
// gives way when more come.
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
  #draining = -1; // the generation whose requests a #drain loop runs, or -1
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
    if (!this.#port) {
      this.#waiting.push(msg);
      if (this.#waiting.length > MAX_WAITING) this.#waiting.shift();
      return;
    }
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
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const msg of waiting) this.send(msg);
  }

  #onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "link") {
      if (msg.up === true) this.#hello();
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

  // One request at a time per connection. After a reconnect the new connection's requests start at
  // once: a handler of the old connection that still runs (an import, up to 115 s) is not waited for,
  // and its answer is muted. importState runs one import at a time by itself.
  async #drain() {
    const gen = this.#generation;
    if (this.#draining === gen) return;
    this.#draining = gen;
    try {
      while (gen === this.#generation && this.#queue.length > 0) {
        const req = this.#queue.shift();
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
      if (this.#draining === gen) this.#draining = -1;
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
