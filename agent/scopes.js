// The allowlists per scope (contract C4, set_scopes; C5). parseScopes reads
// one set_scopes object by C4's rules and gives what applies, with the count
// of what it refused. The relay applies the same rules to its allowlist line;
// test/vectors/scopes.json checks both sides.
import { normalizeEntry } from "./lib/domains.js";

// C11's scope pattern: list names and scopes share it.
export const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isName = (v) => typeof v === "string" && SCOPE_PATTERN.test(v);
// The operator value "*" (C4): the marked tabs may open any site. As a tab's
// list it covers every host; no list name can be "*" (the scope pattern).
export const ANY = "*";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const normalized = (e) => {
  const r = normalizeEntry(e);
  return r.ok && r.entry === e;
};

// What applies of one set_scopes. lists: list name -> its valid entries (a
// list that applies as absent is not there). scopes: scope -> a list name or
// null. default: a valid name or null. operator: "*", a list name of lists,
// or null (choice 3 of the design: what the marked tabs may open). applied: scopes
// and lists are objects (C5: only an applied set_scopes sweeps, and only an
// applied one is the reference of the new entries).
export class ScopeSet {
  constructor({ lists = {}, scopes = {}, default: def = null, operator = null, refused = 0, applied = false } = {}) {
    this.lists = lists;
    this.scopes = scopes;
    this.default = def;
    this.operator = operator;
    this.refused = refused;
    this.applied = applied;
    Object.freeze(this);
  }

  // A scope's list: its scopes entry when it has one (no fall-back to
  // default), else default; null when that name is not in lists.
  listOf(scope) {
    const name = Object.hasOwn(this.scopes, scope) ? this.scopes[scope] : this.default;
    return name !== null && Object.hasOwn(this.lists, name) ? name : null;
  }

  // The entries of a scope's list, or null for a scope with no list.
  entriesOf(scope) {
    const name = this.listOf(scope);
    return name === null ? null : this.lists[name];
  }

  // A marked tab's list (C5): ANY with "*", the entries of the named list,
  // or null (no list).
  markEntries() {
    if (this.operator === ANY) return ANY;
    return this.operator === null ? null : this.lists[this.operator];
  }

  // The union of the lists: the list of a tab of no scope that is not marked
  // (C5's closing rule) and of contentDetails (C10).
  union() {
    const out = new Set();
    for (const name of Object.keys(this.lists)) for (const e of this.lists[name]) out.add(e);
    return [...out];
  }
}

// Before the first set_scopes after the worker's start: no list, no scope.
export const NO_SCOPES = new ScopeSet();

export function parseScopes(msg) {
  const m = isObj(msg) ? msg : {};
  let refused = 0;
  const lists = {};
  if (isObj(m.lists)) {
    for (const [name, v] of Object.entries(m.lists)) {
      if (!isName(name) || !Array.isArray(v)) {
        refused += 1 + (Array.isArray(v) ? v.length : 0); // the list, and each entry of its array
        continue;
      }
      const ok = v.filter(normalized);
      refused += v.length - ok.length;
      lists[name] = ok;
    }
  } else {
    refused += 1;
  }
  const scopes = {};
  if (isObj(m.scopes)) {
    for (const [scope, v] of Object.entries(m.scopes)) {
      if (!isName(scope)) {
        refused += 1; // applies as absent: no connection can name it
      } else if (v === null || isName(v)) {
        scopes[scope] = v;
      } else {
        refused += 1;
        scopes[scope] = null; // no list, and no fall-back to default
      }
    }
  } else {
    refused += 1;
  }
  let def = null;
  if (isName(m.default)) def = m.default;
  else if (m.default !== null) refused += 1; // also a missing default
  // No scope gets the default list while the daemon's scopes are not known.
  if (!isObj(m.scopes)) def = null;
  let operator = null;
  if (Object.hasOwn(m, "operator") && m.operator !== null) {
    const o = m.operator;
    if (o === ANY) operator = ANY;
    else if (isName(o)) operator = Object.hasOwn(lists, o) ? o : null;
    else refused += 1;
  }
  return new ScopeSet({ lists, scopes, default: def, operator, refused, applied: isObj(m.lists) && isObj(m.scopes) });
}

// C5's worker removal: true when some scope has a list in last and in next,
// and next's list lacks an entry of last's. A scope that neither object names
// has the default list in each. The operator value counts as one more
// scope's list: a change from "*" to a list, or a list that loses an entry.
// No last (the first set_scopes after the worker's start): true.
export function shrinks(last, next) {
  if (!last) return true;
  const lost = (a, b) => a !== null && b !== null && a.some((e) => !b.includes(e));
  const names = new Set([...Object.keys(last.scopes), ...Object.keys(next.scopes), ""]); // "" names no scope: the default
  for (const s of names) if (lost(last.entriesOf(s), next.entriesOf(s))) return true;
  const a = last.markEntries();
  const b = next.markEntries();
  if (a === ANY) return b !== ANY && b !== null;
  return b !== ANY && lost(a, b);
}
