// The receiver's state per worker (one per chrome object): the attachments
// (attach.js), the tab-to-scope map and its copy (tabmap.js), the session
// rules (dnr.js), the removal queue (removals.js), the popups with their
// retry (popups.js) and the worker removal at a marked tab's leave
// (workers.js), with the chrome events that change the map and the operator
// marks. The bridge (bridge.js), set_scopes (allowlist.js) and the
// import (importer.js) share it.
//
// The operator mark (C10, each tab's scope; choice 3 of the design, part 1d):
// a tab that starts at Chrome's New Tab page, that no page opened and that no
// bridge op created is the operator's own tab in the live view (no agent tab
// starts there: the relay opens about:blank only and refuses chrome: URLs). A
// popup of a marked tab is marked too, and so is the tab that replaces one.
// A marked tab has no scope; set_scopes' operator value gives what it may
// open (C5: rule 8 with "*", the named list's rules with a name, no rule
// with null). The bridge never attaches, selects or closes it, and no
// connection sees it.
//
// The act of the stored sign-ins (act.js): an incognito tab gets no mark and
// no scope, except an act tab, which has its caller's scope for the list
// rules (C10, the act window).
import { Act, NOT_AGENT_WINDOW } from "./act.js";
import { attachments } from "./attach.js";
import { SessionRules } from "./dnr.js";
import { Guard } from "./guard.js";
import { Popups } from "./popups.js";
import { Removals } from "./removals.js";
import { ANY } from "./scopes.js";
import { TabMap } from "./tabmap.js";
import { Workers } from "./workers.js";

export const NO_LIST = "no list for this scope";
// The URL of a tab that the operator opens (Ctrl+T, Ctrl+N, the new-tab
// button): Chrome's tabs.onCreated names it in pendingUrl, with url ""
// (measured on Chromium 156). The page then commits at another chrome: URL
// (chrome://new-tab-page-third-party/ there).
export const NEW_TAB_URL = "chrome://newtab/";

// The tab starts at the New Tab page: its pendingUrl, else its url.
const startsAtNewTab = (tab) => (tab.pendingUrl || tab.url) === NEW_TAB_URL;

export class Receiver {
  // The timers and the clock; the bridge sets its own (tests use fake ones).
  clock = {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    now: () => Date.now(),
  };
  // The bridge sends an event of C10 through this (bridge.js sets it).
  emit = () => {};
  // The blocked notices of C4 go through this (sw.js sets it: the link).
  notify = () => {};
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
    this.rules = new SessionRules(chrome, () => this.#model(), clock, () => (this.map.current.operator === ANY ? this.map.marked() : []));
    this.removals = new Removals(chrome, { att: this.att, map: this.map, clock });
    this.popups = new Popups(this);
    this.guard = new Guard(this);
    this.workers = new Workers(this);
    this.act = new Act(this);
    // The start's one read of the copy gives the record of workers.js back
    // too, and the act windows of a worker before this one (they close).
    this.map.onCopy = (data) => {
      this.workers.restored(data);
      this.act.restored(data);
    };
    this.att.holds.onKept = (tabId) => this.popups.paused(tabId);
    this.#listen();
  }

  // The lists of the open tabs of the map, under the last set_scopes: list
  // name -> {entries, tabIds}. With an operator value that names a list, the
  // marked tabs are in that list's tabIds too.
  #model() {
    const cur = this.map.current;
    const out = new Map();
    const add = (name, tabId) => {
      if (!out.has(name)) out.set(name, { entries: cur.lists[name], tabIds: [] });
      out.get(name).tabIds.push(tabId);
    };
    for (const [tabId, scope] of this.map.entries()) {
      const name = cur.listOf(scope);
      if (name !== null) add(name, tabId);
    }
    if (cur.operator !== null && cur.operator !== ANY) for (const tabId of this.map.marked()) add(cur.operator, tabId);
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

  // The rules of the marked tabs under the last set_scopes, for
  // rules.replaceLists: ANY (rule 8), the operator's list, or null (none).
  markList() {
    return this.map.current.operator;
  }

