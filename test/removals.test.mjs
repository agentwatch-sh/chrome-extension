// The removal queue and the last window (contract C10, removals and the last window), the
// receiver's close, a client's Page.close with its gate, the orphan set's checks, and a new entry
// after the sweep (part 1a, board ab-v16.31).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REMOVAL_WAIT_MS } from "../agent/removals.js";
import { callsSince, flush, startReceiver } from "./receiver-harness.mjs";

const B = JSON.parse(readFileSync(new URL("./vectors/bridge.json", import.meta.url), "utf8"));
const blank = (id, windowId = 1) => ({ id, windowId, url: "about:blank" });
const target = (id) => ({ id: "T" + id, tabId: id, type: "page", attached: false });
const blanks = (f) => f.callsTo("tabs.create").filter(([p]) => p.url === "about:blank" && p.active === false);
const closeCmds = (f, mark = 0) => callsSince(f, mark).filter(([p, a]) => p === "debugger.sendCommand" && a[1] === "Target.closeTarget").map(([, a]) => a[0].tabId);
const isOpen = (f, id) => f.tabs_.some((t) => t.id === id);

// Tab ids pending: a receiver's close whose command answered with no error and closed no tab, and
// whose fallback (REMOVAL_WAIT_MS after that answer) a beforeunload dialog holds; the item waits
// REMOVAL_WAIT_MS and ends.
async function makePending(s, ids) {
  const sendCommand = s.f.impl["debugger.sendCommand"];
  const remove = s.f.impl["tabs.remove"];
  s.f.impl["debugger.sendCommand"] = async (t, method) => (method === "Target.closeTarget" && ids.includes(t.tabId) ? {} : sendCommand ? sendCommand(t, method) : {});
  s.f.impl["tabs.remove"] = (id) => (ids.includes(id) ? new Promise(() => {}) : remove ? remove(id) : s.f.closeTab(id));
  const done = s.r.removals.closeOwn({ ids });
  await flush();
  await s.fire(REMOVAL_WAIT_MS);
  assert.deepEqual((await done).left, ids);
  assert.deepEqual(s.f.callsTo("tabs.remove").filter(([id]) => ids.includes(id)).map(([id]) => id).sort(), [...ids].sort(), "the held fallbacks");
  s.f.impl["debugger.sendCommand"] = sendCommand;
  if (!sendCommand) delete s.f.impl["debugger.sendCommand"];
  for (const id of ids) assert.equal(s.r.removals.isPending(id), true);
}

test("the window rule: each vector of bridge.json opens about:blank first only when no tab stays open other than the item's tabs and the pending ones", async () => {
  for (const v of B.windowRule) {
    const s = await startReceiver({ tabs: v.open.map((id) => blank(id, 4)), targets: v.open.map(target) });
    if (v.pending.length) await makePending(s, v.pending);
    const before = blanks(s.f).length;
    const r = await s.r.removals.closeOwn({ ids: v.closes });
    assert.equal(blanks(s.f).length - before, v.guard ? 1 : 0, v.note);
    if (v.guard) assert.deepEqual(blanks(s.f).at(-1), [{ windowId: 4, url: "about:blank", active: false }], v.note);
    assert.deepEqual(r.closed, v.closes, v.note);
  }
});

test("two removals at the same time of the browser's only two tabs run one at a time: the second one keeps the last window", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(9)], targets: [target(7), target(9)] });
  s.send({ t: "req", id: "r7", op: "tabs.remove", args: [7] });
  s.send({ t: "req", id: "r9", op: "tabs.remove", args: [9] });
  await flush();
  assert.deepEqual(s.resOf("r7").map((m) => m.data), [null]);
  assert.deepEqual(s.resOf("r9").map((m) => m.data), [null]);
  const order = s.f.calls.map(([p, a]) => (p === "debugger.sendCommand" ? `close ${a[0].tabId}` : p === "tabs.create" ? "blank" : p)).filter((x) => x.startsWith("close") || x === "blank");
  assert.deepEqual(order, ["close 7", "blank", "close 9"]);
});

test("the receiver's close: Target.closeTarget through the bridge's attachment of a bridge tab, or through an attach for the close only, which makes no bridge tab and sends no event", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(8), blank(3)], targets: [target(7), target(8), target(3)] });
  await s.answer({ id: "a7", op: "debugger.attach", args: [7] });
  let mark = s.f.calls.length;
  assert.equal((await s.answer({ id: "r7", op: "tabs.remove", args: [7] })).ok, true);
  assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p.startsWith("debugger.")).map(([p, a]) => [p, a[0], a[1], a[2]]), [
    ["debugger.getTargets", undefined, undefined, undefined],
    ["debugger.sendCommand", { tabId: 7 }, "Target.closeTarget", { targetId: "T7" }],
  ]);
  mark = s.f.calls.length;
  s.f.impl["debugger.sendCommand"] = (t, method, params) => {
    if (method !== "Target.closeTarget") return Promise.resolve({});
    // Events of the attach for the close reach no relay.
    s.f.chrome.debugger.onEvent.fire({ tabId: 8 }, "Page.frameDetached", {});
    s.f.chrome.debugger.onDetach.fire({ tabId: 8 }, "target_closed");
    s.f.closeTab(t.tabId);
    return Promise.reject(new Error("Detached while handling command."));
  };
  const before = s.evs().length;
  assert.equal((await s.answer({ id: "r8", op: "tabs.remove", args: [8] })).ok, true, "Detached while handling command. is no error");
  assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p === "debugger.attach"), [["debugger.attach", [{ tabId: 8 }, "1.3"]]]);
  assert.deepEqual(s.evs().slice(before).map((e) => e.ev), ["tabs.onRemoved"]);
  assert.equal(s.r.att.isBridgeTab(8), false);
  assert.deepEqual(s.f.callsTo("tabs.remove"), [], "no beforeunload: no chrome.tabs.remove");
});

