// set_scopes (contract C4), the scope rules (C5), the worker removal, the
// closing rule and the sweep. One set_scopes runs at a time. In order:
// 1. The object applies by C4's rules (scopes.js) and becomes the last
//    set_scopes; an applied one (scopes and lists are objects) also becomes
//    the reference of the checks of a new entry, before the sweep's query.
// 2. The rule update: rule 5 (with the removal of the old ids 2 and 4) and
//    every scope rule, from the map. A failure fails closed.
// 3. The worker removal, when C5 needs it.
// 4. One item of the removal queue: the closing rule and, for an applied
//    object, the sweep. A tab of the sweep that the item does not close
//    leaves the map and the copy, and joins the orphan set.
// 5. The copy's key removals of the sweep (and the ones that failed
//    before), each within REMOVAL_WAIT_MS.
// The answer comes after all of them: {rules, closed, refused}, or the
// first failure after the tabs closed.
import { importState } from "./importer.js";
import { covers } from "./lib/domains.js";
import { receiver } from "./receiver.js";
import { REMOVAL_WAIT_MS } from "./removals.js";
import { ANY, parseScopes, shrinks } from "./scopes.js";
import { tabUrl } from "./tabs.js";

// Per Receiver: the chain of set_scopes, the last one that applied in full,
// and a worker removal that is still owed.
const runs = new WeakMap();

function stateOf(r) {
  let s = runs.get(r);
  if (!s) {
    s = { chain: Promise.resolve(), lastFull: undefined, workersOwed: false };
    runs.set(r, s);
  }
  return s;
}

// C4, the rollout: a new receiver and an old daemon. The receiver applies
// nothing, so no scope rule exists, and every tab stays blocked.
export const SET_ALLOWLIST_GONE = "set_allowlist is gone: send set_scopes";

// The requests of channel main (C4), as sw.js wires them.
export function mainOps(chrome) {
  return {
    ping: async () => ({}),
    set_scopes: (req) => setScopes(chrome, req),
    set_allowlist: async () => {
      throw new Error(SET_ALLOWLIST_GONE);
    },
    import: (req) => importState(chrome, req.state),
  };
}

export function setScopes(chrome, msg) {
  const r = receiver(chrome);
  const s = stateOf(r);
  const run = s.chain.then(() => r.map.whenRestored(() => apply(r, s, msg)));
  s.chain = run.then(() => {}, () => {});
  return run;
}

// The closing rule and the sweep: does the item close tab t? swept collects
// the tabs of the sweep. The closing rule judges each tab by the last applied
// set_scopes: at one that is not applied (its scopes or lists is not an
// object) the receiver sweeps nothing, and one bad message closes no live
// session's page; with no applied one since the worker's start it closes
// nothing. A marked tab has no scope, so the sweep never closes it; the
// closing rule judges it by its operator value ("*": never).
function picks(r, next, t, swept) {
  const id = t.id;
  if (r.att.isRestoreTab(id)) return false; // never the restore tab of a running import
  const orphan = r.map.isOrphan(id);
  const scope = r.map.scopeOf(id);
  if (next.applied && (orphan || (scope !== undefined && next.listOf(scope) === null))) {
    swept.add(id); // whatever its URL, about:blank too
    return true;
  }
  const by = next.applied ? next : r.map.reference;
  if (by === null) return false;
  const u = tabUrl(t);
  if (u === null) return false;
  // The tab's list: none for a tab of the orphan set, its scope's list, a
  // marked tab's operator value, or the union of the lists for any other tab
  // of no scope.
  const list = r.tabList(id, by);
  if (list === ANY) return false;
  return list === null || !list.some((d) => covers(d, u.hostname));
}

// True when promise gives true within REMOVAL_WAIT_MS.
function within(r, promise) {
  let handle;
  const late = new Promise((resolve) => {
    handle = r.clock.setTimer(() => resolve(false), REMOVAL_WAIT_MS);
  });
  return Promise.race([promise.then((ok) => ok === true, () => false), late]).finally(() => r.clock.clearTimer(handle));
}

async function apply(r, s, msg) {
  const chrome = r.chrome;
  const next = parseScopes(msg);
  r.map.current = next;
  if (next.applied) r.map.applyReference(next);
  let failure = null;
  const fail = (e) => {
    if (failure === null) failure = e instanceof Error ? e : new Error(String(e));
  };
  await r.rules.writeHeader().catch(fail);
  let rules = 0;
  try {
    rules = await r.rules.replaceAll();
  } catch (e) {
    fail(e);
  }
  // The worker removal, within REMOVAL_WAIT_MS: a failed or late one fails
  // the call after the tabs closed, and the next set_scopes removes again.
  if (s.workersOwed || shrinks(s.lastFull, next)) {
    const removed = new Promise((resolve) => resolve(chrome.browsingData.remove({}, { serviceWorkers: true }))).then(() => true);
    if (await within(r, removed)) {
      s.workersOwed = false;
    } else {
      // The failure below makes the removal owed (the end of apply).
      console.warn("agentwatch receiver: the service worker removal failed or did not end in time");
      fail(new Error("service worker removal failed"));
    }
  }
  const swept = new Set();
  const keys = [];
  const item = await r.removals.closeOwn({
    select: (tabs) => tabs.filter((t) => picks(r, next, t, swept)).map((t) => t.id),
    after: ({ closed, error }) => {
      // A query that failed or came late picked no tab: the tabs of the sweep
      // are then the tabs of the map whose scope the new object gives no list.
      if (error && next.applied) {
        for (const [id, scope] of r.map.entries()) if (next.listOf(scope) === null) swept.add(id);
      }
      // A tab of the sweep that did not close leaves its scope, into the orphan set.
      for (const id of swept) {
        if (closed.includes(id)) continue;
        if (r.map.has(id)) {
          r.map.leave(id);
          keys.push(id);
        }
        r.map.addOrphan(id);
      }
    },
  });
  const stale = [...r.staleKeys].map((k) => Number(k.slice(4))).filter((id) => !r.map.has(id));
  const removals = [...new Set([...keys, ...stale])].map((id) => within(r, r.dropKey(id)).then((ok) => {
    if (!ok) r.staleKeys.add("tab:" + id);
    return ok;
  }));
  if (!(await Promise.all(removals)).every(Boolean)) fail(new Error("copy key removal failed"));
  // An ok:false moves no "last" of the worker removal, but the new rules can
  // be in force (a failed key removal or rule 5): the removal is owed.
  if (failure) {
    s.workersOwed = true;
    throw failure;
  }
  if (next.applied) s.lastFull = next;
  return { rules, closed: item.closed.length, refused: next.refused };
}