  // A tab got or lost the mark: the rules of the marks, and a check of the
  // worker removal (a site that no marked tab shows any more).
  #markRules() {
    void this.rules.replaceLists([this.markList()]).catch(() => {});
    void this.workers.schedule();
  }

  // A tab's list under set (a ScopeSet; C5): ANY (every host: a marked tab
  // with the operator value "*"), its entries, or null (no list). A tab of the
  // orphan set has none; a tab of a scope has its scope's list; a marked tab
  // its operator value; any other tab of no scope the union of the lists. The
  // closing rule reads it (by the last applied set_scopes), and so does C5's
  // guard (guard.js, by the last set_scopes); the restore tab of a running
  // import is the caller's case.
  tabList(tabId, set) {
    if (this.map.isOrphan(tabId)) return null;
    const scope = this.map.scopeOf(tabId);
    if (scope !== undefined) return set.entriesOf(scope);
    if (this.map.isMarked(tabId)) return set.markEntries();
    return set.union();
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
  // key and no bridge.tabScope. A tab of a marked tab is marked: no key, no
  // bridge.tabScope, and the rules of the marks follow (got.ruled); a bridge
  // tab that gets the mark is detached (a marked tab is never a bridge tab).
  // A tab that closed gets nothing (no stale entry). Gives what map.adopt()
  // gives.
  adoptTab(tabId, from) {
    if (this.map.isGone(tabId)) return null;
    const got = this.map.adopt(tabId, from);
    if (got && got.orphan) {
      this.orphanClose(tabId);
    } else if (got && got.act) {
      // A tab of an act tab is an act tab: its list's rules, and no
      // bridge.tabScope and no key in the copy (no connection sees it).
      got.ruled = this.rules.replaceLists([this.listName(got.scope)]);
      got.ruled.catch(() => {});
    } else if (got && got.mark) {
      got.ruled = this.rules.replaceLists([this.markList()]);
      got.ruled.catch(() => {});
      if (this.att.isBridgeTab(tabId)) void this.att.detach(tabId).catch(() => {});
    } else if (got) {
      this.emit("bridge.tabScope", { tabId, scope: got.scope });
      void this.map.writeKey(tabId, got.scope).catch(() => {});
      got.ruled = this.rules.replaceLists([this.listName(got.scope)]);
      got.ruled.catch(() => {});
    }
    return got;
  }

  // windows.create with the mark "act" (C10, the act window): act.js.
  createAct(scope, data, op) {
    return this.act.create(scope, data, op, NO_LIST);
  }

  // tabs.create and windows.create (C10, each tab's scope): the scope of the
  // last applied set_scopes has a list, else no list for this scope and no
  // tab. create() calls Chrome at once (no await before it). The new tab
  // gets the scope; the op answers when the tab's scope rule is in force and
  // its key is in the copy. A tab or window that Chrome put into an incognito
  // window (a tabs.create with no windowId while one has the focus) is no
  // agent tab: it closes, and the op answers not an agent window.
  createTab(scope, create, tabOf) {
    if (!this.map.hasList(scope)) return Promise.reject(new Error(NO_LIST));
    return new Promise((resolve) => resolve(create())).then(async (result) => {
      const tabId = tabOf(result);
      if (result && result.incognito === true) {
        if (Number.isInteger(tabId)) this.orphanClose(tabId);
        throw new Error(NOT_AGENT_WINDOW);
      }
      if (Number.isInteger(tabId)) await this.#assign(tabId, scope);
      return result;
    });
  }

  async #assign(tabId, scope) {
    // No stale entry: a tab that closed gets none.
    if (this.map.isGone(tabId)) return;
    // No bridge op creates a marked tab (its URL is about:blank, so Chrome's
    // tabs.onCreated never names the New Tab page; this keeps the rule).
    const unmarked = this.map.unmark(tabId);
    if (unmarked) this.#markRules();
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
    // The operator mark, in the handler (before any await), so the bridge's
    // eager attach of the tab, which comes in the next listener of this
    // event, skips it. A tab whose navigation target came first is a page's
    // popup. The mark needs no restore of the map (no copy holds it); its
    // rule update runs in the rules' chain, after the start's removal.
    // An incognito tab gets no mark: all incognito tabs share the act's context.
    c.tabs.onCreated.addListener((tab) => {
      if (!tab || !Number.isInteger(tab.id) || tab.incognito === true || !startsAtNewTab(tab)) return;
      const id = tab.id;
      if (this.popups.has(id) || this.map.has(id) || this.map.isOrphan(id) || this.map.isGone(id) || this.att.isRestoreTab(id)) return;
      this.map.mark(id);
      this.#markRules();
    });
    // The entry goes and the event goes before any other await (the next
    // query of the removal queue and the relay then see the tab gone).
    c.tabs.onRemoved.addListener((tabId, removeInfo) => this.map.whenRestored(() => {
      const marked = this.map.isMarked(tabId);
      const scope = this.map.removed(tabId);
      this.popups.removed(tabId);
      this.guard.removed(tabId);
      this.emit("tabs.onRemoved", { tabId, removeInfo });
      this.removals.tabRemoved(tabId);
      if (scope !== undefined) {
        void this.rules.replaceLists([this.listName(scope)]).catch(() => {});
        void this.dropKey(tabId);
      }
      if (marked) this.#markRules();
    }));
    // The added tab takes the removed tab's scope (or its mark); bridge.tabScope
    // goes right before the receiver's tabs.onReplaced event. A scope with no
    // list (from the first applied set_scopes on), or a tab of the orphan set:
    // the added tab joins the orphan set and closes.
    c.tabs.onReplaced.addListener((addedTabId, removedTabId) => this.map.whenRestored(() => {
      const before = this.map.scopeOf(removedTabId);
      // The added tab takes only the removed tab's state: a mark that its own
      // tabs.onCreated gave it goes first.
      const marked = this.map.unmark(addedTabId) || this.map.isMarked(removedTabId);
      const from = this.map.opener(removedTabId);
      this.map.release(removedTabId);
      this.popups.removed(removedTabId);
      this.guard.replaced(addedTabId, removedTabId);
      const got = this.adoptTab(addedTabId, from);
      this.emit("tabs.onReplaced", { addedTabId, removedTabId });
      this.removals.tabRemoved(removedTabId);
      if (before !== undefined) {
        void this.dropKey(removedTabId);
        void this.rules.replaceLists([this.listName(before)]).catch(() => {});
      }
      // The added tab's mark replaced the rules of the marks already; its
      // pages join the record of workers.js, and the removed tab's other
      // origins go.
      if (marked && !(got && got.mark)) this.#markRules();
      if (got && got.mark) void this.workers.schedule({ learn: true });
    }));
    // A popup takes the scope of its sourceTabId (never chrome.tabs'
    // openerTabId: it names the active tab): the entry is in the map in the
    // handler, then bridge.tabScope, its key and its list's rules. A popup of
    // a marked tab is marked. Then the event goes, and (with the eager attach
    // off) the popup's tabs.onCreated after it. receiver.js sends this event:
    // it changes the map. A page opened this tab, so a mark that its
    // tabs.onCreated gave it goes: it takes its opener's scope or mark.
    c.webNavigation.onCreatedNavigationTarget.addListener((details) => {
      const tabId = details && details.tabId;
      this.popups.target(tabId);
      return this.map.whenRestored(() => {
        const ids = Number.isInteger(tabId) && Number.isInteger(details.sourceTabId);
        const unmarked = Number.isInteger(tabId) && this.map.unmark(tabId);
        const got = ids ? this.adoptTab(tabId, this.map.opener(details.sourceTabId)) : null;
        if (unmarked && !(got && got.mark)) this.#markRules();
        if (ids) this.guard.opened(tabId, details.sourceTabId);
        this.popups.adopted(tabId, got);
        this.emit("webNavigation.onCreatedNavigationTarget", { details });
        this.popups.announced(tabId);
      });
    });
    // C5's guard (layers 2 and 3) and the blocked notice of a navigation that
    // DNR blocked (C4): guard.js. They come before the bridge's listeners of
    // these events (popups.js, the relay's events).
    c.webNavigation.onBeforeNavigate.addListener((d) => this.guard.beforeNavigate(d));
    c.webNavigation.onCommitted.addListener((d) => this.guard.committed(d));
    c.webNavigation.onErrorOccurred.addListener((d) => this.guard.errorOccurred(d));
    // A frame of any tab commits, or its navigation ends on an error page: the
    // worker removal's record and check (workers.js).
    c.webNavigation.onCommitted.addListener((d) => this.workers.committed(d));
    c.webNavigation.onErrorOccurred.addListener((d) => this.workers.errorOccurred(d));
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
