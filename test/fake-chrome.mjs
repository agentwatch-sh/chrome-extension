// A small fake of the chrome APIs the receiver uses. Every call is recorded in
// fake.calls as [apiPath, args]. A test replaces one API's behaviour with
// fake.impl[apiPath] = (...args) => result.
//
// The fake models one browser behaviour for the restore page: when
// fake.autoNavigate is true (the default), tabs.update fires
// debugger.onEvent "Fetch.requestPaused" for the new URL, and a later
// "Fetch.fulfillRequest" for that request fires webNavigation.onCompleted.
//
// For the bridge (C10): fake.targets_ is what debugger.getTargets returns,
// and runtime.id is the agent package's ID in the bridge vector.
//
// For the removals (C10): tabs.remove of a tab of fake.tabs_ removes it and
// fires tabs.onRemoved before it answers; Target.closeTarget of a target of
// fake.targets_ does the same for its tab (Chrome closes it with no
// beforeunload). With fake.trackNewTabs, a tab of tabs.create gets a target
// ("T<id>") and closes the same way. fake.sessionRules_ and fake.dynamicRules_
// hold the DNR rules.
// When fake.autoNavigate is true, the import's last script (leaveRestorePage)
// fires webNavigation.onCommitted for its URL.
//
// For the worker removal of the recorded origins (C5): webNavigation.getAllFrames
// gives fake.frames_.get(tabId) when the test set it, else the main frame of a
// tab of fake.tabs_ at its url, and null for a tab that does not exist (as
// Chrome does).

function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    fire: (...args) => listeners.slice().map((fn) => fn(...args)),
    listeners,
  };
}

const later = (fn) => setTimeout(fn, 0);

// Chrome converts an executeScript result to its own value type, whose
// dictionaries sort their keys (measured on Chromium 156). A string is kept.
function chromeResult(x) {
  if (Array.isArray(x)) return x.map(chromeResult);
  if (x !== null && typeof x === "object") {
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = chromeResult(x[k]);
    return out;
  }
  return x;
}

