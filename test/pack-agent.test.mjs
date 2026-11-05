// The packed CRX of the agent package (board task ab-v16.18). The format is
// checked with a reader written here from the CRX3 and ZIP layouts, not with
// the packer's own code, and the package's file list comes from git ls-files
// here, not from the packer. Every key is a fresh test key that a test writes
// into a temp folder; no test reads the real signing key. The committed CRX
// (ab-v16.22) and the version table release/versions.json (ab-v16.24) are
// checked at the end of the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { crx3, keyFileProblem, packageFiles, publicKeyDer, readPrivateKey, zip } from "../scripts/pack-agent.mjs";
import { extensionId } from "../scripts/extension-id.mjs";

const root = new URL("../", import.meta.url);
const rootDir = fileURLToPath(root);
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

// --- git: the package is the files that git tracks ---

// The environment without GIT_* variables: a calling git (a hook) sets GIT_DIR or GIT_INDEX_FILE,
// and then git in a temp folder would read another repository.
function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });

// Make a temp folder a git work tree, and track every file in it.
function track(dir) {
  if (!existsSync(join(dir, ".git"))) git(dir, "init", "-q");
  git(dir, "add", "-A", "-f", "--", "."); // -f: a global excludes file must not change what a test tracks
}

// The package as the tests expect it, from git itself and not from the packer: the files that git
// tracks in `dir`, without dotfiles and Chromium's _metadata/, and each folder on their paths up to
// the first dotted part (as Chrome's own packer, lib/.keep keeps lib/), sorted.
function trackedPackage(dir) {
  const out = new Set();
  for (const path of git(dir, "ls-files", "-z", "--", ".").split("\0").filter(Boolean)) {
    const parts = path.split("/");
    if (parts[0] === "_metadata") continue;
    for (let i = 1; i < parts.length && !parts[i - 1].startsWith("."); i++) out.add(parts.slice(0, i).join("/") + "/");
    if (!parts.some((p) => p.startsWith("."))) out.add(path);
  }
  return [...out].sort();
}

// The files of trackedPackage(dir) with their bytes: name -> Buffer.
const trackedContent = (dir) => new Map(trackedPackage(dir).filter((n) => !n.endsWith("/")).map((n) => [n, readFileSync(join(dir, n))]));

// --- The content of a package and the version table ---

// The content of a package, which a repack on another zlib build does not change: SHA-256 over its
// files in the byte order of their paths, each as its path (UTF-8), a NUL, its size in decimal, a NUL
// and its bytes. Folders add nothing (the paths name them). files: name -> Buffer (a name with a
// trailing / is a folder).
function contentSha256(files) {
  const names = [...files.keys()].filter((n) => !n.endsWith("/")).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const h = createHash("sha256");
  for (const n of names) h.update(Buffer.concat([Buffer.from(`${n}\0${files.get(n).length}\0`, "utf8"), files.get(n)]));
  return h.digest("hex");
}

// release/versions.json: each released version of the agent package -> the contentSha256 of its
// files. Chrome installs an external CRX again only for a higher external_version, so a new content
// needs a new entry and a higher version, and an entry never changes.
const versionsFile = fileURLToPath(new URL("release/versions.json", root));
const CHROME_VERSION = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;
const versionParts = (v) => v.split(".").map(Number);

// Chrome's order of versions: number by number, a missing number is 0.
function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const raise = (version) =>
  `agent/ changed, but agent/manifest.json still has version ${version}, and release/versions.json holds another ` +
  `content for ${version}. Chrome installs an external CRX again only for a higher version, so the boxes would keep ` +
  `the old code. On taylor: raise "version" in agent/manifest.json, run npm run pack:agent -- --out release, and add ` +
  `the entry of the new version to release/versions.json (npm test then prints it)`;

// Throws when the table refuses a package of `version` (agent/manifest.json's) with content `sha`.
function checkVersion(table, version, sha) {
  for (const [v, h] of Object.entries(table)) {
    assert.ok(CHROME_VERSION.test(v) && versionParts(v).every((n) => n <= 65535),
      `release/versions.json: ${v} is not a Chrome version (one to four numbers from 0 to 65535, with dots)`);
    assert.ok(/^[0-9a-f]{64}$/.test(h), `release/versions.json: the entry of ${v} is not a SHA-256 in lowercase hex`);
  }
  assert.ok(Object.hasOwn(table, version),
    `release/versions.json has no entry for version ${version} of agent/manifest.json: after the repack on taylor, add "${version}": "${sha}"`);
  assert.ok(table[version] === sha, raise(version));
  for (const v of Object.keys(table)) {
    if (v !== version) {
      assert.ok(compareVersions(version, v) > 0,
        `version ${version} of agent/manifest.json is not higher than ${v} in release/versions.json: Chrome installs an external CRX again only for a higher version`);
    }
  }
}

// The base whose entries the table must keep, as {ref, rev, hint}. A branch may change its own new
// entries: only the base's entries are released.
// - VERSIONS_BASE, when it is set: the commit before a push. The push run sets it from
//   github.event.before and fetches that commit; HEAD^1 would be wrong for a push of more than one
//   commit (the first can change an entry, and a rebased branch holds its own first tries).
// - HEAD^1 in GitHub Actions: a pull_request run checks out the merge of the PR into main, whose
//   first parent is the main tip.
// - origin/main elsewhere.
function baseRef(env) {
  if (env.VERSIONS_BASE !== undefined) {
    const v = env.VERSIONS_BASE;
    assert.ok(/^[0-9a-f]{40}$/.test(v) && !/^0+$/.test(v),
      `VERSIONS_BASE ${JSON.stringify(v)} is not the 40-hex commit before the push: an all-zero github.event.before is a new branch, which has no main before it`);
    return { ref: "VERSIONS_BASE", rev: v, hint: `the push run fetches it: git fetch --no-tags --depth=1 origin ${v}` };
  }
  if (env.GITHUB_ACTIONS) return { ref: "HEAD^1", rev: "HEAD^1", hint: "the CI checkout needs fetch-depth: 2" };
  return { ref: "origin/main", rev: "origin/main", hint: "run git fetch origin main:refs/remotes/origin/main" };
}

