// The allowlist as one dynamic DNR rule, plus closing tabs the list no longer covers (contract C5).
import { normalizeEntry, covers } from "./lib/domains.js";
import { closeTabs, tabUrl } from "./tabs.js";

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
  const closed = await closeTabs(chrome, (t) => {
    const u = tabUrl(t);
    return u !== null && !domains.some((d) => covers(d, u.hostname));
  });
  return { rules: rule ? 1 : 0, closed };
}
