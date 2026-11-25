// The allowlists per scope (contract C4, set_scopes; C5). parseScopes reads
// one set_scopes object by C4's rules and gives what applies, with the count
// of what it refused. The relay applies the same rules to its allowlist line;
// test/vectors/scopes.json checks both sides.
import { covers, normalizeEntry } from "./lib/domains.js";

// C11's scope pattern: list names and local scopes share it.
export const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// C11's remote scope (stage 5, board ab-v16.94.7.2): <box>/<session>, two names
// of SCOPE_PATTERN with one "/". A local scope has no "/", so the two never meet.
export const REMOTE_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A list name (in lists, a scope's value, default and operator): local only.
export const isName = (v) => typeof v === "string" && SCOPE_PATTERN.test(v);
// A scope (of set_scopes, of the tab map and of the bridge): local or remote.
export const isScope = (v) => typeof v === "string" && (SCOPE_PATTERN.test(v) || REMOTE_SCOPE_PATTERN.test(v));
// The operator value "*" (C4): the marked tabs may open any site. As a tab's
// list it covers every host; no list name can be "*" (the scope pattern).
export const ANY = "*";
// A local scope's value "*" (C4, the blanket profile; board ab-4wh.2): the
// scope may open any host of the public host class, minus the names of the
// object's exclude. The service sends it only on the blanket Chrome's link,
// in a blanket-shaped object (review M6): no list, no default, no operator,
// one scope. listOf gives "*" for such a scope, and entriesOf gives its public
// list, {public: true, exclude}, which no list's entries can be.
export const PUBLIC = "*";
// The names that are no public host, with every name under them (C4; review
// I1: localdomain, as localhost.localdomain resolves to loopback).
export const PUBLIC_NOT = Object.freeze(["localhost", "local", "internal", "home.arpa", "localdomain"]);
const LABEL = /^[a-z0-9_-]+$/;
// A name of exclude (C4): as C5 writes an entry (lowercase, punycode, no
// trailing dot), one label allowed, each label 1-63 of [a-z0-9_-] that does
// not start or end with "-", at most 253 characters, no IPv4 literal. At most
// MAX_EXCLUDE names of at most MAX_EXCLUDE_CHARS characters in all, so that
// the block rule's regexFilter stays under Chrome's size limit.
export const MAX_EXCLUDE = 8;
export const MAX_EXCLUDE_CHARS = 512;
const EXCLUDE_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const excludeName = (e) => typeof e === "string" && e.length <= 253 && e.split(".").every((l) => EXCLUDE_LABEL.test(l)) && !/^[0-9.]+$/.test(e);
const goodExclude = (x) => Array.isArray(x) && x.length <= MAX_EXCLUDE && x.join("").length <= MAX_EXCLUDE_CHARS && x.every(excludeName);
const under = (h, names) => names.some((d) => h === d || h.endsWith("." + d));

// C4's public host class: a name of two labels or more (a trailing dot
// allowed), each label of [a-z0-9_-], whose last label holds a letter or "_"
// (so no IPv4 literal, in the dotted form that Chrome's URL parser gives), no
// IPv6 literal ("[...]"), not a name of PUBLIC_NOT or under one, and not a
// name of exclude or under one.
export function isPublicHost(host, exclude = []) {
  if (typeof host !== "string") return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  const labels = h.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !/[a-z_]/.test(labels.at(-1))) return false;
  return !under(h, PUBLIC_NOT) && !under(h, exclude);
}

// A scope's public list (entriesOf of a "*" scope).
export const isPublicList = (x) => x !== null && typeof x === "object" && !Array.isArray(x) && x.public === true;

