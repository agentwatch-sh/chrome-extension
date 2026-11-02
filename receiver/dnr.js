// The allowlist as one dynamic DNR rule, plus closing tabs the list no longer covers (contract C5).
import { normalizeEntry, covers } from "./lib/domains.js";
import { closeTabs, tabUrl } from "./tabs.js";

const RULE_ID = 2;

// The last list that applied in full, per chrome object: one per worker
// start, so the first call after a start counts as a shrink.
const applied = new WeakMap();

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
//
// A site's service worker answers a navigation to its host before DNR sees
// it: a link to a host that left the list loads the worker's page (measured
// on Chromium 156, test/live case sw_removed). So whenever the list loses an
// entry, every service worker of the profile is removed before the tabs
// close. That is coarse (the allowed sites register theirs again on their
// next visit) but needs no list of origins. If the removal fails, the tabs
// still close and the call fails, so the daemon tries again.
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
  const previous = applied.get(chrome);
  const shrinks = previous === undefined || previous.some((d) => !domains.includes(d));
  let workersRemoved = !shrinks;
  if (shrinks) {
    try {
      await chrome.browsingData.remove({}, { serviceWorkers: true });
      workersRemoved = true;
    } catch {
      workersRemoved = false;
    }
  }
  const closed = await closeTabs(chrome, (t) => {
    const u = tabUrl(t);
    return u !== null && !domains.some((d) => covers(d, u.hostname));
  });
  if (!workersRemoved) throw new Error("service worker removal failed");
  applied.set(chrome, domains);
  return { rules: rule ? 1 : 0, closed, refused };
}
