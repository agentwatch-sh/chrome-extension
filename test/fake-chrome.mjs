// A small fake of the chrome APIs the receiver uses. Every call is recorded in
// fake.calls as [apiPath, args]. Later tasks add cookies, debugger and scripting.

function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    fire: (...args) => listeners.map((fn) => fn(...args)),
    listeners,
  };
}

export function makeFakeChrome() {
  const calls = [];
  const rec = (path, impl) => (...args) => {
    calls.push([path, args]);
    return impl ? impl(...args) : undefined;
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
  const fake = {
    calls,
    ports: [],
    tabs_: [],
    manifest: { version: "0.1.0" },
    chrome: null,
  };
  const chrome = {
    runtime: {
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
    },
    declarativeNetRequest: {
      updateDynamicRules: rec("declarativeNetRequest.updateDynamicRules", async () => {}),
    },
    tabs: {
      query: rec("tabs.query", async () => fake.tabs_.map((t) => ({ ...t }))),
      remove: rec("tabs.remove", async () => {}),
      create: rec("tabs.create", async (props) => ({ id: 900 + calls.length, ...props })),
    },
    webNavigation: {
      onErrorOccurred: makeEvent(),
    },
  };
  fake.chrome = chrome;
  fake.setTabs = (tabs) => {
    fake.tabs_ = tabs;
  };
  fake.callsTo = (path) => calls.filter(([p]) => p === path).map(([, a]) => a);
  return fake;
}
