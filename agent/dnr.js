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
// Dynamic rule 5 sets Sec-Fetch-Site: none on the receiver's own top-level
// requests. Dynamic rules 2 and 4 (one list for every tab, before part 1a)
// are gone: the worker removes them at its start and at each set_scopes.
//
// Every change runs in one chain, one after the other, each from the map
// when it runs. A failed scope update fails closed: a remove-only call takes
// every scope rule out, and the next update is a full replace.

import { ANY } from "./scopes.js";
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
export const ACT_RULE_MAX = ACT_RULE_E + 2 * MAX_SEND_TO - 1;
const ACT_IDS = Array.from({ length: ACT_RULE_MAX - ACT_RULE_A + 1 }, (_, i) => ACT_RULE_A + i);
export const ACT_BLOCK_PRIORITY = 4;
export const ACT_ALLOW_PRIORITY = 5;
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
  return [
    { id, priority: 2, action: { type: "allow" }, condition: { requestDomains: [...entries], resourceTypes: MAIN, tabIds: [...tabIds] } },
    { id: id + 1, priority: 2, action: { type: "allow" }, condition: { topDomains: [...entries], resourceTypes: FRAMES, tabIds: [...tabIds] } },
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

  constructor(chrome, model, clock = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) }, marked = () => []) {
    this.#chrome = chrome;
    this.#model = model;
    this.#clock = clock;
    this.#marked = marked;
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
        // end has closed that act's tabs (C10, the act window; review-ce44 N1).
        if (all.some((id) => ACT_IDS.includes(id))) this.#acting = true;
        const ids = all.filter((id) => !ACT_IDS.includes(id));
        if (ids.length > 0) await this.#dnr.updateSessionRules({ removeRuleIds: ids });
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
        this.#unknown = true;
        // Act rules of a worker before this one can be there: the act's end removes them.
        this.#acting = true;
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
      if (entries.length === 0 || tabIds.length === 0) continue;
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
      // Rules 6 and 7 go too when no import of this worker runs, and the
      // act's rules when no act of this worker holds them.
      const keep = [...(this.#importing ? IMPORT_IDS : []), ...(this.#acting ? ACT_IDS : [])];
      if (Array.isArray(rules)) {
        for (const r of rules) if (!keep.includes(r.id)) remove.add(r.id);
      } else {
        for (const i of [...IMPORT_IDS, MARKED_RULE_ID, ...ACT_IDS]) if (!keep.includes(i)) remove.add(i);
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
      if (!m || m.entries.length === 0 || m.tabIds.length === 0) continue;
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
      await this.#dnr.updateSessionRules({ removeRuleIds: ACT_IDS, addRules: rules });
      this.#acting = true;
      this.#actSpec = { tabIds: [...spec.tabIds], sendTo: [...spec.sendTo] };
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
      await this.#dnr.updateSessionRules({ removeRuleIds: ACT_IDS, addRules: actRules(next) });
      this.#actSpec = next;
    });
  }

  // The act's end (and the cleanup of a left act): every id of the act's rules goes.
  removeAct() {
    return this.#run(() => this.#dnr.updateSessionRules({ removeRuleIds: ACT_IDS }).then(() => {
      this.#acting = false;
      this.#actSpec = null;
    }));
  }
}
