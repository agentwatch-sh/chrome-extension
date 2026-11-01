// Build the C2 payload from a tab, send it to a box, and report in plain
// words. It never touches the DOM: the service worker uses it. No text it
// builds holds a cookie value, a storage value or a response body.
import { normalizeEntry, covers, domainCandidates, fallbackDomain } from "./lib/domains.js";
import { dedupe, inScope } from "./lib/cookies.js";
import { readPageState } from "./read-page.js";

export const MAX_SEND_BYTES = 33554432;
const MIB = 1048576;

const encoder = new TextEncoder();
const byteLength = (s) => encoder.encode(s).length;
const mib = (n) => (n / MIB).toFixed(1);
const hostOf = (box) => {
  try {
    return new URL(box).host;
  } catch {
    return String(box);
  }
};
const loginLink = (box) => box + "/login?next=/browser";

// ---- the domain choice ----

export function domainChoices(host) {
  if (host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [];
  return domainCandidates(host).filter((d) => d.includes("."));
}

export async function chooseDomain(chrome, tabId, host) {
  const choices = domainChoices(host);
  try {
    const r = await chrome.cookies.getPartitionKey({ tabId, frameId: 0 });
    const site = r?.partitionKey?.topLevelSite;
    if (typeof site === "string") {
      const top = new URL(site).hostname;
      if (choices.includes(top)) return top;
    }
  } catch {
    // No partition key: use the fallback.
  }
  return fallbackDomain(host);
}

// ---- the payload ----

function cleanCookie(c) {
  const out = {
    name: c.name, value: c.value, domain: c.domain, hostOnly: !!c.hostOnly, path: c.path,
    secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite ?? "unspecified", session: !!c.session,
  };
  if (!c.session) out.expirationDate = c.expirationDate;
  if (c.partitionKey) {
    out.partitionKey = { topLevelSite: c.partitionKey.topLevelSite };
    if (c.partitionKey.hasCrossSiteAncestor !== undefined) {
      out.partitionKey.hasCrossSiteAncestor = c.partitionKey.hasCrossSiteAncestor;
    }
  }
  return out;
}

export async function buildPayload(chrome, { tabId, url, domain }) {
  const origin = new URL(url).origin;
  const plain = await chrome.cookies.getAll({ domain });
  const partitioned = await chrome.cookies.getAll({ domain, partitionKey: {} });
  const cookies = dedupe([...plain, ...partitioned]).filter((c) => inScope(c, domain)).map(cleanCookie);

  await chrome.scripting.executeScript({ target: { tabId }, files: ["lib/codec.js"] });
  const [injected] = await chrome.scripting.executeScript({ target: { tabId }, func: readPageState });
  if (typeof injected?.result !== "string") throw new Error("no page read");
  const { storage, skipped } = JSON.parse(injected.result);

  const payload = { v: 1, domain, url, origin, cookies, storage };
  const json = JSON.stringify(payload);
  let largest = null;
  for (const db of storage.idb) {
    const n = byteLength(JSON.stringify(db));
    if (largest === null || n > largest.bytes) largest = { name: db.name, bytes: n };
  }
  return { payload, json, bytes: byteLength(json), largest, skipped: skipped ?? [] };
}

export function tooLargeText(bytes, largest) {
  let t = `This site's state is too large to send (${mib(bytes)} MiB; the limit is ${MAX_SEND_BYTES / MIB} MiB).`;
  if (largest) t += ` The largest part is the database "${largest.name}" (${mib(largest.bytes)} MiB).`;
  return t;
}

// ---- the send ----

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorCode(j) {
  const c = j?.error_code ?? j?.data?.error_code;
  return typeof c === "string" ? c : "";
}

function findCounts(j) {
  for (const c of [j?.data?.counts, j?.counts, j?.data, j]) {
    if (c && typeof c === "object" && "cookies_set" in c) return c;
  }
  return null;
}

export function resultText(result, box) {
  const host = hostOf(box);
  switch (result.kind) {
    case "ok": {
      const c = result.counts ?? {};
      const n = (v) => (Number.isFinite(v) ? v : 0);
      let t = `Sent ${result.domain ?? "the site"} to ${host}: ${n(c.cookies_set)} cookies, ` +
        `${n(c.local) + n(c.session)} storage keys, ${n(c.idb_databases)} databases ` +
        `(${n(c.idb_records)} records), ${n(c.cache_entries)} cache entries`;
      if (n(c.errors) > 0) t += `, ${c.errors} problems`;
      return t + ".";
    }
    case "password": return `Log in to ${host} with your password, then send again.`;
    case "login": return `Log in to ${host} first.`;
    case "too-large": return "The box refused the send: it is too large.";
    case "unsupported": return "This box's agentwatch has no agent browser yet.";
    case "unreachable": return `Cannot reach ${host}.`;
    default: return `The box refused the send (HTTP ${result.status}).`;
  }
}

export async function sendState(fetchImpl, { box, user, body, domain }) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  let res;
  try {
    res = await fetchImpl(box + "/api/browser/send?user=" + encodeURIComponent(user), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
  } catch {
    return finish({ kind: "unreachable", status: 0, domain }, box);
  }
  const status = res.status;
  const j = await readJson(res);
  const code = errorCode(j);
  const result = { status, domain };
  if (status === 200) {
    const c = findCounts(j);
    result.kind = "ok";
    result.counts = c && { ...c, errors: Array.isArray(c.errors) ? c.errors.length : 0 };
  } else if (status === 403 && code === "password_login_required") {
    result.kind = "password";
  } else if (status === 401) {
    result.kind = "login";
  } else if (status === 413) {
    result.kind = "too-large";
  } else if (status === 409 && code === "browser_unsupported") {
    result.kind = "unsupported";
  } else {
    result.kind = "refused";
  }
  return finish(result, box);
}

function finish(result, box) {
  const out = { ...result, text: resultText(result, box) };
  if (result.kind === "password" || result.kind === "login") out.link = loginLink(box);
  return out;
}

// ---- the box's users ----

export async function fetchTargets(fetchImpl, box) {
  let res;
  try {
    res = await fetchImpl(box + "/api/browser/targets", { credentials: "include" });
  } catch {
    return { kind: "unreachable", text: resultText({ kind: "unreachable" }, box) };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: "login", text: resultText({ kind: "login" }, box), link: loginLink(box) };
  }
  const j = await readJson(res);
  const users = j?.data?.users ?? j?.users;
  if (res.status !== 200 || !Array.isArray(users)) {
    return { kind: "refused", text: resultText({ kind: "refused", status: res.status }, box) };
  }
  return { kind: "ok", users };
}

