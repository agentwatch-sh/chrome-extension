// The tab-to-scope map (contract C10, each tab's scope; the orphan-tabs
// rules). Each tab has at most one scope. The map stays at each disconnect and
// each new daemon connection; only a tab's close, a tabs.onReplaced, the end
// of a sweep item that did not close the tab, and the worker's start remove
// entries. A copy lives in chrome.storage.session, one key per tab
// ("tab:<id>", the scope as its value), so a worker that starts again
// restores the map before it connects its native port.
//
// The map also holds, in memory only: the kept entries (an entry that left
// the map, for TOMBSTONE_MS), the orphan set (a tab that a sweep item did not
// close, or a new tab whose scope has no list) with its kept memberships, the
// operator marks (choice 3 of the design: the operator's own tabs, which have
// no scope) with their kept marks, the object of the last set_scopes (what
// applies now: the scope rules and the closing rule) and the last applied one
// (the reference of the checks of a new entry, the sweep and contentDetails).
// The marks have no copy: they go at the worker's start, and those tabs then
// fail closed.
import { NO_SCOPES, isName } from "./scopes.js";

export const TOMBSTONE_MS = 10000;
export const RESTORE_MAX_MS = 2000;
const KEY = /^tab:(0|[1-9][0-9]{0,15})$/;
export const keyOf = (tabId) => "tab:" + tabId;

export class TabMap {
  #chrome;
  #clock; // {now, setTimer, clearTimer}
  #entries = new Map(); // tabId -> scope
  #kept = new Map(); // tabId -> {scope, until}: entries that left the map
  #orphans = new Set();
  #keptOrphans = new Map(); // tabId -> until: orphan memberships of closed tabs
  #gone = new Map(); // tabId -> until: tabs that closed (no entry is written for them)
  #marks = new Set(); // the marked tabs: the operator's own
  #keptMarks = new Map(); // tabId -> until: marks of tabs that closed or were replaced
  #restored = false;
  #restoring = null;
  // The object of the last set_scopes (it applies now), and the last applied one.
  current = NO_SCOPES;
  reference = null;

  constructor(chrome, clock) {
    this.#chrome = chrome;
    this.#clock = clock;
  }

  // ---- the restore at the worker's start ----

  get restored() {
    return this.#restored;
  }

