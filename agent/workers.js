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
// The items that a check handles between two pauses.
const SLICE = 1000;

export class Workers {
  #r; // the Receiver: chrome, clock, map
  // The record: origin -> {seq, host, site, cls, cov, covVer}, oldest first
  // (a new record of an origin moves it to the end).
  #record = new Map();
  // The record by class, each oldest first: free (no list covers it, no
  // marked tab shows its site), listed (a list covers it, no marked tab shows
  // its site), held (a marked tab shows its site: the bound never evicts it).
  #cls = { free: new Map(), listed: new Map(), held: new Map() };
  #bySite = new Map(); // site -> the recorded origins of that site
  #seq = 0;
  #chain = Promise.resolve();
  #queued = null; // the check that waits to start, or null
  #learn = false;
  // The sites that the marked tabs show: the last frame read, and the marked
  // tabs' commits since (a stale site only keeps an origin longer).
  #shown = new Set();
  // The lists of the last applied set_scopes, cached with a version.
  #listsRef = undefined;
  #lists = [];
  #listsVer = 0;
  // Origins out of the record that get their own check at the next check
  // (origin -> its info): the bound evicted them, or found no room for them.
  #evicted = new Map();
  // The list entries of listed origins that the bound evicted or could not
  // record: at the end of one of them, one removal of every worker that keeps
  // the shown origins and the listed origins of the record.
  #listedGone = new Set();
  // The origins whose follow-up check is due (each removal's timer adds its own).
  #due = new Set();
  // The last frame read of each marked tab: tabId -> {ver, origins (origin ->
  // info), sites}. A check reads a marked tab's frames again only after an
  // event of its frames (a commit or a navigation error: #ver) or for a tab
  // with no read; the other events of a check reuse the read. A frame that
  // goes with no event keeps its site shown until the tab's next event.
  #frames = new Map();
  #ver = new Map(); // tabId -> the count of the events of its frames
  // The most origins in the record (tests set a lower one).
  max = RECORD_MAX;
  // The work counts (for tests): work, the items that the checks and the
  // bound handle; room, the calls of the bound.
  stats = { work: 0, room: 0 };

  constructor(receiver) {
    this.#r = receiver;
  }

