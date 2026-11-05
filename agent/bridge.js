// The bridge (contract C10): in agent mode, agent-browser's relay drives this
// Chrome through a fixed list of chrome.* calls (the ops), and the bridge
// forwards a fixed list of chrome events. It has no CDP logic of its own,
// except the hold of a new tab (hold.js) and the removal queue (removals.js:
// a client's Page.close, and the receiver's own close by Target.closeTarget).
//
// Each tab has at most one scope (receiver.js, tabmap.js): tabs.create and
// windows.create name it, and the receiver keeps it over a link change.
//
// The bridge checks each request in C10's order (the op, the args, the wait,
// the tab); a request that fails a check never reaches Chrome. It calls Chrome
// for a request before the link starts the next one (no await comes before
// the chrome.* call), so CDP commands reach Chrome in the relay's order.
//
// No side logs the args, the results or the event params: they can hold page
// content and sign-in values.
import { call } from "./attach.js";
import { covers, normalizeEntry } from "./lib/domains.js";
import { receiver } from "./receiver.js";
import { NOT_AGENT_TAB } from "./removals.js";
import { isName } from "./scopes.js";

export const BRIDGE_VERSION = 1;
export const WAIT_DEFAULT_MS = 30000;
export const WAIT_MAX_MS = 600000;
export const CONTENT_TYPES = Object.freeze(["location", "notifications", "camera", "microphone", "clipboard", "automaticDownloads"]);
// chrome.tabs.TAB_ID_NONE: the tabId of bridge.tooLarge for an event of no tab (a download).
const NO_TAB = -1;

// ---- the kinds of args ----

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isId = (x) => Number.isInteger(x) && x >= 0;
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
const optional = (o, k, fits) => !Object.hasOwn(o, k) || fits(o[k]);
const isBool = (x) => typeof x === "boolean";

// A new tab or window opens at about:blank only: it makes no request before
// its scope rule is in force (C10, each tab's scope). So a bridge op never
// opens a site, a chrome:, file: or javascript: URL, or Chrome's New Tab page.
const isNewUrl = (u) => u === "about:blank";

// <scheme>://<host>/* or <scheme>://<host>:<port>/*, the scheme http, https or
// *, the host (with or without "*.") a normalized C5 host that a list of the
// last applied set_scopes covers (any list: the receiver does not know which
// scope calls), the port 1 to 65535.
function patternFits(p, domains) {
  const m = typeof p === "string" ? /^(\*|https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\d{1,5}))?\/\*$/.exec(p) : null;
  if (m === null) return false;
  if (m[4] !== undefined && (Number(m[4]) < 1 || Number(m[4]) > 65535)) return false;
  const host = normalizeEntry(m[3]);
  return host.ok && host.entry === m[3] && domains.some((d) => covers(d, m[3]));
}

const KINDS = {
  id: isId,
  object: isObj,
  string: (a) => typeof a === "string" && a.length > 0,
  boolean: isBool,
  target: (a) =>
    isObj(a) && isId(a.tabId) && onlyKeys(a, ["tabId", "sessionId"]) &&
    optional(a, "sessionId", (s) => typeof s === "string" && s.length > 0),
  contentType: (a) => CONTENT_TYPES.includes(a),
  scope: isName,
  newTab: (a) =>
    isObj(a) && onlyKeys(a, ["url", "active", "windowId", "index"]) && isNewUrl(a.url) &&
    optional(a, "active", isBool) && optional(a, "windowId", isId) && optional(a, "index", isId),
  tabUpdate: (a) => isObj(a) && onlyKeys(a, ["active"]) && isBool(a.active),
  newWindow: (a) =>
    isObj(a) && onlyKeys(a, ["url", "focused", "left", "top", "width", "height", "state"]) && isNewUrl(a.url) &&
    optional(a, "focused", isBool) && ["left", "top", "width", "height"].every((k) => optional(a, k, Number.isInteger)),
  windowUpdate: (a) =>
    isObj(a) && Object.keys(a).length > 0 && onlyKeys(a, ["left", "top", "width", "height", "state", "focused"]) &&
    optional(a, "focused", isBool) && ["left", "top", "width", "height"].every((k) => optional(a, k, Number.isInteger)),
  contentDetails: (a, domains) =>
    isObj(a) && onlyKeys(a, ["primaryPattern", "setting"]) && ["allow", "block"].includes(a.setting) &&
    patternFits(a.primaryPattern, domains),
};

// ---- the tab checks ----