test("the fallback: a failed attach, no target, or a failed command ends the close's own attach and calls chrome.tabs.remove; its error is the op's", async () => {
  const cases = [
    ["the attach fails", (f) => (f.impl["debugger.attach"] = async () => { throw new Error("Another debugger is already attached to the tab"); }), []],
    ["no target", (f) => (f.targets_ = []), [[{ tabId: 7 }]]],
    ["getTargets fails", (f) => (f.impl["debugger.getTargets"] = async () => { throw new Error("no"); }), [[{ tabId: 7 }]]],
    ["the command fails", (f) => (f.impl["debugger.sendCommand"] = async () => { throw new Error("No target with given id found"); }), [[{ tabId: 7 }]]],
  ];
  for (const [name, arrange, detaches] of cases) {
    const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
    arrange(s.f);
    s.f.impl["tabs.remove"] = async (id) => {
      if (name === "the command fails") throw new Error(`No tab with id: ${id}.`);
      s.f.closeTab(id);
    };
    const mark = s.f.calls.length;
    const res = await s.answer({ id: "r", op: "tabs.remove", args: [7] });
    assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p === "debugger.detach").map(([, a]) => a), detaches, name);
    assert.deepEqual(s.f.callsTo("tabs.remove"), [[7]], name);
    if (name === "the command fails") {
      assert.deepEqual(res, { t: "res", ch: "bridge", id: "r", ok: false, error: "No tab with id: 7." }, name);
      assert.equal(s.r.removals.isPending(7), false, `${name}: the close failed and the tab stays`);
    } else {
      assert.equal(res.ok, true, name);
    }
  }
});

test("a command with no answer in REMOVAL_WAIT_MS counts as failed: the fallback runs, and the close stays pending until the command answers", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  let answer;
  s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Target.closeTarget" ? new Promise((res, rej) => (answer = rej)) : Promise.resolve({}));
  s.f.impl["tabs.remove"] = () => Promise.reject(new Error("held"));
  s.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  assert.deepEqual(s.f.callsTo("tabs.remove"), []);
  await s.fire(REMOVAL_WAIT_MS); // the command's limit
  assert.deepEqual(s.f.callsTo("tabs.remove"), [[7]], "the fallback");
  assert.equal(s.r.removals.isPending(7), true, "the command has not answered: Chrome can still run it");
  assert.deepEqual(s.resOf("r"), []);
  // A relay attach of the tab is free again: the chain op ended at the fallback's call.
  s.f.impl["debugger.attach"] = async () => {};
  s.send({ t: "req", id: "a", op: "debugger.attach", args: [7] });
  await flush();
  assert.deepEqual(s.resOf("a").map((m) => m.ok), [true]);
  answer(new Error("Target closed"));
  await flush();
  assert.equal(s.r.removals.isPending(7), false);
  assert.deepEqual(s.resOf("r").map((m) => m.error), ["held"]);
});

test("the chain: a bridge attach in flight ends first and the close uses it; a relay attach during the close waits for its op", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  let attached;
  s.f.impl["debugger.attach"] = () => new Promise((r) => (attached = r));
  s.send({ t: "req", id: "a1", op: "debugger.attach", args: [7] });
  await flush();
  let closed;
  s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Target.closeTarget" ? new Promise((r) => (closed = r)) : Promise.resolve({}));
  s.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  assert.equal(s.f.callsTo("debugger.attach").length, 1);
  assert.equal(closed, undefined, "the close waits for the attach in flight");
  attached();
  await flush();
  assert.equal(typeof closed, "function", "the close runs through the bridge's attachment");
  assert.equal(s.f.callsTo("debugger.attach").length, 1, "no attach of its own");
  // A relay attach of the tab during the close waits for the close's op.
  s.att = s.r.att;
  s.send({ t: "req", id: "a2", op: "debugger.attach", args: [7] });
  await flush();
  assert.deepEqual(s.resOf("a2"), []);
  // A link change now: step 3 never detaches the attach of a running close.
  const mark = s.f.calls.length;
  s.port().fireMessage({ t: "link", up: true });
  await flush();
  assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p === "debugger.detach"), []);
  closed({ success: true });
  s.f.closeTab(7);
  await flush();
  assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p === "debugger.detach").map(([, a]) => a[0].tabId), [7], "the detach of the bridge tab came after the close");
});

