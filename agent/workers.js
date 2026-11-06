// The service worker removals (contract C5, the worker removal): the one
// bounded call, and the removal at a marked tab's leave (board ab-v16.74; the
// operator's answer ab-214: "Remove such a site's worker when your tab leaves
// it").
//
// A site's service worker answers a navigation before DNR sees it. A worker
// that the operator's marked tab ("*") registered for a host on no list
// answers a scope's tab too, with the operator's signed-in page, until layer 3
// of the guard sends that tab away (measured, board ab-v16.73). So:
// - The record: each web origin (http:/https:, a blob: URL's inner origin)
//   that a frame of a marked tab commits, the top frame and every sub-frame (a
//   frame can register a worker for its own origin), whatever the operator
//   value. It lives in memory and in chrome.storage.session, one key per
//   origin ("worker:<origin>"), so a worker that starts again knows it; the
//   start's one read of the copy (tabmap.js) gives it back.
// - The check: when no marked tab shows a recorded origin in any frame
//   (webNavigation.getAllFrames, with the origins committed during that read;
//   a page in the back/forward cache or one that is going shows nothing), and
//   no list of the last applied set_scopes covers its host, the receiver
//   removes that origin's workers: browsingData.remove({origins},
//   {serviceWorkers: true}), and the origin leaves the record. A listed origin
//   stays recorded: the set_scopes that takes it off every list removes it.
// - The events of a check: a commit of a frame of a marked tab, a marked tab's
//   close or replace, a tab that gets or loses the mark, each set_scopes (after
//   its answer) and the worker's start (no tab is marked then: the marks have
//   no copy). One check runs at a time; the events while one runs start one
//   more after it.
// - The limits: each frame read and each removal has REMOVAL_WAIT_MS. A read
//   that fails or comes late removes nothing (a shown origin could break the
//   operator's open page); a removal that fails or comes late keeps its
//   origins. Each logs one line (no origin), and the next event's check tries
//   again.
//
// C5's own worker removal of a set_scopes (allowlist.js: every origin) uses
// the same bounded call; neither waits for the other or fails the other.
import { call } from "./attach.js";
import { covers } from "./lib/domains.js";
import { REMOVAL_WAIT_MS } from "./removals.js";
import { webUrl } from "./tabs.js";

// The key of a recorded origin in chrome.storage.session.
export const WORKER_KEY = "worker:";

// The web origin of a frame's URL (as the guard judges a host: tabs.js), or null.
export function originOf(url) {
  const u = webUrl(url);
  return u === null || u.hostname === "" ? null : u.origin;
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
// C5's removal of a set_scopes) or of the given origins (a marked tab's
// leave), within REMOVAL_WAIT_MS. True when it ended in time; a failure or a
// late end logs one line and gives false.
export async function removeWorkers(r, origins = null) {
  const got = await limit(r, () => r.chrome.browsingData.remove(origins === null ? {} : { origins }, { serviceWorkers: true }));
  if (got.ok) return true;
  const what = origins === null ? "" : ` of ${origins.length} origin(s) that no marked tab shows`;
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

  constructor(receiver) {
    this.#r = receiver;
  }

  // The recorded origins (for tests).
  origins() {
    return [...this.#record.keys()];
  }

  // webNavigation.onCommitted of any frame: a marked tab's web origin joins
  // the record, and a check follows (the frame's old document went).
  committed(d) {
    if (!d || !Number.isInteger(d.tabId) || !this.#r.map.isMarked(d.tabId)) return;
    const o = originOf(d.url);
    if (o !== null) this.#add(o);
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
      if (originOf(o) !== o) {
        bad.push(k);
        continue;
      }
      if (!this.#record.has(o)) this.#record.set(o, 0);
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

  #add(o) {
    const known = this.#record.has(o);
    this.#seq += 1;
    this.#record.set(o, this.#seq);
    if (!known) void call(() => this.#r.chrome.storage.session.set({ [WORKER_KEY + o]: true })).catch(() => {});
  }

  async #check() {
    const r = this.#r;
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
    const shown = new Set();
    for (const x of reads) {
      for (const frame of Array.isArray(x.value) ? x.value : []) {
        if (!shows(frame)) continue;
        const o = originOf(frame.url);
        if (o === null) continue;
        shown.add(o);
        if (!this.#record.has(o)) this.#add(o); // a page of a marked tab that no commit named
      }
    }
    // An origin that a marked tab committed during the reads is shown.
    for (const [o, n] of this.#record) if (n > seq0) shown.add(o);
    const ref = r.map.reference;
    const lists = ref === null ? [] : ref.union();
    const gone = [...this.#record.keys()].filter((o) => !shown.has(o) && !lists.some((d) => covers(d, new URL(o).hostname)));
    if (gone.length === 0) return;
    const seq1 = this.#seq;
    if (!(await removeWorkers(r, gone))) return;
    // An origin that a marked tab committed during the removal stays recorded.
    const done = gone.filter((o) => this.#record.has(o) && this.#record.get(o) <= seq1);
    for (const o of done) this.#record.delete(o);
    if (done.length > 0) void call(() => r.chrome.storage.session.remove(done.map((o) => WORKER_KEY + o))).catch(() => {});
  }
}
