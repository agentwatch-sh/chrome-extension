import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PART_BYTES, CHANNELS, MAX_TO_DAEMON, splitParts, PartJoiner, ChannelJoiner, jsonTooLarge } from "../receiver/wire.js";

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

test("after a bad part the later parts of that id never produce a request; a fresh id joins", () => {
  const j = new PartJoiner();
  const bad = splitParts("bad", big());
  assert.equal(j.push(bad[0]), null);
  assert.equal(j.push({ ...bad[1], b64: "!!!" }), null);
  assert.equal(j.push(bad[2]), null);
  assert.equal(j.push(bad[0]), null);
  assert.equal(j.push(bad[1]), null);
  assert.equal(j.push(bad[2]), null);
  const fresh = splitParts("fresh", { t: "req", id: "f", op: "ping" });
  assert.deepEqual(j.push(fresh[0]), { t: "req", id: "f", op: "ping" });
});

// ---- channels: one joiner per channel ----

const ping = (id) => ({ t: "req", id, op: "ping" });
const noCh = ({ ch, ...part }) => part;

test("the channels are main and bridge; splitParts names a channel only when asked", () => {
  assert.deepEqual(CHANNELS, ["main", "bridge"]);
  assert.ok(Object.isFrozen(CHANNELS));
  assert.ok(!Object.hasOwn(splitParts("a", ping("a"))[0], "ch"));
  const parts = splitParts("b", big(), PART_BYTES, "bridge");
  assert.equal(parts.length, 3);
  for (const p of parts) assert.equal(p.ch, "bridge");
});

test("the parts of each channel join on their own, also when the channels interleave", () => {
  const imp = splitParts("i", big(), PART_BYTES, "main");
  const br = splitParts("i", { ...big(), id: "i", op: "x" }, PART_BYTES, "bridge"); // the same id on the other channel
  const j = new ChannelJoiner();
  assert.equal(j.push(imp[0]), null);
  assert.equal(j.push(br[0]), null);
  assert.equal(j.push(imp[1]), null);
  assert.equal(j.push(br[1]), null);
  assert.deepEqual(j.push(br[2]), { ch: "bridge", req: { ...big(), id: "i", op: "x" } });
  assert.deepEqual(j.push(imp[2]), { ch: "main", req: big() });
});

test("a new id drops the unfinished request of its own channel only", () => {
  const imp = splitParts("i", big());
  const j = new ChannelJoiner();
  assert.equal(j.push(imp[0]), null);
  const first = splitParts("b1", big(), PART_BYTES, "bridge");
  assert.equal(j.push(first[0]), null);
  assert.deepEqual(j.push(splitParts("b2", ping("b2"), PART_BYTES, "bridge")[0]), { ch: "bridge", req: ping("b2") }, "b2 drops b1");
  assert.equal(j.push(first[1]), null);
  assert.equal(j.push(first[2]), null, "b1 never joins");
  assert.equal(j.push(imp[1]), null);
  assert.deepEqual(j.push(imp[2]), { ch: "main", req: big() }, "the bridge ids never dropped the import");
  const later = splitParts("b3", big(), PART_BYTES, "bridge");
  assert.equal(j.push(later[0]), null);
  assert.deepEqual(j.push(splitParts("m", ping("m"))[0]), { ch: "main", req: ping("m") }, "a new main id");
  assert.equal(j.push(later[1]), null);
  assert.deepEqual(j.push(later[2]), { ch: "bridge", req: big() }, "the main id never dropped the bridge request");
});

test("a part without ch is channel main", () => {
  const named = splitParts("i", big(), PART_BYTES, "main");
  const j = new ChannelJoiner();
  assert.equal(j.push(noCh(named[0])), null);
  assert.equal(j.push(named[1]), null);
  assert.deepEqual(j.push(noCh(named[2])), { ch: "main", req: big() }, "with and without ch, one channel");
  const br = splitParts("b", big(), PART_BYTES, "bridge");
  assert.equal(j.push(br[0]), null);
  assert.equal(j.push(noCh(splitParts("a", big())[0])), null);
  assert.equal(j.push(br[1]), null);
  assert.deepEqual(j.push(br[2]), { ch: "bridge", req: big() }, "a part without ch never drops a bridge part");
});

test("a part with an unknown ch is dropped and changes no channel", () => {
  const imp = splitParts("i", big());
  const br = splitParts("b", big(), PART_BYTES, "bridge");
  const j = new ChannelJoiner();
  assert.equal(j.push(imp[0]), null);
  assert.equal(j.push(br[0]), null);
  for (const ch of ["other", "MAIN", "", null, 1, ["main"]]) {
    assert.equal(j.push({ ...splitParts("z", ping("z"))[0], ch }), null, JSON.stringify(ch));
  }
  assert.equal(j.push(imp[1]), null);
  assert.equal(j.push(br[1]), null);
  assert.deepEqual(j.push(imp[2]), { ch: "main", req: big() });
  assert.deepEqual(j.push(br[2]), { ch: "bridge", req: big() });
});

test("a bad part drops its own channel's request only", () => {
  const imp = splitParts("i", big());
  const br = splitParts("b", big(), PART_BYTES, "bridge");
  const j = new ChannelJoiner();
  assert.equal(j.push(imp[0]), null);
  assert.equal(j.push(br[0]), null);
  assert.equal(j.push({ ...br[1], b64: "!!!" }), null);
  assert.equal(j.push(br[1]), null, "the dropped id stays dropped");
  assert.equal(j.push(br[2]), null);
  assert.equal(j.push(imp[1]), null);
  assert.deepEqual(j.push(imp[2]), { ch: "main", req: big() });
});

test("the shared bridge vector splits and joins exactly", () => {
  const v = JSON.parse(readFileSync(new URL("./vectors/parts-bridge.json", import.meta.url), "utf8"));
  assert.equal(v.part_bytes, 10);
  assert.equal(v.ch, "bridge");
  assert.equal(v.parts.length, 4);
  assert.deepEqual(splitParts(v.id, v.request, v.part_bytes, v.ch), v.parts);
  const j = new ChannelJoiner();
  let out = null;
  for (const p of v.parts) out = j.push(p);
  assert.deepEqual(out, { ch: "bridge", req: v.request });
});

// ---- the size of a message to the daemon ----

test("a message to the daemon is at most 8 MiB of UTF-8 JSON", () => {
  assert.equal(MAX_TO_DAEMON, 8388608);
  const msg = (s) => ({ t: "res", id: "a", ok: true, data: { s } });
  const pad = MAX_TO_DAEMON - JSON.stringify(msg("")).length;
  assert.equal(jsonTooLarge(msg("x".repeat(pad))), false, "exactly the limit");
  assert.equal(jsonTooLarge(msg("x".repeat(pad + 1))), true, "one byte more");
  const two = "\u00e9"; // 2 bytes in UTF-8, 1 code unit
  const k = Math.floor(pad / 2);
  assert.equal(jsonTooLarge(msg(two.repeat(k))), false);
  assert.equal(jsonTooLarge(msg(two.repeat(k + 1))), true, "the bytes count, not the code units");
  assert.equal(jsonTooLarge({ s: two }, 10), false, '{"s":"\u00e9"} is 10 bytes');
  assert.equal(jsonTooLarge({ s: two }, 9), true);
  assert.equal(jsonTooLarge({ s: "\u{1f600}" }, 12), false, "a pair of surrogates is 4 bytes");
  assert.equal(jsonTooLarge({ s: "\u{1f600}" }, 11), true);
  assert.equal(jsonTooLarge({ n: 1n }), false, "a value that JSON cannot carry is left to postMessage");
});