// {ref, commit, table} of the base. table is null for a base from before the table: no file of the base
// names release/versions.json. The check fails, and never passes in silence, when VERSIONS_BASE is not
// a commit, when the base commit is not in the clone, or when the base names the table but does not
// hold it.
function baseTable(dir, env = process.env) {
  const { ref, rev: name, hint } = baseRef(env);
  const run = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  const rev = run("rev-parse", "--verify", "--quiet", `${name}^{commit}`);
  assert.ok(rev.status === 0, `the base ${ref} is not in this clone, so the version table cannot be checked: ${hint}`);
  const commit = rev.stdout.trim();
  const show = run("show", `${commit}:release/versions.json`);
  if (show.status === 0) return { ref, commit, table: JSON.parse(show.stdout) };
  const named = run("grep", "-q", "-F", "release/versions.json", commit, "--");
  assert.ok(named.status !== 0, `the base ${ref} (${commit}) names release/versions.json but does not hold it`);
  assert.ok(named.status === 1, `git grep fails in the base ${ref} (${commit}): ${named.stderr.trim()}`);
  return { ref, commit, table: null };
}

// Throws when the table changed or lost an entry of the base table.
function checkBase(table, { ref, commit, table: base }) {
  for (const [v, h] of Object.entries(base ?? {})) {
    assert.ok(Object.hasOwn(table, v),
      `release/versions.json has no entry of ${v}, which the base ${ref} (${commit}) holds: an entry never leaves the table (a branch from before that entry merges ${ref} first)`);
    assert.ok(table[v] === h,
      `release/versions.json changed the entry of ${v} (the base ${ref}, ${commit}, holds ${h}): a released version never gets another content; raise the version instead`);
  }
}

// --- An independent reader of the two formats ---

// A varint of at most 8 bytes whose value is a safe integer; it must end inside its message.
function varint(buf, at) {
  let v = 0;
  let mul = 1;
  for (let i = 0; i < 8; i++) {
    assert.ok(at < buf.length, "a varint runs past the end of its message");
    const b = buf[at++];
    v += (b & 0x7f) * mul;
    if (b < 0x80) {
      assert.ok(Number.isSafeInteger(v), "a varint too large for this reader");
      return [v, at];
    }
    mul *= 128;
  }
  assert.fail("a varint of more than 8 bytes");
}

// A protocol buffer message of fields of wire type 2 (bytes), the only type CRX3 uses: field number
// -> bytes. `known` lists the field numbers that the message may hold; another field is refused. A
// field that comes twice is refused too. For an optional field (public_key, signature,
// signed_header_data, crx_id) protobuf keeps the last copy, so a reader of the first copy would read
// another value than Chrome. sha256_with_rsa is a repeated field of crx3.proto, and Chrome checks
// every proof in it; our CRX holds exactly one.
function fields(buf, known) {
  const out = new Map();
  let at = 0;
  while (at < buf.length) {
    let tag;
    [tag, at] = varint(buf, at);
    assert.equal(tag % 8, 2, "a length-delimited field");
    const n = Math.floor(tag / 8);
    assert.ok(known.includes(n), `an unknown field ${n}`);
    assert.ok(!out.has(n), `field ${n} repeats`);
    let len;
    [len, at] = varint(buf, at);
    assert.ok(at + len <= buf.length, `field ${n} runs past the end of its message`);
    out.set(n, buf.subarray(at, at + len));
    at += len;
  }
  return out;
}

