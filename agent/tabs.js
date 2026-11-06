// The URL of a tab, for C5's closing rule (allowlist.js) and the import's
// closes (importer.js), and of a navigation, for C5's guard (guard.js). The
// closes run in the removal queue (removals.js).

// The URL whose host C5 judges: an http: or https: URL, or for a blob: URL
// its inner origin when that is http: or https: (a blob: page is a page of
// that origin); else null (about:, data:, chrome:, file:, a blob: of an
// opaque origin).
export function webUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === "blob:") {
    // An opaque inner origin serializes as "null", which is no URL.
    try {
      u = new URL(u.origin);
    } catch {
      return null;
    }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u;
}

// The URL of a tab (its pending URL first), as webUrl gives it.
export function tabUrl(tab) {
  return webUrl(tab.pendingUrl || tab.url);
}
