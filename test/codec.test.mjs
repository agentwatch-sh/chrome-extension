import { test } from "node:test";
import assert from "node:assert/strict";
import "../shared/codec.js";

const { encode, decode, UnsupportedValue } = globalThis.agentwatchCodec;
const rt = async (x) => decode(JSON.parse(JSON.stringify(await encode(x))));

test("primitives round trip", async () => {
  for (const x of [undefined, null, true, false, "", "ü€😀", 1.5, 0, -Infinity, Infinity]) {
    assert.ok(Object.is(await rt(x), x), String(x));
  }
  assert.ok(Object.is(await rt(-0), -0));
  assert.ok(Number.isNaN(await rt(NaN)));
  assert.equal(await rt(12345678901234567890n), 12345678901234567890n);
});

test("exact tags", async () => {
  assert.deepEqual(await encode(undefined), { t: "undef" });
  assert.deepEqual(await encode("a"), { t: "j", v: "a" });
  assert.deepEqual(await encode(-0), { t: "num", v: "-0" });
  assert.deepEqual(await encode(NaN), { t: "num", v: "NaN" });
  assert.deepEqual(await encode(5n), { t: "big", v: "5" });
  assert.deepEqual(await encode(new Date(5)), { t: "date", v: 5 });
  assert.deepEqual(await encode(new Date(NaN)), { t: "date", v: null });
  assert.deepEqual(await encode(/a/gi), { t: "re", s: "a", f: "gi" });
  assert.deepEqual(await encode(new WeakMap()), { t: "unsupported", c: "WeakMap" });
  assert.deepEqual(await encode(new Uint8Array([1, 2])), { t: "view", c: "Uint8Array", v: "AQI=" });
  assert.deepEqual(await encode(Buffer.from([1, 2])), { t: "view", c: "Uint8Array", v: "AQI=" });
  assert.deepEqual(await encode(new Blob(["hi"], { type: "text/x" })), { t: "blob", type: "text/x", v: "aGk=" });
});

test("dates, regexp", async () => {
  assert.equal((await rt(new Date(1700000000000))).getTime(), 1700000000000);
  assert.ok(Number.isNaN((await rt(new Date(NaN))).getTime()));
  const r = await rt(/a+b/gi);
  assert.ok(r instanceof RegExp);
  assert.equal(r.source, "a+b");
  assert.equal(r.flags, "gi");
});

test("blob and file", async () => {
  const b = await rt(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  assert.ok(b instanceof Blob);
  assert.equal(b.type, "image/png");
  assert.deepEqual(new Uint8Array(await b.arrayBuffer()), new Uint8Array([1, 2, 3]));
  const f = await rt(new File(["abc"], "n.txt", { type: "text/plain", lastModified: 1234 }));
  assert.ok(f instanceof File);
  assert.equal(f.name, "n.txt");
  assert.equal(f.lastModified, 1234);
  assert.equal(await f.text(), "abc");
});

test("buffers and views", async () => {
  const ab = await rt(new Uint8Array([9, 8, 7]).buffer);
  assert.ok(ab instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(ab), new Uint8Array([9, 8, 7]));
  for (const v of [new Uint8Array([1, 2]), new Int32Array([-5, 7]), new Float64Array([1.5, -2])]) {
    const d = await rt(v);
    assert.equal(d.constructor, v.constructor);
    assert.deepEqual(d, v);
  }
  const dv = new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2);
  const d = await rt(dv);
  assert.ok(d instanceof DataView);
  assert.equal(d.byteLength, 2);
  assert.equal(d.getUint8(0), 2);
  const sub = await rt(new Uint8Array([1, 2, 3, 4]).subarray(1, 3));
  assert.deepEqual(sub, new Uint8Array([2, 3]));
});

test("collections", async () => {
  const k = { a: 1 };
  const m = await rt(new Map([[k, "v"], ["s", new Set([1, 2])]]));
  assert.ok(m instanceof Map);
  const [[k1, v1], [k2, v2]] = [...m];
  assert.deepEqual(k1, k);
  assert.equal(v1, "v");
  assert.equal(k2, "s");
  assert.deepEqual(v2, new Set([1, 2]));
  // eslint-disable-next-line no-sparse-arrays
  assert.deepEqual(await rt([1, , 3]), [1, undefined, 3]);
  assert.deepEqual(await rt({ a: { b: [1, { c: null }] }, d: undefined }), { a: { b: [1, { c: null }] }, d: undefined });
});

test("__proto__ key stays own", async () => {
  const src = JSON.parse('{"__proto__":{"x":1},"y":2}');
  const d = await rt(src);
  assert.equal(Object.getPrototypeOf(d), Object.prototype);
  assert.ok(Object.hasOwn(d, "__proto__"));
  assert.equal(d.x, undefined);
  assert.equal(d.y, 2);
});

test("null-prototype object is obj", async () => {
  const o = Object.create(null);
  o.a = 1;
  assert.deepEqual((await encode(o)).t, "obj");
});

test("unsupported", async () => {
  assert.deepEqual(await encode(new WeakMap()), { t: "unsupported", c: "WeakMap" });
  assert.equal((await encode(() => 1)).t, "unsupported");
  assert.equal((await encode(Promise.resolve())).c, "Promise");
  assert.equal((await encode(Symbol("s"))).t, "unsupported");
  assert.throws(() => decode({ t: "unsupported", c: "WeakMap" }), (e) => e instanceof UnsupportedValue && e.name === "UnsupportedValue" && e instanceof Error);
  assert.throws(() => decode({ t: "view", c: "Evil", v: "" }), UnsupportedValue);
  assert.throws(() => decode({ t: "bogus" }), UnsupportedValue);
});

test("error text carries no value", async () => {
  const s = "SENTINEL-secret-9";
  const nested = { k: [new (class Foo { x = s })()] };
  const e = await encode(nested);
  assert.ok(!JSON.stringify(e).includes(s));
  assert.throws(() => decode(e), (err) => !err.message.includes(s));
});

test("5 MB Uint8Array", async () => {
  const a = new Uint8Array(5 * 1024 * 1024);
  for (let i = 0; i < a.length; i++) a[i] = (i * 31) & 255;
  const d = await rt(a);
  assert.equal(d.length, a.length);
  assert.ok(Buffer.compare(d, a) === 0);
});