// CRX3: "Cr24", version 3 and the header size (little-endian), the CrxFileHeader message, the ZIP.
function readCrx(buf) {
  assert.ok(buf.length >= 12, "the CRX3 head");
  assert.equal(buf.subarray(0, 4).toString("latin1"), "Cr24");
  assert.equal(buf.readUInt32LE(4), 3);
  const size = buf.readUInt32LE(8);
  assert.ok(12 + size <= buf.length, "the header runs past the end of the file");
  // CrxFileHeader: 2 sha256_with_rsa (AsymmetricKeyProof: 1 public_key, 2 signature), 10000
  // signed_header_data (SignedData: 1 crx_id). This CRX holds each of them once, and nothing more.
  const header = fields(buf.subarray(12, 12 + size), [2, 10000]);
  assert.deepEqual([...header.keys()].sort((a, b) => a - b), [2, 10000], "one RSA proof and the signed header data");
  const proof = fields(header.get(2), [1, 2]);
  assert.deepEqual([...proof.keys()].sort((a, b) => a - b), [1, 2], "the proof's public key and signature");
  const signedData = header.get(10000);
  const signed = fields(signedData, [1]);
  assert.ok(signed.has(1), "the crx_id");
  return { publicKey: proof.get(1), signature: proof.get(2), signedData, crxId: signed.get(1), archive: buf.subarray(12 + size) };
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

// A ZIP as the packer writes it, and nothing more: the end record, with no comment, at the end; the
// central directory right before it; the local records from offset 0 with no gap, in the order of
// the central directory, up to the central directory. No record has an extra field or a comment, or
// a flag other than bit 11 (UTF-8 names, which Chromium's own packer sets), and no name repeats: each
// of them could make Chrome read other entries or bytes than this reader.
function readZip(buf) {
  const end = buf.length - 22;
  assert.ok(end >= 0 && buf.readUInt32LE(end) === 0x06054b50, "the end of central directory record");
  assert.equal(buf.readUInt16LE(end + 4), 0, "one disk");
  assert.equal(buf.readUInt16LE(end + 6), 0, "one disk");
  const count = buf.readUInt16LE(end + 10);
  assert.equal(buf.readUInt16LE(end + 8), count, "one disk");
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  assert.equal(buf.readUInt16LE(end + 20), 0, "no archive comment");
  assert.equal(cdOffset + cdSize, end, "the central directory ends at the end record");
  const entries = new Map();
  let at = cdOffset;
  let next = 0; // where the next local record starts
  for (let i = 0; i < count; i++) {
    assert.ok(at + 46 <= end && buf.readUInt32LE(at) === 0x02014b50, "a central directory header");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28);
    const xlen = buf.readUInt16LE(at + 30);
    const clen = buf.readUInt16LE(at + 32);
    const disk = buf.readUInt16LE(at + 34);
    const offset = buf.readUInt32LE(at + 42);
    const nameBytes = buf.subarray(at + 46, at + 46 + nlen);
    const name = nameBytes.toString("utf8");
    at += 46 + nlen;
    assert.equal(flags & ~0x800, 0, `${name}: no flags but bit 11`);
    assert.equal(xlen, 0, `${name}: no extra field`);
    assert.equal(clen, 0, `${name}: no comment`);
    assert.equal(disk, 0, `${name}: one disk`);
    assert.ok(!entries.has(name), `the ZIP repeats the name ${name}`);
    // The local record starts where the one before it ends, and repeats the method, CRC, sizes and name.
    assert.equal(offset, next, `${name}: no gap before its local header`);
    assert.ok(offset + 30 <= cdOffset && buf.readUInt32LE(offset) === 0x04034b50, `the local header of ${name}`);
    assert.equal(buf.readUInt16LE(offset + 6), flags, `${name}: the same flags in the local header`);
    assert.equal(buf.readUInt16LE(offset + 8), method, name);
    assert.equal(buf.readUInt32LE(offset + 14), crc, name);
    assert.equal(buf.readUInt32LE(offset + 18), csize, name);
    assert.equal(buf.readUInt32LE(offset + 22), usize, name);
    assert.equal(buf.readUInt16LE(offset + 26), nlen, name);
    assert.equal(buf.readUInt16LE(offset + 28), 0, `${name}: no extra field in the local header`);
    assert.ok(buf.subarray(offset + 30, offset + 30 + nlen).equals(nameBytes), `${name}: the local header's name`);
    const start = offset + 30 + nlen;
    assert.ok(start + csize <= cdOffset, `${name}: its data ends before the central directory`);
    const raw = buf.subarray(start, start + csize);
    assert.ok(method === 0 || method === 8, `${name}: stored or deflated`);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, usize, name);
    assert.equal(crc32(data), crc, `${name}: CRC-32`);
    entries.set(name, data);
    next = start + csize;
  }
  assert.equal(next, cdOffset, "no gap before the central directory");
  assert.equal(at, end, "the central directory holds exactly the counted headers");
  assert.equal(entries.size, count, "each name once");
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
    track(dir);
    assert.deepEqual(packageFiles(dir), ["lib/", "manifest.json", "rules/", "rules/a.json", "rules/b.json", "sw.js"]);
  });
});

test("packageFiles packs only the files that git tracks: an ignored or untracked file in the folder stays out", () => {
  withTemp((dir) => {
    mkdirSync(join(dir, "lib"));
    for (const f of ["manifest.json", "sw.js", "lib/a.js"]) writeFileSync(join(dir, f), f);
    writeFileSync(join(dir, ".gitignore"), "*.zip\n*~\n");
    track(dir);
    // After the add: two ignored files (as agent/notes.zip and agent/attach.js~ would be in this
    // repository), an untracked file, and an untracked folder.
    mkdirSync(join(dir, "extra"));
    for (const f of ["notes.zip", "attach.js~", "lib/b.js", "extra/x.js"]) writeFileSync(join(dir, f), f);
    assert.equal(git(dir, "check-ignore", "notes.zip", "attach.js~"), "notes.zip\nattach.js~\n");
    assert.deepEqual(packageFiles(dir), ["lib/", "lib/a.js", "manifest.json", "sw.js"]);
    assert.deepEqual(packageFiles(dir), trackedPackage(dir));
  });
});

test("packageFiles refuses a path that is not printable ASCII, or that has a backslash: a ZIP reader without flag bit 11 (Python zipfile: cp437) reads it as another name, and a backslash is a separator for some readers", () => {
  for (const name of ["lib/na\u00efve.js", "\u00e9.js", "r\u00e9gles/a.json", "tab\there.js", "lib\\a.js", "rules/b\\c.json"]) {
    withTemp((dir) => {
      writeFileSync(join(dir, "manifest.json"), "{}");
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), "x");
      track(dir);
      assert.throws(() => packageFiles(dir), (e) => /is not printable ASCII|has a backslash/.test(e.message), JSON.stringify(name));
    });
  }
});

test("packageFiles refuses a folder outside a git work tree, a tracked file that is missing, and a tracked symlink", () => {
  withTemp((dir) => {
    writeFileSync(join(dir, "manifest.json"), "{}");
    assert.throws(() => packageFiles(dir), /cannot list the files that git tracks in /);
  });
  withTemp((dir) => {
    for (const f of ["manifest.json", "sw.js"]) writeFileSync(join(dir, f), f);
    track(dir);
    rmSync(join(dir, "sw.js"));
    assert.throws(() => packageFiles(dir), /sw\.js: git tracks it, but it is missing/);
  });
  withTemp((dir) => {
    writeFileSync(join(dir, "manifest.json"), "{}");
    symlinkSync("manifest.json", join(dir, "link.json"));
    track(dir);
    assert.throws(() => packageFiles(dir), /link\.json is not a regular file/);
  });
});

