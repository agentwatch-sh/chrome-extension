import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Chrome derives an extension ID from the manifest key: SHA-256 of the DER
// public key, first 32 hex digits, with 0-9a-f mapped to a-p.
export function extensionId(base64Der) {
  const hex = createHash("sha256").update(Buffer.from(base64Der, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

// Run as a script: Node loads the main module from its real path (a symlink resolved), and
// pathToFileURL encodes that path as import.meta.url does (a space is %20).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  for (const p of ["operator", "agent"]) {
    const m = JSON.parse((await import("node:fs")).readFileSync(new URL(`../${p}/manifest.json`, import.meta.url), "utf8"));
    console.log(`${p}: ${extensionId(m.key)}`);
  }
}
