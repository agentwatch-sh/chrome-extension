// The receiver's part of PageFetch (contracts C4, C5 and C10; the PageFetch
// design, sections 5.3 and 5.4; board ab-v16.102).
//
// agent-browser's service fetches a page for an agent in a fetch window: an
// incognito window that the receiver opens (C10 windows.create with the mark
// "fetch"), so each fetch has a browser context of its own that shares no
// cookie, storage, worker or history with the agent's tabs, and that Chrome
// drops when the window closes. The fetch tab has no scope, no mark and no
// key tab:<id> (tabmap.js): the scope's list does not apply to it, so the
// window opens also for a scope with no list. Its main frame may load any
// host (C5, the fetch window's rules: rule 78, of rule 8's kind), the guard
// skips it (guard.js), and rules 79 to 86 block every request to a refused
// address. No connection sees it: bridge.tabScopes leaves it out, and no
// bridge.tabScope names it. A popup of a fetch tab is a fetch tab.
//
// - The fetch window: the receiver must be allowed in incognito; before it
//   opens one, it ends a left fetch window (its windows, its tabs and its
//   rules), and it refuses while any other incognito tab is open (an act's,
//   the operator's: all incognito windows share one context). The act's work
//   and the fetch's work run in one chain (Receiver.serial), so an act
//   window and a fetch window never both open. The copy holds
//   "fetch:<windowId>" for each fetch window, so a worker that starts again
//   closes it.
// - fetch_end (C4, channel main): every fetch tab closes first, then the
//   fetch window's rules go.
// - A link change ends the fetch window, and so does the worker's start.
//
// No log line holds a URL, a host or a value of the page.
import { ANOTHER_PRIVATE, NO_INCOGNITO, RULES_NOT_HELD, RULES_NOT_REMOVED } from "./act.js";
import { call } from "./attach.js";

export const FETCH_MARK = "fetch";
export const FETCH_KEY = "fetch:";
export const FETCH_TAB_KEY = "fetchtab:";
const KEY = /^fetch:(0|[1-9][0-9]{0,15})$/;
const TAB_KEY = /^fetchtab:(0|[1-9][0-9]{0,15})$/;
// The error text of fetch_end on channel main (C4).
export const FETCH_NOT_CLOSED = "fetch not closed";

export class FetchWindow {
  #r; // the Receiver: chrome, map, rules, removals, serial
  #windows = new Set(); // the fetch windows
  #tabs = new Set(); // the fetch popups and replaced fetch tabs with a key fetchtab:<id> (and those of the copy at the start)
  // At the worker's start with the fetch window's rules (or a fetch window in
  // the copy): every incognito tab is a tab of the fetch, as for the act.
  #sweepAll = false;

  constructor(receiver) {
    this.#r = receiver;
  }

