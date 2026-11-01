import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PART_BYTES, splitParts, PartJoiner } from "../receiver/wire.js";

const big = () => ({ t: "req", id: "x", op: "import", pad: "a".repeat(1500001 - 43) });

test("PART_BYTES is 700000", () => assert.equal(PART_BYTES, 700000));

test("a request of 1,500,001 bytes gives 3 parts under 1,000,000 bytes each", () => {
  const req = big();
  assert.equal(new TextEncoder().encode(JSON.stringify(req)).length, 1500001);
  const parts = splitParts("p1", req);
  assert.equal(parts.length, 3);
  for (const [i, p] of parts.entries()) {
    assert.equal(p.n, 3);
    assert.equal(p.seq, i);
    assert.ok(JSON.stringify(p).length < 1000000);
  }
  const j = new PartJoiner();
  assert.equal(j.push(parts[0]), null);
  assert.equal(j.push(parts[1]), null);
  assert.deepEqual(j.push(parts[2]), req);
});

test("a missing part gives null until it arrives", () => {
  const parts = splitParts("p1", big());
  const j = new PartJoiner();
  assert.equal(j.push(parts[0]), null);
  assert.equal(j.push(parts[2]), null);
  assert.deepEqual(j.push(parts[1]), big());
});

test("a new id drops the unfinished one", () => {
  const a = splitParts("a", big());
  const b = splitParts("b", { t: "req", id: "b", op: "ping" });
  const j = new PartJoiner();
  j.push(a[0]);
  assert.deepEqual(j.push(b[0]), { t: "req", id: "b", op: "ping" });
  assert.equal(j.push(a[1]), null);
  assert.equal(j.push(a[2]), null);
});

test("out-of-range seq, bad n and bad base64 drop the id", () => {
  const j = new PartJoiner();
  assert.equal(j.push({ t: "part", id: "a", seq: 5, n: 2, b64: "AA==" }), null);
  assert.equal(j.push({ t: "part", id: "b", seq: 0, n: 0, b64: "AA==" }), null);
  const good = splitParts("c", big());
  j.push(good[0]);
  assert.equal(j.push({ ...good[1], b64: "!!!not base64!!!" }), null);
  assert.equal(j.push(good[2]), null);
});

test("invalid UTF-8 or invalid JSON gives null", () => {
  const j = new PartJoiner();
  assert.equal(j.push({ t: "part", id: "u", seq: 0, n: 1, b64: btoa("\xff\xfe") }), null);
  assert.equal(j.push({ t: "part", id: "j", seq: 0, n: 1, b64: btoa("{nope") }), null);
});

test("the shared vector splits and joins exactly", () => {
  const v = JSON.parse(readFileSync(new URL("./vectors/parts.json", import.meta.url), "utf8"));
  assert.equal(v.part_bytes, 10);
  assert.equal(v.parts.length, 4);
  assert.deepEqual(splitParts(v.id, v.request, v.part_bytes), v.parts);
  const j = new PartJoiner();
  let out = null;
  for (const p of v.parts) out = j.push(p);
  assert.deepEqual(out, v.request);
});
