import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("the live harness rejects missing or early frames and separates the operator list", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "-v", "test_live"], {
    cwd: fileURLToPath(new URL("./live/", import.meta.url)),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
});
