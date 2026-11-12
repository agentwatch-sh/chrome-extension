// The receiver's part of the stored sign-ins (contracts C4, C5 and C10; the
// stored sign-ins design, sections 7.3, 7.6 and 7.8; board ab-v16.97.3).
//
// agent-browser's service signs in with a stored credential in an act window:
// an incognito window that the receiver opens (C10 windows.create with the
// mark "act"), so the act has a browser context of its own that shares no
// cookie, storage, worker or history with the agent's tabs. The act tab is in
// its caller's scope for the list rules (C5), but no connection sees it:
// bridge.tabScopes leaves it out, no bridge.tabScope names it or its popups,
// and no copy key holds it (tabmap.js). A popup of an act tab is an act tab.
//
// - The act window: the receiver must be allowed in incognito; before it
//   opens one, it ends a left act (its windows, its tabs and its rules), and
//   it refuses while any other incognito tab is open (all incognito windows
//   share one context). The copy holds "act:<windowId>" for each act window,
//   so a worker that starts again closes it.
// - The act's rules (C5, rules A to E, dnr.js), on channel main: act_rules
//   adds them and confirms them by a read of the session rules; act_end
//   closes every act tab first and removes them after.
// - The read of the act store's cookies (act_cookies, channel main): the
//   cookies of a host and its subdomains from the cookie store of the act
//   tab, in C2's form, for the move (C6's import is the move's other half).
// - A link change ends the act (the service's session on the act tab ended
//   with the bridge's detaches), and so does the worker's start.
//
// No log line holds a cookie, a URL, a host or a value of the page.
import { call } from "./attach.js";
import { MAX_SEND_TO } from "./dnr.js";
import { dedupe } from "./lib/cookies.js";

export const ACT_MARK = "act";
export const ACT_KEY = "act:";
export const ACT_TAB_KEY = "acttab:";
const KEY = /^act:(0|[1-9][0-9]{0,15})$/;
const TAB_KEY = /^acttab:(0|[1-9][0-9]{0,15})$/;
// The cookie store of the default context: act_cookies never reads it.
const DEFAULT_STORE = "0";
// The bridge's error texts of the act window (C10).
export const ANOTHER_PRIVATE = "another private window is open";
export const NO_INCOGNITO = "not allowed in incognito";
export const NOT_AGENT_WINDOW = "not an agent window";
// The error texts of the act's requests on channel main (C4).
export const BAD_REQUEST = "bad request";
export const NOT_ACT_TAB = "not an act tab";
export const RULES_NOT_HELD = "rules not held";
export const RULES_NOT_REMOVED = "rules not removed";
export const ACT_NOT_CLOSED = "act not closed";
export const NO_STORE = "no cookie store";
export const COOKIES_FAILED = "cookies failed";

// An origin of http: or https:, exactly as the URL parser gives it.
function isOrigin(o) {
  if (typeof o !== "string") return false;
  try {
    const u = new URL(o);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === o;
  } catch {
    return false;
  }
}

// A host exactly as the URL parser gives it: no port, no path, lowercase.
function isHost(h) {
  if (typeof h !== "string" || h === "") return false;
  try {
    return new URL("http://" + h + "/").hostname === h;
  } catch {
    return false;
  }
}

// One cookie of chrome.cookies in C2's form (as the sender builds it).
export function toPayloadCookie(c) {
  const out = {
    name: c.name, value: c.value, domain: c.domain, hostOnly: !!c.hostOnly, path: c.path,
    secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite ?? "unspecified", session: !!c.session,
  };
  if (!c.session) out.expirationDate = c.expirationDate;
  if (c.partitionKey) {
    out.partitionKey = { topLevelSite: c.partitionKey.topLevelSite };
    if (c.partitionKey.hasCrossSiteAncestor !== undefined) out.partitionKey.hasCrossSiteAncestor = c.partitionKey.hasCrossSiteAncestor;
  }
  return out;
}

export class Act {
  #r; // the Receiver: chrome, map, rules, removals, listName
  #chain = Promise.resolve();
  #windows = new Set(); // the act windows
  #tabs = new Set(); // the act popups and replaced act tabs with a key acttab:<id> (and those of the copy at the start)

  constructor(receiver) {
    this.#r = receiver;
  }