// The restore tab of a running import is never an agent tab.
const restoreTab = (c, [tabId]) => (c.att.isRestoreTab(tabId) ? NOT_AGENT_TAB : null);
// The ops by which a client acts on a tab (attach, select, close) refuse the
// restore tab and a tab of the orphan set (C5, the sweep): it belongs to no
// live session. debugger.detach, tabs.get and bridge.release stay allowed.
const agentTab = (c, [tabId]) => (c.att.isRestoreTab(tabId) || c.r.map.isOrphan(tabId) ? NOT_AGENT_TAB : null);
// A command never goes to a tab of the orphan set, through the import's
// attachment, or to a tab that the bridge did not attach: not an agent tab
// first, then not attached.
const commandTab = (c, [target]) =>
  c.r.map.isOrphan(target.tabId) ? NOT_AGENT_TAB : c.att.isBridgeTab(target.tabId) ? null : "not attached";

// A client's Fetch.enable or Fetch.disable on a tab's own session changes
// the hold of the tab (C10): the hold counts it as it goes to Chrome.
function sendNow(c, target, method, params) {
  const sent = c.chrome.debugger.sendCommand(target, method, params === undefined ? {} : params);
  if ((method === "Fetch.enable" || method === "Fetch.disable") && target.sessionId === undefined) {
    c.att.holds.clientFetch(target.tabId, method, sent);
  }
  return sent;
}

// A Page.close on the tab's own session runs in the removal queue, with the
// window rule; each later command of the tab waits at its gate. A Page.close
// on a child session (a frame or a worker) is no close of the tab: it goes
// to Chrome at once, as any command. No await comes before the chrome call
// of a command with no gate.
function sendCommand(c, op, target, method, params) {
  const send = () => call(() => sendNow(c, target, method, params));
  if (method === "Page.close" && target.sessionId === undefined) return c.r.removals.pageClose(target.tabId, op, send);
  return c.r.removals.command(target.tabId, op, send);
}

function ownOrigin(c, tab) {
  const origin = c.chrome.runtime.getURL("");
  return [tab && tab.url, tab && tab.pendingUrl].some((u) => typeof u === "string" && u.startsWith(origin));
}

// ---- the ops ----
// kinds: the kind of each arg; required: how many must be there; wait: the
// default wait; nullResult: the op answers null; tab: the tab check; run: the
// chrome call (c is {chrome, att, r, navigator}; op is the request's state:
// stale() after a link change, expired after its deadline).

const op = (kinds, required, run, more = {}) => ({ kinds, required, run, wait: WAIT_DEFAULT_MS, nullResult: false, tab: null, ...more });

async function bridgeInfo(c) {
  let fullVersion = "";
  try {
    const ua = c.navigator && c.navigator.userAgentData;
    const values = ua ? await ua.getHighEntropyValues(["fullVersionList"]) : null;
    const list = values && Array.isArray(values.fullVersionList) ? values.fullVersionList : [];
    const brand = (name) => list.find((b) => b && b.brand === name && typeof b.version === "string");
    const hit = brand("Google Chrome") || brand("Chromium");
    fullVersion = hit ? hit.version : "";
  } catch {
    fullVersion = "";
  }
  return {
    bridge: BRIDGE_VERSION,
    version: c.chrome.runtime.getManifest().version,
    id: c.chrome.runtime.id,
    userAgent: String((c.navigator && c.navigator.userAgent) || ""),
    fullVersion,
  };
}

