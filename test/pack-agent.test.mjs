// The packed CRX of the agent package (board task ab-v16.18). The format is
// checked with a reader written here from the CRX3 and ZIP layouts, not with
// the packer's own code. Every key is a fresh test key that a test writes into
// a temp folder; no test reads the real signing key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { crx3, keyFileProblem, packageFiles, publicKeyDer, readPrivateKey, zip } from "../scripts/pack-agent.mjs";
import { extensionId } from "../scripts/extension-id.mjs";

const root = new URL("../", import.meta.url);
const script = fileURLToPath(new URL("scripts/pack-agent.mjs", root));
const agentDir = fileURLToPath(new URL("agent/", root));

// One test key for the file, made here: a fresh RSA-2048 pair.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const der = pair.publicKey.export({ type: "spki", format: "der" });

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pack-agent-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeKey(dir, text = pem, mode = 0o600) {
  const path = join(dir, "test-key.pem");
  writeFileSync(path, text, { mode });
  chmodSync(path, mode); // the umask can only narrow the mode of writeFileSync
  return path;
}

// --- An independent reader of the two formats ---

function varint(buf, at) {
  let v = 0;
  let mul = 1;
  for (;;) {
    const b = buf[at++];
    v += (b & 0x7f) * mul;
    mul *= 128;
    if (b < 0x80) return [v, at];
  }
}

// Protocol buffer fields of wire type 2 (bytes), the only type CRX3 uses: field number -> [bytes].
function fields(buf) {
  const out = new Map();
  let at = 0;
  while (at < buf.length) {
    let tag;
    [tag, at] = varint(buf, at);
    assert.equal(tag & 7, 2, "a length-delimited field");
    let len;
    [len, at] = varint(buf, at);
    const n = Math.floor(tag / 8);
    if (!out.has(n)) out.set(n, []);
    out.get(n).push(buf.subarray(at, at + len));
    at += len;
  }
  assert.equal(at, buf.length);
  return out;
}

// CRX3: "Cr24", version 3 and the header size (little-endian), the CrxFileHeader message, the ZIP.
function readCrx(buf) {
  assert.equal(buf.subarray(0, 4).toString("latin1"), "Cr24");
  assert.equal(buf.readUInt32LE(4), 3);
  const size = buf.readUInt32LE(8);
  const header = fields(buf.subarray(12, 12 + size));
  const archive = buf.subarray(12 + size);
  // CrxFileHeader: 2 sha256_with_rsa (AsymmetricKeyProof: 1 public_key, 2 signature), 10000 signed_header_data.
  assert.deepEqual([...header.keys()].sort((a, b) => a - b), [2, 10000]);
  assert.equal(header.get(2).length, 1, "one RSA proof");
  const proof = fields(header.get(2)[0]);
  const signedData = header.get(10000)[0];
  // SignedData: 1 crx_id.
  const crxId = fields(signedData).get(1)[0];
  return { publicKey: proof.get(1)[0], signature: proof.get(2)[0], signedData, crxId, archive };
}

// What the signature covers: the context string with its NUL, the size of the signed header data
// (uint32, little-endian), that data, then the whole archive.
function signedBytes({ signedData, archive }) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedData.length);
  return Buffer.concat([Buffer.from("CRX3 SignedData\x00", "latin1"), size, signedData, archive]);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A ZIP with no comment: the end record, the central directory, each local header and its data.
function readZip(buf) {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, "the end of central directory record");
  const count = buf.readUInt16LE(end + 10);
  assert.equal(buf.readUInt16LE(end + 8), count);
  const cdSize = buf.readUInt32LE(end + 12);
  let at = buf.readUInt32LE(end + 16);
  assert.equal(at + cdSize, end, "the central directory ends at the end record");
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, "a central directory header");
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28);
    const xlen = buf.readUInt16LE(at + 30);
    const clen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nlen).toString("utf8");
    at += 46 + nlen + xlen + clen;
    // The local header repeats the method, CRC, sizes and name.
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `the local header of ${name}`);
    assert.equal(buf.readUInt16LE(offset + 8), method, name);
    assert.equal(buf.readUInt32LE(offset + 14), crc, name);
    assert.equal(buf.readUInt32LE(offset + 18), csize, name);
    assert.equal(buf.readUInt32LE(offset + 22), usize, name);
    const lnlen = buf.readUInt16LE(offset + 26);
    assert.equal(buf.subarray(offset + 30, offset + 30 + lnlen).toString("utf8"), name);
    const start = offset + 30 + lnlen + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + csize);
    assert.ok(method === 0 || method === 8, `${name}: stored or deflated`);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, usize, name);
    assert.equal(crc32(data), crc, `${name}: CRC-32`);
    entries.set(name, data);
  }
  assert.equal(at, end);
  return entries;
}

