// The receiver's import (contract C6): a send replaces the site's cookies and
// page storage. Page storage needs a document of the site's origin, so the
// import opens a restore page: a URL of the origin that the debugger's Fetch
// domain answers itself, so the site never sees it. The page side is
// replacePageState (page-state.js).
//
// A failed step rejects with the step's name only; no error text and no
// errors entry ever holds a cookie value or a storage value.
import { toSetDetails, toRemoveDetails, inScope, dedupe } from "./lib/cookies.js";
import { normalizeEntry, covers } from "./lib/domains.js";
import { replacePageState } from "./page-state.js";
import { closeTabs, tabUrl } from "./tabs.js";

// The link answers "timeout" at 115 s. Steps share 100 s, and each of the two
// cleanup calls gets at most 4 s, so an import always ends before 110 s.
// Each step has 20 s, except the page's write, which has 60 s.
const STEP_MS = 20000;
const WRITE_MS = 60000;
const IMPORT_MS = 100000;
const CLEANUP_MS = 4000;

const RESTORE_HEADERS = [
  { name: "Content-Type", value: "text/html; charset=utf-8" },
  { name: "Cache-Control", value: "no-store" },
];
const RESTORE_BODY = '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>agentwatch</title>';

// One import at a time: each import starts after the one before it ended.
let queue = Promise.resolve();

