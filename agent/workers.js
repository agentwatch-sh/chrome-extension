// The service worker removals (contract C5, the worker removal): the one
// bounded call, and the removal of the workers of each recorded origin that no
// list covers and whose site no marked tab shows (board ab-v16.74; the
// operator's answer ab-214: "Remove such a site's worker when your tab leaves
// it"; review-30, review-30b and ab-lead's decisions).
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
//   the last applied set_scopes covers (the lists at the removal, not at the
//   check's start) and whose site no marked tab shows in any frame (the site
//   rule): browsingData.remove({origins}, {serviceWorkers: true}); the
//   origins leave the record. Chrome's origin filter removes the origin's own
//   worker and every partitioned worker whose top-level site is the origin's
//   site, so the site rule keeps the workers that the operator's open pages of
//   that site use. A listed origin stays recorded: the set_scopes that takes it
//   off every list removes it.
// - The site: the scheme and the last two labels of the host (an IP address
//   or a host of one or two labels as it is). The receiver has no public
//   suffix list, so this is the registrable domain or wider (two labels under
//   a public suffix of two labels, such as co.uk): the rule keeps more
//   workers, never fewer.
// - The events of a check: each commit and each navigation error of a frame
//   of any tab, a marked tab's close or replace, a tab that loses the mark or
//   gets it at tabs.onCreated or tabs.onReplaced, each set_scopes (after its
//   answer), the worker's start (no tab is marked then: the marks have no
//   copy), and the follow-up check RECHECK_MS after a removal (a page can
//   register its worker after the check of its own commit). One check runs at
//   a time; the events while one runs start one more after it.
// - The limits: each frame read and each removal has REMOVAL_WAIT_MS. A read
//   that fails or comes late removes nothing (a shown origin could break the
//   operator's open page); a removal that fails or comes late keeps its
//   origins. Each logs one line (no origin), and the next event's check tries
//   again.
// - The bound (review-30b B1; ab-lead's decision: no page content can make
//   the receiver remove a worker of a site that a marked tab shows, or of an
//   origin that a list covers while that list is in force). At RECORD_MAX a
//   new origin evicts the oldest recorded origin that no list covers and whose
//   site no marked tab shows, else the oldest listed origin whose site no
//   marked tab shows. It never evicts an origin whose site a marked tab shows.
//   An evicted origin, and a new origin that finds no room, get their own
//   check at the next check: the workers go unless a list covers the origin
//   or a marked tab shows its site. A listed one keeps its list entries: at
//   the end of one of them, one removal of every worker that excludes the
//   origins that the marked tabs show, the origins of their sites and the
//   listed origins of the record. A new origin of a shown site that finds no
//   room is not recorded (the residue). A removal of every worker comes only
//   from a list's end.
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
// The follow-up check after a removal.
export const RECHECK_MS = 5000;
// The most origins that wait for their own removal or for the follow-up
// check (memory only; each check takes them).
export const PENDING_MAX = 10 * RECORD_MAX;

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

// The list entries that cover an origin's host.
const entriesFor = (origin, lists) => {
  const host = new URL(origin).hostname;
  return lists.filter((d) => covers(d, host));
};

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

