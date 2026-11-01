// The allowlist as one dynamic DNR rule, plus closing tabs the list no longer covers (contract C5).
import { normalizeEntry, covers } from "./lib/domains.js";

const RULE_ID = 2;

export function allowRule(domains) {
  if (domains.length === 0) return null;
  return {
    id: RULE_ID,
    priority: 2,
    action: { type: "allow" },
    condition: { requestDomains: [...domains], resourceTypes: ["main_frame"] },
  };
}

function hostOf(tab) {
  const raw = tab.pendingUrl || tab.url;
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.hostname.toLowerCase();
}

export async function applyAllowlist(chrome, domains) {
  if (!Array.isArray(domains)) throw new Error("invalid allowlist entry");
  for (const d of domains) {
    const r = normalizeEntry(d);
    if (!r.ok || r.entry !== d) throw new Error("invalid allowlist entry");
  }
  const rule = allowRule(domains);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: rule ? [rule] : [],
  });
  const tabs = await chrome.tabs.query({});
  const doomed = tabs.filter((t) => {
    const host = hostOf(t);
    return host !== null && !domains.some((d) => covers(d, host));
  });
  const doomedIds = new Set(doomed.map((t) => t.id));
  const windows = new Set(doomed.map((t) => t.windowId));
  for (const windowId of windows) {
    const all = tabs.filter((t) => t.windowId === windowId);
    if (all.every((t) => doomedIds.has(t.id))) {
      await chrome.tabs.create({ windowId, url: "about:blank", active: false });
    }
  }
  if (doomed.length > 0) await chrome.tabs.remove(doomed.map((t) => t.id));
  return { rules: rule ? 1 : 0, closed: doomed.length };
}
