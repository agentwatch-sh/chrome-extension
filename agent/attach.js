// Every chrome.debugger.attach of the agent package goes through this module:
// the bridge's attach (contract C10) and the import's attach of its restore
// tab (C6), and the eager attach of a new tab with its hold (C10, hold.js).
// So one place knows which tabs the bridge attached (the bridge tabs) and
// which tab is the restore tab of a running import, which the bridge never
// touches.
//
// A bridge tab is a tab that the bridge attached and did not detach since.
// The bridge's attaches and detaches of one tab run in arrival order, one
// after the other (a promise chain per tab). Each op takes the epoch (the
// count of resets) when it arrives. After a link change (reset) no bridge tab
// is left: an op from before it attaches nothing, and an attach that was
// still running then detaches its tab, as a tab of no connection.
//
// The receiver's close (removals.js) is one op of the tab's chain too: it
// uses the bridge's attachment when the tab has one, else an attach for the
// close only, which makes no bridge tab (no hold, no event to the relay).

import { Holds } from "./hold.js";

const PROTOCOL_VERSION = "1.3";

// Runs fn now and gives its result or its throw as a promise, so a chrome.*
// call always starts before the caller's next statement.
export function call(fn) {
  return new Promise((resolve) => resolve(fn()));
}

const stale = () => new Error("detached");
const message = (e) => String(e && e.message ? e.message : e);

export class Attachments {
  #chrome;
  #tabs = new Set(); // the bridge tabs
  #live = new Set(); // the tabs that the bridge's attachment holds (a bridge tab, or one whose detach still waits in its chain)
  #closing = new Set(); // the tabs that an attach for a receiver's close holds
  #chains = new Map(); // tabId -> {kind, epoch, run, done}: the last op of the tab that has not ended
  #epoch = 0; // counts the resets
  #restore = null; // the restore tab of the running import
  #restoreDomain = null; // its import's domain (C5's guard: the restore tab's covered set)
  #opening = null; // a promise while the import creates its restore tab and does not know its id
  #eager = new Set(); // the tabs whose eager attach runs
  #gone = new Set(); // of those, the tabs whose attachment Chrome ended meanwhile
  // The eager attach of a new tab (C10 bridge.attachNew). Off at the start
  // and after each reset.
  attachNew = false;

  constructor(chrome) {
    this.#chrome = chrome;
    this.holds = new Holds(chrome);
  }

  isBridgeTab(tabId) {
    return this.#tabs.has(tabId);
  }

  // The tab has an attachment of this worker that a receiver's close can use.
  isAttached(tabId) {
    return this.#live.has(tabId) || this.#closing.has(tabId);
  }

  isRestoreTab(tabId) {
    return this.#restore !== null && this.#restore === tabId;
  }

  // The domain of the import whose restore tab this is, else null.
  restoreDomain(tabId) {
    return this.isRestoreTab(tabId) ? this.#restoreDomain : null;
  }