test("packageFiles of agent/ holds the manifest, the rules and the lib files: the files that git tracks", () => {
  const files = packageFiles(agentDir);
  assert.deepEqual(files, trackedPackage(agentDir));
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
      track(dir);
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
    track(pkg);
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

// --- The reader refuses a file that Chrome could read in another way ---

// Bad CRX and ZIP files, written here byte by byte.
function pbVarint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Buffer.from(out);
}
const pb = (n, ...parts) => {
  const bytes = Buffer.concat(parts);
  return Buffer.concat([pbVarint(n * 8 + 2), pbVarint(bytes.length), bytes]);
};
function rawCrx(header, archive = Buffer.alloc(0), size = header.length) {
  const head = Buffer.alloc(12);
  head.write("Cr24", 0, "latin1");
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(size, 8);
  return Buffer.concat([head, header, archive]);
}
const sig = Buffer.alloc(256, 1);
const idA = Buffer.alloc(16, 2);
const idB = Buffer.alloc(16, 3);
const proof = (...more) => pb(2, pb(1, der), pb(2, sig), ...more);

// A ZIP of stored entries. gap: bytes before each local record; endGap: bytes before the central
// directory; the other options set those fields of each record.
function rawZip(entries, { localExtra = 0, centralExtra = 0, comment = 0, endComment = 0, gap = 0, endGap = 0, flags = 0 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (gap) {
      locals.push(Buffer.alloc(gap));
      offset += gap;
    }
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    local.writeUInt16LE(localExtra, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt16LE(centralExtra, 30);
    central.writeUInt16LE(comment, 32);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, Buffer.alloc(localExtra), data);
    centrals.push(central, n, Buffer.alloc(centralExtra), Buffer.alloc(comment, 0x20));
    offset += 30 + n.length + localExtra + data.length;
  }
  if (endGap) {
    locals.push(Buffer.alloc(endGap));
    offset += endGap;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(endComment, 20);
  return Buffer.concat([...locals, cd, end, Buffer.alloc(endComment, 0x20)]);
}
const two = [{ name: "a.txt", data: Buffer.from("one") }, { name: "b.txt", data: Buffer.from("two") }];

test("the reader reads the well-formed CRX header and ZIP that the bad cases below change", () => {
  const crx = readCrx(rawCrx(Buffer.concat([proof(), pb(10000, pb(1, idA))])));
  assert.ok(crx.publicKey.equals(der) && crx.signature.equals(sig) && crx.crxId.equals(idA));
  const files = readZip(rawZip(two));
  assert.deepEqual([...files.keys()], ["a.txt", "b.txt"]);
  assert.equal(files.get("b.txt").toString(), "two");
});

test("the reader refuses a field of the CRX header that comes twice: protobuf keeps the last copy of an optional field, and Chrome checks every RSA proof of the repeated sha256_with_rsa, so our CRX holds exactly one", () => {
  const cases = [
    ["signed_header_data twice", Buffer.concat([proof(), pb(10000, pb(1, idA)), pb(10000, pb(1, idB))]), /field 10000 repeats/],
    ["two RSA proofs", Buffer.concat([proof(), proof(), pb(10000, pb(1, idA))]), /field 2 repeats/],
    ["public_key twice", Buffer.concat([pb(2, pb(1, der), pb(1, Buffer.from("other")), pb(2, sig)), pb(10000, pb(1, idA))]), /field 1 repeats/],
    ["signature twice", Buffer.concat([pb(2, pb(1, der), pb(2, sig), pb(2, Buffer.from("other"))), pb(10000, pb(1, idA))]), /field 2 repeats/],
    ["crx_id twice", Buffer.concat([proof(), pb(10000, pb(1, idA), pb(1, idB))]), /field 1 repeats/],
  ];
  for (const [what, header, message] of cases) assert.throws(() => readCrx(rawCrx(header)), message, what);
});

test("the reader refuses an unknown field in the CRX header, the RSA proof and the signed data", () => {
  const cases = [
    ["verified_contents in the header", Buffer.concat([proof(), pb(4, Buffer.from("x")), pb(10000, pb(1, idA))])],
    ["an ECDSA proof in the header", Buffer.concat([proof(), pb(3, pb(1, der), pb(2, sig)), pb(10000, pb(1, idA))])],
    ["a third field in the proof", Buffer.concat([proof(pb(3, Buffer.from("x"))), pb(10000, pb(1, idA))])],
    ["a second field in the signed data", Buffer.concat([proof(), pb(10000, pb(1, idA), pb(2, Buffer.from("x")))])],
  ];
  for (const [what, header] of cases) assert.throws(() => readCrx(rawCrx(header)), /unknown field/, what);
});

test("the reader refuses a CRX header or a field that runs past its end, and a varint that never ends", () => {
  const good = Buffer.concat([proof(), pb(10000, pb(1, idA))]);
  assert.throws(() => readCrx(rawCrx(good, Buffer.alloc(0), good.length + 100)), /the header runs past the end of the file/);
  assert.throws(() => readCrx(rawCrx(Buffer.concat([pbVarint(2 * 8 + 2), pbVarint(100), Buffer.alloc(3)]))), /runs past the end of its message/);
  assert.throws(() => readCrx(rawCrx(Buffer.from([0x82]))), /a varint runs past the end of its message/);
});

test("the reader refuses a ZIP that repeats a name: a map of the names would hide one entry", () => {
  const files = [{ name: "a.txt", data: Buffer.from("one") }, { name: "a.txt", data: Buffer.from("two") }];
  assert.throws(() => readZip(rawZip(files)), /repeats the name a\.txt/);
  assert.throws(() => readZip(zip(files)), /repeats the name a\.txt/);
});

test("the reader accepts flag bit 11 (UTF-8 names), which Chromium's own packer sets", () => {
  const files = readZip(rawZip(two, { flags: 0x800 }));
  assert.deepEqual([...files.keys()], ["a.txt", "b.txt"]);
});

test("the reader refuses a ZIP with an extra field, a comment, a flag other than bit 11, or a gap between its records", () => {
  const cases = [
    ["an extra field in a local header", { localExtra: 4 }, /extra field/],
    ["an extra field in the central directory", { centralExtra: 4 }, /extra field/],
    ["a file comment", { comment: 3 }, /comment/],
    ["an archive comment", { endComment: 3 }, /end of central directory record|comment/],
    ["a data descriptor flag", { flags: 8 }, /flags/],
    ["a data descriptor flag with the UTF-8 flag", { flags: 0x808 }, /flags/],
    ["an encryption flag", { flags: 1 }, /flags/],
    ["a gap before each local record", { gap: 2 }, /gap/],
    ["a gap before the central directory", { endGap: 2 }, /gap/],
  ];
  for (const [what, options, message] of cases) assert.throws(() => readZip(rawZip(two, options)), message, what);
});

// --- The command ---

// A copy of the files that git tracks in agent/, in a git work tree of its own that tracks them all,
// whose manifest key is the test key's public key.
function agentCopy(dir, keyDer = der) {
  const src = join(dir, "agent");
  for (const name of git(agentDir, "ls-files", "-z", "--", ".").split("\0").filter(Boolean)) {
    mkdirSync(join(src, name, ".."), { recursive: true });
    cpSync(join(agentDir, name), join(src, name));
  }
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  m.key = keyDer.toString("base64");
  writeFileSync(join(src, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  track(src);
  return src;
}

// HOME is the test's temp folder, so the default key path never reaches a real key.
function run(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...gitEnv(), HOME: dir, AGENT_KEY_PATH: "", ...env },
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
    const version = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")).version;
    assert.ok(r.stdout.includes(`version ${version}\n`), "the version of the copy's manifest");
    assert.deepEqual(readdirSync(out), ["agent.crx"], "only the CRX: no key, no temp file");
    const crx = readCrx(readFileSync(join(out, "agent.crx")));
    assert.ok(crx.publicKey.equals(der));
    assert.ok(verify("sha256", signedBytes(crx), pair.publicKey, crx.signature));
    const files = readZip(crx.archive);
    assert.deepEqual([...files.keys()], trackedPackage(src));
    for (const [name, data] of files) {
      if (!name.endsWith("/")) assert.ok(data.equals(readFileSync(join(src, name))), name);
    }
  });
});

