// The DNR rules of the allowlists per scope (contract C5). The static rules 1
// and 3 block every main frame and every frame; session rules allow each
// tab's list in that tab only:
// - the scope rules: for each list that has an entry and is the list of an
//   open tab, rule 100 + 2i allows its main frames (requestDomains) and rule
//   101 + 2i its frames, <object> and <embed> documents (topDomains), both
//   with the tabIds of the tabs whose list it is;
// - the import's rules 6 and 7: the import's domain in its restore tab only.
// Dynamic rule 5 sets Sec-Fetch-Site: none on the receiver's own top-level
// requests. Dynamic rules 2 and 4 (one list for every tab, before part 1a)
// are gone: the worker removes them at its start and at each set_scopes.
//
// Every change runs in one chain, one after the other, each from the map
// when it runs. A failed scope update fails closed: a remove-only call takes
// every scope rule out, and the next update is a full replace.

const OLD_RULE_ID = 2;
const OLD_FRAME_RULE_ID = 4;
export const HEADER_RULE_ID = 5;
export const IMPORT_RULE_ID = 6;
export const IMPORT_FRAME_RULE_ID = 7;
export const FIRST_SCOPE_RULE_ID = 100;
const IMPORT_IDS = [IMPORT_RULE_ID, IMPORT_FRAME_RULE_ID];
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
  #model; // () => Map(list name -> {entries, tabIds}): the lists of the open tabs of the map
  #chain = Promise.resolve();
  #ids = new Map(); // list name -> the id of its first scope rule, for the rules in force
  #dirty = false; // after a failed update: the next change is a full replace
  #unknown = false; // the start's removal failed: a full replace reads the session rules first

  constructor(chrome, model) {
    this.#chrome = chrome;
    this.#model = model;
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
  start() {
    return this.#run(async () => {
      try {
        await this.#dnr.updateDynamicRules({ removeRuleIds: [OLD_RULE_ID, OLD_FRAME_RULE_ID] });
      } catch {
        // set_scopes removes them again.
      }
      try {
        const rules = await this.#dnr.getSessionRules();
        const ids = (Array.isArray(rules) ? rules : []).map((r) => r.id);
        if (ids.length > 0) await this.#dnr.updateSessionRules({ removeRuleIds: ids });
      } catch {
        this.#unknown = true;
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

  // set_scopes: every scope rule, from the map. Gives the count of the rules
  // that it wrote.
  replaceAll() {
    return this.#run(() => this.#replaceAll());
  }

  // A tab got or lost a scope: the two rules of each named list (null names
  // no list). A full replace after a failed update.
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
      if (Array.isArray(rules)) {
        for (const r of rules) if (!IMPORT_IDS.includes(r.id)) remove.add(r.id);
      } else {
        for (let i = FIRST_SCOPE_RULE_ID; i < FIRST_SCOPE_RULE_ID + 2 * MAX_SESSION_RULES; i++) remove.add(i);
      }
    }
    await this.#update({ removeRuleIds: [...remove], addRules: add });
    this.#ids = ids;
    this.#dirty = false;
    this.#unknown = false;
    return add.length;
  }

  async #replaceLists(names) {
    const model = this.#model();
    const ids = new Map(this.#ids);
    const remove = [];
    const add = [];
    for (const name of new Set(names)) {
      if (name === null || name === undefined) continue;
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
  }

  // The lowest pair of ids that no list of ids holds.
  #free(ids) {
    const used = new Set(ids.values());
    let id = FIRST_SCOPE_RULE_ID;
    while (used.has(id)) id += 2;
    return id;
  }

  #inForce() {
    return [...this.#ids.values()].flatMap((id) => [id, id + 1]);
  }

  // One updateSessionRules call; it is all or nothing. A failure fails
  // closed: a remove-only call takes every scope rule out (if that fails too,
  // old rules can stay), and every later change is a full replace until one
  // succeeds. The map stays.
  async #update(details) {
    try {
      await this.#dnr.updateSessionRules(details);
    } catch (e) {
      this.#dirty = true;
      try {
        await this.#dnr.updateSessionRules({ removeRuleIds: this.#inForce() });
        this.#ids = new Map();
      } catch {
        // Old rules can stay in force: the closing rule still runs.
      }
      throw e;
    }
  }

  // C6: the import's rules for its restore tab, and their end.
  addImport(domain, tabId) {
    return this.#run(() => this.#dnr.updateSessionRules({ removeRuleIds: IMPORT_IDS, addRules: importRules(domain, tabId) }));
  }

  removeImport() {
    return this.#run(() => this.#dnr.updateSessionRules({ removeRuleIds: IMPORT_IDS }));
  }
}
