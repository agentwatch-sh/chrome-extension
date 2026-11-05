// The receiver's state per worker (one per chrome object): the attachments
// (attach.js), the tab-to-scope map and its copy (tabmap.js), the session
// rules (dnr.js), the removal queue (removals.js) and the popups with their
// retry (popups.js), with the chrome events that change the map. The bridge
// (bridge.js), set_scopes (allowlist.js) and the import (importer.js) share it.
import { attachments } from "./attach.js";
import { SessionRules } from "./dnr.js";
import { Popups } from "./popups.js";
import { Removals } from "./removals.js";
import { TabMap } from "./tabmap.js";

export const NO_LIST = "no list for this scope";

export class Receiver {
  // The timers and the clock; the bridge sets its own (tests use fake ones).
  clock = {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    now: () => Date.now(),
  };
  // The bridge sends an event of C10 through this (bridge.js sets it).
  emit = () => {};
  // Copy keys whose removal failed or came late: the next set_scopes removes them again.
  staleKeys = new Set();

  constructor(chrome) {
    this.chrome = chrome;
    this.att = attachments(chrome);
    const clock = {
      setTimer: (fn, ms) => this.clock.setTimer(fn, ms),
      clearTimer: (h) => this.clock.clearTimer(h),
      now: () => this.clock.now(),
    };
    this.map = new TabMap(chrome, clock);
    this.rules = new SessionRules(chrome, () => this.#model(), clock);
    this.removals = new Removals(chrome, { att: this.att, map: this.map, clock });
    this.popups = new Popups(this);
    this.att.holds.onKept = (tabId) => this.popups.paused(tabId);
    this.#listen();
  }

  // The lists of the open tabs of the map, under the last set_scopes: list
  // name -> {entries, tabIds}.
  #model() {
    const cur = this.map.current;
    const out = new Map();
    for (const [tabId, scope] of this.map.entries()) {
      const name = cur.listOf(scope);
      if (name === null) continue;
      if (!out.has(name)) out.set(name, { entries: cur.lists[name], tabIds: [] });
      out.get(name).tabIds.push(tabId);
    }
    return out;
  }

  // C10 at the worker's start, before the native port connects: every
  // session rule goes (and dynamic rules 2 and 4), then the map comes back
  // from its copy. Never rejects.
  startup() {
    return this.map.restore(() => this.rules.start());
  }

  // The list of a tab's scope under the last set_scopes (for its two rules).
  listName(scope) {
    return scope === undefined ? null : this.map.current.listOf(scope);
  }

  // A key of the copy goes: true when it went. A failure leaves it for the
  // next set_scopes (and so does one that ends too late: allowlist.js).
  dropKey(tabId) {
    const key = "tab:" + tabId;
    return this.map.removeKey(tabId).then(() => {
      this.staleKeys.delete(key);
      return true;
    }, () => {
      this.staleKeys.add(key);
      return false;
    });
  }

  // A new tab of the orphan set: it closes in the removal queue, by the
  // receiver's close.
  orphanClose(tabId) {
    this.map.addOrphan(tabId);
    void this.removals.closeOwn({ ids: [tabId] }).catch(() => {});
  }

  // A new tab that a tab of the map replaces (tabs.onReplaced) or opens (a
  // popup, from webNavigation.onCreatedNavigationTarget) takes that tab's
  // scope (C10, each tab's scope). from: map.opener() of the other tab. The
  // new tab enters the map: bridge.tabScope goes as soon as the entry is in
  // the map, then its key and its list's rules follow (got.ruled: that rule
  // update). Or (a scope with no list from the first applied set_scopes on,
  // or a tab of the orphan set) it joins the orphan set and closes, with no
  // key and no bridge.tabScope. A tab that closed gets nothing (no stale
  // entry). Gives what map.adopt() gives.
  adoptTab(tabId, from) {
    if (this.map.isGone(tabId)) return null;
    const got = this.map.adopt(tabId, from);
    if (got && got.orphan) {
      this.orphanClose(tabId);
    } else if (got) {
      this.emit("bridge.tabScope", { tabId, scope: got.scope });
      void this.map.writeKey(tabId, got.scope).catch(() => {});
      got.ruled = this.rules.replaceLists([this.listName(got.scope)]);
      got.ruled.catch(() => {});
    }
    return got;
  }

