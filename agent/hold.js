// The hold of a new tab (contract C10). The eager attach (attach.js) starts
// it: the hold's own Fetch.enable pauses the document requests of the tab's
// top frame, so the tab waits as with Chrome's waitForDebuggerOnStart.
// bridge.release, a detach, a link change or HOLD_MAX_MS ends it.
//
// The bridge's commands share the tab's one chrome.debugger session, and one
// Fetch handler serves the session. So a client's Fetch.enable on the tab
// replaces the hold's patterns: from its answer on, the tab's Fetch events
// are the client's, and the release gives the held requests'
// Fetch.requestPaused to the relay instead of continuing them. A client's
// Fetch.disable continues every paused request and turns Fetch off: it ends
// the hold. The hold's other Fetch events never reach the relay.

export const HOLD_MAX_MS = 5000;
// A release that waits for a client's Fetch command forces the finish after this.
export const HOLD_FORCE_MS = 2000;
// The tab's document requests, paused before they leave.
const PATTERNS = [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }];

export class Holds {
  #chrome;
  // tabId -> {requests, top, client, sent, toClient, wake, releasing, timer, done}
  #holds = new Map();
  setTimer = (fn, ms) => setTimeout(fn, ms);
  clearTimer = (h) => clearTimeout(h);
  forward = () => {}; // (source, method, params): an event of the tab to the relay
  onKept = () => {}; // (tabId): the hold keeps a document request of the tab (popups.js)

  constructor(chrome) {
    this.#chrome = chrome;
  }

  // The command starts now, so it reaches Chrome before the caller's next call.
  #send(tabId, method, params) {
    return new Promise((resolve) => resolve(this.#chrome.debugger.sendCommand({ tabId }, method, params)));
  }

  #end(tabId, hold) {
    this.clearTimer(hold.timer);
    if (this.#holds.get(tabId) === hold) this.#holds.delete(tabId);
  }

  // Starts the hold of a tab that the eager attach is attaching; the caller
  // sends nothing between its attach and this. True when the hold is on. Its
  // Fetch events count from before Fetch.enable answers: a request can pause
  // before that answer comes. The tab's target gives the id of its top frame.
  async start(tabId) {
    const hold = { requests: [], top: undefined, client: false, sent: 0, toClient: true, wake: null, releasing: false, timer: null, done: null };
    this.#holds.set(tabId, hold);
    const enabling = this.#send(tabId, "Fetch.enable", { patterns: PATTERNS });
    new Promise((resolve) => resolve(this.#chrome.debugger.getTargets())).then((targets) => {
      const page = Array.isArray(targets) ? targets.find((t) => t && t.tabId === tabId && t.type === "page") : undefined;
      if (page && typeof page.id === "string") hold.top = page.id;
    }, () => {});
    try {
      await enabling;
    } catch {
      this.#end(tabId, hold);
      return false;
    }
    if (this.#holds.get(tabId) !== hold || hold.done) return false;
    hold.timer = this.setTimer(() => {
      if (this.#holds.get(tabId) === hold) void this.release(tabId);
    }, HOLD_MAX_MS);
    return true;
  }

  // A debugger event: true when it belongs to a hold, so it never reaches the
  // relay. Before the release the hold keeps each paused document request of
  // the tab's top frame (while the top frame is not known yet, each one). It
  // continues any other one at once (a frame's: for example a frame of a page
  // whose own request left before the hold was on), and so does the release
  // until Fetch.disable answers.
  event(source, method, params) {
    if (method !== "Fetch.requestPaused" || source.sessionId !== undefined) return false;
    if (params === null || typeof params !== "object") return false;
    const hold = this.#holds.get(source.tabId);
    if (!hold || hold.client) return false;
    const top = hold.top === undefined || params.frameId === hold.top;
    if (hold.releasing || !top) {
      this.#send(source.tabId, "Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
    } else {
      hold.requests.push(params);
      this.onKept(source.tabId);
    }
    return true;
  }

  // The document requests that the hold of the tab keeps now.
  keptCount(tabId) {
    const hold = this.#holds.get(tabId);
    return hold && !hold.client ? hold.requests.length : 0;
  }

  // A client's Fetch.enable or Fetch.disable on the tab's own session, just
  // sent (sent: its promise). Until it answers, a release waits: the hold's
  // Fetch.disable would turn the client's Fetch off. Its answer: Fetch.enable
  // makes the tab's Fetch events the client's; Fetch.disable has continued
  // every paused request and ended Fetch, so the hold is over.
  clientFetch(tabId, method, sent) {
    const hold = this.#holds.get(tabId);
    if (!hold || hold.releasing) return;
    hold.sent += 1;
    const settle = (ok) => {
      hold.sent -= 1;
      if (ok && this.#holds.get(tabId) === hold && !hold.releasing) {
        if (method === "Fetch.enable") hold.client = true;
        else this.#end(tabId, hold);
      }
      if (hold.sent === 0 && hold.wake) hold.wake();
    };
    Promise.resolve(sent).then(() => settle(true), () => settle(false));
  }

  // Ends the hold of the tab (none: nothing to do). With a client's Fetch on
  // (and toClient), the held requests' events go to the relay and the client
  // continues them. Else the held requests continue and the hold's Fetch
  // ends. With no client Fetch command in flight, the chrome calls start
  // before this returns, so they reach Chrome before the relay's next
  // command; else they wait for those answers. toClient false (a link change,
  // a detach): no client takes the requests.
  release(tabId, toClient = true) {
    const hold = this.#holds.get(tabId);
    if (!hold) return Promise.resolve();
    if (!toClient) hold.toClient = false;
    if (hold.done) return hold.done;
    this.clearTimer(hold.timer);
    if (hold.sent > 0) {
      hold.done = new Promise((resolve) => (hold.wake = resolve)).then(() => this.#finish(tabId, hold));
      // A command that never answers must not keep the tab held for ever.
      hold.timer = this.setTimer(() => hold.wake(), HOLD_FORCE_MS);
    } else {
      hold.done = this.#finish(tabId, hold);
    }
    return hold.done;
  }

  #finish(tabId, hold) {
    if (this.#holds.get(tabId) !== hold) return Promise.resolve(); // a client's Fetch.disable ended it
    if (hold.client && hold.toClient) {
      this.#end(tabId, hold);
      for (const params of hold.requests) this.forward({ tabId }, "Fetch.requestPaused", params);
      return Promise.resolve();
    }
    hold.releasing = true;
    for (const p of hold.requests) this.#send(tabId, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
    return this.#send(tabId, "Fetch.disable").catch(() => {}).then(() => this.#end(tabId, hold));
  }

  // C10's cleanup: every hold ends, also one whose client turned Fetch on,
  // because that client's connection is gone.
  releaseAll() {
    for (const tabId of [...this.#holds.keys()]) void this.release(tabId, false);
  }

  // Chrome ended the tab's attachment, and the hold with it.
  drop(tabId) {
    const hold = this.#holds.get(tabId);
    if (hold) this.#end(tabId, hold);
  }
}