// The one call that removes service workers, within REMOVAL_WAIT_MS: of the
// given origins; or (origins null) of every origin: C5's removal of a
// set_scopes, and, with keep, the removal at a list's end that excludes those
// origins (excludeOrigins). True when it ended in time; a failure or a late
// end logs one line and gives false.
export async function removeWorkers(r, origins = null, keep = null) {
  const filter = origins !== null ? { origins } : keep && keep.length > 0 ? { excludeOrigins: keep } : {};
  const got = await limit(r, () => r.chrome.browsingData.remove(filter, { serviceWorkers: true }));
  if (got.ok) return true;
  const what = origins !== null ? ` of ${origins.length} origin(s) that no list covers and no marked tab shows` : keep ? " of every worker at a list's end" : "";
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
  // The sites that the marked tabs show: the last frame read, and the marked
  // tabs' commits since (a stale site only keeps an origin longer).
  #shown = new Set();
  // Origins out of the record that get their own removal at the next check
  // (the bound evicted them; no list covered them, no marked tab showed their site).
  #evicted = new Set();
  // The list entries of listed origins that the bound evicted or could not
  // record: at the end of one of them, one removal of every worker that keeps
  // the shown origins and the listed origins of the record.
  #listedGone = new Set();
  // The origins that a check removed: the follow-up check removes them again.
  #recheck = new Set();
  #recheckDue = false;
  #timer = null;
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
    if (o !== null) {
      if (this.#r.map.isMarked(d.tabId)) this.#shown.add(siteOf(o));
      this.#add(o);
    }
    this.schedule();
  }

  // webNavigation.onErrorOccurred of any frame of any tab: a navigation that
  // ends on an error page sends no onCommitted, but its tab left the old page.
  errorOccurred(d) {
    if (!d || !Number.isInteger(d.tabId)) return;
    this.schedule();
  }

  // The copy at the worker's start (tabmap.js, its one read): the recorded
  // origins join the record (beyond the bound, their own removal at the next
  // check); a key that is no origin leaves the copy. A check follows.
  restored(data) {
    const bad = [];
    let any = false;
    for (const k of Object.keys(data ?? {})) {
      if (!k.startsWith(WORKER_KEY)) continue;
      const o = k.slice(WORKER_KEY.length);
      if (originOf(o) !== o) {
        bad.push(k);
        continue;
      }
      if (this.#record.has(o)) continue;
      if (this.#record.size < this.max) this.#record.set(o, 0);
      else if (this.#evicted.size < PENDING_MAX) this.#evicted.add(o);
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
    if (!known && this.#record.size >= this.max && !this.#makeRoom(o)) return;
    this.#seq += 1;
    this.#record.set(o, this.#seq);
    if (!known) void call(() => this.#r.chrome.storage.session.set({ [WORKER_KEY + o]: true })).catch(() => {});
  }

  // The bound: makes room for o, or keeps it out of the record. Never evicts
  // an origin whose site a marked tab shows. True when o may join the record.
  #makeRoom(o) {
    const lists = this.#lists();
    let free = null; // the oldest origin on no list and of no shown site
    let listed = null; // the oldest listed origin of no shown site
    for (const [x, n] of this.#record) {
      if (this.#shown.has(siteOf(x))) continue;
      if (entriesFor(x, lists).length === 0) {
        if (free === null || n < this.#record.get(free)) free = x;
      } else if (listed === null || n < this.#record.get(listed)) {
        listed = x;
      }
    }
    const victim = free ?? listed;
    if (victim !== null) {
      this.#record.delete(victim);
      void call(() => this.#r.chrome.storage.session.remove([WORKER_KEY + victim])).catch(() => {});
      this.#outside(victim);
      return true;
    }
    this.#outside(o);
    return false;
  }

  // An origin outside the record gets its own check at once (the next
  // check): its workers go unless a list covers it (then its list entries are
  // kept for its list's end) or a marked tab shows its site. One of a shown
  // site is not kept (the residue).
  #outside(o) {
    if (this.#shown.has(siteOf(o)) || this.#evicted.size >= PENDING_MAX) return;
    this.#evicted.add(o);
    this.schedule();
  }

  // The follow-up check, RECHECK_MS after a removal (one timer at a time).
  #armRecheck() {
    if (this.#timer !== null) return;
    this.#timer = this.#r.clock.setTimer(() => {
      this.#timer = null;
      this.#recheckDue = true;
      void this.schedule();
    }, RECHECK_MS);
    // In Node (the tests) a real timer must not hold the process; Chrome's has no unref.
    if (this.#timer && typeof this.#timer.unref === "function") this.#timer.unref();
  }

  async #check() {
    const r = this.#r;
    const recheck = this.#recheckDue;
    this.#recheckDue = false;
    const idle = this.#record.size === 0 && this.#evicted.size === 0 && this.#listedGone.size === 0 && !(recheck && this.#recheck.size > 0);
    if (idle && !this.#learn) return;
    this.#learn = false;
    const seq0 = this.#seq;
    const tabs = r.map.marked();
    const reads = await Promise.all(tabs.map((tabId) => limit(r, () => r.chrome.webNavigation.getAllFrames({ tabId }))));
    if (reads.some((x) => !x.ok)) {
      if (recheck) this.#recheckDue = true;
      console.warn("agentwatch receiver: the frames of a marked tab could not be read: no service worker removal until the next event");
      return;
    }
    // A tab that got the mark during the reads: its frames are not known yet.
    if (r.map.marked().some((id) => !tabs.includes(id))) {
      if (recheck) this.#recheckDue = true;
      this.schedule({ learn: true });
      return;
    }
    // The site rule: the sites of the frames that the marked tabs show.
    const sites = new Set();
    const seen = new Set();
    for (const x of reads) {
      for (const frame of Array.isArray(x.value) ? x.value : []) {
        if (!shows(frame)) continue;
        const o = originOf(frame.url);
        if (o === null) continue;
        sites.add(siteOf(o));
        seen.add(o);
      }
    }
    // An origin that a tab committed during the reads counts as shown.
    for (const [o, n] of this.#record) if (n > seq0) sites.add(siteOf(o));
    this.#shown = new Set(sites);
    for (const o of seen) if (!this.#record.has(o)) this.#add(o); // a page of a marked tab that no commit named
    const now = this.#lists();
    const covered = (o) => entriesFor(o, now).length > 0;
    // A list's end after the bound kept a listed origin out of the record:
    // one removal of every worker that keeps the shown origins, the origins
    // of the shown sites and the listed origins of the record.
    let all = false;
    if ([...this.#listedGone].some((e) => !now.includes(e))) {
      const keep = new Set(seen);
      for (const o of this.#record.keys()) if (sites.has(siteOf(o)) || covered(o)) keep.add(o);
      all = await removeWorkers(r, null, [...keep].sort());
      if (all) this.#listedGone.clear();
    }
    const second = recheck ? new Set(this.#recheck) : new Set();
    const candidates = new Set([...this.#record.keys(), ...this.#evicted, ...second]);
    const gone = [...candidates].filter((o) => !sites.has(siteOf(o)) && !covered(o));
    // An evicted origin or one of the follow-up that is shown or listed now
    // stays: a listed one keeps its entries for its list's end.
    for (const o of [...this.#evicted, ...second]) {
      if (gone.includes(o)) continue;
      this.#evicted.delete(o);
      this.#recheck.delete(o);
      if (!this.#record.has(o)) for (const e of entriesFor(o, now)) this.#listedGone.add(e);
    }
    if (gone.length === 0) return;
    const seq1 = this.#seq;
    if (!all && !(await removeWorkers(r, gone))) {
      if (recheck) this.#recheckDue = true;
      return;
    }
    // An origin that a tab committed during the removal stays recorded.
    const done = gone.filter((o) => !this.#record.has(o) || this.#record.get(o) <= seq1);
    const keys = done.filter((o) => this.#record.has(o)).map((o) => WORKER_KEY + o);
    for (const o of done) {
      this.#record.delete(o);
      this.#evicted.delete(o);
      // The follow-up check: once for each removal (a page can register its
      // worker after the check of its own commit).
      if (second.has(o)) {
        this.#recheck.delete(o);
      } else if (this.#recheck.size < PENDING_MAX) {
        this.#recheck.add(o);
        this.#armRecheck();
      }
    }
    if (keys.length > 0) void call(() => r.chrome.storage.session.remove(keys)).catch(() => {});
  }
}
