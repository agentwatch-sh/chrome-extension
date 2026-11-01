import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

test("every shared file is copied byte for byte to both lib folders", () => {
  const files = readdirSync(new URL("shared/", root)).filter((f) => !f.startsWith("."));
  for (const f of files) {
    const src = readFileSync(new URL("shared/" + f, root));
    for (const dir of ["sender/lib/", "receiver/lib/"]) {
      assert.ok(src.equals(readFileSync(new URL(dir + f, root))), dir + f);
    }
  }
});
