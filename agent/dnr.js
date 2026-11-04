// The allowlist as dynamic DNR rules, plus closing tabs the list no longer covers (contract C5).
import { normalizeEntry, covers } from "./lib/domains.js";
import { closeTabs, tabUrl } from "./tabs.js";

const RULE_ID = 2;
const FRAME_RULE_ID = 3;
const HEADER_RULE_ID = 4;

// The last list that applied in full, per chrome object: one per worker
// start, so the first call after a start counts as a shrink.
const applied = new WeakMap();
// The list of the rule in force: set when the rule update succeeded, also if
// the call then failed. The bridge checks content-setting patterns against it
// (C10 contentDetails), so a shrink holds there at once.
const ruled = new WeakMap();

export function appliedDomains(chrome) {
  return ruled.get(chrome) ?? [];
}

export function allowRule(domains) {
  if (domains.length === 0) return null;
  return {
    id: RULE_ID,
    priority: 2,
    action: { type: "allow" },
    condition: { requestDomains: [...domains], resourceTypes: ["main_frame"] },
  };
}

// A raw CDP client can make a top-level document with no request
// (about:blank, setContent) and put any host in a frame there. So every
// sub_frame request of a tab whose top-level domain is not on the list is
// blocked; the frames of an allowlisted page still load from any host (O11).
// Two-modes design, section 8 (measured in its probe on Chromium 156).
// excludedTopDomains needs Chrome 145 (the manifest's minimum).
export function frameRule(domains) {
  const condition = { resourceTypes: ["sub_frame"] };
  if (domains.length > 0) condition.excludedTopDomains = [...domains];
  return { id: FRAME_RULE_ID, priority: 1, action: { type: "block" }, condition };
}

// Chrome names the extension as the initiator of a Page.navigate, so the site
// sees Sec-Fetch-Site: cross-site. This rule sets none for the top-level
// requests that the agent package starts, and for no other: then a
// Page.navigate sends none and ?1, as a typed URL, and a page script's
// navigation keeps its own value (two-modes design, section 7, measured in
// its probe). Chrome applies a modifyHeaders rule only above the priority of
// every allow rule that matches, so its priority is above rule 2's; the block
// (rule 1) still holds.
export function headerRule(extensionId) {
  return {
    id: HEADER_RULE_ID,
    priority: 3,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "sec-fetch-site", operation: "set", value: "none" }] },
    condition: { resourceTypes: ["main_frame"], initiatorDomains: [extensionId] },
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
  // The three rules change in one call. So the frame rule always has the
  // list of the allow rule, and the header rule is in force before the
  // daemon confirms a list to the relay (C11: no client connects before).
  const rule = allowRule(domains);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID, FRAME_RULE_ID, HEADER_RULE_ID],
    addRules: [...(rule ? [rule] : []), frameRule(domains), headerRule(chrome.runtime.id)],
  });
  ruled.set(chrome, domains);
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
