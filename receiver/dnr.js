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

// The new list replaces the old one in full. An entry that is not a
// normalized C5 entry is refused and counted; the valid entries still apply,
// so an invalid entry never keeps an older, wider rule in place. A list that
// is not an array applies as an empty list (everything blocked).
export async function applyAllowlist(chrome, input) {
  const list = Array.isArray(input) ? input : [];
  let refused = Array.isArray(input) ? 0 : 1;
  const domains = [];
  for (const d of list) {
    const r = normalizeEntry(d);
    if (r.ok && r.entry === d) domains.push(d);
    else refused += 1;
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
  return { rules: rule ? 1 : 0, closed, refused };
}