test("a client's Page.close runs in the queue with the window rule; each later command of the tab waits at its gate and keeps its order", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7), target(3)] });
  await s.answer({ id: "a", op: "debugger.attach", args: [7] });
  // An earlier item of the queue holds it: the command of tab 3 does not end.
  s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Target.closeTarget" ? new Promise(() => {}) : Promise.resolve({ method }));
  s.send({ t: "req", id: "r3", op: "tabs.remove", args: [3] });
  await flush();
  const mark = s.f.calls.length;
  s.send({ t: "req", id: "pc", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Page.close"] });
  s.send({ t: "req", id: "c1", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Runtime.enable"] });
  s.send({ t: "req", id: "c2", op: "debugger.sendCommand", args: [{ tabId: 7, sessionId: "S1" }, "Runtime.evaluate", { expression: "1" }] });
  s.send({ t: "req", id: "f1", op: "debugger.sendCommand", args: [{ tabId: 8 }, "Page.close"] }); // not attached: refused at once
  await flush();
  assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p === "debugger.sendCommand"), [], "the gate holds the tab's commands");
  assert.deepEqual(s.resOf("f1").map((m) => m.error), ["not attached"]);
  await s.fire(REMOVAL_WAIT_MS); // tab 3's command limit, then its fallback
  await s.fire(REMOVAL_WAIT_MS);
  await flush();
  const methods = callsSince(s.f, mark).filter(([p]) => p === "debugger.sendCommand").map(([, a]) => a[1]);
  assert.deepEqual(methods.filter((m) => m !== "Target.closeTarget"), ["Page.close", "Runtime.enable", "Runtime.evaluate"]);
  assert.deepEqual(["pc", "c1", "c2"].map((id) => s.resOf(id).map((m) => m.data.method)), [["Page.close"], ["Runtime.enable"], ["Runtime.evaluate"]]);
  // The Page.close answered and the tab stays (a beforeunload dialog): it is pending.
  assert.equal(s.r.removals.isPending(7), true);
});

test("a Page.close whose deadline passes in the queue never goes to Chrome, and its gate opens; one on a child session goes at once", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7), target(3)] });
  await s.answer({ id: "a", op: "debugger.attach", args: [7] });
  s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Target.closeTarget" ? new Promise(() => {}) : Promise.resolve({}));
  s.send({ t: "req", id: "r3", op: "tabs.remove", args: [3] });
  await flush();
  const mark = s.f.calls.length;
  s.send({ t: "req", id: "child", op: "debugger.sendCommand", args: [{ tabId: 7, sessionId: "F1" }, "Page.close"] });
  s.send({ t: "req", id: "pc", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Page.close"], wait: 1234 });
  s.send({ t: "req", id: "c1", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Runtime.enable"] });
  await flush();
  assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p === "debugger.sendCommand").map(([, a]) => [a[0], a[1]]), [[{ tabId: 7, sessionId: "F1" }, "Page.close"]]);
  await s.fire(1234);
  assert.deepEqual(s.resOf("pc").map((m) => m.error), ["timeout"]);
  await s.fire(REMOVAL_WAIT_MS);
  await s.fire(REMOVAL_WAIT_MS);
  const methods = callsSince(s.f, mark).filter(([p]) => p === "debugger.sendCommand").map(([, a]) => a[1]);
  assert.ok(!methods.slice(1).includes("Page.close"), "the Page.close never went");
  assert.ok(methods.includes("Runtime.enable"), "the gate opened");
});

test("a later item closes a tab with a pending close again, by the receiver's close; a pending tab counts as closed for the window rule", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(9)], targets: [target(7), target(9)] });
  await s.answer({ id: "a", op: "debugger.attach", args: [7] });
  // The client's Page.close answers, and a dialog holds the tab.
  s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Page.close" ? Promise.resolve({}) : method === "Target.closeTarget" ? (s.f.closeTab(t.tabId), Promise.resolve({})) : Promise.resolve({}));
  s.send({ t: "req", id: "pc", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Page.close"] });
  await flush();
  await s.fire(REMOVAL_WAIT_MS);
  assert.equal(s.r.removals.isPending(7), true);
  // Board ab-v16.43: the item that closes tab 9 counts tab 7 as closed and keeps the last window.
  const before = s.f.callsTo("tabs.create").length;
  assert.equal((await s.answer({ id: "r9", op: "tabs.remove", args: [9] })).ok, true);
  assert.equal(s.f.callsTo("tabs.create").length, before + 1);
  const mark = s.f.calls.length;
  assert.equal((await s.answer({ id: "r7", op: "tabs.remove", args: [7] })).ok, true);
  assert.deepEqual(closeCmds(s.f, mark), [7]);
  assert.equal(s.r.removals.isPending(7), false);
});