// ---- the worker's job ----

export function readableSites(origins, boxes) {
  const boxPatterns = new Set(boxes.map((b) => b + "/*"));
  return origins.filter((o) => !boxPatterns.has(o));
}

async function say(chrome, scope, state, text, extra = {}) {
  await chrome.storage.session.set({ lastSend: { state, text, domain: scope.domain, at: Date.now(), ...extra } });
}

export async function runSend(chrome, fetchImpl, msg) {
  const { tabId, url, domain, box, user } = msg ?? {};
  try {
    const { boxes = [] } = await chrome.storage.local.get("boxes");
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      // Falls through to the check below.
    }
    const entry = typeof domain === "string" ? normalizeEntry(domain) : { ok: false };
    if (!boxes.includes(box) || typeof user !== "string" || user === "" || !entry.ok ||
        entry.entry !== domain || !covers(domain, host) || !Number.isInteger(tabId)) {
      return await say(chrome, msg ?? {}, "error", "The send request is not valid.");
    }
    await say(chrome, msg ?? {}, "reading", `Reading ${domain}...`);
    let built;
    try {
      built = await buildPayload(chrome, { tabId, url, domain });
    } catch {
      return await say(chrome, msg ?? {}, "error", "Could not read this page. Reload the tab and try again.");
    }
    if (built.bytes > MAX_SEND_BYTES) {
      return await say(chrome, msg ?? {}, "error", tooLargeText(built.bytes, built.largest));
    }
    await say(chrome, msg ?? {}, "sending", `Sending ${domain} to ${hostOf(box)}...`);
    const result = await sendState(fetchImpl, { box, user, body: built.json, domain });
    const ok = result.kind === "ok";
    let text = result.text;
    if (ok && built.skipped.length > 0) text += ` Left out: ${built.skipped.join(", ")}.`;
    const extra = {};
    if (result.link) extra.link = result.link;
    if (result.counts) extra.counts = result.counts;
    await say(chrome, msg ?? {}, ok ? "done" : "error", text, extra);
  } catch {
    await say(chrome, msg ?? {}, "error", "The send failed.");
  }
}

