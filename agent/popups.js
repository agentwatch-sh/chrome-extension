// Popups and the retry (contract C10, each tab's scope; the per-scope design,
// section 5.2; part 1b). A popup is a tab that webNavigation's
// onCreatedNavigationTarget names: it takes the scope of its sourceTabId
// (receiver.js adoptTab), never of chrome.tabs' openerTabId.
//
// - tabs.onCreated. While the eager attach is off, a new tab's tabs.onCreated
//   goes after the tab's webNavigation.onCreatedNavigationTarget (so after its
//   bridge.tabScope), or NEW_TAB_WAIT_MS after Chrome's tabs.onCreated when
//   none comes (a tab that no page opened). While the eager attach is on, it
//   goes when the eager attach ends, except for a popup whose hold is on
//   ("held": true): the receiver holds that event until the first of
//   - the popup's first document request is in the hold (it was allowed; also
//     the retry's request);
//   - the decision to send blocked (a host off the list, a popup of no scope,
//     a retry that is blocked again, a retry that starts no request);
//   - a main-frame commit that is not about:blank (a blob: URL, a worker's
//     page: a commit with no network request);
//   - RULE_QUIET_MS from the moment the popup's rule is in force, while the
//     popup has started no main-frame navigation (about:blank does not count);
//   - HOLD_MAX_MS after tabs.onCreated.
//   The held event carries the tab's state at its release (tabs.get). A tab
//   that closes while its event waits or is held gets no tabs.onCreated; a
//   link change drops the waiting and the held events.
// - The retry. A popup's first request often starts before its rule is in
//   force, and DNR blocks it. The tab's first main-frame
//   ERR_BLOCKED_BY_CLIENT, of a host that the tab's list covers when the rule
//   update that put the tab under its list ends, gets one tabs.reload, at the
//   later of the end of that update and the error plus RETRY_AFTER_MS (the
//   error page has committed). The blocked notice of that first request waits
//   for this decision: none for a retried request; one when the list does not
//   cover the host (or the update failed), when the tab has no scope, when the
//   reload's own navigation is blocked again (no second retry), and when the
//   reload starts no request (no main-frame onBeforeNavigate of the URL within
//   RETRY_START_MS, or another error). The retry reloads a GET only: the
//   method comes from webRequest.onErrorOccurred of the blocked request, and it
//   must be GET when webNavigation's error comes and still at the reload's
//   time (the same URL). A request that is not a GET (a form that posts into
//   a new tab), or whose method the receiver has not seen then, gets no
//   reload and sends its notice (Chrome's reload of a blocked POST opens its "Confirm
//   Form Resubmission" dialog, which waits for a person). The retry is only
//   for the popup's first navigation: after its first main-frame commit that
//   is not about:blank, a block sends its notice at once.
// - A popup of a marked tab (the operator's own; part 1d) is marked too. For
//   the retry its list is its operator value: with "*" every host is covered,
//   with a list name that list, with null none.
//
// No log line holds a URL or a host.
import { call } from "./attach.js";
import { HOLD_MAX_MS } from "./hold.js";
import { covers } from "./lib/domains.js";
import { ANY } from "./scopes.js";

export const NEW_TAB_WAIT_MS = 50;
export const RULE_QUIET_MS = 50;
export const RETRY_AFTER_MS = 50;
export const RETRY_START_MS = 1000;
export const BLOCKED = "net::ERR_BLOCKED_BY_CLIENT";

