// The removal queue and the last window (contract C10, removals and the last
// window; C5's closing rule and sweep; C6's closes). Every path by which the
// receiver closes a tab runs in one queue: the tabs.remove op, a client's
// Page.close on the tab's own session, C5's closing rule and its sweep, the
// close of a new tab of the orphan set, and the import's closes. One item
// runs at a time: one tabs.query({}) and the closes of that item.
//
// - The window rule: when no tab stays open other than the item's tabs and
//   the tabs with a pending close, the item first opens an about:blank tab
//   (not active, in no scope) in the window of its last tab, so Chrome never
//   ends. The query and that tab each have REMOVAL_WAIT_MS; when either
//   fails or comes later, the item closes no tab.
// - The receiver's close (every close but a client's Page.close):
//   Target.closeTarget through chrome.debugger on the tab, one op of the
//   tab's chain of attaches (attach.js). No beforeunload handler runs. Its
//   fallback is chrome.tabs.remove. A command that answered with no error
//   but closed no tab (no tabs.onRemoved REMOVAL_WAIT_MS after its answer)
//   counts as failed too: Chrome drops a close that reaches it shortly
//   before the tab's navigation commits (measured, board ab-v16.63).
// - A pending close: from the moment its item starts it until the tab's
//   tabs.onRemoved, or until it fails and the tab stays (and, when a
//   Target.closeTarget command went, until that command answered). The
//   window rule counts a pending tab as closed.
// - The time limit: an item starts its closes one after the other, then
//   waits until they ended, at most REMOVAL_WAIT_MS after the last start.
// - A client's Page.close keeps its own semantics (beforeunload runs); each
//   later debugger.sendCommand of the tab waits at a gate until that
//   Page.close went to Chrome, was refused, or passed its deadline.
import { call } from "./attach.js";

export const REMOVAL_WAIT_MS = 2000;
export const NOT_AGENT_TAB = "not an agent tab";
// Chrome's answer to Target.closeTarget when the tab closed first: no error.
const DETACHED = "Detached while handling command.";
const message = (e) => String(e && e.message ? e.message : e);
const stale = () => new Error("detached");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

// One close of one tab. ended resolves when the close ends: closed is true
// at the tab's tabs.onRemoved (or a fallback that removed it), false when the
// close failed and the tab stays.
class Close {
  done = false;
  closed = false;
  error = null;
  commandOpen = false; // a Target.closeTarget command went and has not answered
  commandAnswer = null; // its answer, also after the command's time limit
  commandClosed = false; // that command answered with no error: the tab closes
  fallback = false; // the fallback ran
  fallbackError = null;