test("at a link change the queued bridge requests and the commands behind a gate never reach Chrome and get no answer; the receiver's own closes go on", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(8), blank(3)], targets: [target(7), target(8), target(3)], copy: { "tab:8": "md-old" } });
  await s.answer({ id: "a", op: "debugger.attach", args: [7] });
  let hold;
  s.f.impl["debugger.sendCommand"] = (t, method) => {
    if (method === "Target.closeTarget" && t.tabId === 3 && !hold) return new Promise((r) => (hold = r));
    if (method === "Target.closeTarget") s.f.closeTab(t.tabId);
    return Promise.resolve({});
  };
  s.send({ t: "req", id: "r3", op: "tabs.remove", args: [3] });
  await flush();
  s.send({ t: "req", id: "r7", op: "tabs.remove", args: [7] });
  s.send({ t: "req", id: "pc", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Page.close"] });
  s.send({ t: "req", id: "c1", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Runtime.enable"] });
  const sweep = s.set({ lists: { md: [] }, scopes: { "md-lead": "md" }, default: null }); // tab 8's scope has no list
  await flush();
  const mark = s.f.calls.length;
  s.port().fireMessage({ t: "link", up: true });
  await flush();
  hold({});
  s.f.closeTab(3);
  await flush();
  await sweep;
  const sent = callsSince(s.f, mark).filter(([p]) => p === "debugger.sendCommand").map(([, a]) => [a[0].tabId, a[1]]);
  assert.deepEqual(sent, [[8, "Target.closeTarget"]], "only the sweep's close went");
  assert.ok(isOpen(s.f, 7));
  assert.equal(isOpen(s.f, 8), false);
  assert.deepEqual(["r7", "pc", "c1"].map((id) => s.resOf(id)), [[], [], []]);
  // The new link's commands of tab 7 go at once.
  await s.answer({ id: "a2", op: "debugger.attach", args: [7] });
  const m2 = s.f.calls.length;
  s.send({ t: "req", id: "c2", op: "debugger.sendCommand", args: [{ tabId: 7 }, "Runtime.enable"] });
  assert.deepEqual(callsSince(s.f, m2).filter(([p]) => p === "debugger.sendCommand").map(([, a]) => a[1]), ["Runtime.enable"]);
});

test("the orphan set's check runs again right before the chrome call: an attach that waited in its chain, a command at a gate, and a tabs.remove in the queue get not an agent tab", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(8), blank(3)], targets: [target(7), target(8), target(3)] });
  await s.answer({ id: "a8", op: "debugger.attach", args: [8] });
  let read;
  s.f.impl["tabs.get"] = (id) => new Promise((r) => (read = () => r({ id, url: "about:blank" })));
  s.send({ t: "req", id: "a7", op: "debugger.attach", args: [7] });
  let hold;
  s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Target.closeTarget" && t.tabId === 3 ? new Promise((r) => (hold = r)) : Promise.resolve({}));
  s.send({ t: "req", id: "r3", op: "tabs.remove", args: [3] });
  await flush();
  s.send({ t: "req", id: "pc", op: "debugger.sendCommand", args: [{ tabId: 8 }, "Page.close"] });
  s.send({ t: "req", id: "c8", op: "debugger.sendCommand", args: [{ tabId: 8 }, "Runtime.enable"] });
  s.send({ t: "req", id: "r8", op: "tabs.remove", args: [8] });
  await flush();
  const mark = s.f.calls.length;
  // The end of a sweep item puts tabs 7 and 8 into the orphan set.
  s.r.map.addOrphan(7);
  s.r.map.addOrphan(8);
  read();
  hold({});
  s.f.closeTab(3);
  await flush();
  assert.deepEqual(["a7", "pc", "c8", "r8"].map((id) => s.resOf(id).map((m) => m.error)), [["not an agent tab"], ["not an agent tab"], ["not an agent tab"], ["not an agent tab"]]);
  assert.deepEqual(callsSince(s.f, mark).filter(([p]) => ["debugger.attach", "debugger.sendCommand", "tabs.remove"].includes(p)), []);
});

// ---- a new entry after the sweep ----

test("a tabs.create during a sweep that takes its scope's list: no entry, the new tab joins the orphan set and closes, and the op answers no list for this scope", async () => {
  const s = await startReceiver({ tabs: [blank(3)], scopes: B.setScopes });
  let made;
  s.f.impl["tabs.create"] = () => new Promise((r) => (made = r));
  s.send({ t: "req", id: "c", op: "tabs.create", args: [{ url: "about:blank" }, B.scope] });
  await flush();
  await s.set({ lists: B.setScopes.lists, scopes: { "md-gone": null }, default: null }); // the session of ab-lead ended
  s.f.tabs_.push(blank(40));
  s.f.targets_.push(target(40));
  made({ id: 40, windowId: 1, url: "", pendingUrl: "about:blank" });
  await flush();
  assert.deepEqual(s.resOf("c").map((m) => m.error), ["no list for this scope"]);
  assert.equal(s.r.map.has(40), false);
  assert.equal(isOpen(s.f, 40), false, "closed by the receiver's close");
  assert.deepEqual(s.f.storage_.session, {});
});

test("a tabs.create whose rule update fails: the new tab closes, the op answers the error, and the scope rules fail closed", async () => {
  const s = await startReceiver({ tabs: [blank(3), blank(9)], copy: { "tab:9": B.scope }, scopes: B.setScopes });
  assert.equal(s.f.sessionRules_.length, 2);
  s.f.impl["tabs.create"] = async (p) => {
    s.f.tabs_.push(blank(41));
    s.f.targets_.push(target(41));
    return { id: 41, ...p };
  };
  s.f.impl["declarativeNetRequest.updateSessionRules"] = async (d) => {
    if (d.addRules && d.addRules.length > 0) throw new Error("Session rule count exceeded.");
    s.f.sessionRules_ = s.f.sessionRules_.filter((r) => !d.removeRuleIds.includes(r.id));
  };
  const res = await s.answer({ id: "c", op: "tabs.create", args: [{ url: "about:blank" }, B.scope] });
  assert.deepEqual(res.error, "Session rule count exceeded.");
  assert.equal(isOpen(s.f, 41), false);
  assert.equal(s.r.map.has(41), false);
  assert.deepEqual(s.f.sessionRules_, [], "fail closed");
});

