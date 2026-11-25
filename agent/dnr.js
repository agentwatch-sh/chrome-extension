// The DNR rules of the allowlists per scope (contract C5). The static rules 1
// and 3 block every main frame and every frame; session rules allow each
// tab's list in that tab only:
// - the scope rules: for each list that has an entry and is the list of an
//   open tab, rule 100 + 2i allows its main frames (requestDomains) and rule
//   101 + 2i its frames, <object> and <embed> documents (topDomains), both
//   with the tabIds of the tabs whose list it is;
// - the import's rules 6 and 7: the import's domain in its restore tab only;
// - the marked-tab rule 8 (choice 3 of the design, part 1d): with the
//   operator value "*", every main frame, frame and <object>/<embed>
//   document in the operator's marked tabs, with no host condition. With a
//   list name, the marked tabs are in that list's tabIds instead (the model);
//   with null they have no rule.
// - the act's rules A to E (the stored sign-ins' block, C5; act.js): from
//   the act's first key to its end, every request of the act tab, of its
//   popups and of the site's workers to a host outside send_to is blocked,
//   except a top-level GET. Ids 10 to 13 (A to D) and from 14 (E, two for
//   each origin of send_to), priorities 4 (block) and 5 (allow), above the
//   scope rules (2) and rule 5 (3).
// - the fetch window's rules (PageFetch, C5; fetch-window.js): from the
//   fetch window's open to its end, rule 78 allows every main frame, frame
//   and <object>/<embed> document in the fetch tabs (as rule 8 does in the
//   marked tabs), and rules 79 to 86 block the requests to a refused
//   address: a local or private IP literal, or a *.localhost, *.local or
//   *.internal host. 79 to 82 every one of the fetch tabs, 83 to 86 each one
//   with no tab (a service worker or a shared worker) that goes to another
//   site than its initiator, unless that initiator is a local name. Rule 87
//   blocks every WebSocket and WebTransport of the fetch tabs, to any host;
//   rule 88 each one with no tab as 83 to 86 match, so a service or shared
//   worker's socket to its own site is not blocked (inside C11's stated
//   limit for those workers; re-check 46C note 2). Priority 6 (block), above
//   every allow rule.
// - the merge guard's floor, rule 9 (C5; board ab-v16.99): it blocks every
//   request to a guarded host (GitHub's, and the hosts that bridge.mergeGuard
//   adds) whose method is not GET, HEAD or OPTIONS (a write), in every tab and
//   in each request with no tab, except the tabs where agent-browser's model
//   judges each request itself (the guarded tabs of bridge.mergeGuard, while
//   the bridge holds them), the marked tabs (the operator's own) and the act
//   tabs. A fetch tab never leaves it. Priority 6, above every allow rule.
// - the floor's initiator rule 89 (C5; board ab-v16.100): it blocks each write
//   to a guarded host whose initiator is not a guarded host, except a top-level
//   request, in every tab but the marked tabs and the act tabs (the guarded
//   tabs too): a frame of another site that the client's auto-attach does not
//   bring has no session in the tab, so agent-browser's model never sees its
//   requests. A request with no initiator counts as another site's (Chromium
//   gives it an opaque origin), so the main frame stays out: the tab's session
//   always holds it. Priority 6; written with rule 9, in the same call.
// Dynamic rule 5 sets Sec-Fetch-Site: none on the receiver's own top-level
// requests. Dynamic rules 2 and 4 (one list for every tab, before part 1a)
// are gone: the worker removes them at its start and at each set_scopes.
//
// Every change runs in one chain, one after the other, each from the map
// when it runs. A failed scope update fails closed: a remove-only call takes
// every scope rule out, and the next update is a full replace.

import { ANY, PUBLIC_LIST, PUBLIC_NOT } from "./scopes.js";
export { PUBLIC_NOT };
import { RESTORE_MAX_MS } from "./tabmap.js";

