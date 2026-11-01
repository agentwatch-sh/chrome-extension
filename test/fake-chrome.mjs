// A small fake of the chrome APIs the receiver uses. Every call is recorded in
// fake.calls as [apiPath, args]. A test replaces one API's behaviour with
// fake.impl[apiPath] = (...args) => result.
//
// The fake models one browser behaviour for the restore page: when
// fake.autoNavigate is true (the default), tabs.update fires
// debugger.onEvent "Fetch.requestPaused" for the new URL, and a later
// "Fetch.fulfillRequest" for that request fires webNavigation.onCompleted.

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
    };
  }
  const chrome = {
    runtime: {
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
      openOptionsPage: rec("runtime.openOptionsPage", async () => {}),
      onMessage: makeEvent(),
    },
    declarativeNetRequest: {
      updateDynamicRules: rec("declarativeNetRequest.updateDynamicRules", async () => {}),
    },
    tabs: {
      query: rec("tabs.query", async () => fake.tabs_.map((t) => ({ ...t }))),
      remove: rec("tabs.remove", async () => {}),
      create: rec("tabs.create", async (props) => ({ id: 900 + calls.length, ...props })),
      update: rec("tabs.update", async (tabId, props) => {
        if (fake.autoNavigate) fake.pauseRequest(tabId, props.url);
        return { id: tabId, ...props };
      }),
    },
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
      attach: rec("debugger.attach", async () => {}),
      detach: rec("debugger.detach", async () => {}),
      sendCommand: rec("debugger.sendCommand", async (target, method, params) => {
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
        if (typeof injection.func === "function" && injection.func.name === "readPageState") {
          return [{ frameId: 0, result: structuredClone(fake.pageRead) }];
        }
        return [{ frameId: 0, result: isPageState ? structuredClone(fake.pageResult) : undefined }];
      }),
    },
    webNavigation: {
      onErrorOccurred: makeEvent(),
      onCompleted: makeEvent(),
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
  return fake;
}
