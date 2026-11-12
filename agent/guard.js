// The guard and the blocked notice (contract C5, the guard and blocked; C4,
// blocked; part 1c, board ab-v16.33).
//
// A site's service worker answers a navigation before DNR sees it, also in a
// tab of a scope whose list lacks the site. So at each main-frame
// webNavigation.onBeforeNavigate (layer 2) and onCommitted (layer 3) of an
// http:/https: URL, or a blob: URL with such an inner origin, whose host the
// tab's covered set does not cover, the receiver sends the tab to about:blank
// (tabs.update) and sends blocked. The covered set of a tab, by the lists of
// the last set_scopes (as the scope rules use them): the restore tab of a
// running import has its domain; any other tab has Receiver.tabList(): a tab
// of a scope its scope's list, a marked tab its operator value (every host
// with "*"), a tab of the orphan set none, any other tab of no scope the
// union of the lists.
//
// blocked: {"t":"blocked","tab":<id>,"host":"<host>","scope":<scope or
// null>,"from":<host or null>}. scope is the tab's scope when the notice
// goes. from is the tab's last listed host when the block came: the host of
// its last main-frame commit of an http:/https: (or blob:) page that the
// guard let stay, and for a new popup with no such commit its opener's
// (sourceTabId). One navigation sends at most one blocked: a navigation
// starts at a main-frame onBeforeNavigate that is not about:blank (a redirect
// stays in it; the receiver's own about:blank starts none), and the guard,
// DNR's net::ERR_BLOCKED_BY_CLIENT and the retry's decision (popups.js) can
// each see it.
//
// No log line holds a URL or a host, and no notice comes from an act tab or
// from another incognito tab; the guard never acts on the latter.
import { call } from "./attach.js";
import { covers } from "./lib/domains.js";
import { BLOCKED } from "./popups.js";
import { ANY } from "./scopes.js";
import { webUrl } from "./tabs.js";

const isBlank = (url) => typeof url === "string" && /^about:blank([?#]|$)/.test(url);
// The notices of how many navigations back a tab keeps (for the once rule).
const SENT_KEPT = 8;

// The host that the guard judges: an http:/https: URL's, or a blob: URL's
// inner origin's when that is http:/https:; else null (about:, data:,
// chrome:, a blob: of an opaque origin). The closing rule judges the same
// host (tabs.js).
export function guardHost(url) {
  const u = webUrl(url);
  return u === null || u.hostname === "" ? null : u.hostname;
}

export class Guard {
  #r; // the Receiver: chrome, map, att, popups, notify
  #navs = new Map(); // tabId -> the count of its main-frame navigations
  #sent = new Map(); // tabId -> the navigations whose notice went
  #from = new Map(); // tabId -> its last listed host

  constructor(receiver) {
    this.#r = receiver;
  }

  // The host is in the tab's covered set, by the lists of the last set_scopes.
  covered(tabId, host) {
    const r = this.#r;
    if (r.att.isRestoreTab(tabId)) {
      const domain = r.att.restoreDomain(tabId);
      return domain !== null && covers(domain, host);
    }
    const list = r.tabList(tabId, r.map.current);
    if (list === ANY) return true;
    return list !== null && list.some((d) => covers(d, host));
  }

  // The tab's last listed host, or null.
  from(tabId) {
    return this.#from.has(tabId) ? this.#from.get(tabId) : null;
  }

  // ---- the events ----

  // Layer 2. A new navigation starts at once; the check waits for the restore.
  beforeNavigate(d) {
    if (!d || d.frameId !== 0 || !Number.isInteger(d.tabId) || isBlank(d.url)) return;
    const nav = (this.#navs.get(d.tabId) ?? 0) + 1;
    this.#navs.set(d.tabId, nav);
    const host = guardHost(d.url);
    if (host === null) return;
    return this.#r.map.whenRestored(() => {
      if (!this.covered(d.tabId, host)) this.#block(d.tabId, host, nav);
    });
  }

  // Layer 3: a worker's page that won the race, a redirect to a worker's
  // host (no new onBeforeNavigate), a page from the back/forward cache. A
  // page that stays gives the tab its from.
  committed(d) {
    if (!d || d.frameId !== 0 || !Number.isInteger(d.tabId)) return;
    const host = guardHost(d.url);
    if (host === null) return;
    const nav = this.#navs.get(d.tabId) ?? 0;
    return this.#r.map.whenRestored(() => {
      if (this.covered(d.tabId, host)) this.#from.set(d.tabId, host);
      else this.#block(d.tabId, host, nav);
    });
  }

  // DNR blocked a main-frame request: blocked, unless the retry takes the
  // notice (popups.js: it sends it later with send(), or never).
  errorOccurred(d) {
    if (!d || d.frameId !== 0 || d.error !== BLOCKED || !Number.isInteger(d.tabId)) return;
    let host;
    try {
      host = new URL(d.url).hostname;
    } catch {
      return;
    }
    const n = this.notice(d.tabId, host);
    if (this.#r.popups.screen(d, n, (x) => this.send(x))) return;
    this.send(n);
  }

  // A popup (webNavigation.onCreatedNavigationTarget): with no listed host of
  // its own yet, it takes its opener's.
  opened(tabId, sourceTabId) {
    if (!Number.isInteger(tabId) || this.#from.has(tabId) || !this.#from.has(sourceTabId)) return;
    this.#from.set(tabId, this.#from.get(sourceTabId));
  }

  // tabs.onReplaced: the added tab takes the removed tab's listed host, when
  // it has none of its own.
  replaced(addedTabId, removedTabId) {
    const from = this.#from.get(removedTabId);
    this.removed(removedTabId);
    if (from !== undefined && !this.#from.has(addedTabId)) this.#from.set(addedTabId, from);
  }

  // tabs.onRemoved: the tab's state goes.
  removed(tabId) {
    this.#navs.delete(tabId);
    this.#sent.delete(tabId);
    this.#from.delete(tabId);
  }

  // ---- the notice ----

  // The notice of a block of host in tab, in the tab's current navigation
  // (or nav): its from now, its scope when it goes.
  notice(tabId, host, nav = this.#navs.get(tabId) ?? 0) {
    return { tab: tabId, host, nav, from: this.from(tabId) };
  }

  #block(tabId, host, nav) {
    // The operator's own incognito tab (no act tab): the guard never acts on
    // it, and no host of it leaves the receiver; static rule 1 still blocks
    // its main frames (C5; review-ce44 B1).
    if (this.#r.map.isOtherIncognito(tabId)) return;
    void call(() => this.#r.chrome.tabs.update(tabId, { url: "about:blank" })).catch(() => {});
    this.send(this.notice(tabId, host, nav));
  }

  // Sends blocked (C4), at most once per navigation of the tab. An act tab
  // of the sign-in act (and one that closed a moment before) sends none: a
  // host that its page chooses can carry the password (C5; act.js).
  send(n) {
    if (this.#r.map.wasAct(n.tab) || this.#r.map.isOtherIncognito(n.tab)) return;
    let sent = this.#sent.get(n.tab);
    if (!sent) {
      sent = new Set();
      this.#sent.set(n.tab, sent);
    }
    if (sent.has(n.nav)) return;
    sent.add(n.nav);
    for (const old of sent) if (old <= n.nav - SENT_KEPT) sent.delete(old);
    const scope = this.#r.map.scopeOf(n.tab);
    this.#r.notify({ t: "blocked", tab: n.tab, host: n.host, scope: scope === undefined ? null : scope, from: n.from });
  }
}
