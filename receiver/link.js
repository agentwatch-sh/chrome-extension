// The receiver's native link to the daemon (contract C4).
import { PartJoiner } from "./wire.js";

const HOST_NAME = "sh.agentwatch.browser";
const MAX_DELAY_MS = 30000;

export class ReceiverLink {
  #chrome;
  #handlers;
  #setTimer;
  #port = null;
  #joiner = new PartJoiner();
  #queue = [];
  #running = false;
  #delay = 1000;

  constructor(chrome, handlers, { setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
    this.#chrome = chrome;
    this.#handlers = handlers;
    this.#setTimer = setTimer;
  }

  start() {
    this.#connect();
  }

  send(msg) {
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
    this.#joiner = new PartJoiner();
    port.onMessage.addListener((msg) => {
      if (this.#port !== port) return;
      this.#delay = 1000;
      this.#onMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      if (this.#port !== port) return;
      this.#port = null;
      const ms = this.#delay;
      this.#delay = Math.min(this.#delay * 2, MAX_DELAY_MS);
      this.#setTimer(() => this.#connect(), ms);
    });
    this.#hello();
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

  async #drain() {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) {
        const req = this.#queue.shift();
        try {
          const handler = Object.hasOwn(this.#handlers, req.op) ? this.#handlers[req.op] : null;
          if (typeof handler !== "function") throw new Error("unknown op");
          const data = await handler(req);
          this.send({ t: "res", id: req.id, ok: true, data });
        } catch (e) {
          this.send({ t: "res", id: req.id, ok: false, error: String(e && e.message ? e.message : "request failed") });
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
