// Closing tabs without closing a window (contract C5's about:blank guard).
// Used by the allowlist (dnr.js) and by the import (importer.js).

// The URL of a tab (its pending URL first) when it is http: or https:, else null.
export function tabUrl(tab) {
  const raw = tab.pendingUrl || tab.url;
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u;
}

// Close every tab that doomed(tab) selects and return how many closed. A
// window whose every tab is selected first gets an about:blank tab, so no
// window closes.
export async function closeTabs(chrome, doomed) {
  const tabs = await chrome.tabs.query({});
  const picked = tabs.filter(doomed);
  const pickedIds = new Set(picked.map((t) => t.id));
  const windows = new Set(picked.map((t) => t.windowId));
  for (const windowId of windows) {
    const all = tabs.filter((t) => t.windowId === windowId);
    if (all.every((t) => pickedIds.has(t.id))) {
      await chrome.tabs.create({ windowId, url: "about:blank", active: false });
    }
  }
  let closed = 0;
  for (const t of picked) {
    try {
      await chrome.tabs.remove(t.id);
      closed += 1;
    } catch {
      // The tab is already gone.
    }
  }
  return closed;
}
