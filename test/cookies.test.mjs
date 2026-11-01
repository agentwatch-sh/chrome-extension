import test from "node:test";
import assert from "node:assert/strict";
import { cookieKey, toSetDetails, toRemoveDetails, inScope, dedupe } from "../shared/cookies.js";

const base = { name: "n", value: "SENTINEL", domain: "a.example", hostOnly: true, path: "/p",
  secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 1234.5 };

test("toSetDetails host-only secure", () => {
  const d = toSetDetails(base);
  assert.deepEqual(d, { url: "https://a.example/p", name: "n", value: "SENTINEL", path: "/p",
    secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1234.5 });
  assert.ok(!("domain" in d));
  assert.ok(!("storeId" in d));
});

test("toSetDetails domain cookie", () => {
  const d = toSetDetails({ ...base, domain: ".example.com", hostOnly: false, secure: false });
  assert.equal(d.domain, ".example.com");
  assert.equal(d.url, "http://example.com/p");
});

test("toSetDetails session cookie", () => {
  const d = toSetDetails({ ...base, session: true, expirationDate: undefined });
  assert.ok(!("expirationDate" in d));
});

test("toSetDetails partitioned", () => {
  const d = toSetDetails({ ...base, partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false } });
  assert.deepEqual(d.partitionKey, { topLevelSite: "https://example.com", hasCrossSiteAncestor: false });
  const e = toSetDetails({ ...base, partitionKey: { topLevelSite: "https://example.com", extra: 1 } });
  assert.deepEqual(e.partitionKey, { topLevelSite: "https://example.com" });
  assert.ok(!("partitionKey" in toSetDetails(base)));
});

test("toRemoveDetails", () => {
  assert.deepEqual(toRemoveDetails(base), { url: "https://a.example/p", name: "n" });
  const pk = { topLevelSite: "https://example.com" };
  assert.deepEqual(toRemoveDetails({ ...base, domain: ".example.com", secure: false, partitionKey: pk }),
    { url: "http://example.com/p", name: "n", partitionKey: pk });
});

test("inScope", () => {
  assert.equal(inScope(base, "a.example"), true);
  assert.equal(inScope(base, "b.example"), false);
  assert.equal(inScope({ ...base, domain: ".Example.com" }, "example.com"), true);
  assert.equal(inScope({ ...base, domain: "www.example.com" }, "example.com"), true);
  assert.equal(inScope({ ...base, domain: "other.com" }, "example.com"), false);
  assert.equal(inScope({ ...base, domain: "badexample.com" }, "example.com"), false);
});

test("cookieKey and dedupe", () => {
  const a = { ...base };
  const b = { ...base, value: "other" };
  const c = { ...base, partitionKey: { topLevelSite: "https://x.example" } };
  assert.equal(cookieKey(a), cookieKey(b));
  assert.notEqual(cookieKey(a), cookieKey(c));
  assert.deepEqual(dedupe([a, c, b]), [a, c]);
});

test("cookieKey tells partitioned cookies apart by hasCrossSiteAncestor", () => {
  const pk = (x) => ({ ...base, partitionKey: { topLevelSite: "https://x.example", hasCrossSiteAncestor: x } });
  assert.notEqual(cookieKey(pk(false)), cookieKey(pk(true)));
  assert.notEqual(cookieKey(pk(undefined)), cookieKey(pk(false)));
  assert.equal(cookieKey(pk(true)), cookieKey({ ...pk(true), value: "other" }));
  assert.deepEqual(dedupe([pk(false), pk(true), pk(false)]), [pk(false), pk(true)]);
});

test("cookieKey lowercases the domain", () => {
  assert.equal(cookieKey({ ...base, domain: "A.Example" }), cookieKey({ ...base, domain: "a.example" }));
});
