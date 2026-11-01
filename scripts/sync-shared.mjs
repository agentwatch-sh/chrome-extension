// Copy every file of shared/ (dotfiles excepted) byte for byte into
// sender/lib/ and receiver/lib/, so each extension loads as an unpacked folder.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const files = readdirSync(new URL("shared/", root)).filter((f) => !f.startsWith("."));
for (const dir of ["sender/lib/", "receiver/lib/"]) {
  mkdirSync(new URL(dir, root), { recursive: true });
  for (const f of files) copyFileSync(new URL("shared/" + f, root), new URL(dir + f, root));
}
console.log(`synced ${files.length} file(s)`);