test("tabs.create answers when the tab's scope rule is in force and its key is in the copy; a scope with no list gets no tab", async () => {
  const s = await startReceiver({ tabs: [blank(3)] });
  const res0 = await s.answer({ id: "c0", op: "tabs.create", args: [{ url: "about:blank" }, B.scope] });
  assert.deepEqual(res0.error, "no list for this scope", "before the first applied set_scopes every scope has no list");
  assert.deepEqual(s.f.callsTo("tabs.create"), []);
  await s.set(B.setScopes);
  let wrote;
  s.f.impl["storage.session.set"] = (items) => new Promise((r) => (wrote = () => {
    Object.assign(s.f.storage_.session, items);
    r();
  }));
  s.send({ t: "req", id: "c1", op: "tabs.create", args: [{ url: "about:blank", active: false }, B.scope] });
  await flush();
  const id = s.f.callsTo("tabs.create").length && s.r.map.list()[0].tabId;
  assert.deepEqual(s.f.sessionRules_.find((r) => r.id === 100).condition.tabIds, [id], "the rule is in force");
  assert.deepEqual(s.resOf("c1"), [], "the key is not in the copy yet");
  wrote();
  await flush();
  assert.equal(s.resOf("c1")[0].ok, true);
  assert.deepEqual(s.f.storage_.session, { ["tab:" + id]: B.scope });
  // windows.create: the window's tab gets the scope.
  delete s.f.impl["storage.session.set"];
  s.f.impl["windows.create"] = async (d) => ({ id: 5, ...d, tabs: [{ id: 50, windowId: 5, url: "", pendingUrl: "about:blank" }] });
  const w = await s.answer({ id: "w", op: "windows.create", args: [{ url: "about:blank", focused: false }, B.scope] });
  assert.equal(w.ok, true);
  assert.equal(s.r.map.scopeOf(50), B.scope);
  assert.deepEqual(s.f.sessionRules_.find((r) => r.id === 100).condition.tabIds, [id, 50]);
});

// review-20 note 1 (a surviving mutation): "Detached while handling command." is no error, also when the
// command answers before the tab's tabs.onRemoved: no fallback runs.
test("Target.closeTarget that answers Detached while handling command. before the tab's tabs.onRemoved: no fallback, and the op answers at the close", async () => {
  const s = await startReceiver({ tabs: [blank(3), blank(8)], targets: [target(8)] });
  let removed;
  s.f.impl["debugger.sendCommand"] = async (t, m) => {
    if (m !== "Target.closeTarget") return {};
    removed = () => s.f.closeTab(8);
    throw new Error("Detached while handling command.");
  };
  s.send({ t: "req", id: "r", op: "tabs.remove", args: [8] });
  await flush();
  assert.deepEqual(s.resOf("r"), [], "the close ends at the tab's tabs.onRemoved");
  assert.deepEqual(s.f.callsTo("tabs.remove"), [], "no fallback");
  removed();
  await flush();
  assert.deepEqual(s.resOf("r").map((m) => m.data), [null]);
  assert.deepEqual(s.f.callsTo("tabs.remove"), []);
});