const OLD_RULE_ID = 2;
const OLD_FRAME_RULE_ID = 4;
export const HEADER_RULE_ID = 5;
export const IMPORT_RULE_ID = 6;
export const IMPORT_FRAME_RULE_ID = 7;
export const FIRST_SCOPE_RULE_ID = 100;
const IMPORT_IDS = [IMPORT_RULE_ID, IMPORT_FRAME_RULE_ID];
// Rule 8, the marked-tab rule (C5).
export const MARKED_RULE_ID = 8;
// The act's rules (C5): A 10, B 11, C 12, D 13, and E from 14, two for each
// origin of send_to (at most MAX_SEND_TO origins), so up to 77, below the
// scope rules' 100.
export const ACT_RULE_A = 10;
export const ACT_RULE_B = 11;
export const ACT_RULE_C = 12;
export const ACT_RULE_D = 13;
export const ACT_RULE_E = 14;
export const MAX_SEND_TO = 32;
// The merge guard's floor (C5, board ab-v16.99): rule 9, priority 6; and its
// initiator rule 89 (board ab-v16.100), between the fetch window's rules (78 to
// 88) and the scope rules (100 and up). The receiver writes both in one call.
export const FLOOR_RULE_ID = 9;
export const FLOOR_INITIATOR_RULE_ID = 89;
export const FLOOR_IDS = Object.freeze([FLOOR_RULE_ID, FLOOR_INITIATOR_RULE_ID]);
export const FLOOR_PRIORITY = 6;
// GitHub's hosts: always in the floor, from the worker's start (bridge.mergeGuard can only add hosts).
export const FLOOR_HOSTS = Object.freeze(["github.com"]);
// The methods that change nothing: every other method is a write.
export const FLOOR_FREE_METHODS = Object.freeze(["get", "head", "options"]);
// Every resource type: with neither resourceTypes nor excludedResourceTypes, DNR matches no main frame.
const ALL_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"];
export const ACT_RULE_MAX = ACT_RULE_E + 2 * MAX_SEND_TO - 1;
const ACT_RANGE_IDS = Array.from({ length: ACT_RULE_MAX - ACT_RULE_A + 1 }, (_, i) => ACT_RULE_A + i);
// The card payment's merchant rule (C5 rule 90; the secure card checkout design, section 8.2): from the copy of the
// merchant's session into a pay act to the act's end, every request to the merchant's registrable domain outside the
// act's tabs fails, so that an agent's tab cannot change the cart or the order while the operator approves or the act
// pays. A request of a worker has no tab, so the rule matches the workers of both contexts (a stated limit).
export const PAY_MERCHANT_RULE_ID = 90;
// Every id of the act's rules: A to E and the merchant rule (each one goes at the act's end).
const ACT_IDS = [...ACT_RANGE_IDS, PAY_MERCHANT_RULE_ID];
export function payMerchantRule({ domain, actTabIds }) {
  const condition = { requestDomains: [domain], resourceTypes: [...ALL_TYPES] };
  if (actTabIds.length > 0) condition.excludedTabIds = [...actTabIds];
  return { id: PAY_MERCHANT_RULE_ID, priority: ACT_BLOCK_PRIORITY, action: { type: "block" }, condition };
}
export const ACT_BLOCK_PRIORITY = 4;
export const ACT_ALLOW_PRIORITY = 5;
// The fetch window's rules (C5, PageFetch; board ab-v16.102): the any-host
// rule 78, then for each pattern of REFUSED_ADDRESSES one rule in the fetch
// tabs (79 to 82) and one for the requests with no tab (83 to 86), then the
// socket blocks 87 and 88.
export const FETCH_RULE_ID = 78;
export const FETCH_BLOCK_FIRST = 79;
export const FETCH_BLOCK_PRIORITY = 6;
// The refused addresses of a fetch window (the PageFetch design, section
// 5.4), as Chrome's URL parser writes the host: IPv4 in dotted decimal (also
// for 0x7f.1, 2130706433 and 127.1), IPv6 in lowercase hex with :: (an
// IPv4-mapped address as ::ffff:7f00:1, never ::ffff:127.0.0.1), a name with
// its trailing dot. Each pattern starts at the scheme and allows a userinfo
// part, and its host ends at the port (digits only) or the path, so a
// userinfo part such as a.localhost:pw@ never counts as the host
// (review-46 N4). One regexFilter each:
// Chrome refuses one above its compiled size limit (2 KB), and these four
// pass (measured on Chromium 156 with isRegexSupported).
export const REFUSED_ADDRESSES = Object.freeze([
  // 0.0.0.0/8, 10/8, 127/8 (loopback), 224/4 (multicast), 100.64/10 (CGNAT),
  // 172.16/12, 192.168/16, 169.254/16 (link-local, with 169.254.169.254).
  "^[a-z]+://([^/?#@]*@)?((0|10|127|22[4-9]|23[0-9])\\.[0-9]+|100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])|172\\.(1[6-9]|2[0-9]|3[01])|192\\.168|169\\.254)\\.[0-9.]+(:[0-9]+)?/",
  // :: and ::1, fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast).
  "^[a-z]+://([^/?#@]*@)?\\[(::1?|(f[cdf][0-9a-f]|fe[89ab])[0-9a-f]:[0-9a-f:.]*)\\]",
  // ::ffff:0:0/96 with an IPv4 address of the first pattern: its first hex
  // group is the address's first two bytes.
  "^[a-z]+://([^/?#@]*@)?\\[::ffff:(7f[0-9a-f]{2}|a[0-9a-f]{2}|ac1[0-9a-f]|e[0-9a-f]{3}|[0-9a-f]{1,2}|c0a8|a9fe|64[4-7][0-9a-f]):[0-9a-f]{1,4}\\]",
  // localhost, local and internal, and every name under them.
  "^[a-z]+://([^/?#@]*@)?([^/?#@:]*\\.)?(localhost|local|internal)\\.?(:[0-9]+)?/",
]);
// The socket blocks (review-168 B1): rule 87 blocks every WebSocket and
// WebTransport of the fetch tabs, rule 88 each one with no tab as rules 83 to
// 86 match (another site, no initiator of FETCH_WORKER_FREE). A WebSocket to a
// public name that resolves to a private address gets no address check (the
// patterns judge the host's text, and the service's request interception does
// not see WebSockets), and a fetched page needs none.
export const FETCH_SOCKET_RULE = FETCH_BLOCK_FIRST + 2 * REFUSED_ADDRESSES.length;
export const FETCH_SOCKET_TYPES = Object.freeze(["websocket", "webtransport"]);
export const FETCH_RULE_MAX = FETCH_SOCKET_RULE + 1;
// The initiators that rules 83 to 86 (the requests with no tab) leave out,
// with every name under them: a fetch window never has a worker there (its
// documents on these hosts are blocked), so a worker of an agent's own local
// site keeps reaching another local site while a fetch runs (review-46 N2).
export const FETCH_WORKER_FREE = Object.freeze(["localhost", "local", "internal"]);
const FETCH_IDS = Array.from({ length: FETCH_RULE_MAX - FETCH_RULE_ID + 1 }, (_, i) => FETCH_RULE_ID + i);
// chrome.tabs.TAB_ID_NONE: a request with no tab.
const NO_TAB = -1;
// Chrome's MAX_NUMBER_OF_SESSION_RULES (measured: the 5001st is refused).
const MAX_SESSION_RULES = 5000;
// The potentially trustworthy URLs, to which Chrome sends Sec-Fetch-*
// headers: https, and http to localhost, *.localhost, 127.0.0.0/8 or [::1].
export const TRUSTWORTHY = "^(https://|http://(localhost|[^/:]+\\.localhost|127\\.[0-9]+\\.[0-9]+\\.[0-9]+|\\[::1\\])(:[0-9]+)?/)";

