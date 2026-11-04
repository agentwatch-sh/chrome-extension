// Every chrome.debugger.attach of the agent package goes through this module:
// the bridge's attach (contract C10) and the import's attach of its restore
// tab (C6). So one place knows which tabs the bridge attached (the bridge
// tabs) and which tab is the restore tab of a running import, which the bridge
// never touches.
//
// A bridge tab is a tab that the bridge attached and did not detach since.
// The bridge's attaches and detaches of one tab run in arrival order, one
// after the other (a promise chain per tab). Each op takes the epoch (the
// count of resets) when it arrives. After a link change (reset) no bridge tab
// is left: an op from before it attaches nothing, and an attach that was
// still running then detaches its tab, as a tab of no connection.

const PROTOCOL_VERSION = "1.3";

// Runs fn now and gives its result or its throw as a promise, so a chrome.*
// call always starts before the caller's next statement.
export function call(fn) {
  return new Promise((resolve) => resolve(fn()));
}

const stale = () => new Error("detached");

export class Attachments {
  #chrome;
  #tabs = new Set(); // the bridge tabs
  #chains = new Map(); // tabId -> {kind, epoch, run, done}: the last op of the tab that has not ended
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

  // Runs fn(epoch) after the ops of the tab that came before it; the first op
  // of a tab runs at once. Gives fn's promise.
  #queue(tabId, kind, fn) {
    const epoch = this.#epoch;
    const before = this.#chains.get(tabId);
    const run = before ? before.done.then(() => fn(epoch)) : call(() => fn(epoch));
    const entry = { kind, epoch, run, done: run.then(() => {}, () => {}) };
    this.#chains.set(tabId, entry);
    entry.done.then(() => {
      if (this.#chains.get(tabId) === entry) this.#chains.delete(tabId);
    });
    return run;
  }

  // C10 debugger.attach: {already: true} for a bridge tab. A second attach
  // while one runs (with no op of the tab between them) joins it: both get
  // its answer, the second with already true. precheck() runs in the op,
  // before Chrome's attach; it throws to refuse the tab.
  attach(tabId, precheck = () => {}) {
    const last = this.#chains.get(tabId);
    if (last && last.kind === "attach" && last.epoch === this.#epoch) return last.run.then(() => ({ already: true }));
    return this.#queue(tabId, "attach", async (epoch) => {
      if (epoch !== this.#epoch) throw stale();
      if (this.#tabs.has(tabId)) return { already: true };
      await precheck();
      if (epoch !== this.#epoch) throw stale();
      await call(() => this.#chrome.debugger.attach({ tabId }, PROTOCOL_VERSION));
      if (epoch !== this.#epoch) {
        // A link change came while the attach ran: no connection owns the tab.
        await call(() => this.#chrome.debugger.detach({ tabId })).catch(() => {});
        throw stale();
      }
      this.#tabs.add(tabId);
      return { already: false };
    });
  }

  // C10 debugger.detach: null also for a tab that is not a bridge tab. It
  // runs after the attach of the tab that came before it (the relay detaches
  // after an attach that timed out).
  detach(tabId) {
    return this.#queue(tabId, "detach", async () => {
      if (!this.#tabs.has(tabId)) return null;
      this.#tabs.delete(tabId);
      await call(() => this.#chrome.debugger.detach({ tabId }));
      return null;
    });
  }

  // Chrome ended the attachment itself (chrome.debugger.onDetach).
  dropped(tabId) {
    this.#tabs.delete(tabId);
  }

  // C10's cleanup at the worker's start and at each link change: the eager
  // attach goes off, and every bridge tab and every tab that
  // chrome.debugger.getTargets() reports as attached is detached (a worker
  // that started again knows no bridge tabs), except the restore tab of a
  // running import. Errors are ignored. The detaches go in the tabs' chains,
  // so an attach of the new connection runs after them; a tab that the new
  // connection attaches, or whose op still runs, keeps its state.
  async reset() {
    this.#epoch += 1;
    this.attachNew = false;
    const known = [...this.#tabs];
    this.#tabs.clear();
    const quiet = (tabId) => this.#queue(tabId, "detach", () => call(() => this.#chrome.debugger.detach({ tabId }))).catch(() => {});
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
      if (known.includes(id) || this.isRestoreTab(id) || this.#tabs.has(id) || this.#chains.has(id)) continue;
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