// Board ab-v16.63 (measured, Chromium 156): a Target.closeTarget that reaches Chrome shortly before the
// tab's navigation commits answers {success: true}, and Chrome drops the close: the tab stays open, and
// no tabs.onRemoved comes. Such a close counts as failed REMOVAL_WAIT_MS after its answer: the fallback runs.
test("a Target.closeTarget that answers with no error but closes no tab: the fallback runs REMOVAL_WAIT_MS after the answer, and the op answers at the close", async () => {
  const noClose = (s) => {
    s.f.impl["debugger.sendCommand"] = async (t, m) => (m === "Target.closeTarget" ? { success: true } : {});
  };
  // A bridge tab (the eager attach's attachment): the fallback keeps that attachment.
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  await s.answer({ id: "a", op: "debugger.attach", args: [7] });
  noClose(s);
  s.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  assert.deepEqual(closeCmds(s.f), [7]);
  assert.deepEqual(s.resOf("r"), [], "the close ends at the tab's tabs.onRemoved");
  assert.deepEqual(s.f.callsTo("tabs.remove"), [], "no fallback before the limit");
  await s.fire(REMOVAL_WAIT_MS); // the item's wait, and the close's limit after the command's answer
  await flush();
  assert.deepEqual(s.f.callsTo("tabs.remove"), [[7]], "the fallback");
  assert.deepEqual(s.f.callsTo("debugger.detach"), [], "the bridge's attachment stays");
  assert.deepEqual(s.resOf("r").map((m) => m.data), [null]);
  assert.equal(isOpen(s.f, 7), false);
  assert.equal(s.r.removals.isPending(7), false);

  // An attach for the close only: the fallback ends it first, then calls chrome.tabs.remove.
  const o = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  noClose(o);
  const mark = o.f.calls.length;
  o.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  await o.fire(REMOVAL_WAIT_MS);
  await flush();
  const order = callsSince(o.f, mark).map(([p]) => p).filter((p) => ["debugger.attach", "debugger.detach", "tabs.remove"].includes(p));
  assert.deepEqual(order, ["debugger.attach", "debugger.detach", "tabs.remove"]);
  assert.deepEqual(o.resOf("r").map((m) => m.data), [null]);

  // A failed fallback: the close fails, the tab stays and is not pending, and the op answers the error.
  const e = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  await e.answer({ id: "a", op: "debugger.attach", args: [7] });
  noClose(e);
  e.f.impl["tabs.remove"] = async (id) => {
    throw new Error(`No tab with id: ${id}.`);
  };
  e.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  await e.fire(REMOVAL_WAIT_MS);
  await flush();
  assert.deepEqual(e.resOf("r").map((m) => m.error), ["No tab with id: 7."]);
  assert.equal(e.r.removals.isPending(7), false);

  // The tab's tabs.onRemoved before the limit: the close ends there, and no fallback runs later.
  const l = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  await l.answer({ id: "a", op: "debugger.attach", args: [7] });
  noClose(l);
  l.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  l.f.closeTab(7);
  await flush();
  assert.deepEqual(l.resOf("r").map((m) => m.data), [null]);
  assert.equal(l.pending(REMOVAL_WAIT_MS).length, 0, "no timer of the close is left");
  await l.fire(REMOVAL_WAIT_MS);
  assert.deepEqual(l.f.callsTo("tabs.remove"), [], "no fallback");

  // A no-error answer after the command's limit, when the fallback ran already and failed: the close
  // ends REMOVAL_WAIT_MS after that answer, with the fallback's error, and no second fallback runs.
  const d = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  await d.answer({ id: "a", op: "debugger.attach", args: [7] });
  let answer;
  d.f.impl["debugger.sendCommand"] = (t, m) => (m === "Target.closeTarget" ? new Promise((res) => (answer = res)) : Promise.resolve({}));
  d.f.impl["tabs.remove"] = () => Promise.reject(new Error("held"));
  d.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  await d.fire(REMOVAL_WAIT_MS); // the command's limit: the fallback fails
  assert.deepEqual(d.f.callsTo("tabs.remove"), [[7]]);
  assert.equal(d.r.removals.isPending(7), true, "the command has not answered");
  answer({ success: true });
  await flush();
  assert.equal(d.r.removals.isPending(7), true, "the tab can still close");
  await d.fire(REMOVAL_WAIT_MS);
  assert.deepEqual(d.resOf("r").map((m) => m.error), ["held"]);
  assert.equal(d.r.removals.isPending(7), false);
  assert.deepEqual(d.f.callsTo("tabs.remove"), [[7]], "one fallback");
});

// review-26 B1: the fallback of a dropped close is one op of the tab's chain (C10): while a second
// close's command runs through the first close's own attach, that fallback neither ends the attach
// (a detach makes the running command fail) nor calls chrome.tabs.remove.
test("a dropped close's fallback waits in the tab's chain while a second close's command runs", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  let n = 0;
  let answer2;
  s.f.impl["debugger.sendCommand"] = (t, m) => {
    if (m !== "Target.closeTarget") return Promise.resolve({});
    n += 1;
    if (n === 1) return Promise.resolve({ success: true }); // the dropped close
    return new Promise((res) => (answer2 = res));
  };
  s.send({ t: "req", id: "r1", op: "tabs.remove", args: [7] });
  await flush();
  const [itemWait, watch, ...more] = s.pending(REMOVAL_WAIT_MS);
  assert.ok(itemWait && watch && more.length === 0, "the item's wait and the close's watch");
  s.send({ t: "req", id: "r2", op: "tabs.remove", args: [7] });
  await flush();
  itemWait.cleared = true;
  itemWait.fn();
  await flush();
  assert.equal(n, 2, "the second close's command runs (through the first close's own attach)");
  const mark = s.f.calls.length;
  watch.cleared = true;
  watch.fn();
  await flush();
  const ends = () => callsSince(s.f, mark).map(([p]) => p).filter((p) => p === "debugger.detach" || p === "tabs.remove");
  assert.deepEqual(ends(), [], "no detach and no tabs.remove while that command runs");
  answer2({ success: true });
  await flush();
  assert.deepEqual(ends(), ["debugger.detach", "tabs.remove"]);
  assert.deepEqual(s.resOf("r1").map((m) => m.data), [null]);
  assert.deepEqual(s.resOf("r2").map((m) => m.data), [null]);
  assert.equal(s.r.removals.isPending(7), false);
});