const isBlank = (url) => typeof url === "string" && /^about:blank([?#]|$)/.test(url);

// The retry's phases of one popup:
// open: no block yet, the popup's first navigation has not committed;
// wait: its first request was blocked, the decision waits for the rule's end;
// planned: the reload waits for its time; reloaded: the reload went, its
// navigation has not started; started: the reload's navigation started;
// over: no retry from now on.
class Popup {
  scope = undefined; // undefined: not adopted yet; null: no scope (or the orphan set, or marked); else its scope
  marked = false; // a popup of a marked tab: marked too
  ruleEnd = null; // when the rule update that put it under its list ended
  entries = null; // its list then (ANY: every host; null: no list, or the update failed)
  navStarted = false; // a main-frame navigation that is not about:blank started
  ended = false; // an end condition of the held tabs.onCreated came
  phase = "open";
  block = null; // {url, at, msg, send, method}: the first blocked request (its method when the block came)
  timer = null; // the reload's time, or RETRY_START_MS

  constructor(tabId) {
    this.tabId = tabId;
  }
}

export class Popups {
  #r; // the Receiver: chrome, map, clock, emit, att
  #popups = new Map(); // tabId -> Popup
  #navs = new Set(); // tabs with no Popup yet whose main-frame navigation started
  #waiting = new Map(); // eager attach off: tabId -> {tab, fields, timer}
  #held = new Map(); // eager attach on: tabId -> {tab, fields, max, quiet, ending}
  #methods = new Map(); // tabId -> {url, method}: the tab's last blocked main-frame request (webRequest)

  constructor(receiver) {
    this.#r = receiver;
  }

  get #clock() {
    return this.#r.clock;
  }

  // The tab has a popup state (tests and the cleanup).
  has(tabId) {
    return this.#popups.has(tabId);
  }

  #emitCreated(tab, fields) {
    this.#r.emit("tabs.onCreated", { tab, ...fields });
  }

  // ---- the popup and its scope ----

  // webNavigation.onCreatedNavigationTarget, at once (before the restore
  // ends): the tab is a popup.
  target(tabId) {
    if (!Number.isInteger(tabId) || this.#popups.has(tabId) || this.#r.map.isGone(tabId)) return;
    const p = new Popup(tabId);
    p.navStarted = this.#navs.delete(tabId);
    this.#popups.set(tabId, p);
  }

  // The popup took its scope or the mark (receiver.js adoptTab gave got):
  // got.ruled is the rule update that puts it under its list.
  adopted(tabId, got) {
    const p = this.#popups.get(tabId);
    if (!p) return;
    if (!got || got.orphan) {
      p.scope = null;
      return;
    }
    if (got.mark) {
      p.scope = null;
      p.marked = true;
    } else {
      p.scope = got.scope;
    }
    got.ruled.then(() => true, () => false).then((ok) => this.#ruleEnded(p, ok));
  }

  // The popup is still where its adoption put it: in its scope (not in the
  // orphan set), or marked.
  #stillIn(p) {
    const map = this.#r.map;
    return p.marked ? map.isMarked(p.tabId) : map.scopeOf(p.tabId) === p.scope && !map.isOrphan(p.tabId);
  }

  #ruleEnded(p, ok) {
    if (this.#popups.get(p.tabId) !== p) return;
    const cur = this.#r.map.current;
    p.ruleEnd = this.#clock.now();
    p.entries = !ok || !this.#stillIn(p) ? null : p.marked ? cur.markEntries() : cur.entriesOf(p.scope);
    if (p.phase === "wait") this.#decide(p);
    this.#quiet(p.tabId);
  }

  // The tab closed, or Chrome replaced it: its events and its retry go.
  removed(tabId) {
    const p = this.#popups.get(tabId);
    if (p) this.#clock.clearTimer(p.timer);
    this.#popups.delete(tabId);
    this.#navs.delete(tabId);
    this.#methods.delete(tabId);
    this.#dropWaiting(tabId);
    this.#dropHeld(tabId);
  }

  // C10's cleanup at a link change: the waiting and the held tabs.onCreated
  // events belong to the old connection. The retries go on.
  reset() {
    for (const tabId of [...this.#waiting.keys()]) this.#dropWaiting(tabId);
    for (const tabId of [...this.#held.keys()]) this.#dropHeld(tabId);
  }

  // ---- tabs.onCreated ----

  // The eager attach is off: the event goes after the navigation target, or
  // NEW_TAB_WAIT_MS late when none comes.
  created(tab, fields) {
    const p = this.#popups.get(tab.id);
    if (p && p.scope !== undefined) return this.#emitCreated(tab, fields);
    const w = { tab, fields, timer: null };
    // A popup whose navigation target came first waits only for its scope.
    if (!p) w.timer = this.#clock.setTimer(() => this.#flushWaiting(tab.id, w), NEW_TAB_WAIT_MS);
    this.#waiting.set(tab.id, w);
  }

  // The popup's navigation target went to the relay (after its bridge.tabScope).
  announced(tabId) {
    const w = this.#waiting.get(tabId);
    if (w) this.#flushWaiting(tabId, w);
  }

  #flushWaiting(tabId, w) {
    if (this.#waiting.get(tabId) !== w) return;
    this.#dropWaiting(tabId);
    this.#emitCreated(w.tab, w.fields);
  }

  #dropWaiting(tabId) {
    const w = this.#waiting.get(tabId);
    if (!w) return;
    this.#clock.clearTimer(w.timer);
    this.#waiting.delete(tabId);
  }

  // The eager attach is on and ended (fields: attached, held, error). at:
  // when Chrome's tabs.onCreated came. A popup whose hold is on keeps its
  // event; any other tab gets it now.
  attached(tab, fields, at) {
    const p = this.#popups.get(tab.id);
    if (!fields.held || !p) return this.#emitCreated(tab, fields);
    const h = { tab, fields, max: null, quiet: null, ending: false };
    this.#held.set(tab.id, h);
    h.max = this.#clock.setTimer(() => this.#endHeld(tab.id), Math.max(0, at + HOLD_MAX_MS - this.#clock.now()));
    if (p.ended || this.#r.att.holds.keptCount(tab.id) > 0) return this.#endHeld(tab.id);
    this.#quiet(tab.id);
  }

  // RULE_QUIET_MS from the rule, while the popup has started no main-frame
  // navigation and its event is held.
  #quiet(tabId) {
    const h = this.#held.get(tabId);
    const p = this.#popups.get(tabId);
    if (!h || h.ending || h.quiet !== null || !p || p.navStarted || p.ruleEnd === null || p.entries === null) return;
    h.quiet = this.#clock.setTimer(() => this.#endHeld(tabId), Math.max(0, p.ruleEnd + RULE_QUIET_MS - this.#clock.now()));
  }

  #stopQuiet(tabId) {
    const h = this.#held.get(tabId);
    if (!h || h.quiet === null) return;
    this.#clock.clearTimer(h.quiet);
    h.quiet = null;
  }

  // The hold (hold.js) keeps a document request of the tab's top frame: the
  // request was allowed.
  paused(tabId) {
    this.#endHeld(tabId);
  }

  // An end condition of the held event: the decision to send blocked, or a
  // main-frame commit.
  #ended(tabId) {
    const p = this.#popups.get(tabId);
    if (p) p.ended = true;
    this.#endHeld(tabId);
  }

  #endHeld(tabId) {
    const h = this.#held.get(tabId);
    if (!h || h.ending) return;
    h.ending = true;
    this.#clock.clearTimer(h.max);
    this.#clock.clearTimer(h.quiet);
    call(() => this.#r.chrome.tabs.get(tabId)).then((tab) => tab, () => h.tab).then((tab) => {
      if (this.#held.get(tabId) !== h) return; // the tab closed, or the link changed
      this.#held.delete(tabId);
      this.#emitCreated(tab, h.fields);
    });
  }

  #dropHeld(tabId) {
    const h = this.#held.get(tabId);
    if (!h) return;
    this.#clock.clearTimer(h.max);
    this.#clock.clearTimer(h.quiet);
    this.#held.delete(tabId);
  }

  // ---- the navigations and the retry ----

  beforeNavigate(d) {
    if (!d || d.frameId !== 0 || isBlank(d.url)) return;
    const p = this.#popups.get(d.tabId);
    if (!p) {
      this.#navs.add(d.tabId);
      return;
    }
    p.navStarted = true;
    this.#stopQuiet(d.tabId);
    if (p.phase === "reloaded" && d.url === p.block.url) {
      p.phase = "started";
      this.#clock.clearTimer(p.timer);
      p.timer = null;
    }
  }

  committed(d) {
    if (!d || d.frameId !== 0 || isBlank(d.url)) return;
    const p = this.#popups.get(d.tabId);
    if (!p) return;
    // Another page committed while the retry waited: the first request stays
    // blocked, and its notice goes. Else the first navigation (or the
    // retry's) loaded: no retry from now on.
    if (p.phase === "wait" || p.phase === "planned") this.#notice(p);
    else if (p.phase !== "over") this.#over(p);
    this.#ended(d.tabId);
  }

  // webRequest.onErrorOccurred of a main-frame request: the method of a
  // blocked one (it comes before webNavigation's error: measured).
  requestError(d) {
    if (!d || d.type !== "main_frame" || d.error !== BLOCKED || !Number.isInteger(d.tabId) || d.tabId < 0) return;
    this.#methods.set(d.tabId, { url: d.url, method: d.method });
  }

  // The method of the tab's last blocked main-frame request of url, or
  // undefined when the receiver has not seen it.
  #methodFor(tabId, url) {
    const m = this.#methods.get(tabId);
    return m && m.url === url ? m.method : undefined;
  }

  // The popup's blocked first request is a GET: when the block came, and now.
  #isGet(p) {
    return p.block.method === "GET" && this.#methodFor(p.tabId, p.block.url) === "GET";
  }

  // A main-frame error that is not ERR_BLOCKED_BY_CLIENT: the reload started
  // no request (a POST that Chrome does not send again).
  error(d) {
    if (!d || d.frameId !== 0 || d.error === BLOCKED) return;
    const p = this.#popups.get(d.tabId);
    if (p && (p.phase === "reloaded" || p.phase === "started")) this.#notice(p);
  }

  // A main-frame ERR_BLOCKED_BY_CLIENT, before its blocked notice goes
  // (link.js watchBlocked): true when the retry takes the notice (it sends it
  // with send() later, or never), false when the notice goes now.
  screen(details, msg, send) {
    const p = this.#popups.get(details.tabId);
    if (!p) return false;
    if (p.phase === "open") {
      if (typeof p.scope !== "string" && !p.marked) {
        // A popup of no scope: no retry, the notice goes now.
        p.phase = "over";
        this.#ended(p.tabId);
        return false;
      }
      p.navStarted = true;
      this.#stopQuiet(p.tabId);
      p.block = { url: details.url, at: this.#clock.now(), msg, send, method: this.#methodFor(p.tabId, details.url) };
      p.phase = "wait";
      if (p.ruleEnd !== null) this.#decide(p);
      return true;
    }
    if (p.phase === "reloaded" || p.phase === "started") {
      // Blocked again: no second retry.
      this.#over(p);
      this.#ended(p.tabId);
      return false;
    }
    return false;
  }

  // At the end of the popup's rule update: a reload when its list then
  // covered the blocked host, else the notice.
  #decide(p) {
    const host = p.block.msg.host;
    const covered = p.entries !== null && (p.entries === ANY || p.entries.some((d) => covers(d, host))) && this.#stillIn(p);
    if (!covered) return this.#notice(p);
    // A blocked request that is not a GET (a form's POST) gets no reload.
    const method = this.#methodFor(p.tabId, p.block.url);
    if ((p.block.method !== undefined && p.block.method !== "GET") || (method !== undefined && method !== "GET")) return this.#notice(p);
    p.phase = "planned";
    const wait = p.block.at + RETRY_AFTER_MS - this.#clock.now();
    if (wait <= 0) this.#reload(p);
    else p.timer = this.#clock.setTimer(() => this.#reload(p), wait);
  }

  #reload(p) {
    p.timer = null;
    if (this.#popups.get(p.tabId) !== p || p.phase !== "planned") return;
    // The tab left its scope (or its mark) meanwhile (the sweep): no retry. A
    // GET only; a method that the receiver has not seen by now fails closed too.
    if (!this.#stillIn(p) || !this.#isGet(p)) return this.#notice(p);
    p.phase = "reloaded";
    p.timer = this.#clock.setTimer(() => {
      p.timer = null;
      if (p.phase === "reloaded") this.#notice(p);
    }, RETRY_START_MS);
    call(() => this.#r.chrome.tabs.reload(p.tabId)).catch(() => {
      if (p.phase === "reloaded") this.#notice(p);
    });
  }

  // The decision to send blocked: the first request's notice goes now.
  #notice(p) {
    const block = p.block;
    this.#over(p);
    if (block) block.send(block.msg);
    this.#ended(p.tabId);
  }

  #over(p) {
    p.phase = "over";
    this.#clock.clearTimer(p.timer);
    p.timer = null;
  }
}