  get #chrome() {
    return this.#r.chrome;
  }

  // An act window of this worker (or of the copy at its start).
  isWindow(windowId) {
    return this.#windows.has(windowId);
  }

  // An act window, an act tab or the act's rules are (or may be) there.
  get open() {
    return this.#windows.size > 0 || this.#tabs.size > 0 || this.#r.map.acts().length > 0 || this.#r.rules.acting;
  }

  // An act popup or a replaced act tab: its key acttab:<id> goes into the
  // copy, so a worker that starts again closes it (best effort: act_end
  // closes it by its id anyway).
  keepTab(tabId) {
    this.#tabs.add(tabId);
    void call(() => this.#chrome.storage.session.set({ [ACT_TAB_KEY + tabId]: true })).catch(() => {});
  }

  // The act's work runs one at a time: the window, the rules, the cookies, the end.
  #run(fn) {
    const run = this.#chain.then(fn);
    this.#chain = run.then(() => {}, () => {});
    return run;
  }

  // ---- the act window (C10 windows.create with the mark "act") ----

  // data: the createData (url about:blank, incognito true); scope: the
  // caller's scope, which must have a list; op: the bridge request's state.
  // The incognito check is the first chrome call (no await before it).
  // Answers the Window when the act tab's scope rule is in force and the
  // window's key is in the copy.
  create(scope, data, op, noList) {
    const r = this.#r;
    if (!r.map.hasList(scope)) return Promise.reject(new Error(noList));
    const allowed = call(() => this.#chrome.extension.isAllowedIncognitoAccess()).then((a) => a === true, () => false);
    return this.#run(async () => {
      if (!(await allowed)) throw new Error(NO_INCOGNITO);
      if (op.stale()) throw new Error("detached");
      // A left act: its windows, its popups and its rules go first. A tab of
      // it that stays open is another private window; rules that do not go
      // answer their own text (review-ce44 N6).
      try {
        await this.#end();
      } catch (e) {
        throw new Error(e && e.message === RULES_NOT_REMOVED ? RULES_NOT_REMOVED : ANOTHER_PRIVATE);
      }
      // All incognito windows share one context: no other may be open.
      const tabs = await call(() => this.#chrome.tabs.query({}));
      if ((Array.isArray(tabs) ? tabs : []).some((t) => t && t.incognito === true)) throw new Error(ANOTHER_PRIVATE);
      if (op.stale()) throw new Error("detached");
      const win = await call(() => this.#chrome.windows.create(data));
      const tab = win && Array.isArray(win.tabs) ? win.tabs[0] : null;
      if (!win || win.incognito !== true || !tab || !Number.isInteger(tab.id) || !Number.isInteger(win.id)) {
        // Chrome gave no incognito window with a tab that the receiver can reach.
        if (tab && Number.isInteger(tab.id) && tab.incognito !== true) r.orphanClose(tab.id);
        if (win && win.incognito === true && Number.isInteger(win.id)) {
          // An incognito window with no tab: it closes as an act window that is left.
          this.#windows.add(win.id);
          await this.#end().catch(() => {});
        }
        throw new Error(NO_INCOGNITO);
      }
      this.#windows.add(win.id);
      const keyed = call(() => this.#chrome.storage.session.set({ [ACT_KEY + win.id]: true }));
      keyed.catch(() => {});
      if (r.map.isGone(tab.id)) {
        // The tab closed already: no entry (as for tabs.create).
        await this.#end().catch(() => {});
        return win;
      }
      if (!r.map.hasList(scope)) {
        // A sweep came during the op.
        await this.#end().catch(() => {});
        throw new Error(noList);
      }
      r.map.set(tab.id, scope);
      r.map.addAct(tab.id);
      const ruled = r.rules.replaceLists([r.listName(scope)]);
      const [a, b] = await Promise.allSettled([ruled, keyed]);
      if (a.status === "rejected" || b.status === "rejected") {
        // A failed rule update fails closed, and so does a failed key: the act ends.
        await this.#end().catch(() => {});
        throw a.status === "rejected" ? a.reason : b.reason;
      }
      if (op.stale()) {
        // A link change came during the op: no act survives it.
        await this.#end().catch(() => {});
        throw new Error("detached");
      }
      return win;
    });
  }

  // ---- the requests of channel main (C4) ----

  // act_rules: the act's rules A to E for the act tab, with the
  // confirmation. Answers {rules: [ids]}.
  rules(req) {
    return this.#run(async () => {
      const { tab, origin, send_to: sendTo } = req;
      const fits = Number.isInteger(tab) && tab >= 0 && isOrigin(origin) && Array.isArray(sendTo) &&
        sendTo.length >= 1 && sendTo.length <= MAX_SEND_TO && sendTo.every(isOrigin) &&
        new Set(sendTo).size === sendTo.length && sendTo.includes(origin);
      if (!fits) throw new Error(BAD_REQUEST);
      if (!this.#r.map.isAct(tab)) throw new Error(NOT_ACT_TAB);
      // The act tab of the request, then every other act tab (its popups and
      // replaced tabs that came before the rules).
      const tabIds = [tab, ...this.#r.map.acts().filter((id) => id !== tab)];
      try {
        return { rules: await this.#r.rules.setAct({ tabIds, sendTo }) };
      } catch {
        throw new Error(RULES_NOT_HELD);
      }
    });
  }

  // act_cookies: the cookies of a host and its subdomains in the act tab's
  // cookie store, in C2's form. Answers {cookies: [...]}.
  cookies(req) {
    return this.#run(async () => {
      const { tab, domain } = req;
      if (!Number.isInteger(tab) || tab < 0 || !isHost(domain)) throw new Error(BAD_REQUEST);
      if (!this.#r.map.isAct(tab)) throw new Error(NOT_ACT_TAB);
      let stores;
      try {
        stores = await call(() => this.#chrome.cookies.getAllCookieStores());
      } catch {
        throw new Error(COOKIES_FAILED);
      }
      const store = (Array.isArray(stores) ? stores : []).find((s) => s && typeof s.id === "string" && Array.isArray(s.tabIds) && s.tabIds.includes(tab));
      // Never the store of the default context (review-ce44 N10).
      if (!store || store.id === DEFAULT_STORE) throw new Error(NO_STORE);
      try {
        const plain = await this.#chrome.cookies.getAll({ domain, storeId: store.id });
        const parted = await this.#chrome.cookies.getAll({ domain, storeId: store.id, partitionKey: {} });
        return { cookies: dedupe([...(plain ?? []), ...(parted ?? [])]).map(toPayloadCookie) };
      } catch {
        throw new Error(COOKIES_FAILED);
      }
    });
  }

  // act_end: every act tab closes (the act windows and their popups, by the
  // receiver's close), then the act's rules go. Answers {closed}.
  end() {
    return this.#run(() => this.#end());
  }

  async #end() {
    const r = this.#r;
    const windows = new Set(this.#windows);
    const tabs = new Set(this.#tabs);
    // A tab of the act: an act tab, a tab of an act window, a tab of a key
    // acttab:<id>, and an incognito tab whose opener is one of them (a popup
    // whose navigation target has not come yet; review-ce44 N2).
    const known = (id) => r.map.isAct(id) || r.map.wasAct(id) || tabs.has(id);
    const ofAct = (t) => t && Number.isInteger(t.id) && (r.map.isAct(t.id) || (t.incognito === true &&
      (windows.has(t.windowId) || tabs.has(t.id) || (Number.isInteger(t.openerTabId) && known(t.openerTabId)))));
    let closed = 0;
    if (windows.size > 0 || tabs.size > 0 || r.map.acts().length > 0) {
      const item = await r.removals.closeOwn({ select: (tabs) => tabs.filter(ofAct).map((t) => t.id) });
      closed = item.closed.length;
      if (item.error) throw new Error(ACT_NOT_CLOSED);
      let again;
      try {
        again = await call(() => this.#chrome.tabs.query({}));
      } catch {
        throw new Error(ACT_NOT_CLOSED);
      }
      // The rules stay while a tab of the act is open.
      if ((Array.isArray(again) ? again : []).some(ofAct)) throw new Error(ACT_NOT_CLOSED);
    }
    if (r.rules.acting) {
      try {
        await r.rules.removeAct();
      } catch {
        throw new Error(RULES_NOT_REMOVED);
      }
    }
    if (windows.size > 0 || tabs.size > 0) {
      for (const id of windows) this.#windows.delete(id);
      for (const id of tabs) this.#tabs.delete(id);
      // A key that stays closes nothing at the next start: its window and its tabs are gone.
      const keys = [...[...windows].map((id) => ACT_KEY + id), ...[...tabs].map((id) => ACT_TAB_KEY + id)];
      await call(() => this.#chrome.storage.session.remove(keys)).catch(() => {});
    }
    return { closed };
  }

  // ---- the link and the worker ----

  // A link change (C10's cleanup): the act ends. No chrome call when no act is open.
  linkChanged() {
    if (!this.open) return Promise.resolve();
    return this.end().catch(() => {});
  }

  // The copy at the worker's start (tabmap.js, its one read): the act
  // windows and act tabs of a worker before this one. The start's end
  // (receiver.js startup) closes them, while the act's rules still hold.
  restored(data) {
    for (const k of Object.keys(data ?? {})) {
      const w = KEY.exec(k);
      if (w) this.#windows.add(Number(w[1]));
      const t = TAB_KEY.exec(k);
      if (t) this.#tabs.add(Number(t[1]));
    }
  }
}