// Whether a tab's list (ANY, a public list, a list's entries, or null) covers a host.
export function listCovers(list, host) {
  if (list === ANY) return true;
  if (isPublicList(list)) return isPublicHost(host, list.exclude);
  return Array.isArray(list) && list.some((d) => covers(d, host));
}

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
  constructor({ lists = {}, scopes = {}, default: def = null, operator = null, refused = 0, applied = false, exclude = [] } = {}) {
    this.lists = lists;
    // The names that a "*" scope may not open (C4, exclude), and its public list.
    this.exclude = Object.freeze([...exclude]);
    this.publicList = Object.freeze({ public: true, exclude: this.exclude });
    this.scopes = scopes;
    this.default = def;
    this.operator = operator;
    this.refused = refused;
    this.applied = applied;
    Object.freeze(this);
  }

  // A scope's list: its scopes entry when it has one (no fall-back to
  // default), else default for a local scope only; null when that name is not
  // in lists. A remote scope that scopes does not name has no list (C4; fail
  // closed, board ab-v16.94.7.2).
  listOf(scope) {
    const name = Object.hasOwn(this.scopes, scope) ? this.scopes[scope] : isName(scope) ? this.default : null;
    if (name === PUBLIC) return PUBLIC;
    return name !== null && Object.hasOwn(this.lists, name) ? name : null;
  }

  // The entries of the default list: the list of a local scope that scopes
  // does not name; null when there is none.
  defaultEntries() {
    return this.default !== null && Object.hasOwn(this.lists, this.default) ? this.lists[this.default] : null;
  }

  // The entries of a scope's list, the public list for a scope with "*", or null
  // for a scope with no list.
  entriesOf(scope) {
    const name = this.listOf(scope);
    if (name === PUBLIC) return this.publicList;
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
  // A "*" applies only for a local scope of a blanket-shaped object with a
  // good exclude (absent: none); else it counts 1 and applies as null.
  const blanket = isObj(m.lists) && Object.keys(m.lists).length === 0 && m.default === null
    && (!Object.hasOwn(m, "operator") || m.operator === null) && isObj(m.scopes) && Object.keys(m.scopes).length === 1
    && (!Object.hasOwn(m, "exclude") || goodExclude(m.exclude));
  let star = false;
  if (isObj(m.scopes)) {
    for (const [scope, v] of Object.entries(m.scopes)) {
      if (!isScope(scope)) {
        refused += 1; // applies as absent: no connection can name it
      } else if (v === PUBLIC && isName(scope) && blanket) {
        scopes[scope] = PUBLIC; // a local scope's "*" (C4, the blanket profile)
        star = true;
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
  const exclude = star && Object.hasOwn(m, "exclude") ? [...new Set(m.exclude)] : [];
  return new ScopeSet({ lists, scopes, default: def, operator, refused, applied: isObj(m.lists) && isObj(m.scopes), exclude });
}

// C5's worker removal: true when some scope has a list in last and in next,
// and next's list lacks an entry of last's. A local scope that neither object
// names has the default list in each. The operator value counts as one more
// scope's list: a change from "*" to a list, or a list that loses an entry.
// No last (the first set_scopes after the worker's start): true.
export function shrinks(last, next) {
  if (!last) return true;
  // A "*" scope's public list holds every host of the public class minus its
  // exclude names: to it, a list loses only its hosts outside that; from it,
  // any list; from one public list to another, a name that exclude gains.
  const lost = (a, b) => {
    if (a === null || b === null) return false;
    if (isPublicList(a)) return !isPublicList(b) || b.exclude.some((d) => !under(d, a.exclude));
    if (isPublicList(b)) return a.some((e) => !isPublicHost(e, b.exclude));
    return a.some((e) => !b.includes(e));
  };
  const names = new Set([...Object.keys(last.scopes), ...Object.keys(next.scopes)]);
  for (const s of names) if (lost(last.entriesOf(s), next.entriesOf(s))) return true;
  if (lost(last.defaultEntries(), next.defaultEntries())) return true;
  const a = last.markEntries();
  const b = next.markEntries();
  if (a === ANY) return b !== ANY && b !== null;
  return b !== ANY && lost(a, b);
}
