import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const names = (dir) => readdirSync(new URL(dir, root)).filter((f) => !f.startsWith(".")).sort();

test("every shared file is copied byte for byte to both lib folders, and nothing else is there", () => {
  const files = names("shared/");
  for (const dir of ["operator/lib/", "agent/lib/"]) {
    // A file that shared/ no longer has would still load in that extension: remove it from lib/.
    assert.deepEqual(names(dir), files, dir + " holds exactly the files of shared/");
    for (const f of files) {
      assert.ok(readFileSync(new URL("shared/" + f, root)).equals(readFileSync(new URL(dir + f, root))), dir + f);
    }
  }
});