export function makeFakeChrome() {
  const calls = [];
  const fake = {
    calls,
    ports: [],
    tabs_: [],
    cookies_: [],
    impl: {},
    autoNavigate: true,
    paused: new Map(), // requestId -> {tabId, url}
    storage_: { local: {}, session: {} },
    permissions_: { origins: [], permissions: [] },
    partitionKey: undefined, // reply of cookies.getPartitionKey, or undefined for none
    pageRead: { storage: { local: {}, session: {}, idb: [], caches: [] }, skipped: [] },
    permissionAnswer: true,
    pageResult: { local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] },
    manifest: { version: "0.1.0" },
    targets_: [],
    trackAttachments: false, // model Chrome's attachment ownership for removal races
    sessionRules_: [],
    dynamicRules_: [],
    trackNewTabs: false,
    frames_: new Map(), // tabId -> the frames that webNavigation.getAllFrames gives
    created_: new Map(), // tabId -> windowId: the tabs of tabs.create, with trackNewTabs
    chrome: null,
  };
  const rec = (path, impl) => (...args) => {
    calls.push([path, args]);
    const f = Object.hasOwn(fake.impl, path) ? fake.impl[path] : impl;
    return f ? f(...args) : undefined;
  };
  const port = {
    posted: [],
    onMessage: makeEvent(),
    onDisconnect: makeEvent(),
    postMessage(msg) {
      calls.push(["port.postMessage", [msg]]);
      port.posted.push(msg);
    },
    fireMessage: (msg) => port.onMessage.fire(msg),
    fireDisconnect: () => port.onDisconnect.fire(port),
  };
  let requestSeq = 0;
  // A storage area. get(keys) takes a string, a list or null; set() fires
  // chrome.storage.onChanged with {key: {oldValue, newValue}}, "<area>".
  function makeArea(name) {
    return {
      get: rec("storage." + name + ".get", async (keys) => {
        const data = fake.storage_[name];
        if (keys === null || keys === undefined) return structuredClone(data);
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) if (Object.hasOwn(data, k)) out[k] = structuredClone(data[k]);
        return out;
      }),
      set: rec("storage." + name + ".set", async (items) => {
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: fake.storage_[name][k], newValue: structuredClone(v) };
          fake.storage_[name][k] = structuredClone(v);
        }
        chrome.storage.onChanged.fire(changes, name);
      }),
      remove: rec("storage." + name + ".remove", async (keys) => {
        const changes = {};
        for (const k of typeof keys === "string" ? [keys] : keys) {
          if (!Object.hasOwn(fake.storage_[name], k)) continue;
          changes[k] = { oldValue: fake.storage_[name][k], newValue: undefined };
          delete fake.storage_[name][k];
        }
        if (Object.keys(changes).length > 0) chrome.storage.onChanged.fire(changes, name);
      }),
    };
  }
  const chrome = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getURL: (path) => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/" + path,
      get lastError() {
        calls.push(["runtime.lastError", []]);
        return undefined;
      },
      connectNative: rec("runtime.connectNative", () => {
        // A fresh port per connect, so a test can fire a disconnect on the old one.
        const p = Object.create(port, {
          posted: { value: [] },
          onMessage: { value: makeEvent() },
          onDisconnect: { value: makeEvent() },
        });
        p.postMessage = (msg) => {
          calls.push(["port.postMessage", [msg]]);
          p.posted.push(msg);
        };
        p.fireMessage = (msg) => p.onMessage.fire(msg);
        p.fireDisconnect = () => p.onDisconnect.fire(p);
        fake.ports.push(p);
        return p;
      }),
      getManifest: () => fake.manifest,
      sendMessage: rec("runtime.sendMessage", async () => undefined),
      getPlatformInfo: rec("runtime.getPlatformInfo", async () => ({ os: "linux", arch: "x86-64" })),
      openOptionsPage: rec("runtime.openOptionsPage", async () => {}),
      onMessage: makeEvent(),
    },
    declarativeNetRequest: {
      updateDynamicRules: rec("declarativeNetRequest.updateDynamicRules", async (d) => {
        fake.dynamicRules_ = applyRules(fake.dynamicRules_, d);
      }),
      updateSessionRules: rec("declarativeNetRequest.updateSessionRules", async (d) => {
        fake.sessionRules_ = applyRules(fake.sessionRules_, d);
      }),
      getSessionRules: rec("declarativeNetRequest.getSessionRules", async () => structuredClone(fake.sessionRules_)),
    },
    browsingData: {
      remove: rec("browsingData.remove", async () => {}),
    },
    tabs: {
      query: rec("tabs.query", async () => fake.tabs_.map((t) => ({ ...t }))),
      get: rec("tabs.get", async (tabId) => {
        const t = fake.tabs_.find((x) => x.id === tabId);
        if (!t) throw new Error("No tab with id: " + tabId);
        return { ...t };
      }),
      remove: rec("tabs.remove", async (tabId) => {
        fake.closeTab(tabId);
      }),
      create: rec("tabs.create", async (props) => {
        const tab = { id: 900 + calls.length, ...props };
        if (fake.trackNewTabs) {
          fake.created_.set(tab.id, props.windowId ?? 1);
          fake.targets_.push({ id: "T" + tab.id, tabId: tab.id, type: "page", attached: false });
        }
        return tab;
      }),
      update: rec("tabs.update", async (tabId, props) => {
        // about:blank makes no request (C5's guard sends a tab there).
        if (fake.autoNavigate && !/^about:blank([?#]|$)/.test(props.url ?? "")) fake.pauseRequest(tabId, props.url);
        return { id: tabId, ...props };
      }),
      reload: rec("tabs.reload", async () => {}),
      onCreated: makeEvent(),
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
      onReplaced: makeEvent(),
    },
    windows: {
      get: rec("windows.get", async (windowId) => ({ id: windowId })),
      create: rec("windows.create", async (data) => ({ id: 800 + calls.length, ...data })),
      update: rec("windows.update", async (windowId, info) => ({ id: windowId, ...info })),
    },
    downloads: {
      search: rec("downloads.search", async () => []),
      cancel: rec("downloads.cancel", async () => {}),
      onCreated: makeEvent(),
      onChanged: makeEvent(),
    },
    contentSettings: Object.fromEntries(
      ["location", "notifications", "camera", "microphone", "clipboard", "automaticDownloads", "cookies"].map((type) => [type, {
        set: rec("contentSettings." + type + ".set", async () => {}),
        clear: rec("contentSettings." + type + ".clear", async () => {}),
      }]),
    ),
    cookies: {
      // Without partitionKey: unpartitioned cookies only. With partitionKey {}:
      // every cookie, so the two reads overlap (as in Chrome).
      getAll: rec("cookies.getAll", async (filter) =>
        fake.cookies_.filter((c) => (filter.partitionKey ? true : !c.partitionKey)).map((c) => ({ ...c }))),
      getPartitionKey: rec("cookies.getPartitionKey", async () =>
        fake.partitionKey ? { partitionKey: fake.partitionKey } : {}),
      set: rec("cookies.set", async (details) => ({ ...details })),
      remove: rec("cookies.remove", async (details) => ({ ...details })),
    },
    debugger: {
      attach: rec("debugger.attach", async ({ tabId }) => {
        if (!fake.trackAttachments) return;
        const t = fake.targets_.find((x) => x.tabId === tabId);
        if (!t) throw new Error("No target with given id found");
        if (t.attached) throw new Error("Another debugger is already attached to the tab");
        t.attached = true;
      }),
      detach: rec("debugger.detach", async ({ tabId }) => {
        if (!fake.trackAttachments) return;
        const t = fake.targets_.find((x) => x.tabId === tabId);
        if (t) t.attached = false;
      }),
      getTargets: rec("debugger.getTargets", async () => fake.targets_.map((t) => ({ ...t }))),
      sendCommand: rec("debugger.sendCommand", async (target, method, params) => {
        if (method === "Target.closeTarget") {
          const t = fake.targets_.find((x) => x.id === params.targetId);
          if (!t) throw new Error("No target with given id found");
          fake.closeTab(t.tabId);
          return { success: true };
        }
        if (method === "Fetch.fulfillRequest" && fake.paused.has(params.requestId)) {
          const { tabId, url } = fake.paused.get(params.requestId);
          later(() => chrome.webNavigation.onCompleted.fire({ tabId, frameId: 0, url }));
        }
        return {};
      }),
      onEvent: makeEvent(),
      onDetach: makeEvent(),
    },
    permissions: {
      request: rec("permissions.request", async () => fake.permissionAnswer),
      remove: rec("permissions.remove", async () => true),
      contains: rec("permissions.contains", async (p) =>
        (p.origins ?? []).every((o) => fake.permissions_.origins.includes(o))),
      onAdded: makeEvent(),
      getAll: rec("permissions.getAll", async () => ({
        origins: fake.permissions_.origins.slice(), permissions: fake.permissions_.permissions.slice(),
      })),
    },
    storage: {
      local: makeArea("local"),
      session: makeArea("session"),
      onChanged: makeEvent(),
    },
    scripting: {
      executeScript: rec("scripting.executeScript", async (injection) => {
        const isPageState = typeof injection.func === "function" && injection.func.name === "replacePageState";
        // readPageState returns its read as one JSON string. Unless the test
        // names another origin, the page shows the origin the reader expects.
        if (typeof injection.func === "function" && injection.func.name === "readPageState") {
          const read = Object.hasOwn(fake.pageRead, "origin") ? fake.pageRead : { origin: injection.args?.[1], ...fake.pageRead };
          return [{ frameId: 0, result: chromeResult(JSON.stringify(read)) }];
        }
        if (fake.autoNavigate && typeof injection.func === "function" && injection.func.name === "leaveRestorePage") {
          const { tabId } = injection.target;
          const url = injection.args?.[0];
          later(() => chrome.webNavigation.onCommitted.fire({ tabId, frameId: 0, url }));
        }
        return [{ frameId: 0, result: isPageState ? chromeResult(structuredClone(fake.pageResult)) : undefined }];
      }),
    },
    webRequest: {
      onBeforeRequest: makeEvent(),
      onErrorOccurred: makeEvent(),
    },
    webNavigation: {
      getAllFrames: rec("webNavigation.getAllFrames", async ({ tabId }) => {
        if (fake.frames_.has(tabId)) return structuredClone(fake.frames_.get(tabId));
        const t = fake.tabs_.find((x) => x.id === tabId);
        return t ? [{ frameId: 0, parentFrameId: -1, url: t.url ?? "", documentLifecycle: "active", frameType: "outermost_frame" }] : null;
      }),
      onErrorOccurred: makeEvent(),
      onCompleted: makeEvent(),
      onCommitted: makeEvent(),
      onBeforeNavigate: makeEvent(),
      onCreatedNavigationTarget: makeEvent(),
    },
  };
  fake.chrome = chrome;
  fake.setTabs = (tabs) => {
    fake.tabs_ = tabs;
  };
  fake.pauseRequest = (tabId, url) => {
    requestSeq += 1;
    const requestId = "rq" + requestSeq;
    fake.paused.set(requestId, { tabId, url });
    later(() =>
      chrome.debugger.onEvent.fire({ tabId }, "Fetch.requestPaused", {
        requestId,
        request: { url, method: "GET" },
        frameId: "F" + tabId,
        resourceType: "Document",
      }));
    return requestId;
  };
  fake.callsTo = (path) => calls.filter(([p]) => p === path).map(([, a]) => a);
  // A tab of fake.tabs_ closes: it goes, with its targets, and tabs.onRemoved fires.
  fake.closeTab = (tabId) => {
    const t = fake.tabs_.find((x) => x.id === tabId) ?? (fake.created_.has(tabId) ? { id: tabId, windowId: fake.created_.get(tabId) } : null);
    if (!t) return;
    fake.tabs_ = fake.tabs_.filter((x) => x.id !== tabId);
    fake.created_.delete(tabId);
    fake.targets_ = fake.targets_.filter((x) => x.tabId !== tabId);
    chrome.tabs.onRemoved.fire(tabId, { windowId: t.windowId, isWindowClosing: false });
  };
  return fake;
}

// A DNR update as Chrome makes it: all or nothing, the removals first; an id
// that is still in use refuses the whole call.
function applyRules(rules, { removeRuleIds = [], addRules = [] } = {}) {
  const kept = rules.filter((r) => !removeRuleIds.includes(r.id));
  for (const r of addRules) {
    if (kept.some((k) => k.id === r.id)) throw new Error(`Rule with id ${r.id} does not have a unique ID.`);
    kept.push(structuredClone(r));
  }
  return kept;
}
