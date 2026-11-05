// The URL of a tab, for C5's closing rule (allowlist.js) and the import's
// closes (importer.js). The closes run in the removal queue (removals.js).

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