  // tabs.create and windows.create (C10, each tab's scope): the scope of the
  // last applied set_scopes has a list, else no list for this scope and no
  // tab. create() calls Chrome at once (no await before it). The new tab
  // gets the scope; the op answers when the tab's scope rule is in force and
  // its key is in the copy.
  createTab(scope, create, tabOf) {
    if (!this.map.hasList(scope)) return Promise.reject(new Error(NO_LIST));
    return new Promise((resolve) => resolve(create())).then(async (result) => {
      const tabId = tabOf(result);
      if (Number.isInteger(tabId)) await this.#assign(tabId, scope);
      return result;
    });
  }

  async #assign(tabId, scope) {
    // No stale entry: a tab that closed gets none.
    if (this.map.isGone(tabId)) return;
    // A sweep came during the op: the scope check again at the entry write.
    if (!this.map.hasList(scope)) {
      this.orphanClose(tabId);
      throw new Error(NO_LIST);
    }
    this.map.set(tabId, scope);
    const ruled = this.rules.replaceLists([this.listName(scope)]);
    const copied = this.map.writeKey(tabId, scope);
    const [r, k] = await Promise.allSettled([ruled, copied]);
    if (r.status === "fulfilled" && k.status === "fulfilled") return;
    // A failed rule update fails closed, and a failed write of the key is
    // handled the same way: the new tab leaves the map and closes.
    if (this.map.has(tabId)) {
      this.map.leave(tabId);
      void this.dropKey(tabId);
      if (r.status === "fulfilled") void this.rules.replaceLists([this.listName(scope)]).catch(() => {});
    }
    if (!this.map.isGone(tabId)) this.orphanClose(tabId);
    throw r.status === "rejected" ? r.reason : k.reason;
  }

  #listen() {
    const c = this.chrome;
    // The entry goes and the event goes before any other await (the next
    // query of the removal queue and the relay then see the tab gone).
    c.tabs.onRemoved.addListener((tabId, removeInfo) => this.map.whenRestored(() => {
      const scope = this.map.removed(tabId);
      this.popups.removed(tabId);
      this.emit("tabs.onRemoved", { tabId, removeInfo });
      this.removals.tabRemoved(tabId);
      if (scope !== undefined) {
        void this.rules.replaceLists([this.listName(scope)]).catch(() => {});
        void this.dropKey(tabId);
      }
    }));
    // The added tab takes the removed tab's scope; bridge.tabScope goes right
    // before the receiver's tabs.onReplaced event. A scope with no list (from
    // the first applied set_scopes on), or a tab of the orphan set: the added
    // tab joins the orphan set and closes.
    c.tabs.onReplaced.addListener((addedTabId, removedTabId) => this.map.whenRestored(() => {
      const before = this.map.scopeOf(removedTabId);
      const from = this.map.opener(removedTabId);
      this.map.release(removedTabId);
      this.popups.removed(removedTabId);
      this.adoptTab(addedTabId, from);
      this.emit("tabs.onReplaced", { addedTabId, removedTabId });
      this.removals.tabRemoved(removedTabId);
      if (before !== undefined) {
        void this.dropKey(removedTabId);
        void this.rules.replaceLists([this.listName(before)]).catch(() => {});
      }
    }));
    // A popup takes the scope of its sourceTabId (never chrome.tabs'
    // openerTabId: it names the active tab): the entry is in the map in the
    // handler, then bridge.tabScope, its key and its list's rules. Then the
    // event goes, and (with the eager attach off) the popup's tabs.onCreated
    // after it. receiver.js sends this event: it changes the map.
    c.webNavigation.onCreatedNavigationTarget.addListener((details) => {
      const tabId = details && details.tabId;
      this.popups.target(tabId);
      return this.map.whenRestored(() => {
        const ids = Number.isInteger(tabId) && Number.isInteger(details.sourceTabId);
        this.popups.adopted(tabId, ids ? this.adoptTab(tabId, this.map.opener(details.sourceTabId)) : null);
        this.emit("webNavigation.onCreatedNavigationTarget", { details });
        this.popups.announced(tabId);
      });
    });
  }
}

// One Receiver per chrome object (one per worker start).
const byChrome = new WeakMap();

export function receiver(chrome) {
  let r = byChrome.get(chrome);
  if (!r) {
    r = new Receiver(chrome);
    byChrome.set(chrome, r);
  }
  return r;
}