test("N1: a dropped close's fallback keeps a borrowed attachment while the second command runs past its limit", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  let n = 0;
  let fail2;
  s.f.impl["debugger.sendCommand"] = (t, m) => {
    if (m !== "Target.closeTarget") return Promise.resolve({});
    if (++n === 1) return Promise.resolve({ success: true });
    return new Promise((res, rej) => (fail2 = rej));
  };
  s.f.impl["tabs.remove"] = async () => { throw new Error("held"); };
  s.send({ t: "req", id: "r1", op: "tabs.remove", args: [7] });
  await flush();
  const [itemWait, watch] = s.pending(REMOVAL_WAIT_MS);
  s.send({ t: "req", id: "r2", op: "tabs.remove", args: [7] });
  itemWait.cleared = true;
  itemWait.fn();
  await flush();
  assert.equal(n, 2, "the second close borrows the first close's attachment");
  watch.cleared = true;
  watch.fn();
  await s.fire(REMOVAL_WAIT_MS); // the second command times out; its fallback fails
  assert.deepEqual(s.f.callsTo("tabs.remove"), [[7]], "only the second close's fallback runs");
  assert.deepEqual(s.f.callsTo("debugger.detach"), [], "the borrowed attachment still runs the command");
  assert.deepEqual(s.resOf("r2"), [], "the failed fallback waits for the command's answer");
  delete s.f.impl["tabs.remove"];
  fail2(new Error("close refused"));
  await flush();
  assert.deepEqual(s.f.callsTo("debugger.detach"), [[{ tabId: 7 }]]);
  assert.deepEqual(s.f.callsTo("tabs.remove"), [[7], [7]]);
  assert.deepEqual(s.resOf("r1").map((m) => m.data), [null]);
  assert.deepEqual(s.resOf("r2").map((m) => m.error), ["held"]);
  assert.equal(isOpen(s.f, 7), false);
  assert.equal(s.r.removals.isPending(7), false);
  assert.equal(s.pending(REMOVAL_WAIT_MS).length, 0, "the command's answer cancels the deferred retry");
});

test("N1: a borrowed command that never answers holds no queue or later close", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3), blank(9)], targets: [target(7), target(3)] });
  let n = 0;
  s.f.impl["debugger.sendCommand"] = async (t, m) => {
    if (m !== "Target.closeTarget") return {};
    if (t.tabId === 7 && ++n === 1) return { success: true };
    if (t.tabId === 7 && n === 2) return new Promise(() => {});
    s.f.closeTab(t.tabId);
    return { success: true };
  };
  s.f.impl["tabs.remove"] = async () => { throw new Error("held"); };
  s.send({ t: "req", id: "r1", op: "tabs.remove", args: [7] });
  await flush();
  const [itemWait, watch] = s.pending(REMOVAL_WAIT_MS);
  s.send({ t: "req", id: "r2", op: "tabs.remove", args: [7] });
  itemWait.cleared = true;
  itemWait.fn();
  await flush();
  watch.cleared = true;
  watch.fn();
  await s.fire(REMOVAL_WAIT_MS);
  assert.deepEqual(s.f.callsTo("tabs.remove"), [[7]]);
  assert.equal((await s.answer({ id: "other-tab", op: "tabs.remove", args: [3] })).ok, true);
  assert.equal((await s.answer({ id: "same-tab", op: "tabs.remove", args: [7] })).ok, true);
  assert.equal(n, 3, "a later close runs although the borrowed command never answers");
  assert.deepEqual(s.resOf("r1").map((m) => m.data), [null]);
  assert.deepEqual(s.resOf("r2").map((m) => m.data), [null]);
  assert.deepEqual(s.f.callsTo("debugger.detach"), []);
  assert.deepEqual(s.f.callsTo("tabs.remove"), [[7]], "the old watch skips the removed tab");
  assert.equal(s.pending(REMOVAL_WAIT_MS).length, 0, "tab removal cancels the deferred retry");
});

test("N1: a borrowed command that never answers gets one bounded retry and leaves no retry timer", async () => {
  for (const retryFails of [false, true]) {
    const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
    let n = 0;
    s.f.impl["debugger.sendCommand"] = async () => (++n === 1 ? { success: true } : new Promise(() => {}));
    let removes = 0;
    s.f.impl["tabs.remove"] = async (id) => {
      if (++removes === 1 || retryFails) throw new Error("held");
      s.f.closeTab(id);
    };
    s.send({ t: "req", id: "r1", op: "tabs.remove", args: [7] });
    await flush();
    const [itemWait, watch] = s.pending(REMOVAL_WAIT_MS);
    s.send({ t: "req", id: "r2", op: "tabs.remove", args: [7] });
    itemWait.cleared = true;
    itemWait.fn();
    await flush();
    watch.cleared = true;
    watch.fn();
    await s.fire(REMOVAL_WAIT_MS); // the borrowed command's limit and first fallback
    assert.deepEqual(s.f.callsTo("tabs.remove"), [[7]]);
    assert.deepEqual(s.resOf("r1"), []);
    await s.fire(REMOVAL_WAIT_MS); // the deferred fallback's extra limit
    assert.deepEqual(s.f.callsTo("tabs.remove"), [[7], [7]], "exactly one retry");
    assert.deepEqual(s.f.callsTo("debugger.detach"), [], "the command still runs");
    assert.deepEqual(s.resOf("r1").map((m) => retryFails ? m.error : m.data), [retryFails ? "held" : null]);
    assert.equal(isOpen(s.f, 7), retryFails);
    assert.equal(s.pending(REMOVAL_WAIT_MS).length, 0, "no retry timer stays after either result");
    await s.fire(REMOVAL_WAIT_MS);
    assert.deepEqual(s.f.callsTo("tabs.remove"), [[7], [7]], "no repeated retry");
  }
});

