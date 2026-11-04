// The bridge (contract C10): in agent mode, agent-browser's relay drives this
// Chrome through a fixed list of chrome.* calls (the ops), and the bridge
// forwards a fixed list of chrome events. It has no CDP logic of its own.
//
// The bridge checks each request in C10's order (the op, the args, the wait,
// the tab); a request that fails a check never reaches Chrome. It calls Chrome
// for a request before the link starts the next one (no await comes before
// the chrome.* call), so CDP commands reach Chrome in the relay's order.
//
// No side logs the args, the results or the event params: they can hold page
// content and sign-in values.
import { attachments, call } from "./attach.js";
import { appliedDomains } from "./dnr.js";
import { covers } from "./lib/domains.js";
import { jsonTooLarge } from "./wire.js";

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

// about:blank, or an absolute http: or https: URL: never a chrome:, file: or
// javascript: URL, or Chrome's New Tab page.
function isWebUrl(u) {
  if (u === "about:blank") return true;
  if (typeof u !== "string" || !/^https?:\/\/[^/?#\s]+/i.test(u)) return false;
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

// <scheme>://<host>/* or <scheme>://<host>:<port>/*, the scheme http, https or
// *, the host (with or without "*.") covered by the applied allowlist.
function patternFits(p, domains) {
  const m = typeof p === "string" ? /^(\*|https?):\/\/(\*\.)?([a-z0-9.-]+)(:\d{1,5})?\/\*$/.exec(p) : null;
  return m !== null && domains.some((d) => covers(d, m[3]));
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
  newTab: (a) =>
    isObj(a) && onlyKeys(a, ["url", "active", "windowId", "index"]) && isWebUrl(a.url) &&
    optional(a, "active", isBool) && optional(a, "windowId", isId) && optional(a, "index", isId),
  tabUpdate: (a) => isObj(a) && onlyKeys(a, ["active"]) && isBool(a.active),
  newWindow: (a) =>
    isObj(a) && onlyKeys(a, ["url", "focused", "left", "top", "width", "height", "state"]) && isWebUrl(a.url) &&
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
const agentTab = (c, [tabId]) => (c.att.isRestoreTab(tabId) ? "not an agent tab" : null);
// A command never goes through the import's attachment, or to a tab that the
// bridge did not attach.
const attachedTab = (c, [target]) => (c.att.isBridgeTab(target.tabId) ? null : "not attached");

function ownOrigin(c, tab) {
  const origin = c.chrome.runtime.getURL("");
  return [tab && tab.url, tab && tab.pendingUrl].some((u) => typeof u === "string" && u.startsWith(origin));
}

// ---- the ops ----
// kinds: the kind of each arg; required: how many must be there; wait: the
// default wait; nullResult: the op answers null; tab: the tab check; run: the
// chrome call (c is {chrome, att, navigator}).

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
  "debugger.attach": op(["id"], 1, (c, [tabId]) =>
    call(() => c.chrome.tabs.get(tabId)).then((tab) => {
      if (ownOrigin(c, tab) || c.att.isRestoreTab(tabId)) throw new Error("not an agent tab");
      return c.att.attach(tabId);
    }), { tab: agentTab }),
  "debugger.detach": op(["id"], 1, (c, [tabId]) => c.att.detach(tabId), { tab: agentTab, nullResult: true }),
  "debugger.sendCommand": op(["target", "string", "object"], 2,
    (c, [target, method, params]) => c.chrome.debugger.sendCommand(target, method, params === undefined ? {} : params),
    { tab: attachedTab, wait: WAIT_MAX_MS }),
  "debugger.getTargets": op([], 0, (c) => c.chrome.debugger.getTargets()),
  "tabs.create": op(["newTab"], 1, (c, [props]) => c.chrome.tabs.create(props)),
  "tabs.get": op(["id"], 1, (c, [tabId]) => c.chrome.tabs.get(tabId)),
  "tabs.query": op(["object"], 1, (c, [info]) => c.chrome.tabs.query(info)),
  "tabs.update": op(["id", "tabUpdate"], 2, (c, [tabId, props]) => c.chrome.tabs.update(tabId, props), { tab: agentTab }),
  "tabs.remove": op(["id"], 1, (c, [tabId]) => c.chrome.tabs.remove(tabId), { tab: agentTab, nullResult: true }),
  "windows.get": op(["id", "object"], 1, (c, args) => c.chrome.windows.get(...args)),
  "windows.create": op(["newWindow"], 1, (c, [data]) => c.chrome.windows.create(data)),
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
  // The hold of a new tab, which this ends, comes with the eager attach.
  "bridge.release": op(["id"], 1, () => null, { nullResult: true }),
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
  #ctx;
  #setTimer;
  #clearTimer;

  // link: {eventsOpen(), sendEvent(ev)} (the ReceiverLink). The chrome event
  // listeners are registered here, synchronously (the Manifest V3 rule).
  constructor(chrome, link, { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h), navigator = globalThis.navigator } = {}) {
    this.#chrome = chrome;
    this.#link = link;
    this.#att = attachments(chrome);
    this.#ctx = { chrome, att: this.#att, navigator };
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#listen();
  }

  // Runs one bridge request: a promise of its data (an object, a list or
  // null), or a rejection whose message is the res's error text.
  handle(req) {
    const spec = Object.hasOwn(OPS, req.op) ? OPS[req.op] : null;
    if (!spec) return Promise.reject(new Error("unknown op"));
    const args = Object.hasOwn(req, "args") ? req.args : [];
    if (!argsFit(spec, args, appliedDomains(this.#chrome))) return Promise.reject(new Error("bad args"));
    const wait = Object.hasOwn(req, "wait") ? req.wait : spec.wait;
    if (!Number.isInteger(wait) || wait < 1 || wait > WAIT_MAX_MS) return Promise.reject(new Error("bad wait"));
    const refused = spec.tab ? spec.tab(this.#ctx, args) : null;
    if (refused) return Promise.reject(new Error(refused));
    const work = call(() => spec.run(this.#ctx, args)).then((data) => (spec.nullResult || data === undefined ? null : data));
    return this.#deadline(work, wait);
  }

  // C10's cleanup, at the worker's start and at each link change. The link
  // drops the answers of the bridge requests that still run.
  reset() {
    return this.#att.reset();
  }

  // "timeout" when the op runs wait ms; a later result or error is dropped.
  #deadline(work, ms) {
    let handle;
    const timeout = new Promise((_, reject) => {
      handle = this.#setTimer(() => reject(new Error("timeout")), ms);
    });
    work.catch(() => {});
    return Promise.race([work, timeout]).finally(() => this.#clearTimer(handle));
  }

  // An event goes at once while the link carries events, and is dropped
  // otherwise; it is never kept. One above MAX_TO_DAEMON goes as
  // bridge.tooLarge.
  #emit(name, fields) {
    if (!this.#link.eventsOpen()) return;
    let ev = { t: "ev", ch: "bridge", ev: name, ...fields };
    if (jsonTooLarge(ev)) ev = { t: "ev", ch: "bridge", ev: "bridge.tooLarge", of: name, ...tooLargeFields(name, fields) };
    this.#link.sendEvent(ev);
  }

  #listen() {
    const c = this.#chrome;
    const att = this.#att;
    // Only for a bridge tab: so never for the restore tab, whose attachment is the import's.
    c.debugger.onEvent.addListener((source, method, params) => {
      if (!source || !att.isBridgeTab(source.tabId)) return;
      this.#emit("debugger.onEvent", { source, method, params: params === undefined ? {} : params });
    });
    c.debugger.onDetach.addListener((source, reason) => {
      if (!source || !att.isBridgeTab(source.tabId)) return;
      att.dropped(source.tabId);
      this.#emit("debugger.onDetach", { source, reason });
    });
    // The eager attach and the hold of a new tab come in a later part of stage 2.
    c.tabs.onCreated.addListener((tab) => this.#emit("tabs.onCreated", { tab, attached: false, held: false }));
    c.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!isObj(changeInfo) || !["url", "title", "status"].some((k) => Object.hasOwn(changeInfo, k))) return;
      this.#emit("tabs.onUpdated", { tabId, changeInfo, tab });
    });
    c.tabs.onRemoved.addListener((tabId, removeInfo) => this.#emit("tabs.onRemoved", { tabId, removeInfo }));
    c.tabs.onReplaced.addListener((addedTabId, removedTabId) => this.#emit("tabs.onReplaced", { addedTabId, removedTabId }));
    c.webNavigation.onCreatedNavigationTarget.addListener((details) =>
      this.#emit("webNavigation.onCreatedNavigationTarget", { details }));
    c.webNavigation.onErrorOccurred.addListener((d) => {
      if (!d || d.frameId !== 0) return;
      this.#emit("webNavigation.onErrorOccurred", { details: { tabId: d.tabId, frameId: d.frameId, url: d.url, error: d.error } });
    });
    c.downloads.onCreated.addListener((item) => this.#emit("downloads.onCreated", { item }));
    c.downloads.onChanged.addListener((delta) => this.#emit("downloads.onChanged", { delta }));
  }
}