test("the command packs only the files that git tracks: an ignored or untracked file in --src stays out of the CRX", () => {
  withTemp((dir) => {
    const src = agentCopy(dir);
    for (const f of ["notes.zip", "attach.js~", "lib/scratch.js"]) writeFileSync(join(src, f), "a file that git does not track");
    const out = join(dir, "out");
    const r = run(dir, ["--key", writeKey(dir), "--src", src, "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const files = readZip(readCrx(readFileSync(join(out, "agent.crx"))).archive);
    assert.deepEqual([...files.keys()], trackedPackage(src));
    for (const f of ["notes.zip", "attach.js~", "lib/scratch.js"]) assert.ok(!files.has(f), f);
  });
});

test("the command refuses a --src outside a git work tree, and a --src whose manifest.json git does not track", () => {
  withTemp((dir) => {
    const src = agentCopy(dir);
    rmSync(join(src, ".git"), { recursive: true, force: true });
    const r = run(dir, ["--key", writeKey(dir), "--src", src, "--out", join(dir, "out")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot list the files that git tracks in /);
    assert.equal(existsSync(join(dir, "out")), false);
  });
  withTemp((dir) => {
    const src = agentCopy(dir);
    git(src, "rm", "-q", "--cached", "manifest.json");
    const r = run(dir, ["--key", writeKey(dir), "--src", src, "--out", join(dir, "out")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /git does not track .*manifest\.json/);
    assert.equal(existsSync(join(dir, "out")), false);
  });
});

test("the command lists and checks the package's files before it opens the key: a git error comes first", () => {
  // The key path does not exist: an error of the key would say "cannot open the key file".
  const cases = [
    ["a --src outside a git work tree", (src) => rmSync(join(src, ".git"), { recursive: true, force: true }), /cannot list the files that git tracks in /],
    ["an untracked manifest.json", (src) => git(src, "rm", "-q", "--cached", "manifest.json"), /git does not track .*manifest\.json/],
    ["a tracked key file", (src) => { writeFileSync(join(src, "old.pem"), "a dummy file, not a key"); track(src); }, /never packed/],
    ["a path that is not ASCII", (src) => { writeFileSync(join(src, "na\u00efve.js"), "x"); track(src); }, /is not printable ASCII/],
  ];
  for (const [what, spoil, message] of cases) {
    withTemp((dir) => {
      const src = agentCopy(dir);
      spoil(src);
      const r = run(dir, ["--key", join(dir, "missing.pem"), "--src", src, "--out", join(dir, "out")]);
      assert.equal(r.status, 1, what);
      assert.match(r.stderr, message, what);
      assert.doesNotMatch(r.stderr, /key file/, what);
    });
  }
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
    track(src);
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

test("the command's temp file (.agent.crx.<pid>.tmp) is git-ignored in release/ and in every other folder", () => {
  const r = spawnSync("git", ["check-ignore", "release/.agent.crx.12345.tmp", "dist/.agent.crx.1.tmp", ".agent.crx.7.tmp"], { cwd: rootDir, encoding: "utf8" });
  assert.equal(r.stdout, "release/.agent.crx.12345.tmp\ndist/.agent.crx.1.tmp\n.agent.crx.7.tmp\n");
});

// --- The committed CRX (board task ab-v16.22) ---

// agentwatch pins a commit of this repository and installs release/agent.crx from it, so the
// CRX at every commit must be the agent/ folder of that commit, signed with the agent key.
const releaseCrx = fileURLToPath(new URL("release/agent.crx", root));
const STALE = "release/agent.crx does not hold the files that git tracks in agent/: on taylor, raise the version in agent/manifest.json, run npm run pack:agent -- --out release, add the entry of the new version to release/versions.json (npm test prints it), and commit release/agent.crx and release/versions.json";

test("release/agent.crx is tracked by git, and other CRX files stay ignored", () => {
  const tracked = execFileSync("git", ["ls-files", "--error-unmatch", "release/agent.crx"], { cwd: fileURLToPath(root), encoding: "utf8" });
  assert.equal(tracked, "release/agent.crx\n");
  const r = spawnSync("git", ["check-ignore", "release/agent.crx"], { cwd: fileURLToPath(root), encoding: "utf8" });
  assert.equal(r.status, 1, "release/agent.crx is not ignored");
  const others = execFileSync("git", ["check-ignore", "release/other.crx", "agent/agent.crx", "release/agent-extension.pem"], { cwd: fileURLToPath(root), encoding: "utf8" });
  assert.equal(others, "release/other.crx\nagent/agent.crx\nrelease/agent-extension.pem\n");
});

test("release/agent.crx has the agent ID, a valid signature of the agent key, and exactly the files of agent/", () => {
  const manifest = JSON.parse(readFileSync(join(agentDir, "manifest.json"), "utf8"));
  const crx = readCrx(readFileSync(releaseCrx));
  assert.equal(crx.publicKey.toString("base64"), manifest.key, "the public key is the manifest key");
  assert.ok(crx.crxId.equals(createHash("sha256").update(crx.publicKey).digest().subarray(0, 16)), "the crx_id");
  assert.equal(extensionId(manifest.key), "ifhfjdmdbgbnmllffiadajepajbcdnai");
  const publicKey = createPublicKey({ key: crx.publicKey, format: "der", type: "spki" });
  assert.ok(verify("sha256", signedBytes(crx), publicKey, crx.signature), "the signature");
  const files = readZip(crx.archive);
  assert.deepEqual([...files.keys()], trackedPackage(agentDir), STALE);
  for (const [name, data] of files) {
    if (!name.endsWith("/")) assert.ok(data.equals(readFileSync(join(agentDir, name))), `${name}: ${STALE}`);
  }
});

// --- The version table (board task ab-v16.24) ---

const A = "a".repeat(64);
const B = "b".repeat(64);

test("contentSha256: SHA-256 over path, NUL, size, NUL and bytes of each file, in the byte order of the paths; folders add nothing", () => {
  const files = new Map([["b", Buffer.from("yy")], ["a/", Buffer.alloc(0)], ["a/x", Buffer.from("1")], ["B", Buffer.alloc(0)]]);
  const expected = createHash("sha256").update("B\x000\x00" + "a/x\x001\x001" + "b\x002\x00yy").digest("hex");
  assert.equal(contentSha256(files), expected);
  // The deflated bytes do not count: the files that a ZIP holds give the same content.
  assert.equal(contentSha256(readZip(zip([...files].map(([name, data]) => ({ name, data: name.endsWith("/") ? null : data }))))), expected);
});

test("checkVersion accepts the entry of the manifest version when it is the highest version, in Chrome's order", () => {
  checkVersion({ "0.2.0": A }, "0.2.0", A);
  checkVersion({ "0.2.0": A, "0.10.0": B }, "0.10.0", B); // 10 is higher than 2: not the order of the strings
  checkVersion({ "0.2.0": A, 1: B }, "1", B);
});

test("checkVersion refuses a changed agent/ at the same version: raise the version, repack on taylor, add the entry", () => {
  withTemp((dir) => {
    const src = agentCopy(dir);
    const { version } = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
    const table = { [version]: contentSha256(trackedContent(src)) };
    checkVersion(table, version, contentSha256(trackedContent(src)));
    // One more line in a tracked file; a repack would put it into a CRX of the same version.
    appendFileSync(join(src, "sw.js"), "// one more line\n");
    assert.throws(() => checkVersion(table, version, contentSha256(trackedContent(src))), (e) =>
      e.message.includes(`still has version ${version}`) && e.message.includes('raise "version" in agent/manifest.json') &&
      e.message.includes("On taylor") && e.message.includes("npm run pack:agent -- --out release") && e.message.includes("release/versions.json"));
  });
});

test("checkVersion refuses a version with no entry, and names the entry to add", () => {
  assert.throws(() => checkVersion({ "0.2.0": A }, "0.3.0", B), (e) => e.message.includes(`no entry for version 0.3.0`) && e.message.includes(`add "0.3.0": "${B}"`));
});

test("checkVersion refuses a manifest version that is not higher than each other version of the table", () => {
  assert.throws(() => checkVersion({ "0.2.0": A, "0.3.0": B }, "0.2.0", A), /version 0\.2\.0 of agent\/manifest\.json is not higher than 0\.3\.0/);
  // Chrome reads 0.2 as 0.2.0: the same version.
  assert.throws(() => checkVersion({ "0.2": B, "0.2.0": A }, "0.2.0", A), /is not higher than 0\.2 /);
});

test("checkVersion refuses a table entry that is not a Chrome version or not a SHA-256", () => {
  for (const v of ["01.2", "1.2.3.4.5", "65536", "v1", "1..2", "", "1.2 "]) {
    assert.throws(() => checkVersion({ [v]: A, "0.2.0": A }, "0.2.0", A), /is not a Chrome version/, JSON.stringify(v));
  }
  for (const h of ["A".repeat(64), "abc", A + "0", 7]) {
    assert.throws(() => checkVersion({ "0.2.0": h }, "0.2.0", h), /is not a SHA-256 in lowercase hex/, String(h));
  }
});

// Temp repositories for the base rule: commits by a test identity, with no signing and no hooks.
const gitc = (dir, ...args) => git(dir, "-c", "user.name=test", "-c", "user.email=test@invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args);
function commitTable(dir, table, message) {
  if (table) {
    mkdirSync(join(dir, "release"), { recursive: true });
    writeFileSync(join(dir, "release", "versions.json"), JSON.stringify(table, null, 2) + "\n");
  }
  git(dir, "add", "-A", "-f", "--", ".");
  gitc(dir, "commit", "-q", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD").trim();
}
const tableOf = (dir) => JSON.parse(readFileSync(join(dir, "release", "versions.json"), "utf8"));
function repoWithMain(dir, table) {
  git(dir, "init", "-q", "-b", "main");
  return commitTable(dir, table, "main");
}

test("checkBase refuses a table that changed or lost an entry of the base, and accepts new entries", () => {
  const base = { ref: "origin/main", commit: "c1", table: { "0.2.0": A } };
  checkBase({ "0.2.0": A, "0.3.0": B }, base);
  checkBase({ "0.2.0": B }, { ref: "origin/main", commit: "c0", table: null }); // a base from before the table
  assert.throws(() => checkBase({ "0.2.0": B }, base), /changed the entry of 0\.2\.0 \(the base origin\/main, c1, holds a{64}\)/);
  assert.throws(() => checkBase({ "0.3.0": B }, base), /has no entry of 0\.2\.0, which the base origin\/main \(c1\) holds/);
});

test("outside CI the base is origin/main: a changed 0.2.0 entry fails against it", () => {
  withTemp((dir) => {
    const main = repoWithMain(dir, { "0.2.0": A });
    git(dir, "update-ref", "refs/remotes/origin/main", main);
    git(dir, "checkout", "-q", "-b", "topic");
    commitTable(dir, { "0.2.0": B }, "topic: a changed 0.2.0 entry");
    const base = baseTable(dir, {});
    assert.deepEqual(base, { ref: "origin/main", commit: main, table: { "0.2.0": A } });
    assert.throws(() => checkBase(tableOf(dir), base), /changed the entry of 0\.2\.0/);
  });
});

test("a branch that adds 0.3.0 = A and then corrects it to B passes: only the base's entries are released", () => {
  withTemp((dir) => {
    const main = repoWithMain(dir, { "0.2.0": A });
    git(dir, "update-ref", "refs/remotes/origin/main", main);
    git(dir, "checkout", "-q", "-b", "topic");
    commitTable(dir, { "0.2.0": A, "0.3.0": A }, "topic: add 0.3.0");
    commitTable(dir, { "0.2.0": A, "0.3.0": B }, "topic: correct 0.3.0");
    checkBase(tableOf(dir), baseTable(dir, {}));
  });
});

test("in GitHub Actions the base is HEAD^1, the main tip of a pull_request merge commit; origin/main is not needed", () => {
  withTemp((dir) => {
    const main = repoWithMain(dir, { "0.2.0": A });
    for (const [branch, table, ok] of [["bad", { "0.2.0": B }, false], ["good", { "0.2.0": A, "0.3.0": B }, true]]) {
      git(dir, "checkout", "-q", "-b", branch, main);
      commitTable(dir, table, `${branch}: the table`);
      // As actions/checkout does for a pull_request: the merge of the branch into the main tip.
      git(dir, "checkout", "-q", "--detach", main);
      gitc(dir, "merge", "-q", "--no-ff", "-m", `Merge ${branch} into main`, branch);
      assert.throws(() => baseTable(dir, {}), /the base origin\/main is not in this clone.*run git fetch origin main:refs\/remotes\/origin\/main/);
      const base = baseTable(dir, { GITHUB_ACTIONS: "true" });
      assert.deepEqual(base, { ref: "HEAD^1", commit: main, table: { "0.2.0": A } });
      if (ok) checkBase(tableOf(dir), base);
      else assert.throws(() => checkBase(tableOf(dir), base), /changed the entry of 0\.2\.0 \(the base HEAD\^1/);
    }
  });
});

test("a CI clone of depth 1 has no HEAD^1: the check fails and asks for fetch-depth: 2; a clone of depth 2 passes", () => {
  withTemp((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const main = repoWithMain(repo, { "0.2.0": A });
    git(repo, "checkout", "-q", "-b", "topic");
    commitTable(repo, { "0.2.0": A, "0.3.0": B }, "topic: add 0.3.0");
    git(repo, "checkout", "-q", "-b", "pr-merge", main);
    gitc(repo, "merge", "-q", "--no-ff", "-m", "Merge topic into main", "topic");
    for (const depth of ["1", "2"]) {
      const clone = join(dir, `depth-${depth}`);
      git(dir, "clone", "-q", "--depth", depth, "--branch", "pr-merge", `file://${repo}`, clone);
      if (depth === "1") {
        assert.throws(() => baseTable(clone, { GITHUB_ACTIONS: "true" }), /the base HEAD\^1 is not in this clone.*fetch-depth: 2/);
      } else {
        const base = baseTable(clone, { GITHUB_ACTIONS: "true" });
        assert.equal(base.commit, main);
        checkBase(tableOf(clone), base);
      }
    }
  });
});

test("on a push the base is VERSIONS_BASE (github.event.before): a push of two commits whose first changes 0.2.0 fails", () => {
  withTemp((dir) => {
    const before = repoWithMain(dir, { "0.2.0": A });
    commitTable(dir, { "0.2.0": B }, "push 1: a changed 0.2.0 entry");
    writeFileSync(join(dir, "notes.txt"), "push 2: another file\n");
    commitTable(dir, null, "push 2: no change of the table");
    // HEAD^1 is the first commit of the push, which already holds the changed entry: it misses it.
    checkBase(tableOf(dir), baseTable(dir, { GITHUB_ACTIONS: "true" }));
    const base = baseTable(dir, { GITHUB_ACTIONS: "true", VERSIONS_BASE: before });
    assert.deepEqual(base, { ref: "VERSIONS_BASE", commit: before, table: { "0.2.0": A } });
    assert.throws(() => checkBase(tableOf(dir), base), /changed the entry of 0\.2\.0 \(the base VERSIONS_BASE/);
  });
});

test("on a push the base is VERSIONS_BASE: a rebase and merge of a branch that corrected its own new entry passes", () => {
  withTemp((dir) => {
    const before = repoWithMain(dir, { "0.2.0": A });
    commitTable(dir, { "0.2.0": A, "0.3.0": A }, "rebased 1: add 0.3.0");
    commitTable(dir, { "0.2.0": A, "0.3.0": B }, "rebased 2: correct 0.3.0");
    // HEAD^1 holds the branch's own first try at 0.3.0, so it fails with no real fault.
    assert.throws(() => checkBase(tableOf(dir), baseTable(dir, { GITHUB_ACTIONS: "true" })), /changed the entry of 0\.3\.0/);
    checkBase(tableOf(dir), baseTable(dir, { GITHUB_ACTIONS: "true", VERSIONS_BASE: before }));
  });
});

test("VERSIONS_BASE that is empty, all zeros (a new branch), not a 40-hex commit, or not in the clone fails visibly", () => {
  withTemp((dir) => {
    repoWithMain(dir, { "0.2.0": A });
    for (const v of ["", "0".repeat(40), "abc", "HEAD", "A".repeat(40)]) {
      assert.throws(() => baseTable(dir, { GITHUB_ACTIONS: "true", VERSIONS_BASE: v }), /VERSIONS_BASE .* is not the 40-hex commit before the push/, JSON.stringify(v));
    }
    assert.throws(() => baseTable(dir, { GITHUB_ACTIONS: "true", VERSIONS_BASE: "1".repeat(40) }),
      /the base VERSIONS_BASE is not in this clone.*git fetch --no-tags --depth=1 origin/);
  });
});

test("a clone of depth 1 that fetches the commit before the push by its SHA, as the push run does, has the base", () => {
  withTemp((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const before = repoWithMain(repo, { "0.2.0": A });
    commitTable(repo, { "0.2.0": A, "0.3.0": B }, "push 1");
    writeFileSync(join(repo, "notes.txt"), "push 2\n");
    commitTable(repo, null, "push 2");
    git(repo, "config", "uploadpack.allowAnySHA1InWant", "true"); // as GitHub serves a fetch by SHA
    const clone = join(dir, "clone");
    git(dir, "clone", "-q", "--depth", "1", "--branch", "main", `file://${repo}`, clone);
    assert.throws(() => baseTable(clone, { GITHUB_ACTIONS: "true", VERSIONS_BASE: before }), /not in this clone/);
    git(clone, "fetch", "-q", "--no-tags", "--depth=1", "origin", before);
    const base = baseTable(clone, { GITHUB_ACTIONS: "true", VERSIONS_BASE: before });
    assert.equal(base.commit, before);
    checkBase(tableOf(clone), base);
  });
});

test("the workflow fetches github.event.before on a push and passes it as VERSIONS_BASE, and fails on an all-zero before", () => {
  const wf = readFileSync(new URL(".github/workflows/test.yml", root), "utf8");
  assert.match(wf, /fetch-depth: 2/);
  assert.match(wf, /if: github\.event_name == 'push'/);
  assert.match(wf, /\$\{\{ github\.event\.before \}\}/);
  assert.match(wf, /git fetch --no-tags --depth=1 origin "\$BEFORE"/);
  assert.match(wf, /VERSIONS_BASE=\$BEFORE" >> "\$GITHUB_ENV"/);
  assert.match(wf, /0{40}/);
});

test("a base from before the table passes; a base that names release/versions.json but lacks it fails", () => {
  withTemp((dir) => {
    writeFileSync(join(dir, "README.md"), "no table yet\n");
    const old = repoWithMain(dir, null);
    git(dir, "update-ref", "refs/remotes/origin/main", old);
    assert.deepEqual(baseTable(dir, {}), { ref: "origin/main", commit: old, table: null });
    writeFileSync(join(dir, "README.md"), "see release/versions.json\n");
    const lost = commitTable(dir, null, "main: names the table, but has no table");
    git(dir, "update-ref", "refs/remotes/origin/main", lost);
    assert.throws(() => baseTable(dir, {}), /the base origin\/main \([0-9a-f]{40}\) names release\/versions\.json but does not hold it/);
  });
});

test("release/versions.json keeps each entry of the base table: VERSIONS_BASE on a push run, HEAD^1 on a pull_request run, origin/main elsewhere", (t) => {
  const base = baseTable(rootDir);
  t.diagnostic(`base ${base.ref} = ${base.commit}${base.table ? "" : " (from before release/versions.json)"}`);
  checkBase(JSON.parse(readFileSync(versionsFile, "utf8")), base);
});

test("release/versions.json has the entry of agent/manifest.json's version, and that entry is the content of agent/ and of release/agent.crx", () => {
  const { version } = JSON.parse(readFileSync(join(agentDir, "manifest.json"), "utf8"));
  const table = JSON.parse(readFileSync(versionsFile, "utf8"));
  checkVersion(table, version, contentSha256(trackedContent(agentDir)));
  const files = readZip(readCrx(readFileSync(releaseCrx)).archive);
  assert.equal(contentSha256(files), table[version], STALE);
});