const MAIN = ["main_frame"];
const FRAMES = ["sub_frame", "object"];

// The two scope rules of one list. A raw CDP client can make a top-level
// document with no request (about:blank, setContent) and put any host in a
// frame there; the frame rule allows frames only in a tab whose top-level
// domain is on the tab's list, so a page of a listed site still loads its
// frames from any host (O11). topDomains needs Chrome 141.
export function scopeRules(id, entries, tabIds) {
  if (entries === PUBLIC_LIST) return publicRules(id, tabIds);
  return [
    { id, priority: 2, action: { type: "allow" }, condition: { requestDomains: [...entries], resourceTypes: MAIN, tabIds: [...tabIds] } },
    { id: id + 1, priority: 2, action: { type: "allow" }, condition: { topDomains: [...entries], resourceTypes: FRAMES, tabIds: [...tabIds] } },
  ];
}

// The public rules (C4 and C5, the blanket profile; board ab-4wh.2): the two
// scope rules of a scope with "*". The main frames, the frames and the
// object documents of its tabs load a host of the public host class: a URL of
// http or https whose host is a name of two labels or more with a letter or
// "_" in its last label (so no IPv4 or IPv6 literal), with a userinfo part
// that never counts as the host, minus localhost, local, internal, home.arpa
// and every name under them. PUBLIC_RULES names them in the model and in
// replaceLists: never "*", which is rule 8's name.
export const PUBLIC_RULES = "*public";
export const PUBLIC_HOST_FILTER = "^https?://([^/?#@]*@)?([a-z0-9_-]+\\.)+[a-z0-9_-]*[a-z_][a-z0-9_-]*\\.?(:[0-9]+)?/";
export function publicRules(id, tabIds) {
  const condition = (resourceTypes) => ({ regexFilter: PUBLIC_HOST_FILTER, excludedRequestDomains: [...PUBLIC_NOT], resourceTypes, tabIds: [...tabIds] });
  return [
    { id, priority: 2, action: { type: "allow" }, condition: condition(MAIN) },
    { id: id + 1, priority: 2, action: { type: "allow" }, condition: condition(FRAMES) },
  ];
}

// C6, the import's rules: its domain in the restore tab, whatever the lists hold.
export function importRules(domain, tabId) {
  return [
    { id: IMPORT_RULE_ID, priority: 2, action: { type: "allow" }, condition: { requestDomains: [domain], resourceTypes: MAIN, tabIds: [tabId] } },
    { id: IMPORT_FRAME_RULE_ID, priority: 2, action: { type: "allow" }, condition: { topDomains: [domain], resourceTypes: FRAMES, tabIds: [tabId] } },
  ];
}

// C5, the marked-tab rule with "*": every site in the marked tabs. DNR
// refuses an empty tabIds, so there is no rule while no tab is marked.
export function markedRule(tabIds) {
  return { id: MARKED_RULE_ID, priority: 2, action: { type: "allow" }, condition: { resourceTypes: [...MAIN, ...FRAMES], tabIds: [...tabIds] } };
}