  // True while the import creates its restore tab and does not know its id.
  get restoreOpening() {
    return this.#opening !== null;
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

  // Runs fn() as one op of the tab's chain (the receiver's close). Joins the
  // chain at once; gives fn's promise.
  inChain(tabId, fn) {
    return this.#queue(tabId, "close", () => fn());
  }

  // C10 debugger.attach: {already: true} for a bridge tab. A second attach
  // while one runs (with no op of the tab between them) joins it: both get
  // its answer, the second with already true. precheck() runs in the op,
  // before Chrome's attach; it throws to refuse the tab. refuse() runs right
  // before Chrome's attach, with no await between: a text refuses the tab.
  attach(tabId, precheck = () => {}, refuse = () => null) {
    const last = this.#chains.get(tabId);
    if (last && last.kind === "attach" && last.epoch === this.#epoch) return last.run.then(() => ({ already: true }));
    return this.#queue(tabId, "attach", async (epoch) => {
      if (epoch !== this.#epoch) throw stale();
      if (this.#tabs.has(tabId)) return { already: true };
      await precheck();
      if (epoch !== this.#epoch) throw stale();
      const no = refuse();
      if (no) throw new Error(no);
      await call(() => this.#chrome.debugger.attach({ tabId }, PROTOCOL_VERSION));
      this.#live.add(tabId);
      if (epoch !== this.#epoch) {
        // A link change came while the attach ran: no connection owns the tab.
        await this.#detachNow(tabId).catch(() => {});
        throw stale();
      }
      this.#tabs.add(tabId);
      return { already: false };
    });
  }

  #detachNow(tabId) {
    return call(() => this.#chrome.debugger.detach({ tabId })).finally(() => this.#live.delete(tabId));
  }

  // The receiver's close of a tab that has no attachment of this worker: an
  // attach for this close only, and its end (removals.js; in the tab's chain).
  attachForClose(tabId) {
    return call(() => this.#chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)).then(() => {
      this.#closing.add(tabId);
    });
  }

  detachForClose(tabId) {
    this.#closing.delete(tabId);
    return call(() => this.#chrome.debugger.detach({ tabId }));
  }

  // C10's eager attach of a new tab, one op of the tab's chain: the attach and
  // the start of its hold, so an attach or a command of the relay comes after
  // the hold's own Fetch.enable. The tab is a bridge tab once its hold is on.
  // The hold's Fetch.enable goes right behind the attach, without waiting for
  // its answer: Chrome runs the calls in order, and the tab's first request
  // leaves a few ms after tabs.onCreated (C10 gives the measured numbers).
  // While the import creates its restore tab and does not know its id, the op
  // waits; then it skips the restore tab. skip(): true for a tab that the
  // bridge never attaches (a page of the agent package's own origin, a
  // marked tab). It is read again when the attach and the hold are on: a tab
  // that became such a tab meanwhile (a popup of a marked tab, whose
  // navigation target came during the attach) gets its hold ended and its
  // attachment detached, and is no bridge tab. A tab whose attachment Chrome
  // ends during the op (the tab closed) is no bridge tab either. Gives the
  // fields of the tabs.onCreated event: attached, held, and error when
  // Chrome refused the attach.
  attachNewTab(tabId, skip = () => false) {
    const no = { attached: false, held: false };
    const skipped = typeof skip === "function" ? skip : () => skip;
    return this.#queue(tabId, "eager", async (epoch) => {
      while (this.#opening) await this.#opening;
      if (epoch !== this.#epoch || !this.attachNew || skipped() || this.isRestoreTab(tabId)) return no;
      if (this.#tabs.has(tabId)) return { attached: true, held: false };
      this.#eager.add(tabId);
      try {
        const attaching = call(() => this.#chrome.debugger.attach({ tabId }, PROTOCOL_VERSION));
        const holding = this.holds.start(tabId);
        try {
          await attaching;
        } catch (e) {
          await holding;
          this.holds.drop(tabId);
          return { ...no, error: message(e) };
        }
        if (!this.#gone.has(tabId)) this.#live.add(tabId);
        const held = await holding;
        if (this.#gone.has(tabId)) {
          this.holds.drop(tabId);
          return no;
        }
        if (epoch !== this.#epoch) {
          // A link change came while the attach ran: no connection owns the tab.
          this.holds.drop(tabId);
          await this.#detachNow(tabId).catch(() => {});
          return no;
        }
        if (skipped()) {
          // The tab got the mark while the attach ran: no client takes its
          // held requests (they continue), and it is detached.
          await this.holds.release(tabId, false);
          await this.#detachNow(tabId).catch(() => {});
          return no;
        }
        this.#tabs.add(tabId);
        return { attached: true, held };
      } finally {
        this.#eager.delete(tabId);
        this.#gone.delete(tabId);
      }
    });
  }

  // C10 bridge.release: ends the hold of the tab, after the ops of the tab
  // that came before it. null also for a tab with no hold.
  release(tabId) {
    return this.#queue(tabId, "release", () => this.holds.release(tabId).then(() => null));
  }

  // C10 debugger.detach: null also for a tab that is not a bridge tab. It
  // runs after the attach of the tab that came before it (the relay detaches
  // after an attach that timed out). A hold of the tab ends first.
  detach(tabId) {
    return this.#queue(tabId, "detach", async () => {
      if (!this.#tabs.has(tabId)) return null;
      this.#tabs.delete(tabId);
      await this.holds.release(tabId, false); // the relay takes no request of a tab that it detaches
      await this.#detachNow(tabId);
      return null;
    });
  }

  // Chrome ended the attachment itself (chrome.debugger.onDetach), also of a
  // tab whose eager attach runs. True for a bridge tab.
  dropped(tabId) {
    if (this.#eager.has(tabId)) this.#gone.add(tabId);
    this.holds.drop(tabId);
    this.#live.delete(tabId);
    this.#closing.delete(tabId);
    return this.#tabs.delete(tabId);
  }

  // C10's cleanup at the worker's start and at each link change: the eager
  // attach goes off, every hold ends, and every bridge tab and every tab that
  // chrome.debugger.getTargets() reports as attached is detached (a worker
  // that started again knows no bridge tabs), except the restore tab of a
  // running import. Errors are ignored. The detaches go in the tabs' chains,
  // so an attach of the new connection runs after them; a tab that the new
  // connection attaches, or whose op still runs, keeps its state. So the
  // attach of a receiver's close that runs is never detached: the detach of
  // a bridge tab goes into the chain after the close.
  async reset() {
    this.#epoch += 1;
    this.attachNew = false;
    this.holds.releaseAll();
    const known = [...this.#tabs];
    this.#tabs.clear();
    const quiet = (tabId) => this.#queue(tabId, "detach", () => this.#detachNow(tabId)).catch(() => {});
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

  // The import's restore tab (channel main, C6). The import sets a flag
  // before it calls tabs.create (openingRestore), marks the tab as soon as it
  // knows its id, then clears the flag (the function that openingRestore
  // gives; it may run again), and clears the mark when it ends. Its attach and
  // detach of that tab come through here too.
  openingRestore() {
    let known;
    const opening = new Promise((resolve) => (known = resolve));
    this.#opening = opening;
    return () => {
      if (this.#opening === opening) this.#opening = null;
      known();
    };
  }

  markRestore(tabId, domain = null) {
    this.#restore = tabId;
    this.#restoreDomain = domain;
  }

  clearRestore(tabId) {
    if (this.#restore !== tabId) return;
    this.#restore = null;
    this.#restoreDomain = null;
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