export const OPS = Object.freeze({
  // The own-origin check reads the tab inside the attach, in the tab's order;
  // the orphan set's check runs again right before Chrome's attach.
  "debugger.attach": op(["id"], 1, (c, [tabId]) => c.att.attach(tabId, () =>
    call(() => c.chrome.tabs.get(tabId)).then((tab) => {
      if (ownOrigin(c, tab) || c.att.isRestoreTab(tabId)) throw new Error(NOT_AGENT_TAB);
    }), () => (c.r.map.isOrphan(tabId) ? NOT_AGENT_TAB : null)), { tab: agentTab }),
  "debugger.detach": op(["id"], 1, (c, [tabId]) => c.att.detach(tabId), { tab: restoreTab, nullResult: true }),
  "debugger.sendCommand": op(["target", "string", "object"], 2,
    (c, [target, method, params], o) => sendCommand(c, o, target, method, params), { tab: commandTab, wait: WAIT_MAX_MS }),
  "debugger.getTargets": op([], 0, (c) => c.chrome.debugger.getTargets()),
  "tabs.create": op(["newTab", "scope"], 2, (c, [props, scope]) =>
    c.r.createTab(scope, () => c.chrome.tabs.create(props), (tab) => tab && tab.id)),
  "tabs.get": op(["id"], 1, (c, [tabId]) => c.chrome.tabs.get(tabId)),
  "tabs.query": op(["object"], 1, (c, [info]) => c.chrome.tabs.query(info)),
  "tabs.update": op(["id", "tabUpdate"], 2, (c, [tabId, props]) => c.chrome.tabs.update(tabId, props), { tab: agentTab }),
  // The receiver's close, in the removal queue, with the window rule.
  "tabs.remove": op(["id"], 1, (c, [tabId], o) => c.r.removals.removeTab(tabId, o), { tab: agentTab, nullResult: true }),
  "windows.get": op(["id", "object"], 1, (c, args) => c.chrome.windows.get(...args)),
  // The window's tab gets the scope, as for tabs.create.
  "windows.create": op(["newWindow", "scope"], 2, (c, [data, scope]) =>
    c.r.createTab(scope, () => c.chrome.windows.create(data), (win) => (win && Array.isArray(win.tabs) && win.tabs[0] ? win.tabs[0].id : null))),
  "windows.update": op(["id", "windowUpdate"], 2, (c, [windowId, info]) => c.chrome.windows.update(windowId, info)),
  "downloads.search": op(["object"], 1, (c, [query]) => c.chrome.downloads.search(query)),
  "downloads.cancel": op(["id"], 1, (c, [id]) => c.chrome.downloads.cancel(id), { nullResult: true }),
  "contentSettings.set": op(["contentType", "contentDetails"], 2,
    (c, [type, details]) => c.chrome.contentSettings[type].set(details), { nullResult: true }),
  "contentSettings.clear": op(["contentType"], 1, (c, [type]) => c.chrome.contentSettings[type].clear({}), { nullResult: true }),
  "bridge.info": op([], 0, bridgeInfo),
  "bridge.attachNew": op(["boolean"], 1, (c, [on]) => {
    c.att.attachNew = on;
  }, { nullResult: true }),
  "bridge.release": op(["id"], 1, (c, [tabId]) => c.att.release(tabId), { nullResult: true }),
  // Every entry of the tab-to-scope map at the moment of the answer.
  "bridge.tabScopes": op([], 0, (c) => c.r.map.list()),
});

function argsFit(spec, args, domains) {
  if (!Array.isArray(args) || args.length < spec.required || args.length > spec.kinds.length) return false;
  return args.every((a, i) => KINDS[spec.kinds[i]](a, domains));
}

// The tabId and the names that the relay needs for its default action on an
// event that is too large to send.
function tooLargeFields(name, fields) {
  if (name === "debugger.onEvent") {
    const { source, method, params } = fields;
    const out = { tabId: source.tabId, method };
    if (typeof source.sessionId === "string") out.sessionId = source.sessionId;
    if (/^Fetch\./.test(method) && isObj(params) && typeof params.requestId === "string") out.requestId = params.requestId;
    return out;
  }
  const tab = fields.source ?? fields.tab ?? fields.details;
  const tabId = [fields.tabId, fields.addedTabId, tab && tab.tabId, tab && tab.id].find(Number.isInteger);
  return { tabId: tabId ?? NO_TAB };
}

export class Bridge {
  #chrome;
  #link;
  #att;
  #r;
  #ctx;
  #setTimer;
  #clearTimer;
  #epoch = 0; // counts the link changes: a request of an older link is stale