// --- The key file check ---

const stat = (uid, mode, file = true) => ({ uid, mode, isFile: () => file });

test("keyFileProblem accepts a regular file of this user that only this user can read", () => {
  assert.equal(keyFileProblem(stat(1001, 0o100600), 1001), null);
  assert.equal(keyFileProblem(stat(1001, 0o100400), 1001), null);
});

test("keyFileProblem refuses a file of another user, a file that group or others can open, and a non-file", () => {
  assert.match(keyFileProblem(stat(0, 0o100600), 1001), /not owned by this user/);
  for (const mode of [0o100640, 0o100604, 0o100644, 0o100620, 0o100602, 0o100610, 0o100601]) {
    assert.match(keyFileProblem(stat(1001, mode), 1001), /group or others/, mode.toString(8));
  }
  assert.match(keyFileProblem(stat(1001, 0o040700, false), 1001), /not a regular file/);
});

test("readPrivateKey refuses a key file that group or others can read, and a key that is not RSA-2048 or more", () => {
  withTemp((dir) => {
    assert.throws(() => readPrivateKey(writeKey(dir, pem, 0o640)), /group or others/);
  });
  withTemp((dir) => {
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
    assert.throws(() => readPrivateKey(writeKey(dir, small)), /RSA key of at least 2048 bits/);
  });
  withTemp((dir) => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
    assert.throws(() => readPrivateKey(writeKey(dir, ec)), /RSA key of at least 2048 bits/);
  });
  withTemp((dir) => {
    // An error names the file, never what it holds.
    assert.throws(() => readPrivateKey(writeKey(dir, "not a key\n")),
      (e) => /holds no private key/.test(e.message) && !e.message.includes("not a key"));
  });
  withTemp((dir) => {
    assert.throws(() => readPrivateKey(join(dir, "missing.pem")), /cannot open/);
  });
});

test("readPrivateKey reads a 0600 key, and publicKeyDer gives its SubjectPublicKeyInfo DER", () => {
  withTemp((dir) => {
    const path = writeKey(dir);
    const { key, file } = readPrivateKey(path);
    assert.ok(publicKeyDer(key).equals(der));
    // The file's identity, for packageFiles.
    const st = statSync(path);
    assert.deepEqual(file, { dev: st.dev, ino: st.ino });
  });
});

// --- The package's files and the ZIP ---

test("packageFiles lists the package sorted, without dotfiles and without Chromium's _metadata/", () => {
  withTemp((dir) => {
    mkdirSync(join(dir, "rules"));
    mkdirSync(join(dir, "lib"));
    mkdirSync(join(dir, "_metadata", "generated_indexed_rulesets"), { recursive: true });
    for (const f of ["manifest.json", "sw.js", "rules/b.json", "rules/a.json", "lib/.keep", ".hidden", "_metadata/generated_indexed_rulesets/x"]) {
      writeFileSync(join(dir, f), f);
    }
    assert.deepEqual(packageFiles(dir), ["lib/", "manifest.json", "rules/", "rules/a.json", "rules/b.json", "sw.js"]);
  });
});

test("packageFiles of agent/ holds the manifest, the rules and the lib files", () => {
  const files = packageFiles(agentDir);
  for (const f of ["manifest.json", "sw.js", "rules/block-main-frame.json", "rules/block-frames.json", "lib/codec.js"]) {
    assert.ok(files.includes(f), f);
  }
  assert.ok(!files.some((f) => f.split("/").some((p) => p.startsWith(".")) || f.startsWith("_metadata")), "no dotfile, no _metadata");
});

