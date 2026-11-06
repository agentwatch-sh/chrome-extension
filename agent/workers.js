// The service worker removals (contract C5, the worker removal): the one
// bounded call, and the removal of the workers of each recorded origin that no
// list covers and whose site no marked tab shows (board ab-v16.74; the
// operator's answer ab-214: "Remove such a site's worker when your tab leaves
// it"; review-30, -30b, -30c, -30d and ab-lead's decisions).
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
// - The check: the receiver reads the frames of the marked tabs
//   (webNavigation.getAllFrames; a page in the back/forward cache or one that
//   is going shows nothing) and keeps the last read of each tab: it reads a
//   tab again only after an event of its frames (the version is taken before
//   the read). The shown sites are those of these reads and of the marked
//   tabs' commits during the running check, never the record's. It removes
//   the workers of each recorded or waiting origin that no list of the last
//   applied set_scopes covers and whose site no marked tab shows in any frame
//   (the site rule): browsingData.remove({origins}, {serviceWorkers: true}),
//   in calls of at most SLICE origins; the origins leave the record. Chrome's
//   origin filter removes the origin's own worker and every partitioned worker
//   whose top-level site is the origin's site, so the site rule keeps the
//   workers that the operator's open pages of that site use. A listed origin
//   stays: the set_scopes that takes it off every list removes it.
// - The site: the scheme and the last two labels of the host (an IP address
//   or a host of one or two labels as it is). The receiver has no public
//   suffix list, so this is the registrable domain or wider (two labels under
//   a public suffix of two labels, such as co.uk): the rule keeps more
//   workers, never fewer.
// - The events of a check: each commit and each navigation error of a frame
//   of any tab, a marked tab's close or replace, a tab that loses the mark or
//   gets it at tabs.onCreated or tabs.onReplaced, each set_scopes (after its
//   answer), the worker's start (no tab is marked then: the marks have no
//   copy), and the follow-up check after a removal (a page can register its
//   worker after the check of its own commit; one timer at a time). One check
//   runs at a time; the events while one runs start one more after it.
// - The limits: each frame read and each removal has REMOVAL_WAIT_MS. A read
//   that fails or comes late removes nothing (a shown origin could break the
//   operator's open page); a removal that fails or comes late keeps its
//   origins. Each logs one line (no origin), and the next event's check tries
//   again. Every loop of a check pauses (one task) after SLICE items, so
//   Chrome's queued events (the guard's) run between its parts.
// - The bound (ab-lead's decisions after review-30b and review-30d: no page
//   content can make the receiver remove a worker of a site that a marked tab
//   shows, or of an origin that a list covers while that list is in force; a
//   simple bound): at RECORD_MAX the record refuses a new origin, and never
//   evicts one. A refused origin waits in memory (the pending set, at most
//   pendingMax) with the record's rules. Beyond that, a listed origin keeps
//   its list entries: at the end of one of them, one removal of every worker
//   that excludes the origins that the marked tabs show, the origins of their
//   sites and the listed origins; an origin on no list is the residue. A
//   removal of every worker comes only from a list's end.
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

// One parse of an origin: its host and its site (cached with the origin).
function infoOf(origin) {
  return { host: new URL(origin).hostname, site: siteOf(origin) };
}

// A pause that lets Chrome's queued events (the guard's) run.
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
// The items that a check handles between two pauses, and the most origins of one removal call.
export const SLICE = 500;