  // link: {eventsOpen(), sendEvent(ev)} (the ReceiverLink). The chrome event
  // listeners are registered here, synchronously (the Manifest V3 rule).
  constructor(chrome, link, { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h), navigator = globalThis.navigator } = {}) {
    this.#chrome = chrome;
    this.#link = link;
    this.#r = receiver(chrome);
    this.#att = this.#r.att;
    this.#ctx = { chrome, att: this.#att, r: this.#r, navigator };
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    Object.assign(this.#att.holds, {
      setTimer,
      clearTimer,
      forward: (source, method, params) => this.#emit("debugger.onEvent", { source, method, params }),
    });
    Object.assign(this.#r.clock, { setTimer, clearTimer });
    this.#r.emit = (name, fields) => this.#emit(name, fields);
    this.#listen();
  }

  // Runs one bridge request: a promise of its data (an object, a list or
  // null), or a rejection whose message is the res's error text.
  handle(req) {
    const spec = typeof req.op === "string" && Object.hasOwn(OPS, req.op) ? OPS[req.op] : null;
    if (!spec) return Promise.reject(new Error("unknown op"));
    const args = Object.hasOwn(req, "args") ? req.args : [];
    const reference = this.#r.map.reference;
    if (!argsFit(spec, args, reference ? reference.union() : [])) return Promise.reject(new Error("bad args"));
    const wait = Object.hasOwn(req, "wait") ? req.wait : spec.wait;
    if (!Number.isInteger(wait) || wait < 1 || wait > WAIT_MAX_MS) return Promise.reject(new Error("bad wait"));
    const refused = spec.tab ? spec.tab(this.#ctx, args) : null;
    if (refused) return Promise.reject(new Error(refused));
    const epoch = this.#epoch;
    const state = { expired: false, stale: () => epoch !== this.#epoch };
    const work = call(() => spec.run(this.#ctx, args, state)).then((data) => (spec.nullResult || data === undefined ? null : data));
    return this.#deadline(work, wait, state);
  }

  // C10's cleanup, at the worker's start and at each link change. The link
  // drops the answers of the bridge requests that still run; a request that
  // waits in the removal queue or at a gate and has not gone to Chrome never
  // goes. The map, the scope rules and the receiver's own closes stay.
  reset() {
    this.#epoch += 1;
    this.#r.removals.dropBridge();
    this.#r.popups.reset();
    return this.#att.reset();
  }

  // "timeout" when the op runs wait ms; a later result or error is dropped.
  #deadline(work, ms, state) {
    let handle;
    const timeout = new Promise((_, reject) => {
      handle = this.#setTimer(() => {
        state.expired = true;
        reject(new Error("timeout"));
      }, ms);
    });
    work.catch(() => {});
    return Promise.race([work, timeout]).finally(() => this.#clearTimer(handle));
  }

  // An event goes at once while the link carries events, and is dropped
  // otherwise; it is never kept. One above MAX_TO_DAEMON (the link measures
  // it, once) goes as bridge.tooLarge.
  #emit(name, fields) {
    if (!this.#link.eventsOpen()) return;
    if (this.#link.sendEvent({ t: "ev", ch: "bridge", ev: name, ...fields })) return;
    this.#link.sendEvent({ t: "ev", ch: "bridge", ev: "bridge.tooLarge", of: name, ...tooLargeFields(name, fields) });
  }

  #listen() {
    const c = this.#chrome;
    const att = this.#att;
    // Only for a bridge tab: so never for the restore tab, whose attachment is
    // the import's, and never for the hold's own Fetch events.
    c.debugger.onEvent.addListener((source, method, params) => {
      if (!source || att.holds.event(source, method, params) || !att.isBridgeTab(source.tabId)) return;
      this.#emit("debugger.onEvent", { source, method, params: params === undefined ? {} : params });
    });
    c.debugger.onDetach.addListener((source, reason) => {
      if (source && att.dropped(source.tabId)) this.#emit("debugger.onDetach", { source, reason });
    });
    // While the eager attach is on, the event comes once the attach and the
    // hold of the tab are on (or failed), and a popup whose hold is on keeps
    // it longer (popups.js); an event of the tab that Chrome fires meanwhile
    // can come before it. Off, it comes after the tab's navigation target, or
    // NEW_TAB_WAIT_MS late when none comes (popups.js).
    c.tabs.onCreated.addListener((tab) => {
      const at = this.#r.clock.now();
      if (!tab || !isId(tab.id)) {
        this.#emit("tabs.onCreated", { tab, attached: false, held: false });
        return;
      }
      if (!att.attachNew) {
        this.#r.popups.created(tab, { attached: false, held: false });
        return;
      }
      void att.attachNewTab(tab.id, ownOrigin(this.#ctx, tab)).then((fields) => this.#r.popups.attached(tab, fields, at));
    });
    c.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!isObj(changeInfo) || !["url", "title", "status"].some((k) => Object.hasOwn(changeInfo, k))) return;
      this.#emit("tabs.onUpdated", { tabId, changeInfo, tab });
    });
    // tabs.onRemoved, tabs.onReplaced and webNavigation.onCreatedNavigationTarget
    // change the map: receiver.js sends them.
    c.webNavigation.onErrorOccurred.addListener((d) => {
      if (!d || d.frameId !== 0) return;
      this.#emit("webNavigation.onErrorOccurred", { details: { tabId: d.tabId, frameId: d.frameId, url: d.url, error: d.error } });
      this.#r.popups.error(d);
    });
    // A popup's main-frame navigations: the retry and the hold of its
    // tabs.onCreated (popups.js). No event of them goes to the relay.
    c.webNavigation.onBeforeNavigate.addListener((d) => this.#r.popups.beforeNavigate(d));
    c.webNavigation.onCommitted.addListener((d) => this.#r.popups.committed(d));
    c.downloads.onCreated.addListener((item) => this.#emit("downloads.onCreated", { item }));
    c.downloads.onChanged.addListener((delta) => this.#emit("downloads.onChanged", { delta }));
  }
}