test("N2: a dropped close's watch keeps the new bridge attachment after a link reset", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  s.f.trackAttachments = true;
  s.f.impl["debugger.sendCommand"] = async () => ({ success: true });
  const done = s.r.removals.closeOwn({ ids: [7] });
  await flush();
  assert.equal(s.r.att.isAttached(7), true, "the close owns an attachment");
  s.port().fireMessage({ t: "link", up: true });
  await flush();
  assert.equal((await s.f.chrome.debugger.getTargets())[0].attached, false, "reset detached the close's attachment");
  assert.equal((await s.answer({ id: "new-attach", op: "debugger.attach", args: [7] })).ok, true);
  s.f.impl["tabs.remove"] = async () => { throw new Error("held"); };
  const mark = s.f.calls.length;
  await s.fire(REMOVAL_WAIT_MS);
  await done;
  assert.deepEqual(callsSince(s.f, mark).filter(([p]) => p === "debugger.detach"), [], "the old watch never detaches the new bridge");
  assert.equal((await s.f.chrome.debugger.getTargets())[0].attached, true);
  assert.equal(s.r.att.isBridgeTab(7), true);
  assert.equal(s.r.removals.isPending(7), false);
});

test("N3: a tab removed during the fallback's detach gets no tabs.remove call", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  s.f.impl["debugger.sendCommand"] = async () => { throw new Error("close refused"); };
  let detached;
  s.f.impl["debugger.detach"] = () => new Promise((res) => (detached = res));
  s.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  assert.equal(typeof detached, "function");
  s.f.closeTab(7);
  detached();
  await flush();
  assert.deepEqual(s.resOf("r").map((m) => m.data), [null]);
  assert.deepEqual(s.f.callsTo("tabs.remove"), [], "tabs.onRemoved ended the close during detach");
  assert.equal(s.r.removals.isPending(7), false);
});

// review-20 note 2: the fallback never ends its own attach while Target.closeTarget still runs (a detach
// before the command's answer makes the command fail, review-17b E4b); it ends it after the answer.
test("a command with no answer in time: the fallback calls chrome.tabs.remove at once, and ends the close's own attach only after the command answered", async () => {
  const s = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  let answer;
  s.f.impl["debugger.sendCommand"] = (t, method) => (method === "Target.closeTarget" ? new Promise((res) => (answer = res)) : Promise.resolve({}));
  s.f.impl["tabs.remove"] = () => new Promise(() => {}); // a beforeunload dialog holds it
  s.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  await s.fire(REMOVAL_WAIT_MS);
  assert.deepEqual(s.f.callsTo("tabs.remove"), [[7]], "the fallback ran");
  assert.deepEqual(s.f.callsTo("debugger.detach"), [], "no detach while the command runs");
  answer({ success: true });
  s.f.closeTab(7);
  await flush();
  assert.deepEqual(s.resOf("r").map((m) => m.data), [null]);
  // A command that answers with an error, and a tab that stays: the own attach ends then.
  const t = await startReceiver({ tabs: [blank(7), blank(3)], targets: [target(7)] });
  let fail;
  t.f.impl["debugger.sendCommand"] = (x, method) => (method === "Target.closeTarget" ? new Promise((res, rej) => (fail = rej)) : Promise.resolve({}));
  t.f.impl["tabs.remove"] = () => Promise.reject(new Error("held"));
  t.send({ t: "req", id: "r", op: "tabs.remove", args: [7] });
  await flush();
  await t.fire(REMOVAL_WAIT_MS);
  assert.deepEqual(t.f.callsTo("debugger.detach"), []);
  fail(new Error("Target closed"));
  await flush();
  assert.deepEqual(t.f.callsTo("debugger.detach"), [[{ tabId: 7 }]], "the own attach ends after the answer");
  assert.deepEqual(t.resOf("r").map((m) => m.error), ["held"]);
});

// review-20 Q3 (C10): a failed copy write is a failed rule update: the new tab joins the orphan set and
// closes, and the op answers the error.
test("a tabs.create or windows.create whose copy write fails: the new tab joins the orphan set and closes, and the op answers the error", async () => {
  for (const op of ["tabs.create", "windows.create"]) {
    const s = await startReceiver({ tabs: [blank(3), blank(9)], copy: { "tab:9": B.scope }, scopes: B.setScopes });
    s.f.impl["storage.session.set"] = async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    };
    s.f.impl["tabs.create"] = async (p) => {
      s.f.tabs_.push(blank(41));
      s.f.targets_.push(target(41));
      return { id: 41, ...p };
    };
    s.f.impl["windows.create"] = async (d) => {
      s.f.tabs_.push(blank(41, 6));
      s.f.targets_.push(target(41));
      return { id: 6, ...d, tabs: [{ id: 41, windowId: 6 }] };
    };
    const args = op === "tabs.create" ? [{ url: "about:blank" }, B.scope] : [{ url: "about:blank", focused: false }, B.scope];
    const res = await s.answer({ id: "c", op, args });
    assert.equal(res.error, "QUOTA_BYTES quota exceeded", op);
    assert.equal(s.r.map.has(41), false, op);
    assert.equal(isOpen(s.f, 41), false, `${op}: closed`);
    assert.deepEqual(s.f.sessionRules_.find((r) => r.id === 100).condition.tabIds, [9], `${op}: its rule went`);
  }
});