test("packageFiles refuses a key or CRX file by its name: .pem, .key, .der, .crx, in any case", () => {
  for (const name of ["agent-extension.pem", "lib/signing.key", "rules/public.DER", "old.crx", "x.Pem"]) {
    withTemp((dir) => {
      mkdirSync(join(dir, "lib"));
      mkdirSync(join(dir, "rules"));
      writeFileSync(join(dir, "manifest.json"), "{}");
      writeFileSync(join(dir, name), "a dummy file, not a key");
      assert.throws(() => packageFiles(dir), (e) => e.message.includes(name) && /never packed/.test(e.message), name);
    });
  }
});

test("packageFiles refuses a file that is the key file itself (the same device and inode), under any name", () => {
  withTemp((dir) => {
    const pkg = join(dir, "pkg");
    mkdirSync(join(pkg, "lib"), { recursive: true });
    writeFileSync(join(pkg, "manifest.json"), "{}");
    const dummy = join(dir, "dummy.txt");
    writeFileSync(dummy, "a dummy file, not a key");
    linkSync(dummy, join(pkg, "lib", "notes.txt"));
    const st = statSync(dummy);
    assert.throws(() => packageFiles(pkg, { dev: st.dev, ino: st.ino }), /lib\/notes\.txt is the key file/);
    // Without the key file's identity, or with another file's, the same folder packs.
    assert.deepEqual(packageFiles(pkg), ["lib/", "lib/notes.txt", "manifest.json"]);
    writeFileSync(join(dir, "other.txt"), "another dummy file, outside the package");
    const other = statSync(join(dir, "other.txt"));
    assert.deepEqual(packageFiles(pkg, { dev: other.dev, ino: other.ino }), ["lib/", "lib/notes.txt", "manifest.json"]);
  });
});

test("zip writes a ZIP that an independent reader reads back byte for byte, the same bytes each time", () => {
  const big = Buffer.from("x".repeat(10000) + "y");
  const entries = [
    { name: "dir/", data: null },
    { name: "dir/big.txt", data: big },
    { name: "empty", data: Buffer.alloc(0) },
    { name: "manifest.json", data: Buffer.from('{"a":1}') },
  ];
  const out = zip(entries);
  const back = readZip(out);
  assert.deepEqual([...back.keys()], ["dir/", "dir/big.txt", "empty", "manifest.json"]);
  assert.equal(back.get("dir/").length, 0);
  assert.ok(back.get("dir/big.txt").equals(big));
  assert.equal(back.get("empty").length, 0);
  assert.equal(back.get("manifest.json").toString(), '{"a":1}');
  assert.ok(out.length < big.length, "the data is deflated");
  assert.ok(zip(entries).equals(out), "no time stamp or other varying byte");
});

// --- The CRX3 file ---

test("crx3 writes a CRX3 file: magic, version 3, one RSA proof of the key, the crx_id, a valid signature", () => {
  withTemp((dir) => {
    const { key } = readPrivateKey(writeKey(dir));
    const archive = zip([{ name: "manifest.json", data: Buffer.from("{}") }]);
    const crx = readCrx(crx3(archive, key));
    assert.ok(crx.publicKey.equals(der), "the proof's public key is the SubjectPublicKeyInfo DER");
    assert.ok(crx.archive.equals(archive), "the archive follows the header unchanged");
    // crx_id: the first 128 bits of SHA-256 of the DER, which maps to the extension ID (a-p).
    assert.ok(crx.crxId.equals(createHash("sha256").update(der).digest().subarray(0, 16)));
    const id = [...crx.crxId.toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
    assert.equal(id, extensionId(der.toString("base64")));
    // RSASSA-PKCS1-v1_5 with SHA-256, checked with the public key alone.
    assert.ok(verify("sha256", signedBytes(crx), createPublicKey({ key: der, format: "der", type: "spki" }), crx.signature));
    // A changed archive byte breaks it.
    const bad = Buffer.from(crx.archive);
    bad[bad.length - 1] ^= 1;
    assert.equal(verify("sha256", signedBytes({ ...crx, archive: bad }), pair.publicKey, crx.signature), false);
  });
});

// --- The command ---

// A copy of agent/ whose manifest key is the test key's public key.
function agentCopy(dir, keyDer = der) {
  const src = join(dir, "agent");
  cpSync(agentDir, src, { recursive: true, filter: (p) => !p.includes("_metadata") });
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  m.key = keyDer.toString("base64");
  writeFileSync(join(src, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  return src;
}

// HOME is the test's temp folder, so the default key path never reaches a real key.
function run(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, HOME: dir, AGENT_KEY_PATH: "", ...env },
  });
  assert.equal(r.error, undefined, "the command ends in time");
  // The command never prints the key, in any form.
  const body = pem.split("\n").filter((l) => l && !l.startsWith("-----"));
  const keyDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
  for (const text of [r.stdout, r.stderr]) {
    for (const line of body) assert.ok(!text.includes(line), "a line of the PEM in the output");
    assert.ok(!text.includes(keyDer.toString("base64").slice(64, 128)), "the private key DER in the output");
    assert.ok(!text.includes(keyDer.toString("hex").slice(64, 128)), "the private key hex in the output");
  }
  return r;
}

