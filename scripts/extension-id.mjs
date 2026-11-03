import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Chrome derives an extension ID from the manifest key: SHA-256 of the DER
// public key, first 32 hex digits, with 0-9a-f mapped to a-p.
export function extensionId(base64Der) {
  const hex = createHash("sha256").update(Buffer.from(base64Der, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

// Run as a script: pathToFileURL encodes the path as import.meta.url does (a space is %20).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const p of ["sender", "receiver"]) {
    const m = JSON.parse((await import("node:fs")).readFileSync(new URL(`../${p}/manifest.json`, import.meta.url), "utf8"));
    console.log(`${p}: ${extensionId(m.key)}`);
  }
}