  // Runs fn at once when the restore has ended (or never started: a test
  // with no worker start), else after it. A handler that reads or writes the
  // map runs through this.
  whenRestored(fn) {
    if (this.#restored || this.#restoring === null) return fn();
    return this.#restoring.then(fn);
  }

  // C10, at the worker's start: first before() (the removal of every session
  // rule), then read the copy, keep the entries of the tabs that exist, and
  // remove the keys of the others. When chrome.storage.session.get or
  // chrome.tabs.query fails, or has not answered in RESTORE_MAX_MS, the map
  // starts empty (a late answer of get still removes its keys). The handlers
  // wait from this call on. Never rejects.
  restore(before = async () => {}) {
    if (this.#restoring) return this.#restoring;
    this.#restoring = Promise.resolve()
      .then(before)
      .catch(() => {})
      .then(() => this.#restore())
      .catch(() => {})
      .finally(() => {
        this.#restored = true;
      });
    return this.#restoring;
  }

  async #restore() {
    const area = this.#chrome.storage && this.#chrome.storage.session;
    if (!area) return;
    const reading = new Promise((resolve) => resolve(area.get(null)));
    const querying = new Promise((resolve) => resolve(this.#chrome.tabs.query({})));
    reading.catch(() => {});
    querying.catch(() => {});
    const got = await this.#within(Promise.all([reading, querying]), RESTORE_MAX_MS);
    if (!got.ok) {
      // A late answer of the copy: remove each of its keys that no entry holds.
      reading.then((data) => this.#removeKeys(Object.keys(data ?? {}).filter((k) => KEY.test(k) && !this.#entries.has(Number(KEY.exec(k)[1])))), () => {});
      return;
    }
    const [data, tabs] = got.value;
    const open = new Set((Array.isArray(tabs) ? tabs : []).map((t) => t && t.id));
    const drop = [];
    for (const [k, v] of Object.entries(data ?? {})) {
      const m = KEY.exec(k);
      if (!m) continue;
      const tabId = Number(m[1]);
      if (open.has(tabId) && isName(v)) this.#entries.set(tabId, v);
      else drop.push(k);
    }
    await this.#within(this.#removeKeys(drop), RESTORE_MAX_MS);
  }

  #removeKeys(keys) {
    if (keys.length === 0) return Promise.resolve();
    return new Promise((resolve) => resolve(this.#chrome.storage.session.remove(keys))).catch(() => {});
  }

  #within(promise, ms) {
    let handle;
    const late = new Promise((resolve) => {
      handle = this.#clock.setTimer(() => resolve({ ok: false }), ms);
    });
    const done = promise.then((value) => ({ ok: true, value }), () => ({ ok: false }));
    return Promise.race([done, late]).finally(() => this.#clock.clearTimer(handle));
  }

  // ---- the copy ----

  writeKey(tabId, scope) {
    return new Promise((resolve) => resolve(this.#chrome.storage.session.set({ [keyOf(tabId)]: scope })));
  }

  removeKey(tabId) {
    return new Promise((resolve) => resolve(this.#chrome.storage.session.remove(keyOf(tabId))));
  }

  // ---- the entries ----

  #prune() {
    const now = this.#clock.now();
    for (const m of [this.#kept, this.#keptOrphans, this.#gone, this.#keptMarks]) {
      for (const [k, v] of m) if ((typeof v === "number" ? v : v.until) <= now) m.delete(k);
    }
  }

  has(tabId) {
    return this.#entries.has(tabId);
  }

  scopeOf(tabId) {
    return this.#entries.get(tabId);
  }

  // bridge.tabScopes: every entry, in no set order.
  list() {
    return [...this.#entries].map(([tabId, scope]) => ({ tabId, scope }));
  }

  entries() {
    return this.#entries.entries();
  }

  // The scope has a list in the last applied set_scopes (none before the first).
  hasList(scope) {
    return this.reference !== null && this.reference.listOf(scope) !== null;
  }

  // A tab that closed: its entry is never written (no stale entry).
  isGone(tabId) {
    this.#prune();
    return this.#gone.has(tabId);
  }

  set(tabId, scope) {
    this.#entries.set(tabId, scope);
  }

  // The entry leaves the map; it is kept for TOMBSTONE_MS. Gives the scope
  // that it had, or undefined.
  leave(tabId) {
    const scope = this.#entries.get(tabId);
    if (scope === undefined) return undefined;
    this.#entries.delete(tabId);
    this.#prune();
    this.#kept.set(tabId, { scope, until: this.#clock.now() + TOMBSTONE_MS });
    return scope;
  }

  // ---- the orphan set ----

  isOrphan(tabId) {
    return this.#orphans.has(tabId);
  }

  addOrphan(tabId) {
    this.#orphans.add(tabId);
  }

  orphans() {
    return [...this.#orphans];
  }

  #leaveOrphans(tabId) {
    if (!this.#orphans.delete(tabId)) return false;
    this.#prune();
    this.#keptOrphans.set(tabId, this.#clock.now() + TOMBSTONE_MS);
    return true;
  }

  // ---- the operator marks ----

  isMarked(tabId) {
    return this.#marks.has(tabId);
  }

  // The marked tabs, in the order of their marks.
  marked() {
    return [...this.#marks];
  }

  mark(tabId) {
    this.#marks.add(tabId);
  }

  // The mark goes with no kept mark: the tab is no operator tab (a page
  // opened it, or a bridge op created it). True when it had the mark.
  unmark(tabId) {
    return this.#marks.delete(tabId);
  }

  // The mark of a tab that closed or was replaced: kept for TOMBSTONE_MS.
  #leaveMarks(tabId) {
    if (!this.#marks.delete(tabId)) return false;
    this.#prune();
    this.#keptMarks.set(tabId, this.#clock.now() + TOMBSTONE_MS);
    return true;
  }

  // ---- the events ----

  // tabs.onRemoved: the entry, the orphan membership and the mark leave, and
  // each is kept for TOMBSTONE_MS. Gives the scope that the tab had, or
  // undefined.
  removed(tabId) {
    const scope = this.leave(tabId);
    this.#leaveOrphans(tabId);
    this.#leaveMarks(tabId);
    this.#gone.set(tabId, this.#clock.now() + TOMBSTONE_MS);
    return scope;
  }

  // The scope of a new tab that a tab of the map opens or replaces (a popup's
  // sourceTabId, a replaced tab): {orphan: true} for a tab of the orphan set
  // or a kept membership of one (the set spreads as the mark does), else its
  // entry, {mark: true} for a marked tab, else its kept entry or kept mark,
  // else null (no scope).
  opener(tabId) {
    this.#prune();
    if (this.#orphans.has(tabId) || this.#keptOrphans.has(tabId)) return { orphan: true };
    if (this.#entries.has(tabId)) return { scope: this.#entries.get(tabId) };
    if (this.#marks.has(tabId)) return { mark: true };
    if (this.#kept.has(tabId)) return { scope: this.#kept.get(tabId).scope };
    if (this.#keptMarks.has(tabId)) return { mark: true };
    return null;
  }

  // The new tab of opener() joins the map, the orphan set or the marks. From
  // the first applied set_scopes after the worker's start on, a scope with no
  // list never enters the map: its tab joins the orphan set. Before it, such
  // a tab enters the map with its scope (that set_scopes sweeps it). A tab of
  // a marked tab is marked. Gives {orphan: true}, {mark: true}, {scope} (the
  // tab entered the map) or null.
  adopt(tabId, from) {
    if (from === null) return null;
    if (from.mark) {
      this.#marks.add(tabId);
      return { mark: true };
    }
    if (from.orphan || (this.reference !== null && this.reference.listOf(from.scope) === null)) {
      this.#orphans.add(tabId);
      return { orphan: true };
    }
    this.#entries.set(tabId, from.scope);
    return { scope: from.scope };
  }

  // tabs.onReplaced: the removed tab leaves the map (its entry is kept), the
  // orphan set and the marks; its added tab takes its place (opener() before,
  // adopt() after).
  release(tabId) {
    this.leave(tabId);
    this.#leaveOrphans(tabId);
    this.#leaveMarks(tabId);
  }

  // ---- set_scopes ----

  // A new applied object becomes the reference. It drops the kept entries of
  // each scope that it gives a list, so a popup of an old tab never joins a
  // later session of the same name.
  applyReference(next) {
    this.reference = next;
    for (const [tabId, k] of this.#kept) if (next.listOf(k.scope) !== null) this.#kept.delete(tabId);
  }
}