// ---- the hand-off from the popup ----
//
// Chrome closes the popup when it shows its permission dialog, and a message
// from the closing popup to a stopped worker is lost (both measured on
// Chromium 156). So the popup writes the send to storage.session in the same
// task as permissions.request; that write reaches Chrome before the popup
// closes. The worker runs it when storage.onChanged or permissions.onAdded
// wakes it, once Chrome gives the access to the site. A send that waits
// longer than PENDING_MS is dropped.

export const PENDING_MS = 2 * 60 * 1000;

export function siteOrigins(domain) {
  return ["*://*." + domain + "/*"];
}

async function hasAccess(chrome, domain) {
  try {
    return await chrome.permissions.contains({ origins: siteOrigins(domain) });
  } catch {
    return false;
  }
}

// The popup's half: it must start before the click handler's first await.
export function queueSend(chrome, ctx) {
  const pendingSend = {
    tabId: ctx.tabId, url: ctx.url, domain: ctx.domain, box: ctx.box, user: ctx.user, at: Date.now(),
  };
  return chrome.storage.session.set({ pendingSend });
}

// The worker's half. Calls run one after another, so one pending send runs once.
let resumeChain = Promise.resolve();

export function resumeSend(chrome, fetchImpl, now) {
  const run = resumeChain.then(() => resumeOnce(chrome, fetchImpl, now ?? Date.now()));
  resumeChain = run.catch(() => {});
  return run;
}

async function resumeOnce(chrome, fetchImpl, now) {
  const { pendingSend: pending, lastSend: last } = await chrome.storage.session.get(["pendingSend", "lastSend"]);
  if (!pending || typeof pending !== "object") return;
  if (!(now - pending.at <= PENDING_MS)) {
    await chrome.storage.session.remove("pendingSend");
    return;
  }
  const { at, ...msg } = pending;
  if (typeof msg.domain !== "string" || !normalizeEntry(msg.domain).ok) {
    await chrome.storage.session.remove("pendingSend");
    await say(chrome, msg, "error", "The send request is not valid.");
    return;
  }
  if (!(await hasAccess(chrome, msg.domain))) {
    if (!(last && last.state === "waiting" && last.at === at && last.domain === msg.domain)) {
      await chrome.storage.session.set({
        lastSend: { state: "waiting", text: `Waiting for Chrome's access to ${msg.domain}...`, domain: msg.domain, at },
      });
    }
    return;
  }
  await chrome.storage.session.remove("pendingSend");
  await runSend(chrome, fetchImpl, msg);
}

export const STALE_MS = 3 * 60 * 1000;

// What the popup shows for a stored lastSend on this tab's domain, or null.
export function visibleStatus(last, domain, now = Date.now()) {
  if (!last || last.domain !== domain) return null;
  if (last.state === "waiting" && now - last.at > PENDING_MS) {
    return { state: "error", text: `Chrome did not give access to ${domain}.` };
  }
  if ((last.state === "reading" || last.state === "sending") && now - last.at > STALE_MS) {
    return { state: "error", text: "The last send did not finish." };
  }
  return last;
}
