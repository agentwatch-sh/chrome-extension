// The hold of a new tab (contract C10). The eager attach (attach.js) starts
// it: the hold's own Fetch.enable pauses the tab's first document request, so
// the tab waits as with Chrome's waitForDebuggerOnStart. bridge.release, a
// detach, a link change or HOLD_MAX_MS ends it.
//
// The bridge's commands share the tab's one chrome.debugger session with the
// hold. So a client's Fetch.enable on the tab replaces the hold's patterns:
// from its answer on, the tab's Fetch events are the client's, and the release
// gives the held request's Fetch.requestPaused to the relay instead of
// continuing it. The hold's other Fetch events never reach the relay.

export const HOLD_MAX_MS = 5000;
// The tab's document requests, paused before they leave.
const PATTERNS = [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }];

export class Holds {
  #chrome;
  #holds = new Map(); // tabId -> {request, client, releasing, timer, done}
  setTimer = (fn, ms) => setTimeout(fn, ms);
  clearTimer = (h) => clearTimeout(h);
  forward = () => {}; // (source, method, params): an event of the tab to the relay

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

  // Starts the hold of a tab that the eager attach has just attached. True
  // when the hold is on. Its Fetch events count from before Fetch.enable
  // answers: a request can pause before that answer comes.
  async start(tabId) {
    const hold = { request: null, client: false, releasing: false, timer: null, done: null };
    this.#holds.set(tabId, hold);
    try {
      await this.#send(tabId, "Fetch.enable", { patterns: PATTERNS });
    } catch {
      this.#end(tabId, hold);
      return false;
    }
    if (this.#holds.get(tabId) !== hold || hold.releasing) return false;
    hold.timer = this.setTimer(() => {
      if (this.#holds.get(tabId) === hold) void this.release(tabId);
    }, HOLD_MAX_MS);
    return true;
  }

  // A debugger event: true when it belongs to a hold, so it never reaches the
  // relay. Before the release the hold keeps the first paused request (the
  // tab's first document request); it continues a later one at once (for
  // example a frame of a page whose own request left before the hold was
  // on), and so does the release until Fetch.disable answers.
  event(source, method, params) {
    if (method !== "Fetch.requestPaused" || source.sessionId !== undefined) return false;
    if (params === null || typeof params !== "object") return false;
    const hold = this.#holds.get(source.tabId);
    if (!hold || hold.client) return false;
    if (hold.releasing || hold.request !== null) {
      this.#send(source.tabId, "Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
    } else {
      hold.request = params;
    }
    return true;
  }

  // A client's Fetch.enable (on) or Fetch.disable (off) on the tab's own
  // session got its answer during the hold.
  clientFetch(tabId, on) {
    const hold = this.#holds.get(tabId);
    if (hold && !hold.releasing) hold.client = on;
  }

  // Ends the hold of the tab (none: nothing to do). With a client's Fetch on
  // (and toClient), the held request's event goes to the relay and the
  // client continues it. Else the held request continues and the hold's
  // Fetch ends. The chrome calls start before this returns, so they reach
  // Chrome before the relay's next command.
  release(tabId, toClient = true) {
    const hold = this.#holds.get(tabId);
    if (!hold) return Promise.resolve();
    if (hold.releasing) return hold.done;
    if (hold.client && toClient) {
      this.#end(tabId, hold);
      if (hold.request !== null) this.forward({ tabId }, "Fetch.requestPaused", hold.request);
      return Promise.resolve();
    }
    this.clearTimer(hold.timer);
    hold.releasing = true;
    if (hold.request !== null) this.#send(tabId, "Fetch.continueRequest", { requestId: hold.request.requestId }).catch(() => {});
    hold.done = this.#send(tabId, "Fetch.disable").catch(() => {}).then(() => this.#end(tabId, hold));
    return hold.done;
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