// The act's rules A to E (C5, the stored sign-ins' block; the stored
// sign-ins design, section 7.6). tabIds: the act tabs (the act tab, and each
// act popup and replaced act tab that joined); sendTo: the origins that may
// receive the password (origin first). DNR matches hosts, not origins: A, B
// and C block by the hosts of send_to (a host and its subdomains), D blocks
// those hosts in the act tabs, and E allows back exactly the origins of
// send_to (and ws: or wss: to the same host and port), one urlFilter rule
// each. No rule but B matches a main frame, so a top-level GET to another
// host stays open and rule 5 still sets the act's own navigations as typed
// ones. C has no tabIds: it matches in every tab, also in the default
// context, by the initiator: any host of send_to (review-ce44).
export function actRules({ tabIds, sendTo }) {
  const hosts = [...new Set(sendTo.map((o) => new URL(o).hostname))];
  const tabs = [...tabIds];
  const notMain = ["main_frame"];
  const block = { type: "block" };
  const rules = [
    { id: ACT_RULE_A, priority: ACT_BLOCK_PRIORITY, action: block, condition: { tabIds: [...tabs], excludedResourceTypes: notMain, excludedRequestDomains: hosts } },
    { id: ACT_RULE_B, priority: ACT_BLOCK_PRIORITY, action: block, condition: { tabIds: [...tabs], resourceTypes: MAIN, excludedRequestMethods: ["get"], excludedRequestDomains: hosts } },
    { id: ACT_RULE_C, priority: ACT_BLOCK_PRIORITY, action: block, condition: { initiatorDomains: [...hosts], excludedResourceTypes: notMain, excludedRequestDomains: hosts } },
    { id: ACT_RULE_D, priority: ACT_BLOCK_PRIORITY, action: block, condition: { tabIds: [...tabs], excludedResourceTypes: notMain, requestDomains: hosts } },
  ];
  let id = ACT_RULE_E;
  for (const o of sendTo) {
    const u = new URL(o);
    const ws = u.protocol === "https:" ? "wss:" : "ws:";
    for (const prefix of [u.origin, ws + "//" + u.host]) {
      rules.push({ id, priority: ACT_ALLOW_PRIORITY, action: { type: "allow" }, condition: { tabIds: [...tabs], excludedResourceTypes: notMain, urlFilter: "|" + prefix + "/" } });
      id += 1;
    }
  }
  return rules;
}

// C5, the fetch window's rules (PageFetch): tabIds are the fetch tabs (the
// fetch tab and each popup or replaced tab of one). Rule 78 is rule 8's kind:
// no host condition, so the fetch tabs load any host, and the scope's list
// does not apply to them. Each block rule matches every resource type (the
// main frame among them). The rules with no tab match only a request to
// another site than its initiator, and no initiator of FETCH_WORKER_FREE:
// the fetched page is on a public host, so its workers' requests to a
// refused address always match, and a worker of the default context keeps
// its own local site, and a local site of a name, while a fetch runs.
export function fetchRules(tabIds) {
  const rules = [{ id: FETCH_RULE_ID, priority: 2, action: { type: "allow" }, condition: { resourceTypes: [...MAIN, ...FRAMES], tabIds: [...tabIds] } }];
  const block = (id, regexFilter, more) => ({
    id, priority: FETCH_BLOCK_PRIORITY, action: { type: "block" },
    condition: { regexFilter, isUrlFilterCaseSensitive: true, resourceTypes: [...ALL_TYPES], ...more },
  });
  REFUSED_ADDRESSES.forEach((re, i) => rules.push(block(FETCH_BLOCK_FIRST + i, re, { tabIds: [...tabIds] })));
  REFUSED_ADDRESSES.forEach((re, i) => rules.push(block(FETCH_BLOCK_FIRST + REFUSED_ADDRESSES.length + i, re, { tabIds: [NO_TAB], domainType: "thirdParty", excludedInitiatorDomains: [...FETCH_WORKER_FREE] })));
  const sockets = (id, more) => ({ id, priority: FETCH_BLOCK_PRIORITY, action: { type: "block" }, condition: { resourceTypes: [...FETCH_SOCKET_TYPES], ...more } });
  rules.push(sockets(FETCH_SOCKET_RULE, { tabIds: [...tabIds] }));
  rules.push(sockets(FETCH_SOCKET_RULE + 1, { tabIds: [NO_TAB], domainType: "thirdParty", excludedInitiatorDomains: [...FETCH_WORKER_FREE] }));
  return rules;
}

// C5, the merge guard's floor: each write to a host of hosts (and its
// subdomains), of any resource type, in every tab but the excluded ones, and
// in each request with no tab (a shared or a service worker).
export function floorRule(hosts, excluded) {
  const condition = { requestDomains: [...hosts], excludedRequestMethods: [...FLOOR_FREE_METHODS], resourceTypes: [...ALL_TYPES] };
  if (excluded.length > 0) condition.excludedTabIds = [...excluded];
  return { id: FLOOR_RULE_ID, priority: FLOOR_PRIORITY, action: { type: "block" }, condition };
}