export function importState(chrome, state, opts = {}) {
  const run = queue.then(() => runImport(chrome, state, opts));
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The worker's own check of the C2 fields it acts on; the daemon checks the
// whole payload before it sends.
function validState(state) {
  try {
    if (state === null || typeof state !== "object") return false;
    const entry = normalizeEntry(state.domain);
    if (!entry.ok || entry.entry !== state.domain) return false;
    const origin = new URL(state.origin);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
    if (origin.origin !== state.origin) return false;
    if (!covers(state.domain, origin.hostname)) return false;
    if (new URL(state.url).origin !== state.origin) return false;
    if (!Array.isArray(state.cookies)) return false;
    return state.storage !== null && typeof state.storage === "object" && !Array.isArray(state.storage);
  } catch {
    return false;
  }
}

function cookieName(c) {
  return c !== null && typeof c === "object" && typeof c.name === "string" ? c.name : "?";
}

// C6 step 1: remove every cookie of the domain and its subdomains (also the
// partitioned ones), then set each sent cookie. One failed cookie is an
// errors entry; the import goes on. When the step has failed (its deadline),
// signal.aborted stops the work before its next chrome call.
async function replaceCookies(chrome, state, signal) {
  const goOn = () => {
    if (signal.aborted) throw new Error("aborted");
  };
  const errors = [];
  goOn();
  const unpartitioned = await chrome.cookies.getAll({ domain: state.domain });
  goOn();
  const partitioned = await chrome.cookies.getAll({ domain: state.domain, partitionKey: {} });
  const found = [...unpartitioned, ...partitioned];
  let removed = 0;
  for (const c of dedupe(found)) {
    goOn();
    try {
      if (await chrome.cookies.remove(toRemoveDetails(c))) removed += 1;
    } catch {
      errors.push("cookie " + cookieName(c) + ": not removed");
    }
  }
  let set = 0;
  for (const c of state.cookies) {
    const name = cookieName(c);
    let scoped = false;
    try {
      scoped = inScope(c, state.domain);
    } catch {
      scoped = false;
    }
    if (!scoped) {
      errors.push("cookie " + name + ": out of scope");
      continue;
    }
    goOn();
    let ok = false;
    try {
      ok = Boolean(await chrome.cookies.set(toSetDetails(c)));
    } catch {
      ok = false;
    }
    if (ok) set += 1;
    else errors.push("cookie " + name + ": not set");
  }
  return { removed, set, errors };
}

function count(x) {
  return Number.isSafeInteger(x) && x >= 0 ? x : 0;
}

// The page's result, or {fatal: true} when the page found that it is not the
// restore page (it then touched nothing).
function pageCounts(results) {
  const r = Array.isArray(results) && results[0] ? results[0].result : null;
  if (r === null || typeof r !== "object") throw new Error("no page result");
  if (typeof r.fatal === "string") return { fatal: true };
  return {
    local: count(r.local),
    session: count(r.session),
    idb_databases: count(r.idb_databases),
    idb_records: count(r.idb_records),
    cache_entries: count(r.cache_entries),
    errors: Array.isArray(r.errors) ? r.errors.filter((e) => typeof e === "string") : [],
  };
}

// Injected into the restore page as the last step. The timeout lets the
// script return its result before the page unloads.
function leaveRestorePage(url) {
  setTimeout(() => location.replace(url), 0);
}

async function runImport(chrome, state, opts) {
  if (!validState(state)) throw new Error("invalid state");
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((h) => clearTimeout(h));
  const nonce = opts.nonce || randomNonce;
  const restoreUrl = state.origin + "/__agentwatch_restore_" + nonce() + "__";

  const ctx = { tabId: null, tabPending: null, attached: false, listeners: [] };
  const listen = (event, fn) => {
    event.addListener(fn);
    ctx.listeners.push([event, fn]);
  };

  let importHandle;
  const importDeadline = new Promise((_, reject) => {
    importHandle = setTimer(() => reject(new Error("deadline")), IMPORT_MS);
  });
  importDeadline.catch(() => {});

  // fn gets a signal; signal.aborted is true once the step has failed, so
  // work that is still running can stop.
  const step = async (name, fn, ms = STEP_MS) => {
    let handle;
    const signal = { aborted: false };
    const stepDeadline = new Promise((_, reject) => {
      handle = setTimer(() => reject(new Error("deadline")), ms);
    });
    const work = Promise.resolve().then(() => fn(signal));
    work.catch(() => {}); // a late failure after the deadline is ignored
    try {
      return await Promise.race([work, stepDeadline, importDeadline]);
    } catch {
      signal.aborted = true;
      throw new Error(name);
    } finally {
      clearTimer(handle);
    }
  };

  // Best effort: errors are ignored, and a call that hangs is left behind.
  const bounded = (fn) => {
    let handle;
    const limit = new Promise((resolve) => {
      handle = setTimer(resolve, CLEANUP_MS);
    });
    const work = Promise.resolve().then(fn).catch(() => {});
    return Promise.race([work, limit]).finally(() => clearTimer(handle));
  };

  try {
    const cookies = await step("cookies", (signal) => replaceCookies(chrome, state, signal));

    // Tabs of the origin hold the state being replaced (an open IndexedDB
    // connection blocks its deletion).
    const tabsClosed = await step("close tabs", () =>
      closeTabs(chrome, (t) => {
        const u = tabUrl(t);
        return u !== null && u.origin === state.origin;
      }));

    const tabId = await step("open tab", async () => {
      ctx.tabPending = chrome.tabs.create({ url: "about:blank", active: true });
      const tab = await ctx.tabPending;
      if (!tab || typeof tab.id !== "number") throw new Error("no tab");
      ctx.tabId = tab.id;
      return tab.id;
    });
    const target = { tabId };

    await step("attach", () => chrome.debugger.attach(target, "1.3"));
    ctx.attached = true;

    // Set by the restore page step; a failed fulfill fails that step.
    let restoreFailed = () => {};
    const onDebuggerEvent = (source, method, params) => {
      if (!source || source.tabId !== tabId || method !== "Fetch.requestPaused" || !params) return;
      const url = params.request && params.request.url;
      if (url === restoreUrl) {
        Promise.resolve()
          .then(() =>
            chrome.debugger.sendCommand(target, "Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: 200,
              responseHeaders: RESTORE_HEADERS,
              body: btoa(RESTORE_BODY),
            }))
          .catch(() => restoreFailed());
      } else {
        Promise.resolve()
          .then(() => chrome.debugger.sendCommand(target, "Fetch.continueRequest", { requestId: params.requestId }))
          .catch(() => {});
      }
    };

    // A service worker of the site must not answer the restore page.
    await step("fetch enable", async () => {
      listen(chrome.debugger.onEvent, onDebuggerEvent);
      await chrome.debugger.sendCommand(target, "Network.setBypassServiceWorker", { bypass: true });
      await chrome.debugger.sendCommand(target, "Fetch.enable", {
        patterns: [{ urlPattern: restoreUrl, requestStage: "Request" }],
      });
    });

    await step("restore page", () =>
      new Promise((resolve, reject) => {
        const ours = (d) => d && d.tabId === tabId && d.frameId === 0 && d.url === restoreUrl;
        restoreFailed = () => reject(new Error("not fulfilled"));
        listen(chrome.webNavigation.onCompleted, (d) => {
          if (ours(d)) resolve();
        });
        listen(chrome.webNavigation.onErrorOccurred, (d) => {
          if (ours(d)) reject(new Error("navigation failed"));
        });
        Promise.resolve()
          .then(() => chrome.tabs.update(tabId, { url: restoreUrl }))
          .catch(() => reject(new Error("update failed")));
      }));

    await step("codec", () => chrome.scripting.executeScript({ target: { tabId }, files: ["lib/codec.js"] }));

    const page = await step(
      "write storage",
      async () =>
        pageCounts(
          await chrome.scripting.executeScript({
            target: { tabId },
            func: replacePageState,
            args: [JSON.stringify(state.storage), restoreUrl],
          }),
        ),
      WRITE_MS,
    );
    if (page.fatal) throw new Error("restore page");

    await step("detach", async () => {
      await chrome.debugger.sendCommand(target, "Fetch.disable");
      await chrome.debugger.detach(target);
      ctx.attached = false;
    });

    await step("navigate", () =>
      chrome.scripting.executeScript({ target: { tabId }, func: leaveRestorePage, args: [state.url] }));

    return {
      cookies_removed: cookies.removed,
      cookies_set: cookies.set,
      tabs_closed: tabsClosed,
      local: page.local,
      session: page.session,
      idb_databases: page.idb_databases,
      idb_records: page.idb_records,
      cache_entries: page.cache_entries,
      errors: [...cookies.errors, ...page.errors],
    };
  } catch (e) {
    // e is always an Error with a step's name: every statement that can throw
    // runs in a step, and a page that is not the restore page fails "restore page".
    if (ctx.attached) await bounded(() => chrome.debugger.detach({ tabId: ctx.tabId }));
    if (ctx.tabId !== null) {
      await bounded(() => chrome.tabs.remove(ctx.tabId));
    } else if (ctx.tabPending) {
      // The tab came after its step's deadline: close it when it comes.
      Promise.resolve(ctx.tabPending)
        .then((tab) => (tab && typeof tab.id === "number" ? chrome.tabs.remove(tab.id) : null))
        .catch(() => {});
    }
    throw e;
  } finally {
    for (const [event, fn] of ctx.listeners) event.removeListener(fn);
    clearTimer(importHandle);
  }
}
