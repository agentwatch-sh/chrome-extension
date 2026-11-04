// The allowlist as dynamic DNR rules, plus closing tabs the list no longer covers (contract C5).
import { normalizeEntry, covers } from "./lib/domains.js";
import { closeTabs, tabUrl } from "./tabs.js";

const RULE_ID = 2;
const FRAME_RULE_ID = 4;
const HEADER_RULE_ID = 5;
// The potentially trustworthy URLs, to which Chrome sends Sec-Fetch-*
// headers: https, and http to localhost, *.localhost, 127.0.0.0/8 or [::1].
export const TRUSTWORTHY = "^(https://|http://(localhost|[^/:]+\\.localhost|127\\.[0-9]+\\.[0-9]+\\.[0-9]+|\\[::1\\])(:[0-9]+)?/)";

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
// (about:blank, setContent) and put any host in a frame, an <object> or an
// <embed> there (DNR type object). So the static rule 3 blocks every such
// request, and this rule allows it in a tab whose top-level domain is on the
// list: the frames of an allowlisted page still load from any host (O11). As
// with rules 1 and 2, the block holds from Chromium's first moment. Two-modes
// design, section 8. topDomains needs Chrome 141; the manifest asks for 145
// as a safe minimum.
export function frameRule(domains) {
  if (domains.length === 0) return null;
  return {
    id: FRAME_RULE_ID,
    priority: 2,
    action: { type: "allow" },
    condition: { resourceTypes: ["sub_frame", "object"], topDomains: [...domains] },
  };
}

// Chrome names the extension as the initiator of a Page.navigate, so the site
// sees Sec-Fetch-Site: cross-site. This rule sets none for the top-level
// requests that the agent package starts, and for no other: then a
// Page.navigate sends none and ?1, as a typed URL, and a page script's
// navigation keeps its own value (two-modes design, section 7, measured in
// its probe). Only to a potentially trustworthy URL: to any other URL Chrome
// sends no Sec-Fetch-* header, and one there would mark the agent. Chrome
// applies a modifyHeaders rule only above the priority of every allow rule
// that matches, so its priority is above rule 2's; the block (rule 1) still
// holds.
export function headerRule(extensionId) {
  return {
    id: HEADER_RULE_ID,
    priority: 3,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "sec-fetch-site", operation: "set", value: "none" }] },
    condition: { resourceTypes: ["main_frame"], initiatorDomains: [extensionId], regexFilter: TRUSTWORTHY },
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
  const frames = frameRule(domains);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID, FRAME_RULE_ID, HEADER_RULE_ID],
    addRules: [rule, frames, headerRule(chrome.runtime.id)].filter((r) => r !== null),
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
