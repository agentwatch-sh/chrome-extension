// The service worker removals (contract C5, the worker removal): the one
// bounded call, and the removal of the workers of each recorded origin that no
// list covers and whose site no marked tab shows (board ab-v16.74; the
// operator's answer ab-214: "Remove such a site's worker when your tab leaves
// it"; review-30).
//
// A site's service worker answers a navigation before DNR sees it. A worker
// that the operator's marked tab ("*") registered for a host on no list
// answers a scope's tab too, with the operator's signed-in page, until layer 3
// of the guard sends that tab away (measured, board ab-v16.73); so does a
// worker of a scope's site after that scope's list ended. So:
// - The record: each web origin (http:/https:, a blob: URL's inner origin)
//   that a frame of any tab commits, the top frame and every sub-frame (a
//   frame can register a worker for its own origin). It lives in memory and in
//   chrome.storage.session, one key per origin ("worker:<origin>"), so a worker
//   that starts again knows it; the start's one read of the copy (tabmap.js)
//   gives it back. At most RECORD_MAX origins (the bound, below).
// - The check: the receiver reads the frames of each marked tab
//   (webNavigation.getAllFrames; a page in the back/forward cache or one that
//   is going shows nothing; an origin committed during that read counts as
//   shown). It removes the workers of each recorded origin that no list of
//   the last applied set_scopes covers and whose site no marked tab shows in
//   any frame (the site rule): browsingData.remove({origins},
//   {serviceWorkers: true}); the origins leave the record. Chrome's origin
//   filter removes the origin's own worker and every partitioned worker whose
//   top-level site is the origin's site, so the site rule keeps the workers
//   that the operator's open pages of that site use. A listed origin stays
//   recorded: the set_scopes that takes it off every list removes it.
// - The site: the scheme and the last two labels of the host (an IP address
//   or a host of one or two labels as it is). The receiver has no public
//   suffix list, so this is the registrable domain or wider (two labels under
//   a public suffix of two labels, such as co.uk): the rule keeps more
//   workers, never fewer.
// - The events of a check: each commit and each navigation error of a frame
//   of any tab, a marked tab's close or replace, a tab that loses the mark or
//   gets it at tabs.onCreated or tabs.onReplaced, each set_scopes (after its
//   answer) and the worker's start (no tab is marked then: the marks have no
//   copy). One check runs at a time; the events while one runs start one more
//   after it.
// - The limits: each frame read and each removal has REMOVAL_WAIT_MS. A read
//   that fails or comes late removes nothing (a shown origin could break the
//   operator's open page); a removal that fails or comes late keeps its
//   origins. Each logs one line (no origin), and the next event's check tries
//   again.
// - The bound: at RECORD_MAX origins a new origin evicts the oldest one that
//   a list covers (else the oldest one). The receiver then owes one removal of
//   every worker: at the next check when the evicted origin was not covered,
//   else at the first check whose lists no longer hold an entry that covered
//   an evicted origin.
//
// C5's own worker removal of a set_scopes (allowlist.js: every origin) uses
// the same bounded call; neither waits for the other or fails the other.
import { call } from "./attach.js";
import { covers } from "./lib/domains.js";
import { REMOVAL_WAIT_MS } from "./removals.js";
import { webUrl } from "./tabs.js";

// The key of a recorded origin in chrome.storage.session.
export const WORKER_KEY = "worker:";
// The most origins that the record holds.
export const RECORD_MAX = 1000;

// The web origin of a frame's URL (as the guard judges a host: tabs.js), or null.
export function originOf(url) {
  const u = webUrl(url);
  return u === null || u.hostname === "" ? null : u.origin;
}

// The site of an origin for the site rule: its scheme and the last two labels
// of its host; an IP address, or a host of one or two labels, as it is. The
// port does not count.
export function siteOf(origin) {
  const u = new URL(origin);
  const host = u.hostname.replace(/\.$/, "");
  const ip = host.startsWith("[") || /^[0-9]+(\.[0-9]+){3}$/.test(host);
  const labels = host.split(".");
  return u.protocol + "//" + (ip || labels.length <= 2 ? host : labels.slice(-2).join("."));
}

// A frame of getAllFrames that its tab shows: not a page of the
// back/forward cache, and not a document that is going.
const shows = (frame) => !!frame && frame.documentLifecycle !== "cached" && frame.documentLifecycle !== "pending_deletion";

// Calls fn now: {ok, value}, or {ok: false} when it fails or has not
// answered within REMOVAL_WAIT_MS (on the receiver's clock).
function limit(r, fn) {
  let handle;
  const late = new Promise((resolve) => {
    handle = r.clock.setTimer(() => resolve({ ok: false }), REMOVAL_WAIT_MS);
  });
  const done = call(fn).then((value) => ({ ok: true, value }), () => ({ ok: false }));
  return Promise.race([done, late]).finally(() => r.clock.clearTimer(handle));
}

// The one call that removes service workers: of every origin (origins null:
// C5's removal of a set_scopes, and the bound's owed removal) or of the given
// origins, within REMOVAL_WAIT_MS. True when it ended in time; a failure or a
// late end logs one line and gives false.
export async function removeWorkers(r, origins = null) {
  const got = await limit(r, () => r.chrome.browsingData.remove(origins === null ? {} : { origins }, { serviceWorkers: true }));
  if (got.ok) return true;
  const what = origins === null ? "" : ` of ${origins.length} origin(s) that no list covers and no marked tab shows`;
  console.warn(`agentwatch receiver: the service worker removal${what} failed or did not end in time`);
  return false;
}