export class Workers {
  #r; // the Receiver: chrome, clock, map
  // The record: origin -> {seq, host, site, cov, covVer}; at most max, with
  // its copy in chrome.storage.session.
  #record = new Map();
  // The origins that the full record refused (the same entries), in memory
  // only, at most pendingMax: each check handles them with the same rules.
  #pending = new Map();
  #seq = 0;
  #chain = Promise.resolve();
  #queued = null; // the check that waits to start, or null
  #learn = false;
  // The lists of the last applied set_scopes, cached with a version.
  #listsRef = undefined;
  #lists = [];
  #listsVer = 0;
  // The list entries of listed origins that the full pending set dropped: at
  // the end of one of them, one removal of every worker that keeps the shown
  // origins and the listed origins.
  #listedGone = new Set();
  // The last frame read of each marked tab: tabId -> {ver, origins (origin ->
  // info), sites}. A check reads a marked tab's frames again only after an
  // event of its frames (a commit or a navigation error: #ver) or for a tab
  // with no read; the other events of a check reuse the read. The version is
  // taken before the read, so an event during the read makes the read old.
  #frames = new Map();
  #ver = new Map(); // tabId -> the count of the events of its frames
  // The sites of the marked tabs' commits since the start of the running
  // check (null between checks): they count as shown in that check.
  #recent = null;
  // The follow-up checks: one timer at a time. An origin that a removal
  // removed waits one whole period of the timer (RECHECK_MS), then it is due.
  #due = new Set();
  #waiting = new Set(); // its period runs: due at the next tick
  #next = new Set(); // its period starts at the next tick
  #timer = null;
  // The most origins in the record and in the pending set (tests set lower ones).
  max = RECORD_MAX;
  pendingMax = PENDING_MAX;
  // The work counts (for tests): work, the items that the checks handle;
  // room, the origins that the full record refused.
  stats = { work: 0, room: 0 };

  constructor(receiver) {
    this.#r = receiver;
  }