  // The recorded origins (for tests).
  origins() {
    return [...this.#record.keys()];
  }

  // webNavigation.onCommitted of any frame of any tab: its web origin joins
  // the record, and a check follows (the frame's old document went). A
  // marked tab's commit makes its site shown at once.
  committed(d) {
    if (!d || !Number.isInteger(d.tabId)) return;
    this.#touch(d.tabId);
    const o = originOf(d.url);
    if (o !== null) {
      const info = this.#record.get(o) ?? infoOf(o);
      if (this.#r.map.isMarked(d.tabId)) this.#show(info.site);
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
  // origins join the record (beyond the bound, their own check at the next
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
      if (this.#record.size < this.max) this.#insert(o, infoOf(o), 0);
      else if (this.#evicted.size < PENDING_MAX) this.#evicted.set(o, infoOf(o));
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

  // ---- the lists, the classes ----

  #listsNow() {
    const ref = this.#r.map.reference;
    if (ref !== this.#listsRef) {
      this.#listsRef = ref;
      this.#lists = ref === null || ref === undefined ? [] : ref.union();
      this.#listsVer += 1;
    }
    return this.#lists;
  }

  // A list covers this host (cached on a record entry until the lists change).
  #covered(e) {
    const lists = this.#listsNow();
    if (e.covVer !== this.#listsVer) {
      e.cov = lists.some((d) => covers(d, e.host));
      e.covVer = this.#listsVer;
    }
    return e.cov;
  }

  #classOf(e) {
    if (this.#shown.has(e.site)) return "held";
    return this.#covered(e) ? "listed" : "free";
  }

  #place(o, e, cls) {
    if (e.cls) this.#cls[e.cls].delete(o);
    e.cls = cls;
    this.#cls[cls].set(o, true);
  }

  // A marked tab shows site: its recorded origins are held.
  #show(site) {
    if (this.#shown.has(site)) return;
    this.#shown.add(site);
    for (const o of this.#bySite.get(site) ?? []) this.#place(o, this.#record.get(o), "held");
  }

  // ---- the record and the bound ----

  #insert(o, info, seq) {
    const e = { seq, host: info.host, site: info.site, cls: null, cov: false, covVer: -1 };
    this.#record.set(o, e);
    if (!this.#bySite.has(e.site)) this.#bySite.set(e.site, new Set());
    this.#bySite.get(e.site).add(o);
    this.#place(o, e, this.#classOf(e));
    return e;
  }

  #drop(o) {
    const e = this.#record.get(o);
    if (!e) return;
    this.#record.delete(o);
    this.#cls[e.cls].delete(o);
    const same = this.#bySite.get(e.site);
    same.delete(o);
    if (same.size === 0) this.#bySite.delete(e.site);
  }

  #add(o, info) {
    this.#seq += 1;
    const e = this.#record.get(o);
    if (e) {
      // A new record moves it to the end (the newest), in the record and in its class.
      e.seq = this.#seq;
      this.#record.delete(o);
      this.#record.set(o, e);
      this.#place(o, e, e.cls);
      return;
    }
    if (this.#record.size >= this.max && !this.#makeRoom(o, info)) return;
    this.#insert(o, info, this.#seq);
    void call(() => this.#r.chrome.storage.session.set({ [WORKER_KEY + o]: true })).catch(() => {});
  }

  // The bound, in one step: the oldest free origin, else the oldest listed
  // one, leaves the record and gets its own check; with neither, o gets it.
  // Never an origin whose site a marked tab shows. True when o may join.
  #makeRoom(o, info) {
    this.stats.room += 1;
    const first = (m) => m.keys().next().value;
    const victim = first(this.#cls.free) ?? first(this.#cls.listed);
    if (victim !== undefined) {
      const e = this.#record.get(victim);
      this.#drop(victim);
      void call(() => this.#r.chrome.storage.session.remove([WORKER_KEY + victim])).catch(() => {});
      this.#outside(victim, e);
      return true;
    }
    this.#outside(o, info);
    return false;
  }

  // An origin outside the record gets its own check at once (the next
  // check): its workers go unless a list covers it (then its list entries are
  // kept for its list's end) or a marked tab shows its site. One of a shown
  // site is not kept (the residue).
  #outside(o, info) {
    if (this.#shown.has(info.site) || this.#evicted.size >= PENDING_MAX) return;
    this.#evicted.set(o, { host: info.host, site: info.site });
    this.schedule();
  }

  // The follow-up check of one removal, RECHECK_MS after it.
  #armRecheck(origins) {
    const handle = this.#r.clock.setTimer(() => {
      for (const o of origins) if (this.#due.size < PENDING_MAX) this.#due.add(o);
      void this.schedule();
    }, RECHECK_MS);
    // In Node (the tests) a real timer must not hold the process; Chrome's has no unref.
    if (handle && typeof handle.unref === "function") handle.unref();
  }

  // ---- the check ----

  async #check() {
    const r = this.#r;
    const second = this.#due;
    this.#due = new Set();
    const keepDue = () => {
      for (const o of second) this.#due.add(o);
    };
    const idle = this.#record.size === 0 && this.#evicted.size === 0 && this.#listedGone.size === 0 && second.size === 0;
    if (idle && !this.#learn) return;
    this.#learn = false;
    const seq0 = this.#seq;
    const tabs = r.map.marked();
    // The reads of the marked tabs: only of a tab with an event of its frames
    // since its last read, or with no read; a tab that is not marked any more
    // leaves the cache.
    for (const id of [...this.#frames.keys()]) {
      if (tabs.includes(id)) continue;
      this.#frames.delete(id);
      this.#ver.delete(id);
    }
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
    // shows (one parse per frame), with a pause after each SLICE frames.
    const fresh = new Map(); // origin -> info: the origins of the new reads
    let n = 0;
    for (let i = 0; i < stale.length; i++) {
      const origins = new Map();
      const tabSites = new Set();
      for (const frame of Array.isArray(reads[i].value) ? reads[i].value : []) {
        this.stats.work += 1;
        if (++n % SLICE === 0) await pause();
        if (!shows(frame)) continue;
        const o = originOf(frame.url);
        if (o === null) continue;
        let info = origins.get(o);
        if (!info) {
          info = this.#record.get(o) ?? infoOf(o);
          origins.set(o, { host: info.host, site: info.site });
          fresh.set(o, info);
        }
        tabSites.add(info.site);
      }
      this.#frames.set(stale[i], { ver: vers[i], origins, sites: tabSites });
    }
    // The site rule: the sites that the marked tabs show (their last reads).
    const sites = new Set();
    for (const id of tabs) {
      const c = this.#frames.get(id);
      if (c) for (const x of c.sites) sites.add(x);
    }
    // An origin that a tab committed during the reads counts as shown.
    for (const [, e] of this.#record) {
      this.stats.work += 1;
      if (e.seq > seq0) sites.add(e.site);
    }
    // The shown sites of this read; the classes again from the record (oldest first).
    this.#shown = sites;
    for (const m of Object.values(this.#cls)) m.clear();
    for (const [o, e] of this.#record) {
      this.stats.work += 1;
      e.cls = null;
      this.#place(o, e, this.#classOf(e));
    }
    // A page of a marked tab that no commit named joins the record (the bound
    // refuses an origin in one step).
    n = 0;
    for (const [o, info] of fresh) {
      this.stats.work += 1;
      if (++n % SLICE === 0) await pause();
      if (!this.#record.has(o)) this.#add(o, info);
    }
    const now = this.#listsNow();
    const coveredInfo = (info) => now.some((d) => covers(d, info.host));
    // A list's end after the bound kept a listed origin out of the record:
    // one removal of every worker that keeps the shown origins, the origins
    // of the shown sites and the listed origins of the record.
    let all = false;
    if ([...this.#listedGone].some((e) => !now.includes(e))) {
      const keep = new Set();
      for (const id of tabs) {
        const c = this.#frames.get(id);
        if (c) for (const o of c.origins.keys()) keep.add(o);
      }
      for (const [o, e] of this.#record) {
        this.stats.work += 1;
        if (sites.has(e.site) || this.#covered(e)) keep.add(o);
      }
      all = await removeWorkers(r, null, [...keep].sort());
      if (all) this.#listedGone.clear();
    }
    // The origins to remove: of the record, the own checks and the follow-ups.
    const gone = new Set();
    for (const [o, e] of this.#record) {
      this.stats.work += 1;
      if (!sites.has(e.site) && !this.#covered(e)) gone.add(o);
    }
    for (const [o, info] of this.#evicted) {
      this.stats.work += 1;
      if (this.#record.has(o)) {
        this.#evicted.delete(o);
        continue;
      }
      if (!sites.has(info.site) && !coveredInfo(info)) {
        gone.add(o);
        continue;
      }
      // Shown or listed now: it stays; a listed one keeps its entries for its list's end.
      this.#evicted.delete(o);
      if (coveredInfo(info)) for (const d of now) if (covers(d, info.host)) this.#listedGone.add(d);
    }
    for (const o of second) {
      this.stats.work += 1;
      if (gone.has(o) || this.#record.has(o)) continue;
      const info = infoOf(o);
      if (!sites.has(info.site) && !coveredInfo(info)) gone.add(o);
      else if (coveredInfo(info)) for (const d of now) if (covers(d, info.host)) this.#listedGone.add(d);
    }
    if (gone.size === 0) return;
    const seq1 = this.#seq;
    const list = [...gone];
    if (!all && !(await removeWorkers(r, list))) {
      keepDue();
      return;
    }
    // An origin that a tab committed during the removal stays recorded.
    const keys = [];
    const followUp = [];
    for (const o of list) {
      const e = this.#record.get(o);
      if (e && e.seq > seq1) continue;
      if (e) {
        this.#drop(o);
        keys.push(WORKER_KEY + o);
      }
      this.#evicted.delete(o);
      // The follow-up check, once for each removal (a page can register its
      // worker after the check of its own commit).
      if (!second.has(o)) followUp.push(o);
    }
    if (followUp.length > 0) this.#armRecheck(followUp);
    if (keys.length > 0) void call(() => r.chrome.storage.session.remove(keys)).catch(() => {});
  }
}