export class Workers {
  #r; // the Receiver: chrome, clock, map
  #record = new Map(); // origin -> the count (#seq) at its last record
  #seq = 0;
  #chain = Promise.resolve();
  #queued = null; // the check that waits to start, or null
  #learn = false;
  // The bound's owed removal of every worker: now (an evicted origin that no
  // list covered), or when one of these entries leaves the lists.
  #owedNow = false;
  #owedEntries = new Set();
  // The most origins in the record (tests set a lower one).
  max = RECORD_MAX;

  constructor(receiver) {
    this.#r = receiver;
  }

  // The recorded origins (for tests).
  origins() {
    return [...this.#record.keys()];
  }

  // webNavigation.onCommitted of any frame of any tab: its web origin joins
  // the record, and a check follows (the frame's old document went).
  committed(d) {
    if (!d || !Number.isInteger(d.tabId)) return;
    const o = originOf(d.url);
    if (o !== null) this.#add(o);
    this.schedule();
  }

  // webNavigation.onErrorOccurred of any frame of any tab: a navigation that
  // ends on an error page sends no onCommitted, but its tab left the old page.
  errorOccurred(d) {
    if (!d || !Number.isInteger(d.tabId)) return;
    this.schedule();
  }

  // The copy at the worker's start (tabmap.js, its one read): the recorded
  // origins join the record; a key that is no origin leaves the copy. A check
  // follows.
  restored(data) {
    const bad = [];
    let any = false;
    for (const k of Object.keys(data ?? {})) {
      if (!k.startsWith(WORKER_KEY)) continue;
      const o = k.slice(WORKER_KEY.length);
      if (originOf(o) !== o || this.#record.has(o)) {
        if (originOf(o) !== o) bad.push(k);
        continue;
      }
      if (this.#record.size >= this.max) this.#evict();
      this.#record.set(o, 0);
      any = true;
    }
    if (bad.length > 0) void call(() => this.#r.chrome.storage.session.remove(bad)).catch(() => {});
    if (any) this.schedule();
  }

  // A check after an event. learn: run it also with an empty record (a tab
  // that took a mark with its pages: their origins join the record). Gives
  // the check's end.
  schedule({ learn = false } = {}) {
    if (learn) this.#learn = true;
    if (this.#queued) return this.#queued;
    const run = this.#chain.then(() => {
      this.#queued = null;
      return this.#check();
    });
    this.#queued = run;
    this.#chain = run.catch(() => {});
    return this.#chain;
  }

  #lists() {
    const ref = this.#r.map.reference;
    return ref === null ? [] : ref.union();
  }

  #add(o) {
    const known = this.#record.has(o);
    if (!known && this.#record.size >= this.max) this.#evict();
    this.#seq += 1;
    this.#record.set(o, this.#seq);
    if (!known) void call(() => this.#r.chrome.storage.session.set({ [WORKER_KEY + o]: true })).catch(() => {});
  }

  // The bound: the oldest origin that a list covers leaves the record (else
  // the oldest one), and the removal of every worker is owed for it.
  #evict() {
    const lists = this.#lists();
    let victim = null;
    let entries = [];
    for (const [o, n] of this.#record) {
      const by = lists.filter((d) => covers(d, new URL(o).hostname));
      if (by.length === 0) continue;
      if (victim === null || n < this.#record.get(victim)) {
        victim = o;
        entries = by;
      }
    }
    if (victim === null) {
      for (const [o, n] of this.#record) if (victim === null || n < this.#record.get(victim)) victim = o;
      if (victim === null) return;
      this.#owedNow = true;
    }
    for (const e of entries) this.#owedEntries.add(e);
    this.#record.delete(victim);
    void call(() => this.#r.chrome.storage.session.remove([WORKER_KEY + victim])).catch(() => {});
  }

  async #check() {
    const r = this.#r;
    const lists = this.#lists();
    if (this.#owedNow || [...this.#owedEntries].some((e) => !lists.includes(e))) {
      if (await removeWorkers(r, null)) {
        this.#owedNow = false;
        this.#owedEntries.clear();
      }
    }
    if (this.#record.size === 0 && !this.#learn) return;
    this.#learn = false;
    const seq0 = this.#seq;
    const tabs = r.map.marked();
    const reads = await Promise.all(tabs.map((tabId) => limit(r, () => r.chrome.webNavigation.getAllFrames({ tabId }))));
    if (reads.some((x) => !x.ok)) {
      console.warn("agentwatch receiver: the frames of a marked tab could not be read: no service worker removal until the next event");
      return;
    }
    // A tab that got the mark during the reads: its frames are not known yet.
    if (r.map.marked().some((id) => !tabs.includes(id))) {
      this.schedule({ learn: true });
      return;
    }
    // The site rule: the sites of the frames that the marked tabs show.
    const sites = new Set();
    for (const x of reads) {
      for (const frame of Array.isArray(x.value) ? x.value : []) {
        if (!shows(frame)) continue;
        const o = originOf(frame.url);
        if (o === null) continue;
        sites.add(siteOf(o));
        if (!this.#record.has(o)) this.#add(o); // a page of a marked tab that no commit named
      }
    }
    // An origin that a tab committed during the reads counts as shown.
    for (const [o, n] of this.#record) if (n > seq0) sites.add(siteOf(o));
    const now = this.#lists();
    const gone = [...this.#record.keys()].filter((o) => !sites.has(siteOf(o)) && !now.some((d) => covers(d, new URL(o).hostname)));
    if (gone.length === 0) return;
    const seq1 = this.#seq;
    if (!(await removeWorkers(r, gone))) return;
    // An origin that a tab committed during the removal stays recorded.
    const done = gone.filter((o) => this.#record.has(o) && this.#record.get(o) <= seq1);
    for (const o of done) this.#record.delete(o);
    if (done.length > 0) void call(() => r.chrome.storage.session.remove(done.map((o) => WORKER_KEY + o))).catch(() => {});
  }
}