// C5, the floor's initiator rule 89 (board ab-v16.100): each write to a host
// of hosts (and its subdomains) whose initiator is not a host of hosts (nor
// its subdomain), of every resource type but the main frame, in every tab but
// the excluded ones (the marked tabs and the act tabs: the guarded tabs stay
// in), and in each request with no tab.
export function floorInitiatorRule(hosts, excluded) {
  const condition = {
    requestDomains: [...hosts], excludedRequestMethods: [...FLOOR_FREE_METHODS],
    excludedResourceTypes: ["main_frame"], excludedInitiatorDomains: [...hosts],
  };
  if (excluded.length > 0) condition.excludedTabIds = [...excluded];
  return { id: FLOOR_INITIATOR_RULE_ID, priority: FLOOR_PRIORITY, action: { type: "block" }, condition };
}

// Chrome names the extension as the initiator of a Page.navigate, so the site
// sees Sec-Fetch-Site: cross-site. This rule sets none for the top-level
// requests that the agent package starts, and for no other: then a
// Page.navigate sends none and ?1, as a typed URL, and a page script's
// navigation keeps its own value (two-modes design, section 7). Only to a
// potentially trustworthy URL: to any other URL Chrome sends no Sec-Fetch-*
// header, and one there would mark the agent. Chrome applies a modifyHeaders
// rule only above the priority of every allow rule that matches, so its
// priority is above the scope rules' (2); the block (rule 1) still holds.
export function headerRule(extensionId) {
  return {
    id: HEADER_RULE_ID,
    priority: 3,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "sec-fetch-site", operation: "set", value: "none" }] },
    condition: { resourceTypes: MAIN, initiatorDomains: [extensionId], regexFilter: TRUSTWORTHY },
  };
}

export class SessionRules {
  #chrome;
  #model; // () => Map(list name -> {entries, tabIds}): the lists of the open tabs of the map (and of the marked tabs)
  #marked; // () => the tabIds of rule 8: the marked tabs while the operator value is "*", else none
  #clock;
  #chain = Promise.resolve();
  #ids = new Map(); // list name -> the id of its first scope rule, for the rules in force
  #rule8 = false; // rule 8 is in force
  #dirty = false; // after a failed update: the next change is a full replace
  #unknown = false; // the start's removal failed: a full replace removes every rule of the scheme first
  #importing = false; // rules 6 and 7 of a running import are (or may be) in force
  #acting = false; // the act's rules are (or may be) in force
  #actSpec = null; // {tabIds, sendTo} of the act's rules in force
  #payDomain = null; // the merchant rule's domain while it is in force (C5 rule 90)
  #fetching = false; // the fetch window's rules are (or may be) in force
  #fetchTabs = null; // the tabIds of the fetch window's rules in force
  #floorMarked; // () => every marked tab (the operator's own), whatever the operator value is
  #guardHosts = [...FLOOR_HOSTS]; // the floor's hosts: GitHub's and those that bridge.mergeGuard added
  #guarded = new Set(); // the tabs that agent-browser's model guards (bridge.mergeGuard), while the bridge holds them
  #floorKey = null; // the floor rule in force (JSON), or null when it is not known to be in force
  #floorStarted = false; // the worker's start wrote the floor (or tried): before it, only the start writes it