  // The recorded origins (for tests).
  origins() {
    return [...this.#record.keys()];
  }

  // webNavigation.onCommitted of any frame of any tab: its web origin joins
  // the record (or, with the record full, the pending set), and a check
  // follows (the frame's old document went). A marked tab's commit counts as
  // shown in a check that runs.
  committed(d) {
    if (!d || !Number.isInteger(d.tabId)) return;
    this.#touch(d.tabId);
    const o = originOf(d.url);
    if (o !== null) {
      const info = this.#record.get(o) ?? this.#pending.get(o) ?? infoOf(o);
      if (this.#recent !== null && this.#r.map.isMarked(d.tabId)) this.#recent.add(info.site);
      this.#add(o, info);
    }
    this.schedule();
  }

  // webNavigation.onErrorOccurred of any frame of any tab: a navigation that
  // ends on an error page sends no onCommitted, but its tab left the old page.
  errorOccurred(d) {
    if (!d || !Number.isInteger(d.tabId)) return;
    this.#touch(d.tabId);
    this.schedule();
  }

  // An event of a marked tab's frames: the next check reads them again.
  #touch(tabId) {
    if (this.#r.map.isMarked(tabId)) this.#ver.set(tabId, (this.#ver.get(tabId) ?? 0) + 1);
  }

  // The copy at the worker's start (tabmap.js, its one read): the recorded
  // origins join the record (beyond the bound, the pending set, and their
  // keys leave the copy); a key that is no origin leaves the copy. A check
  // follows.
  restored(data) {
    const drop = [];
    let any = false;
    for (const k of Object.keys(data ?? {})) {
      if (!k.startsWith(WORKER_KEY)) continue;
      const o = k.slice(WORKER_KEY.length);
      if (originOf(o) !== o) {
        drop.push(k);
        continue;
      }
      if (this.#record.has(o) || this.#pending.has(o)) continue;
      any = true;
      if (this.#record.size < this.max) {
        this.#record.set(o, this.#entry(infoOf(o), 0));
        continue;
      }
      drop.push(k);
      if (this.#pending.size < this.pendingMax) this.#pending.set(o, this.#entry(infoOf(o), 0));
    }
    if (drop.length > 0) void call(() => this.#r.chrome.storage.session.remove(drop)).catch(() => {});
    if (any) this.schedule();
  }

  // A check after an event. learn: run it also with nothing recorded (a tab
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

  // ---- the lists ----

  #listsNow() {
    const ref = this.#r.map.reference;
    if (ref !== this.#listsRef) {
      this.#listsRef = ref;
      this.#lists = ref === null || ref === undefined ? [] : ref.union();
      this.#listsVer += 1;
    }
    return this.#lists;
  }

  // A list covers the entry's host (cached on the entry until the lists change).
  #covered(e) {
    const lists = this.#listsNow();
    if (e.covVer !== this.#listsVer) {
      e.cov = lists.some((d) => covers(d, e.host));
      e.covVer = this.#listsVer;
    }
    return e.cov;
  }

  // ---- the record and the bound ----

  #entry(info, seq) {
    return { seq, host: info.host, site: info.site, cov: false, covVer: -1 };
  }

  // The bound, in one step: the full record refuses a new origin (it never
  // evicts one); the origin waits in the pending set, and beyond that bound
  // a listed one keeps its list entries for its list's end (an origin on no
  // list is then the residue).
  #add(o, info) {
    this.#seq += 1;
    const e = this.#record.get(o) ?? this.#pending.get(o);
    if (e) {
      e.seq = this.#seq;
      return;
    }
    if (this.#record.size < this.max) {
      this.#record.set(o, this.#entry(info, this.#seq));
      void call(() => this.#r.chrome.storage.session.set({ [WORKER_KEY + o]: true })).catch(() => {});
      return;
    }
    this.stats.room += 1;
    const ne = this.#entry(info, this.#seq);
    if (this.#pending.size < this.pendingMax) {
      this.#pending.set(o, ne);
      return;
    }
    if (this.#covered(ne)) for (const d of this.#listsNow()) if (covers(d, ne.host)) this.#listedGone.add(d);
  }

  // ---- the follow-up checks ----

  // The origins of one removal: due after one whole period of the timer.
  #followUp(origins) {
    if (this.#timer === null) {
      for (const o of origins) if (this.#waiting.size < this.pendingMax) this.#waiting.add(o);
      this.#arm();
    } else {
      for (const o of origins) if (this.#next.size < this.pendingMax) this.#next.add(o);
    }
  }

  #arm() {
    this.#timer = this.#r.clock.setTimer(() => {
      this.#timer = null;
      for (const o of this.#waiting) if (this.#due.size < this.pendingMax) this.#due.add(o);
      this.#waiting = this.#next;
      this.#next = new Set();
      if (this.#waiting.size > 0) this.#arm();
      void this.schedule();
    }, RECHECK_MS);
    // In Node (the tests) a real timer must not hold the process; Chrome's has no unref.
    if (this.#timer && typeof this.#timer.unref === "function") this.#timer.unref();
  }

  // ---- the check ----

  async #check() {
    const recent = new Set();
    this.#recent = recent;
    try {
      await this.#run(recent);
    } finally {
      this.#recent = null;
    }
  }

  async #run(recent) {
    const r = this.#r;
    const second = this.#due;
    this.#due = new Set();
    const keepDue = () => {
      for (const o of second) this.#due.add(o);
    };
    const idle = this.#record.size === 0 && this.#pending.size === 0 && this.#listedGone.size === 0 && second.size === 0;
    if (idle && !this.#learn) return;
    this.#learn = false;
    let n = 0;
    const step = async () => {
      this.stats.work += 1;
      if (++n % SLICE === 0) await pause();
    };
    const tabs = r.map.marked();
    // The reads of the marked tabs: only of a tab with an event of its frames
    // since its last read, or with no read; a tab that is not marked any more
    // leaves the cache. The version is taken before the read.
    for (const id of [...this.#frames.keys()]) if (!tabs.includes(id)) this.#frames.delete(id);
    for (const id of [...this.#ver.keys()]) if (!tabs.includes(id)) this.#ver.delete(id);
    const stale = tabs.filter((id) => {
      const c = this.#frames.get(id);
      return !c || c.ver !== (this.#ver.get(id) ?? 0);
    });
    const vers = stale.map((id) => this.#ver.get(id) ?? 0);
    const reads = await Promise.all(stale.map((tabId) => limit(r, () => r.chrome.webNavigation.getAllFrames({ tabId }))));
    if (reads.some((x) => !x.ok)) {
      keepDue();
      console.warn("agentwatch receiver: the frames of a marked tab could not be read: no service worker removal until the next event");
      return;
    }
    // A tab that got the mark during the reads: its frames are not known yet.
    if (r.map.marked().some((id) => !tabs.includes(id))) {
      keepDue();
      this.schedule({ learn: true });
      return;
    }
    // Each new read: the origins and the sites of the frames that the tab
    // shows (one parse per frame).
    const fresh = new Map(); // origin -> info: the origins of the new reads
    for (let i = 0; i < stale.length; i++) {
      const origins = new Map();
      const tabSites = new Set();
      for (const frame of Array.isArray(reads[i].value) ? reads[i].value : []) {
        await step();
        if (!shows(frame)) continue;
        const o = originOf(frame.url);
        if (o === null) continue;
        if (!origins.has(o)) {
          const known = this.#record.get(o) ?? this.#pending.get(o) ?? fresh.get(o);
          const info = known ? { host: known.host, site: known.site } : infoOf(o);
          origins.set(o, info);
          fresh.set(o, info);
        }
        tabSites.add(origins.get(o).site);
      }
      this.#frames.set(stale[i], { ver: vers[i], origins, sites: tabSites });
    }
    // A page of a marked tab that no commit named joins the record (or the
    // pending set; a refused origin is tried again in one step).
    for (const [o, info] of fresh) {
      await step();
      if (!this.#record.has(o) && !this.#pending.has(o)) this.#add(o, info);
    }
    // The site rule: the sites that the marked tabs show (their last reads,
    // and their commits during this check).
    const sites = new Set(recent);
    for (const id of tabs) {
      const c = this.#frames.get(id);
      if (c) for (const x of c.sites) sites.add(x);
    }
    const listsVer = (this.#listsNow(), this.#listsVer);
    const now = this.#lists;
    // A list's end after the pending set dropped a listed origin: one removal
    // of every worker that keeps the shown origins, the origins of the shown
    // sites and the listed origins (of the record and of the pending set).
    let all = false;
    if ([...this.#listedGone].some((d) => !now.includes(d))) {
      const keep = new Set();
      for (const id of tabs) {
        const c = this.#frames.get(id);
        if (c) for (const o of c.origins.keys()) keep.add(o);
      }
      for (const [o, e] of [...this.#record, ...this.#pending]) {
        await step();
        if (sites.has(e.site) || recent.has(e.site) || this.#covered(e)) keep.add(o);
      }
      all = await removeWorkers(r, null, [...keep].sort());
      if (all) this.#listedGone.clear();
    }
    // The origins to remove: of the record, of the pending set and of the
    // follow-ups (each with its entry).
    const gone = new Map();
    for (const [o, e] of [...this.#record, ...this.#pending]) {
      await step();
      if (!sites.has(e.site) && !this.#covered(e)) gone.set(o, e);
    }
    for (const o of second) {
      await step();
      if (gone.has(o) || this.#record.has(o) || this.#pending.has(o)) continue;
      const e = this.#entry(infoOf(o), 0);
      if (!sites.has(e.site) && !this.#covered(e)) gone.set(o, e);
    }
    // The lists changed during the loops: the set_scopes's own check decides.
    if (this.#listsNow() !== now || this.#listsVer !== listsVer) {
      keepDue();
      return;
    }
    // The removals, in parts of at most SLICE origins (each call lets the
    // queued events run). The last filter of each part, with no pause before
    // its call: the marked tabs' commits during the check count as shown.
    const list = [...gone.keys()];
    const keys = [];
    for (let i = 0; i < list.length; i += SLICE) {
      const part = list.slice(i, i + SLICE).filter((o) => !recent.has(gone.get(o).site));
      if (part.length === 0) continue;
      const seq1 = this.#seq;
      if (!all && !(await removeWorkers(r, part))) {
        keepDue();
        break;
      }
      // An origin that a tab committed during the removal stays.
      const followUp = [];
      for (const o of part) {
        const e = this.#record.get(o) ?? this.#pending.get(o);
        if (e && e.seq > seq1) continue;
        if (this.#record.delete(o)) keys.push(WORKER_KEY + o);
        this.#pending.delete(o);
        // The follow-up check, once for each removal (a page can register its
        // worker after the check of its own commit).
        if (!second.has(o)) followUp.push(o);
      }
      if (followUp.length > 0) this.#followUp(followUp);
    }
    if (keys.length > 0) void call(() => r.chrome.storage.session.remove(keys)).catch(() => {});
  }
}
