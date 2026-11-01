import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEntry, covers, domainCandidates, fallbackDomain } from "../shared/domains.js";

test("normalizeEntry accepts and normalizes", () => {
  assert.deepEqual(normalizeEntry("Example.COM."), { ok: true, entry: "example.com" });
  assert.deepEqual(normalizeEntry("  a.example "), { ok: true, entry: "a.example" });
  assert.deepEqual(normalizeEntry("bücher.example"), { ok: true, entry: "xn--bcher-kva.example" });
});

test("normalizeEntry refuses with a reason", () => {
  const bad = ["com", "https://a.example/x", "a.example:8080", "*.a.example", "1.2.3.4", "[::1]",
    "-a.example", "", "a.example..", "a b.example", "a@b.example", "a.example/x", "0x7f.1",
    "a-.example", "a_b.example", ("a".repeat(62) + ".").repeat(4) + "com", "a".repeat(64) + ".example"];
  for (const s of bad) {
    const r = normalizeEntry(s);
    assert.equal(r.ok, false, JSON.stringify(s));
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 0);
    if (s.length > 3) assert.ok(!r.reason.includes(s), "reason echoes input: " + s);
  }
  assert.match(normalizeEntry("https://a.example/x").reason, /paste the host only/);
  assert.equal(normalizeEntry("a".repeat(254)).ok, false);
});

test("normalizeEntry accepts a 253-char name", () => {
  const name = [("a".repeat(63)), ("b".repeat(63)), ("c".repeat(63)), "d".repeat(61)].join(".");
  assert.equal(name.length, 253);
  assert.equal(normalizeEntry(name).ok, true);
});

test("covers", () => {
  assert.equal(covers("example.com", "a.b.example.com"), true);
  assert.equal(covers("example.com", "example.com"), true);
  assert.equal(covers("example.com", "badexample.com"), false);
  assert.equal(covers("a.example.com", "example.com"), false);
});

test("domainCandidates", () => {
  assert.deepEqual(domainCandidates("a.b.example.co.uk"),
    ["a.b.example.co.uk", "b.example.co.uk", "example.co.uk", "co.uk"]);
  assert.deepEqual(domainCandidates("example.com"), ["example.com"]);
  assert.deepEqual(domainCandidates("localhost"), ["localhost"]);
});

test("fallbackDomain", () => {
  assert.equal(fallbackDomain("a.b.example.com"), "example.com");
  assert.equal(fallbackDomain("example.com"), "example.com");
  assert.equal(fallbackDomain("localhost"), "localhost");
});