  constructor(chrome, model, clock = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) }, marked = () => [], floorMarked = () => []) {
    this.#chrome = chrome;
    this.#model = model;
    this.#clock = clock;
    this.#marked = marked;
    this.#floorMarked = floorMarked;
  }

  // The floor's rules now, 9 and 89: their hosts, and the tabs that each
  // leaves out, in order: rule 9 the guarded tabs, the marked tabs and the act
  // tabs; rule 89 the marked tabs and the act tabs. A fetch tab never leaves
  // them (C5, the fetch window's rules).
  floorRules() {
    const fetchTabs = new Set(this.#fetchTabs ?? []);
    const out = (ids) => [...new Set(ids)].filter((id) => Number.isInteger(id) && !fetchTabs.has(id)).sort((a, b) => a - b);
    const kept = [...this.#floorMarked(), ...(this.#actSpec ? this.#actSpec.tabIds : [])];
    return [floorRule(this.#guardHosts, out([...this.#guarded, ...kept])), floorInitiatorRule(this.#guardHosts, out(kept))];
  }

  // The floor's rules again when they changed (inside the chain), both in one
  // call. A call that fails leaves the floor unknown: the next change writes
  // it again.
  async #syncFloor() {
    if (!this.#floorStarted) return;
    const rules = this.floorRules();
    const key = JSON.stringify(rules);
    if (key === this.#floorKey) return;
    this.#floorKey = null;
    await this.#dnr.updateSessionRules({ removeRuleIds: [...FLOOR_IDS], addRules: rules });
    this.#floorKey = key;
  }

  // C10 bridge.mergeGuard: the floor's hosts (GitHub's always, and the op's)
  // and the guarded tabs (the caller gives only the bridge's tabs), a full
  // replace; it answers when the rule is in force.
  setGuard(hosts, tabIds) {
    return this.#run(() => {
      this.#guardHosts = [...new Set([...FLOOR_HOSTS, ...hosts])];
      this.#guarded = new Set(tabIds);
      return this.#syncFloor();
    });
  }

  // A guarded tab leaves its guard (the bridge's detach, Chrome's detach),
  // or every one (null: a link change): the floor holds it again. The
  // bridge's detach waits for this, so the floor is in force first.
  unguard(tabIds) {
    return this.#run(() => {
      const before = this.#guarded.size;
      if (tabIds === null) this.#guarded.clear();
      else for (const id of tabIds) this.#guarded.delete(id);
      return this.#guarded.size === before ? undefined : this.#syncFloor();
    });
  }

  // A mark changed (the floor leaves the marked tabs out).
  syncFloor() {
    return this.#run(() => this.#syncFloor());
  }

  get #dnr() {
    return this.#chrome.declarativeNetRequest;
  }

  #run(fn) {
    const run = this.#chain.then(fn);
    this.#chain = run.then(() => {}, () => {});
    return run;
  }

  // The worker's start: dynamic rules 2 and 4 go (a package before part 1a
  // leaves them in the profile), and every session rule (also 6, 7 and 8).
  // It has RESTORE_MAX_MS (C10, the restore): a removal that fails or has
  // not ended by then fails closed (the next full replace removes every rule
  // of the scheme, and rules 6 and 7 when no import runs), with a log line.
  // Its late part removes nothing: it could take the full replace's rules.
  start() {
    return this.#run(async () => {
      let over = false;
      const work = (async () => {
        try {
          await this.#dnr.updateDynamicRules({ removeRuleIds: [OLD_RULE_ID, OLD_FRAME_RULE_ID] });
        } catch {
          // set_scopes removes them again.
        }
        const rules = await this.#dnr.getSessionRules();
        if (over) return;
        const all = (Array.isArray(rules) ? rules : []).map((r) => r.id);
        // The act's rules of a worker before this one stay until the act's
        // end has closed that act's tabs (C10, the act window; review-ce44 N1),
        // and so do the fetch window's rules until the fetch's end (C10, the
        // fetch window).
        if (all.some((id) => ACT_IDS.includes(id))) this.#acting = true;
        if (all.some((id) => FETCH_IDS.includes(id))) this.#fetching = true;
        const ids = all.filter((id) => !ACT_IDS.includes(id) && !FETCH_IDS.includes(id));
        // The floor in the same call as the removal: a worker that starts again leaves no moment without it.
        this.#guarded.clear();
        const floor = this.floorRules();
        this.#floorStarted = true;
        await this.#dnr.updateSessionRules({ removeRuleIds: [...new Set([...ids, ...FLOOR_IDS])], addRules: floor });
        this.#floorKey = JSON.stringify(floor);
      })();
      let handle;
      const late = new Promise((resolve) => {
        handle = this.#clock.setTimer(() => {
          over = true;
          resolve(false);
        }, RESTORE_MAX_MS);
      });
      const ok = await Promise.race([work.then(() => true, () => false), late]).finally(() => this.#clock.clearTimer(handle));
      if (!ok) {
        // The floor alone, so that it holds even when the removal did not end (not awaited: a call that hangs keeps no change back).
        this.#floorStarted = true;
        void this.#syncFloor().catch(() => console.warn("agentwatch receiver: the merge guard's floor was not written at the worker's start"));
        this.#unknown = true;
        // Act rules (and fetch rules) of a worker before this one can be there: the act's end (and the fetch's) removes them.
        this.#acting = true;
        this.#fetching = true;
        console.warn("agentwatch receiver: the session rules of the worker's start were not removed in time");
      }
    });
  }

  // set_scopes: rule 5, in one call that also removes ids 2 and 4.
  writeHeader() {
    return this.#run(() => this.#dnr.updateDynamicRules({
      removeRuleIds: [OLD_RULE_ID, OLD_FRAME_RULE_ID, HEADER_RULE_ID],
      addRules: [headerRule(this.#chrome.runtime.id)],
    }));
  }

  // set_scopes: every scope rule and rule 8, from the map and the marks.
  // Gives the count of the rules that it wrote.
  replaceAll() {
    return this.#run(() => this.#replaceAll());
  }

  // A tab got or lost a scope or the mark: the two rules of each named list
  // (null names no list), and rule 8 for the name ANY. A full replace after
  // a failed update.
  replaceLists(names) {
    return this.#run(() => (this.#dirty || this.#unknown ? this.#replaceAll().then(() => {}) : this.#replaceLists(names)));
  }

  async #replaceAll() {
    const model = this.#model();
    const ids = new Map();
    const add = [];
    let id = FIRST_SCOPE_RULE_ID;
    for (const name of [...model.keys()].sort()) {
      const { entries, tabIds } = model.get(name);
      if ((entries !== PUBLIC_LIST && entries.length === 0) || tabIds.length === 0) continue;
      ids.set(name, id);
      add.push(...scopeRules(id, entries, tabIds));
      id += 2;
    }
    const marked = this.#marked();
    if (marked.length > 0) add.push(markedRule(marked));
    const remove = new Set(this.#inForce());
    if (this.#unknown) {
      // A worker before this one can have left scope rules (they stay over a
      // worker stop). With no list of them, every id of the scheme goes.
      let rules = null;
      try {
        rules = await this.#dnr.getSessionRules();
      } catch {
        rules = null;
      }
      // Rules 6 and 7 go too when no import of this worker runs, the act's
      // rules when no act of this worker holds them, and the fetch window's
      // rules when no fetch window of this worker holds them.
      const keep = [...FLOOR_IDS, ...(this.#importing ? IMPORT_IDS : []), ...(this.#acting ? ACT_IDS : []), ...(this.#fetching ? FETCH_IDS : [])];
      if (Array.isArray(rules)) {
        for (const r of rules) if (!keep.includes(r.id)) remove.add(r.id);
      } else {
        for (const i of [...IMPORT_IDS, MARKED_RULE_ID, ...ACT_IDS, ...FETCH_IDS]) if (!keep.includes(i)) remove.add(i);
        for (let i = FIRST_SCOPE_RULE_ID; i < FIRST_SCOPE_RULE_ID + 2 * MAX_SESSION_RULES; i++) remove.add(i);
      }
    }
    await this.#update({ removeRuleIds: [...remove], addRules: add });
    this.#ids = ids;
    this.#rule8 = marked.length > 0;
    this.#dirty = false;
    this.#unknown = false;
    return add.length;
  }

  async #replaceLists(names) {
    const model = this.#model();
    const ids = new Map(this.#ids);
    let rule8 = this.#rule8;
    const remove = [];
    const add = [];
    for (const name of new Set(names)) {
      if (name === null || name === undefined) continue;
      if (name === ANY) {
        if (rule8) remove.push(MARKED_RULE_ID);
        const marked = this.#marked();
        rule8 = marked.length > 0;
        if (rule8) add.push(markedRule(marked));
        continue;
      }
      const old = ids.get(name);
      if (old !== undefined) remove.push(old, old + 1);
      ids.delete(name);
      const m = model.get(name);
      if (!m || (m.entries !== PUBLIC_LIST && m.entries.length === 0) || m.tabIds.length === 0) continue;
      const id = old ?? this.#free(ids);
      ids.set(name, id);
      add.push(...scopeRules(id, m.entries, m.tabIds));
    }
    if (remove.length === 0 && add.length === 0) return;
    await this.#update({ removeRuleIds: remove, addRules: add });
    this.#ids = ids;
    this.#rule8 = rule8;
  }

  // The lowest pair of ids that no list of ids holds.
  #free(ids) {
    const used = new Set(ids.values());
    let id = FIRST_SCOPE_RULE_ID;
    while (used.has(id)) id += 2;
    return id;
  }

  // The scope rules and rule 8 in force.
  #inForce() {
    return [...[...this.#ids.values()].flatMap((id) => [id, id + 1]), ...(this.#rule8 ? [MARKED_RULE_ID] : [])];
  }

  // One updateSessionRules call; it is all or nothing. A failure fails
  // closed: a remove-only call takes every scope rule and rule 8 out (if that
  // fails too, old rules can stay), and every later change is a full replace
  // until one succeeds. The map and the marks stay.
  async #update(details) {
    try {
      await this.#dnr.updateSessionRules(details);
    } catch (e) {
      this.#dirty = true;
      try {
        await this.#dnr.updateSessionRules({ removeRuleIds: this.#inForce() });
        this.#ids = new Map();
        this.#rule8 = false;
      } catch {
        // Old rules can stay in force: the closing rule still runs.
      }
      throw e;
    }
  }

  // C6: the import's rules for its restore tab, and their end.
  addImport(domain, tabId) {
    return this.#run(() => {
      this.#importing = true;
      return this.#dnr.updateSessionRules({ removeRuleIds: IMPORT_IDS, addRules: importRules(domain, tabId) });
    });
  }

  removeImport() {
    return this.#run(() => this.#dnr.updateSessionRules({ removeRuleIds: IMPORT_IDS }).then(() => {
      this.#importing = false;
    }));
  }

  // The act's rules held now (C5): true from a confirmed add to their removal.
  get acting() {
    return this.#acting;
  }

  // C5, the act's rules: one call that replaces them all (all or nothing:
  // after a failure the rules before it stay), then the confirmation: a read
  // of the session rules that must hold each rule of the call. Gives their
  // ids; throws when the call fails or a rule is not there.
  setAct(spec) {
    return this.#run(async () => {
      const rules = actRules(spec);
      // The merchant rule, when it holds, is rebuilt with these act tabs (a tab of the act is never blocked from its merchant).
      const merchant = this.#payDomain === null ? [] : [payMerchantRule({ domain: this.#payDomain, actTabIds: spec.tabIds })];
      await this.#dnr.updateSessionRules({ removeRuleIds: merchant.length ? ACT_IDS : ACT_RANGE_IDS, addRules: [...rules, ...merchant] });
      this.#acting = true;
      this.#actSpec = { tabIds: [...spec.tabIds], sendTo: [...spec.sendTo] };
      // The act tabs leave the floor: their sign-in's POST goes to its site (the act's own guard judges them).
      await this.#syncFloor();
      const held = await this.#dnr.getSessionRules();
      const ids = new Set((Array.isArray(held) ? held : []).map((r) => r && r.id));
      if (!rules.every((r) => ids.has(r.id))) throw new Error("a rule is not held");
      return rules.map((r) => r.id);
    });
  }

  // An act popup or a replaced act tab joins the tabIds of rules A, B, D and
  // E while they hold: one call that replaces them all. With no act's rules
  // in force it does nothing. A call that fails rejects (the caller closes the
  // tab), and the rules before it stay.
  addActTab(tabId) {
    return this.#run(async () => {
      const spec = this.#actSpec;
      if (!this.#acting || spec === null || spec.tabIds.includes(tabId)) return;
      const next = { tabIds: [...spec.tabIds, tabId], sendTo: spec.sendTo };
      // A joined act tab leaves the merchant rule too (its requests are the act's).
      const merchant = this.#payDomain === null ? [] : [payMerchantRule({ domain: this.#payDomain, actTabIds: next.tabIds })];
      await this.#dnr.updateSessionRules({ removeRuleIds: merchant.length ? ACT_IDS : ACT_RANGE_IDS, addRules: [...actRules(next), ...merchant] });
      this.#actSpec = next;
      await this.#syncFloor();
    });
  }

  // The act's end (and the cleanup of a left act): every id of the act's rules goes.
  removeAct() {
    return this.#run(() => this.#dnr.updateSessionRules({ removeRuleIds: ACT_IDS }).then(() => {
      this.#acting = false;
      this.#actSpec = null;
      this.#payDomain = null;
      return this.#syncFloor();
    }));
  }

  // The card payment's merchant rule (C5 rule 90): on adds it for domain, with the act tabs in force excluded (and it
  // counts as an act's rule: the act's end and a worker's start remove it); off removes it. Answers the ids in force.
  setPayMerchant({ domain, on, actTabIds }) {
    return this.#run(async () => {
      if (!on) {
        await this.#dnr.updateSessionRules({ removeRuleIds: [PAY_MERCHANT_RULE_ID] });
        this.#payDomain = null;
        return [];
      }
      const rule = payMerchantRule({ domain, actTabIds });
      await this.#dnr.updateSessionRules({ removeRuleIds: [PAY_MERCHANT_RULE_ID], addRules: [rule] });
      this.#acting = true;
      this.#payDomain = domain;
      const held = await this.#dnr.getSessionRules();
      if (!(Array.isArray(held) ? held : []).some((r) => r && r.id === PAY_MERCHANT_RULE_ID)) throw new Error("a rule is not held");
      return [PAY_MERCHANT_RULE_ID];
    });
  }

  // ---- the fetch window's rules (C5, PageFetch; fetch-window.js) ----

  // The fetch window's rules held now: true from their add (or a start that
  // found them or whose removal failed) to their removal.
  get fetching() {
    return this.#fetching;
  }

  // The fetch window's rules for tabIds (the fetch tab first): one call that
  // replaces them all, then the confirmation, a read of the session rules
  // that must hold each rule of the call. #fetching is true before the call:
  // a call that Chrome took but whose answer failed leaves rules that only
  // the fetch's end removes. The floor is written again: a fetch tab that
  // bridge.mergeGuard named leaves the guarded tabs. Gives their ids; throws
  // when the call fails or a rule is not there.
  setFetch(tabIds) {
    return this.#run(async () => {
      const rules = fetchRules(tabIds);
      this.#fetching = true;
      await this.#dnr.updateSessionRules({ removeRuleIds: FETCH_IDS, addRules: rules });
      this.#fetchTabs = [...tabIds];
      await this.#syncFloor();
      const held = await this.#dnr.getSessionRules();
      const ids = new Set((Array.isArray(held) ? held : []).map((r) => r && r.id));
      if (!rules.every((r) => ids.has(r.id))) throw new Error("a rule is not held");
      return rules.map((r) => r.id);
    });
  }

  // A popup or a replaced tab of a fetch tab joins the tabIds of the fetch
  // window's rules while they hold: one call that replaces them all. With no
  // fetch rules in force it does nothing. A call that fails rejects (the
  // caller closes the tab), and the rules before it stay.
  addFetchTab(tabId) {
    return this.#run(async () => {
      const tabs = this.#fetchTabs;
      if (!this.#fetching || tabs === null || tabs.includes(tabId)) return;
      const next = [...tabs, tabId];
      await this.#dnr.updateSessionRules({ removeRuleIds: FETCH_IDS, addRules: fetchRules(next) });
      this.#fetchTabs = next;
      await this.#syncFloor();
    });
  }

  // The fetch's end (and the cleanup of a left fetch window): every id of the fetch window's rules goes.
  removeFetch() {
    return this.#run(() => this.#dnr.updateSessionRules({ removeRuleIds: FETCH_IDS }).then(() => {
      this.#fetching = false;
      this.#fetchTabs = null;
      return this.#syncFloor();
    }));
  }
}