  constructor(tabId, forget) {
    this.tabId = tabId;
    this.#forget = forget;
    this.ended = new Promise((resolve) => (this.#resolve = resolve));
  }

  #resolve;
  #forget;

  end(closed, error = null) {
    if (this.done) return;
    this.done = true;
    this.closed = closed;
    this.error = error;
    this.#forget(this);
    this.#resolve();
  }

  // A failed fallback ends the close only once its command has answered
  // with an error (Chrome can still run a command that has not answered).
  check() {
    if (this.fallbackError && !this.commandOpen && !this.commandClosed) this.end(false, this.fallbackError);
  }
}

export class Removals {
  #chrome;
  #att;
  #map;
  #clock;
  #chain = Promise.resolve();
  #pending = new Map(); // tabId -> Set(Close)
  #gates = new Map(); // tabId -> a promise: the later commands of the tab wait for it

  constructor(chrome, { att, map, clock }) {
    this.#chrome = chrome;
    this.#att = att;
    this.#map = map;
    this.#clock = clock;
  }

  isPending(tabId) {
    return this.#pending.has(tabId);
  }

  // tabs.onRemoved: every close of the tab ends.
  tabRemoved(tabId) {
    for (const c of [...(this.#pending.get(tabId) ?? [])]) c.end(true);
  }

  // A link change: the gates of the old link's commands go, so the commands
  // of the new link go at once. The old link's requests that still wait in
  // the queue or at a gate see their stale op and never reach Chrome.
  dropBridge() {
    this.#gates.clear();
  }

  #enqueue(fn) {
    const run = this.#chain.then(fn);
    this.#chain = run.then(() => {}, () => {});
    return run;
  }

  #newClose(tabId) {
    const c = new Close(tabId, (x) => {
      const set = this.#pending.get(x.tabId);
      if (!set) return;
      set.delete(x);
      if (set.size === 0) this.#pending.delete(x.tabId);
    });
    if (!this.#pending.has(tabId)) this.#pending.set(tabId, new Set());
    this.#pending.get(tabId).add(c);
    return c;
  }

  // Calls fn now; its answer, or {ok: false} when it fails or has not
  // answered in REMOVAL_WAIT_MS (error: timeout).
  #limit(fn) {
    let handle;
    const late = new Promise((resolve) => {
      handle = this.#clock.setTimer(() => resolve({ ok: false, error: new Error("timeout") }), REMOVAL_WAIT_MS);
    });
    const done = call(fn).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    return Promise.race([done, late]).finally(() => this.#clock.clearTimer(handle));
  }

  #wait(promises) {
    let handle;
    const late = new Promise((resolve) => {
      handle = this.#clock.setTimer(resolve, REMOVAL_WAIT_MS);
    });
    return Promise.race([Promise.all(promises), late]).finally(() => this.#clock.clearTimer(handle));
  }

  // One item: the query, the window rule, the closes, the wait. ids: the
  // item's tabs, or select(tabs) picks them from the query. start(tabId)
  // starts one close and gives its Close. Gives {closes, error}: error when
  // the query or the window rule failed (then no close started).
  async #item({ ids = null, select = null, start }) {
    const q = await this.#limit(() => this.#chrome.tabs.query({}));
    if (!q.ok) return { closes: [], error: q.error };
    const tabs = (Array.isArray(q.value) ? q.value : []).filter((t) => t && Number.isInteger(t.id));
    const mine = ids ?? select(tabs);
    if (mine.length === 0) return { closes: [], error: null };
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const open = mine.filter((id) => byId.has(id));
    const stays = tabs.some((t) => !mine.includes(t.id) && !this.isPending(t.id));
    if (open.length > 0 && !stays) {
      const last = byId.get(open.at(-1));
      const blank = await this.#limit(() => this.#chrome.tabs.create({ windowId: last.windowId, url: "about:blank", active: false }));
      if (!blank.ok) return { closes: [], error: blank.error };
    }
    const closes = mine.map((id) => start(id));
    await this.#wait(closes.map((c) => c.ended));
    return { closes, error: null };
  }

  // ---- the receiver's close ----

  // Starts the receiver's close of the tab: it joins the tab's chain now (so
  // the close is pending from now on).
  #receiverClose(tabId) {
    const c = this.#newClose(tabId);
    void this.#att.inChain(tabId, () => this.#closeOp(c)).catch(() => {});
    return c;
  }

  // The op of the tab's chain. It ends at the command's answer, or when the
  // fallback called chrome.tabs.remove; the close stays pending outside it.
  async #closeOp(c) {
    const { tabId } = c;
    if (c.done) return;
    let own = false;
    let fallback = false;
    let running = null; // the answer of a command that has not answered in time
    if (!this.#att.isAttached(tabId)) {
      try {
        await this.#att.attachForClose(tabId);
        own = true;
      } catch {
        fallback = true;
      }
    }
    let targetId = null;
    if (!fallback && !c.done) {
      try {
        const targets = await this.#chrome.debugger.getTargets();
        const t = (Array.isArray(targets) ? targets : []).find((x) => x && x.tabId === tabId && x.type === "page" && typeof x.id === "string");
        targetId = t ? t.id : null;
      } catch {
        targetId = null;
      }
      if (targetId === null) fallback = true;
    }
    if (!fallback && !c.done) {
      c.commandOpen = true;
      const sent = call(() => this.#chrome.debugger.sendCommand({ tabId }, "Target.closeTarget", { targetId }));
      const answered = sent.then(() => true, (e) => message(e) === DETACHED);
      c.commandAnswer = answered;
      void answered.then((ok) => {
        c.commandOpen = false;
        if (ok) {
          c.commandClosed = true;
          this.#watch(c, own);
        }
        c.check();
      });
      // A command with no answer in REMOVAL_WAIT_MS counts as failed.
      const r = await this.#limit(() => answered);
      if (r.ok && r.value) return;
      fallback = true;
      running = !r.ok ? answered : null;
    }
    return this.#fallback(c, own, running);
  }

  // own: this close made the attachment. running is only a flag here: when
  // truthy, chrome.tabs.remove goes now and detach cleanup waits outside the
  // chain. Cleanup reads the live commands again and ends the attachment
  // only when no close command of the tab is open.
  async #fallback(c, own, running = null) {
    if (c.done) return;
    const { tabId } = c;
    c.fallback = true;
    if (own && running) this.#detachWhenIdle(tabId);
    else if (own) await call(() => this.#att.detachForClose(tabId)).catch(() => {});
    if (c.done) return;
    const removing = call(() => this.#chrome.tabs.remove(tabId));
    void removing.then(() => c.end(true), (e) => {
      c.fallbackError = e;
      c.check();
    });
  }

  // The detach runs in the chain, but waits outside it. A later close can
  // borrow the attachment during that wait: check every command again when
  // the detach's chain op runs, rather than keeping a snapshot of commands.
  #detachWhenIdle(tabId) {
    void this.#att.inChain(tabId, () => {
      const running = [...(this.#pending.get(tabId) ?? [])]
        .filter((c) => c.commandOpen).map((c) => c.commandAnswer);
      if (running.length) {
        void Promise.all(running).then(() => this.#detachWhenIdle(tabId));
        return;
      }
      return this.#att.detachForClose(tabId);
    }).catch(() => {});
  }

  // The command answered with no error. When no tabs.onRemoved of the tab
  // comes in REMOVAL_WAIT_MS after that answer, Chrome dropped the close
  // (measured: a Target.closeTarget that reaches Chrome shortly before the
  // tab's navigation commits answers {success: true}, and the tab stays
  // open): the command counts as failed, and the fallback runs, one op of
  // the tab's chain. When the fallback ran already (the command answered
  // after its limit), its result ends the close.
  #watch(c, own) {
    if (c.done) return;
    const handle = this.#clock.setTimer(() => {
      if (c.done) return;
      c.commandClosed = false;
      if (c.fallback) c.check();
      else this.#watchedFallback(c, own);
    }, REMOVAL_WAIT_MS);
    void c.ended.then(() => this.#clock.clearTimer(handle));
  }

  #watchedFallback(c, own) {
    if (c.done) return;
    void this.#att.inChain(c.tabId, () => {
      if (c.done) return;
      // A later close can borrow this close's attach and pass its command
      // limit. Wait outside the chain: a later close must still be free to run.
      const running = [...(this.#pending.get(c.tabId) ?? [])]
        .filter((x) => x.commandOpen).map((x) => x.commandAnswer);
      if (running.length) {
        const ready = Promise.race([c.ended, Promise.all(running)]);
        // One extra limit, outside both queues. A command that never answers
        // must neither hold later closes nor prevent this fallback forever.
        void this.#limit(() => ready).then(() => {
          if (c.done) return;
          void this.#att.inChain(c.tabId, () => {
            const stillRunning = [...(this.#pending.get(c.tabId) ?? [])]
              .filter((x) => x.commandOpen).map((x) => x.commandAnswer);
            return this.#fallback(c, own, stillRunning.length ? Promise.all(stillRunning) : null);
          }).catch(() => {});
        });
        return;
      }
      return this.#fallback(c, own);
    }).catch(() => {});
  }

  // ---- the items ----

  // The receiver's own closes (the closing rule and the sweep, the import,
  // a new tab of the orphan set): ids, or select(tabs) from the item's
  // query. after(result) runs at the end of the item, before the next one.
  // Gives {closed, left, pending, error}: the tabs that closed in the item's
  // wait, the others (failed or still pending), of those the ones still
  // pending, and the error of the window rule (its query or its tab).
  closeOwn({ ids = null, select = null, after = null }) {
    return this.#enqueue(async () => {
      const r = await this.#item({ ids, select, start: (id) => this.#receiverClose(id) });
      const closed = r.closes.filter((c) => c.done && c.closed).map((c) => c.tabId);
      const left = r.closes.filter((c) => !(c.done && c.closed)).map((c) => c.tabId);
      const pending = r.closes.filter((c) => !c.done).map((c) => c.tabId);
      const result = { closed, left, pending, error: r.error };
      if (after) after(result);
      return result;
    });
  }

  // The tabs.remove op (the relay's end_scope and Target.closeTarget): the
  // receiver's close in the queue. Answers null when the tab closed, the
  // error when the close failed or the window rule refused it. op: the
  // request's state ({stale(), expired}).
  removeTab(tabId, op) {
    const answer = deferred();
    void this.#enqueue(async () => {
      if (op.stale()) return answer.reject(stale());
      if (op.expired) return answer.reject(new Error("timeout"));
      // The orphan set's check (and the restore tab's and the mark's) when the item starts.
      if (this.#map.isOrphan(tabId) || this.#map.isMarked(tabId) || this.#att.isRestoreTab(tabId)) return answer.reject(new Error(NOT_AGENT_TAB));
      const r = await this.#item({ ids: [tabId], start: (id) => this.#receiverClose(id) });
      if (r.error) return answer.reject(r.error);
      const c = r.closes[0];
      void c.ended.then(() => (c.closed ? answer.resolve(null) : answer.reject(c.error ?? new Error("close failed"))));
    });
    return answer.promise;
  }

  // ---- the commands of a tab, and a client's Page.close ----

  // A debugger.sendCommand of a tab: send() calls Chrome. With no gate it
  // runs now (no await); behind a gate it runs when the gate opens, after
  // the orphan set's check, unless its op went stale or passed its deadline.
  command(tabId, op, send) {
    const gate = this.#gates.get(tabId);
    if (!gate) return send();
    const answer = deferred();
    let passed;
    const next = new Promise((resolve) => (passed = resolve));
    this.#gates.set(tabId, next);
    void gate.then(() => {
      try {
        if (op.stale()) return answer.reject(stale());
        if (op.expired) return answer.reject(new Error("timeout"));
        if (this.#map.isOrphan(tabId)) return answer.reject(new Error(NOT_AGENT_TAB));
        send().then(answer.resolve, answer.reject);
      } catch (e) {
        answer.reject(e);
      } finally {
        passed();
        if (this.#gates.get(tabId) === next) this.#gates.delete(tabId);
      }
    });
    return answer.promise;
  }

  // A client's Page.close on the tab's own session: an item of the queue,
  // with the window rule. send() calls Chrome; the op answers with Chrome's
  // answer (or the window rule's error). The close is pending from its send
  // until the tab's tabs.onRemoved, or until Chrome's answer is an error.
  pageClose(tabId, op, send) {
    const answer = deferred();
    const gate = this.#gates.get(tabId) ?? Promise.resolve();
    let open;
    const opened = new Promise((resolve) => (open = resolve));
    this.#gates.set(tabId, opened);
    const openGate = () => {
      open();
      if (this.#gates.get(tabId) === opened) this.#gates.delete(tabId);
    };
    void gate.then(() => this.#enqueue(async () => {
      if (op.stale()) {
        openGate();
        return answer.reject(stale());
      }
      if (op.expired) {
        openGate();
        return answer.reject(new Error("timeout"));
      }
      if (this.#map.isOrphan(tabId)) {
        openGate();
        return answer.reject(new Error(NOT_AGENT_TAB));
      }
      const start = (id) => {
        const c = this.#newClose(id);
        let sent;
        try {
          sent = send();
        } catch (e) {
          sent = Promise.reject(e);
        } finally {
          openGate();
        }
        sent.then(answer.resolve, (e) => {
          c.end(false, e);
          answer.reject(e);
        });
        return c;
      };
      const r = await this.#item({ ids: [tabId], start });
      if (r.error) {
        openGate();
        answer.reject(r.error);
      }
    }));
    return answer.promise;
  }
}
