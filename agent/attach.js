// Every chrome.debugger.attach of the agent package goes through this module:
// the bridge's attach (contract C10) and the import's attach of its restore
// tab (C6). So one place knows which tabs the bridge attached (the bridge
// tabs) and which tab is the restore tab of a running import, which the bridge
// never touches.
//
// A bridge tab is a tab that the bridge attached and did not detach since.
// After a link change (reset) no bridge tab is left: an attach that was still
// running then detaches its tab when it ends, as a tab of no connection.

const PROTOCOL_VERSION = "1.3";

// Runs fn now and gives its result or its throw as a promise, so a chrome.*
// call always starts before the caller's next statement.
export function call(fn) {
  return new Promise((resolve) => resolve(fn()));
}

export class Attachments {
  #chrome;
  #tabs = new Set(); // the bridge tabs
  #inflight = new Map(); // tabId -> {epoch, promise}: a bridge attach that runs
  #epoch = 0; // counts the resets
  #restore = null; // the restore tab of the running import
  // The eager attach of a new tab (C10 bridge.attachNew). Off at the start
  // and after each reset.
  attachNew = false;

  constructor(chrome) {
    this.#chrome = chrome;
  }

  isBridgeTab(tabId) {
    return this.#tabs.has(tabId);
  }

  isRestoreTab(tabId) {
    return this.#restore !== null && this.#restore === tabId;
  }

  // C10 debugger.attach: {already: true} for a bridge tab. A second attach
  // while one runs joins it: both get its answer, the second with already
  // true. An attach of a tab whose attach from before a reset still runs
  // waits until that one has ended and detached.
  attach(tabId) {
    if (this.#tabs.has(tabId)) return Promise.resolve({ already: true });
    const running = this.#inflight.get(tabId);
    if (running && running.epoch === this.#epoch) return running.promise.then(() => ({ already: true }));
    if (running) {
      const again = () => this.attach(tabId);
      return running.promise.then(again, again);
    }
    const epoch = this.#epoch;
    const entry = { epoch, promise: null };
    entry.promise = call(() => this.#chrome.debugger.attach({ tabId }, PROTOCOL_VERSION))
      .then(async () => {
        if (epoch === this.#epoch) {
          this.#tabs.add(tabId);
          return;
        }
        // A link change came while the attach ran: no connection owns the tab.
        await call(() => this.#chrome.debugger.detach({ tabId })).catch(() => {});
        throw new Error("detached");
      })
      .finally(() => {
        if (this.#inflight.get(tabId) === entry) this.#inflight.delete(tabId);
      });
    this.#inflight.set(tabId, entry);
    return entry.promise.then(() => ({ already: false }));
  }

  // C10 debugger.detach: null also for a tab that is not a bridge tab. A
  // detach while an attach of the tab runs (the relay detaches after an
  // attach that timed out) waits for that attach first.
  detach(tabId) {
    const running = this.#inflight.get(tabId);
    if (running) {
      const again = () => this.detach(tabId);
      return running.promise.then(again, again);
    }
    if (!this.#tabs.has(tabId)) return Promise.resolve(null);
    this.#tabs.delete(tabId);
    return call(() => this.#chrome.debugger.detach({ tabId })).then(() => null);
  }

  // Chrome ended the attachment itself (chrome.debugger.onDetach).
  dropped(tabId) {
    this.#tabs.delete(tabId);
  }

  // C10's cleanup at the worker's start and at each link change: the eager
  // attach goes off, and every bridge tab and every tab that
  // chrome.debugger.getTargets() reports as attached is detached (a worker
  // that started again knows no bridge tabs), except the restore tab of a
  // running import. Errors are ignored. A tab that a new connection attached
  // while this runs stays attached.
  async reset() {
    this.#epoch += 1;
    this.attachNew = false;
    const known = [...this.#tabs];
    this.#tabs.clear();
    const quiet = (tabId) => call(() => this.#chrome.debugger.detach({ tabId })).catch(() => {});
    const detaching = known.map(quiet);
    let targets = [];
    try {
      targets = await this.#chrome.debugger.getTargets();
    } catch {
      targets = [];
    }
    for (const t of Array.isArray(targets) ? targets : []) {
      if (!t || t.attached !== true || !Number.isInteger(t.tabId)) continue;
      const id = t.tabId;
      if (known.includes(id) || this.isRestoreTab(id) || this.#tabs.has(id) || this.#inflight.has(id)) continue;
      detaching.push(quiet(id));
    }
    await Promise.all(detaching);
  }

  // The import's restore tab (channel main, C6). The import marks the tab as
  // soon as it knows its id and clears the mark when it ends; its attach and
  // detach of that tab come through here too.
  markRestore(tabId) {
    this.#restore = tabId;
  }

  clearRestore(tabId) {
    if (this.#restore === tabId) this.#restore = null;
  }

  attachRestore(tabId) {
    return call(() => this.#chrome.debugger.attach({ tabId }, PROTOCOL_VERSION));
  }

  detachRestore(tabId) {
    return call(() => this.#chrome.debugger.detach({ tabId }));
  }
}

// One Attachments per chrome object (one per worker start), so the bridge and
// the import share it.
const byChrome = new WeakMap();

export function attachments(chrome) {
  let a = byChrome.get(chrome);
  if (!a) {
    a = new Attachments(chrome);
    byChrome.set(chrome, a);
  }
  return a;
}