test("the command packs a copy of agent/ into <out>/agent.crx with the key from --key, and prints the ID", () => {
  withTemp((dir) => {
    const src = agentCopy(dir);
    const out = join(dir, "out");
    const r = run(dir, ["--key", writeKey(dir), "--src", src, "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const id = extensionId(der.toString("base64"));
    assert.match(r.stdout, new RegExp(`ID ${id}`));
    assert.match(r.stdout, /version 0\.2\.0/);
    assert.deepEqual(readdirSync(out), ["agent.crx"], "only the CRX: no key, no temp file");
    const crx = readCrx(readFileSync(join(out, "agent.crx")));
    assert.ok(crx.publicKey.equals(der));
    assert.ok(verify("sha256", signedBytes(crx), pair.publicKey, crx.signature));
    const files = readZip(crx.archive);
    assert.deepEqual([...files.keys()], packageFiles(src));
    for (const [name, data] of files) {
      if (!name.endsWith("/")) assert.ok(data.equals(readFileSync(join(src, name))), name);
    }
  });
});

test("the command takes the key path from AGENT_KEY_PATH", () => {
  withTemp((dir) => {
    const r = run(dir, ["--src", agentCopy(dir), "--out", join(dir, "out")], { AGENT_KEY_PATH: writeKey(dir) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, "out", "agent.crx")));
  });
});

test("the command refuses a key file that group or others can read, and writes nothing", () => {
  withTemp((dir) => {
    const r = run(dir, ["--key", writeKey(dir, pem, 0o644), "--src", agentCopy(dir), "--out", join(dir, "out")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /group or others/);
    assert.equal(existsSync(join(dir, "out")), false);
  });
});

test("the command refuses a key whose public key is not the manifest key: the CRX would get another ID", () => {
  withTemp((dir) => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" });
    const r = run(dir, ["--key", writeKey(dir), "--src", agentCopy(dir, other), "--out", join(dir, "out")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not the public key of/);
    assert.equal(existsSync(join(dir, "out")), false);
  });
});

test("the command with no --key and no AGENT_KEY_PATH reads the default path under HOME", () => {
  withTemp((dir) => {
    const r = run(dir, ["--src", agentCopy(dir), "--out", join(dir, "out")]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`cannot open the key file ${join(dir, ".config", "agentwatch", "browser", "agent-extension.pem")}`), r.stderr);
  });
});

test("the command refuses a FIFO as the key file at once: it does not wait for a writer", () => {
  withTemp((dir) => {
    const fifo = join(dir, "key.fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    const r = run(dir, ["--key", fifo, "--src", agentCopy(dir), "--out", join(dir, "out")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not a regular file/);
  });
});

test("the command refuses to pack the key file when a hard link of it is in the package, and writes nothing", () => {
  withTemp((dir) => {
    const key = writeKey(dir);
    const src = agentCopy(dir);
    linkSync(key, join(src, "lib", "notes.txt"));
    const r = run(dir, ["--key", key, "--src", src, "--out", join(dir, "out")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lib\/notes\.txt is the key file/);
    assert.equal(existsSync(join(dir, "out")), false);
  });
});

test("the command's default output folder dist/ and the key and CRX files are git-ignored", () => {
  const ignored = readFileSync(new URL(".gitignore", root), "utf8").split("\n");
  for (const line of ["dist/", "*.crx", "*.pem"]) assert.ok(ignored.includes(line), line);
  const r = execFileSync("git", ["check-ignore", "dist/agent.crx", "agent-extension.pem"], { cwd: fileURLToPath(root), encoding: "utf8" });
  assert.equal(r, "dist/agent.crx\nagent-extension.pem\n");
});
