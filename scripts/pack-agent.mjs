// Pack the agent package (agent/) as a CRX3 file for Chrome's external
// extensions file (board task ab-v16.18): a ZIP of the package and a header
// that signs it with the agent package's RSA key (SHA-256, PKCS #1 v1.5).
//
//   node scripts/pack-agent.mjs [--key PATH] [--out DIR] [--src DIR]
//
// --key PATH, or AGENT_KEY_PATH=PATH: the private key file (PEM). Both name a
//   path, never the key. Default ~/.config/agentwatch/browser/agent-extension.pem.
//   The file must be a regular file of this user that group and others cannot
//   open (mode 0600 or 0400). This script never prints, logs or copies the key.
// --out DIR: where agent.crx goes. Default dist/ (git-ignored).
// --src DIR: the package folder. Default agent/.
//
// The manifest's "key" must be the public key of that private key, so that the
// unpacked folder and the CRX have the same extension ID. A file of the package
// named *.pem, *.key, *.der or *.crx, or the key file itself, stops the build.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import { extensionId } from "./extension-id.mjs";

// --- The key ---

// Why a key file is refused, or null. `st` is an fs.Stats of the open file.
export function keyFileProblem(st, uid) {
  if (!st.isFile()) return "is not a regular file";
  if (st.uid !== uid) return "is not owned by this user";
  if (st.mode & 0o077) return `can be opened by group or others (mode ${(st.mode & 0o777).toString(8).padStart(4, "0")}); run chmod 600 on it`;
  return null;
}

// The private key of a PEM file, as {key: a KeyObject, file: {dev, ino}}. The
// checks run on the open file itself, so the file that is read is the file that
// was checked; O_NONBLOCK lets a FIFO open at once, and the check then refuses
// it. No error holds the file's content.
export function readPrivateKey(path) {
  let fd;
  let st;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new Error(`cannot open the key file ${path}`);
  }
  let pem;
  try {
    st = fstatSync(fd);
    const problem = keyFileProblem(st, process.getuid());
    if (problem) throw new Error(`the key file ${path} ${problem}`);
    pem = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new Error(`the key file ${path} holds no private key in PEM form`);
  } finally {
    pem.fill(0);
  }
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error(`the key file ${path} holds no RSA key of at least 2048 bits`);
  }
  return { key, file: { dev: st.dev, ino: st.ino } };
}

// The SubjectPublicKeyInfo DER of a private key: the manifest's "key" (in base64) and the CRX's public key.
export function publicKeyDer(privateKey) {
  return createPublicKey(privateKey).export({ type: "spki", format: "der" });
}

// --- The package and the ZIP ---

// A key or a CRX in the package folder (git ignores *.pem and *.crx, so a copy there is easy
// to miss) would go into a CRX that anyone can unpack.
const NEVER_PACKED = /\.(pem|key|der|crx)$/i;

// Every folder (with a trailing /) and file of the package, sorted, with / as the separator.
// Dotfiles stay out, as with Chrome's own packer, and so does _metadata/, which Chromium writes
// into an unpacked folder that it loads. A file named as a key or a CRX is refused, and so is
// the key file itself under any name (keyFile: its {dev, ino}, for a hard link).
export function packageFiles(dir, keyFile = null) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith(".") || (rel === "" && e.name === "_metadata")) continue;
      const name = rel + e.name;
      if (e.isDirectory()) {
        out.push(name + "/");
        walk(name + "/");
      } else if (e.isFile()) {
        if (NEVER_PACKED.test(e.name)) throw new Error(`${join(dir, name)}: a key or a CRX is never packed`);
        const st = keyFile && statSync(join(dir, name));
        if (st && st.dev === keyFile.dev && st.ino === keyFile.ino) throw new Error(`${join(dir, name)} is the key file`);
        out.push(name);
      } else {
        throw new Error(`${join(dir, name)} is not a regular file or folder`);
      }
    }
  };
  walk("");
  return out.sort();
}

// A ZIP of the entries in their order: [{name, data}], data null for a folder (a name with a
// trailing /). Files are deflated. Every time field is 1980-01-01 00:00, so the same files give
// the same bytes.
export function zip(entries) {
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const folder = data === null;
    const body = folder ? Buffer.alloc(0) : deflateRawSync(data);
    const crc = folder ? 0 : crc32(data);
    const size = folder ? 0 : data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(folder ? 0 : 8, 8); // stored or deflated
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: 2.0, MS-DOS attributes
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(folder ? 0 : 8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra field and comment lengths, disk number, internal attributes: 0
    central.writeUInt32LE(folder ? 0x10 : 0, 38); // the MS-DOS folder attribute
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// --- The CRX3 file ---

function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Buffer.from(out);
}

// One protocol buffer field of wire type 2 (bytes).
const field = (n, bytes) => Buffer.concat([varint(n * 8 + 2), varint(bytes.length), bytes]);

// A CRX3 file of a ZIP archive (Chromium's components/crx_file/crx3.proto):
//   "Cr24", uint32 3, uint32 header size (little-endian), CrxFileHeader, the archive.
//   CrxFileHeader: field 2 sha256_with_rsa = AsymmetricKeyProof {1 public_key, 2 signature};
//   field 10000 signed_header_data = SignedData {1 crx_id}.
//   crx_id: the first 16 bytes of SHA-256 of the public key DER (the extension ID, in hex).
//   The signature covers "CRX3 SignedData\x00", the size of signed_header_data (uint32,
//   little-endian), signed_header_data and the archive.
export function crx3(archive, privateKey) {
  const der = publicKeyDer(privateKey);
  const signedData = field(1, createHash("sha256").update(der).digest().subarray(0, 16));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedData.length);
  const signature = sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\x00", "latin1"), size, signedData, archive]), privateKey);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, der), field(2, signature)])), field(10000, signedData)]);
  const head = Buffer.alloc(12);
  head.write("Cr24", 0, "latin1");
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, archive]);
}

// --- The command ---

function main() {
  const { values } = parseArgs({ options: { key: { type: "string" }, out: { type: "string" }, src: { type: "string" } } });
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const keyPath = values.key || process.env.AGENT_KEY_PATH || join(homedir(), ".config", "agentwatch", "browser", "agent-extension.pem");
  const src = resolve(values.src ?? join(repo, "agent"));
  const out = resolve(values.out ?? join(repo, "dist"));

  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  if (typeof manifest.key !== "string") throw new Error(`${src}/manifest.json has no "key"`);
  const { key, file: keyFile } = readPrivateKey(keyPath);
  const der = publicKeyDer(key);
  if (der.toString("base64") !== manifest.key) {
    throw new Error(`the "key" of ${src}/manifest.json is not the public key of ${keyPath}: the CRX would get another ID`);
  }
  const names = packageFiles(src, keyFile);
  const archive = zip(names.map((name) => ({ name, data: name.endsWith("/") ? null : readFileSync(join(src, name)) })));
  const crx = crx3(archive, key);

  mkdirSync(out, { recursive: true });
  const file = join(out, "agent.crx");
  const tmp = join(out, `.agent.crx.${process.pid}.tmp`);
  writeFileSync(tmp, crx);
  renameSync(tmp, file);
  const id = extensionId(der.toString("base64"));
  console.log(`wrote ${file} (${names.length} entries, ${crx.length} bytes): ID ${id}, version ${manifest.version}`);
  console.log(`external extensions file ${id}.json: ${JSON.stringify({ external_crx: file, external_version: manifest.version })}`);
}

// Run as a script (see extension-id.mjs for the check).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`pack-agent: ${e.message}`);
    process.exit(1);
  }
}