  get #chrome() {
    return this.#r.chrome;
  }

  // A fetch window of this worker (or of the copy at its start).
  isWindow(windowId) {
    return this.#windows.has(windowId);
  }

  // A fetch window, a fetch tab or the fetch window's rules are (or may be) there.
  get open() {
    return this.#windows.size > 0 || this.#tabs.size > 0 || this.#r.map.fetches().length > 0 || this.#r.rules.fetching;
  }

  // A fetch popup or a replaced fetch tab: its key fetchtab:<id> goes into
  // the copy, so a worker that starts again closes it (best effort:
  // fetch_end closes it by its id anyway).
  keepTab(tabId) {
    this.#tabs.add(tabId);
    void call(() => this.#chrome.storage.session.set({ [FETCH_TAB_KEY + tabId]: true })).catch(() => {});
  }

  // ---- the fetch window (C10 windows.create with the mark "fetch") ----

  // data: the createData (url about:blank, incognito true); op: the bridge
  // request's state. The caller's scope needs no list: the receiver keeps
  // no scope for the fetch tab. The incognito check is the first chrome call
  // (no await before it). Answers the Window when the fetch window's rules
  // are in force (confirmed by a read) and the window's key is in the copy.
  create(data, op) {
    const r = this.#r;
    const allowed = call(() => this.#chrome.extension.isAllowedIncognitoAccess()).then((a) => a === true, () => false);
    return r.serial(async () => {
      if (!(await allowed)) throw new Error(NO_INCOGNITO);
      if (op.stale()) throw new Error("detached");
      // A left fetch window (a crash of the service, a fetch that did not
      // end): its windows, its popups and its rules go first. A tab of it
      // that stays open is another private window; rules that do not go
      // answer their own text.
      try {
        await this.#end();
      } catch (e) {
        throw new Error(e && e.message === RULES_NOT_REMOVED ? RULES_NOT_REMOVED : ANOTHER_PRIVATE);
      }
      // All incognito windows share one context: no other may be open (an act window neither).
      const tabs = await call(() => this.#chrome.tabs.query({}));
      if ((Array.isArray(tabs) ? tabs : []).some((t) => t && t.incognito === true)) throw new Error(ANOTHER_PRIVATE);
      if (op.stale()) throw new Error("detached");
      const win = await call(() => this.#chrome.windows.create(data));
      const tab = win && Array.isArray(win.tabs) ? win.tabs[0] : null;
      if (!win || win.incognito !== true || !tab || !Number.isInteger(tab.id) || !Number.isInteger(win.id)) {
        // Chrome gave no incognito window with a tab that the receiver can reach.
        if (tab && Number.isInteger(tab.id) && tab.incognito !== true) r.orphanClose(tab.id);
        if (win && win.incognito === true && Number.isInteger(win.id)) {
          // An incognito window with no tab: it closes as a fetch window that is left.
          this.#windows.add(win.id);
          await this.#end().catch(() => {});
        }
        throw new Error(NO_INCOGNITO);
      }
      this.#windows.add(win.id);
      const keyed = call(() => this.#chrome.storage.session.set({ [FETCH_KEY + win.id]: true }));
      keyed.catch(() => {});
      if (r.map.isGone(tab.id)) {
        // The tab closed already: no fetch tab (as for tabs.create).
        await this.#end().catch(() => {});
        return win;
      }
      r.map.addFetch(tab.id);
      // The fetch tab first, then each other fetch tab (a popup that came before the rules).
      const ruled = r.rules.setFetch([tab.id, ...r.map.fetches().filter((id) => id !== tab.id)]);
      const [a, b] = await Promise.allSettled([ruled, keyed]);
      if (a.status === "rejected" || b.status === "rejected") {
        // A rule that is not held fails closed, and so does a failed key: the fetch window ends.
        await this.#end().catch(() => {});
        throw a.status === "rejected" ? new Error(RULES_NOT_HELD) : b.reason;
      }
      if (op.stale()) {
        // A link change came during the op: no fetch window survives it.
        await this.#end().catch(() => {});
        throw new Error("detached");
      }
      return win;
    });
  }

  // ---- fetch_end (C4, channel main) ----

  // Every fetch tab closes (the fetch windows and their popups, by the
  // receiver's close), then the fetch window's rules go. Answers {closed}.
  end() {
    return this.#r.serial(() => this.#end());
  }

  // The worker's start, when the fetch window's rules are (or may be) in
  // force or the copy names a fetch window: every incognito tab that is open
  // closes first, then the rules go (as the act's start does: while a fetch
  // runs, every incognito tab belongs to it). A tab that does not close keeps
  // the rules (fail closed), and the next link change or fetch window tries
  // again, with the same rule.
  endAtStart() {
    this.#sweepAll = true;
    return this.end();
  }

  async #end() {
    const r = this.#r;
    const windows = new Set(this.#windows);
    const tabs = new Set(this.#tabs);
    // A tab of the fetch: a fetch tab, a tab of a fetch window, a tab of a
    // key fetchtab:<id>, and an incognito tab whose opener is one of them (a
    // popup whose navigation target has not come yet).
    const known = (id) => r.map.wasFetch(id) || tabs.has(id);
    const sweepAll = this.#sweepAll;
    const ofFetch = (t) => t && Number.isInteger(t.id) && (r.map.isFetch(t.id) || (t.incognito === true && (sweepAll ||
      windows.has(t.windowId) || tabs.has(t.id) || (Number.isInteger(t.openerTabId) && known(t.openerTabId)))));
    let closed = 0;
    if (sweepAll || windows.size > 0 || tabs.size > 0 || r.map.fetches().length > 0) {
      const item = await r.removals.closeOwn({ select: (all) => all.filter(ofFetch).map((t) => t.id) });
      closed = item.closed.length;
      if (item.error) throw new Error(FETCH_NOT_CLOSED);
      let again;
      try {
        again = await call(() => this.#chrome.tabs.query({}));
      } catch {
        throw new Error(FETCH_NOT_CLOSED);
      }
      // The rules stay while a tab of the fetch is open.
      if ((Array.isArray(again) ? again : []).some(ofFetch)) throw new Error(FETCH_NOT_CLOSED);
    }
    if (r.rules.fetching) {
      try {
        await r.rules.removeFetch();
      } catch {
        throw new Error(RULES_NOT_REMOVED);
      }
    }
    this.#sweepAll = false;
    if (windows.size > 0 || tabs.size > 0) {
      for (const id of windows) this.#windows.delete(id);
      for (const id of tabs) this.#tabs.delete(id);
      // A key that stays closes nothing at the next start: its window and its tabs are gone.
      const keys = [...[...windows].map((id) => FETCH_KEY + id), ...[...tabs].map((id) => FETCH_TAB_KEY + id)];
      await call(() => this.#chrome.storage.session.remove(keys)).catch(() => {});
    }
    return { closed };
  }

  // ---- the link and the worker ----

  // A link change (C10's cleanup): the fetch window ends. No chrome call when none is open.
  linkChanged() {
    if (!this.open) return Promise.resolve();
    return this.end().catch(() => {});
  }

  // The copy at the worker's start (tabmap.js, its one read): the fetch
  // windows and fetch tabs of a worker before this one. The start's end
  // (receiver.js startup) closes them, while the fetch window's rules still hold.
  restored(data) {
    for (const k of Object.keys(data ?? {})) {
      const w = KEY.exec(k);
      if (w) this.#windows.add(Number(w[1]));
      const t = TAB_KEY.exec(k);
      if (t) this.#tabs.add(Number(t[1]));
    }
  }
}
