import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extensionId } from "../scripts/extension-id.mjs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const json = (p) => JSON.parse(read(p));
const sender = json("operator/manifest.json");
const receiver = json("agent/manifest.json");
const protocol = read("docs/protocol.md");

test("extensionId known vector", () => {
  assert.equal(extensionId("MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtUH8+XV08FK9KGaU8FcmUNec/UsjUDG70wumt2xW2HbcY2hIdCOHxxJFMkU7pEvXKO+fj9O9X8VjAGX7BGh8WCRPVMkNqL3PWNZGYJsCgf13wDeGCGSmtZxzjG1q8224futefeBj5293z/7CwD9NKCqp2pbPOmxSdQoBvBeJpfz4jSaaq4SkpzhHBH1L9/jkRedXLu3kqGoPyQLcR+sEVRoI8wA6ZeMKcV6kec+rrar3UTOlC6s3DG0MI/9xqURESf8mzcjbZ4+1eUwP4EOw0DhFVzOszprGo4JyS0nIB8YNwFxSD5BnDa3MHxxDaXlcjfUtoc/ZxIqMgtgxMdQvDQIDAQAB"), "gdjdfolbhmofnfeagfbobogmbncneffe");
});

test("scripts/extension-id.mjs prints both IDs when it runs, also from a path with a space or through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "extension id "));
  try {
    for (const p of ["scripts/extension-id.mjs", "operator/manifest.json", "agent/manifest.json"]) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      copyFileSync(new URL("../" + p, import.meta.url), join(dir, p));
    }
    symlinkSync(join(dir, "scripts", "extension-id.mjs"), join(dir, "id-link.mjs"));
    const want = `operator: ${extensionId(sender.key)}\nagent: ${extensionId(receiver.key)}\n`;
    for (const script of [join(dir, "scripts", "extension-id.mjs"), join(dir, "id-link.mjs")]) {
      assert.equal(execFileSync(process.execPath, [script], { encoding: "utf8" }), want, script);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator manifest", () => {
  assert.equal(sender.manifest_version, 3);
  assert.equal(sender.version, "0.2.0");
  assert.equal(sender.name, "agentwatch \u2014 operator mode");
  assert.equal(sender.minimum_chrome_version, "132");
  assert.equal(typeof sender.description, "string");
  assert.ok(sender.description.length <= 132, "Chrome's description limit");
  assert.deepEqual(sender.permissions, ["cookies", "activeTab", "scripting", "storage"]);
  assert.deepEqual(sender.optional_host_permissions, ["*://*/*"]);
  assert.equal("host_permissions" in sender, false);
  assert.equal("optional_permissions" in sender, false);
  assert.equal(sender.action.default_popup, "popup.html");
  assert.equal(sender.options_page, "options.html");
  assert.deepEqual(sender.background, { service_worker: "sw.js", type: "module" });
  assert.equal(typeof sender.key, "string");
  assert.ok(existsSync(new URL("../operator/sw.js", import.meta.url)));
  for (const n of ["16", "32", "48", "128"]) {
    assert.equal(sender.icons[n], `icons/icon-${n}.png`);
    assert.equal(sender.action.default_icon[n], `icons/icon-${n}.png`);
    assert.ok(existsSync(new URL("../operator/" + sender.icons[n], import.meta.url)));
  }
  for (const f of ["popup.html", "popup.js", "popup.css", "options.html", "options.js", "send.js", "read-page.js"]) {
    assert.ok(existsSync(new URL("../operator/" + f, import.meta.url)), f);
  }
});

// Two-modes design, section 3.4: operator mode can never control the
// operator's Chrome. Chrome gives an extension without these permissions no
// chrome.debugger, no native port and no network rules; without these keys it
// has no inbound channel. Optional permissions count too: a package can ask
// for them later.
const CONTROL_PERMISSIONS = [
  "debugger", "nativeMessaging", "declarativeNetRequest", "declarativeNetRequestWithHostAccess",
  "declarativeNetRequestFeedback", "webRequest", "webRequestBlocking", "proxy", "management",
];
const INBOUND_KEYS = ["content_scripts", "externally_connectable", "web_accessible_resources", "declarative_net_request"];

test("the operator package has no control permission, no debugger and no inbound channel", () => {
  for (const list of ["permissions", "optional_permissions"]) {
    for (const p of sender[list] ?? []) assert.ok(!CONTROL_PERMISSIONS.includes(p), `operator ${list}: ${p}`);
  }
  for (const k of INBOUND_KEYS) assert.equal(k in sender, false, k);
  // The agent package holds the control permissions, so the list is not empty by mistake.
  for (const p of ["debugger", "nativeMessaging", "declarativeNetRequest"]) assert.ok(receiver.permissions.includes(p), p);
});

test("agent manifest", () => {
  assert.equal(receiver.manifest_version, 3);
  assert.equal(receiver.version, "0.3.7");
  assert.equal(receiver.name, "agentwatch \u2014 agent mode (agent browser only)");
  // The frame rule's topDomains (C5 rule 4) needs Chrome 141; 145 is the safe minimum.
  assert.equal(receiver.minimum_chrome_version, "145");
  assert.equal(typeof receiver.description, "string");
  assert.ok(receiver.description.length <= 132, "Chrome's description limit");
  // Two-modes design, section 3.1; downloads and contentSettings for the bridge (C10); storage for
  // the copy of the tab-to-scope map in chrome.storage.session (C10, each tab's scope); webRequest
  // for the method of a popup's blocked first request (C10, the retry: a GET only; no install warning).
  assert.deepEqual(receiver.permissions, [
    "cookies", "scripting", "tabs", "webNavigation",
    "declarativeNetRequest", "nativeMessaging", "debugger", "browsingData",
    "downloads", "contentSettings", "storage", "webRequest",
  ]);
  assert.equal("optional_permissions" in receiver, false);
  assert.deepEqual(receiver.host_permissions, ["<all_urls>"]);
  assert.deepEqual(receiver.declarative_net_request.rule_resources, [
    { id: "block_main_frame", enabled: true, path: "rules/block-main-frame.json" },
    { id: "block_frames", enabled: true, path: "rules/block-frames.json" },
  ]);
  for (const k of ["content_scripts", "web_accessible_resources", "externally_connectable", "action"]) {
    assert.equal(k in receiver, false, k);
  }
  assert.equal(typeof receiver.key, "string");
  assert.ok(existsSync(new URL("../agent/sw.js", import.meta.url)));
});

test("the block rules are C5 rules 1 and 3", () => {
  assert.deepEqual(json("agent/rules/block-main-frame.json"), [
    { id: 1, priority: 1, action: { type: "block" }, condition: { resourceTypes: ["main_frame"] } },
  ]);
  // <object> and <embed> documents are DNR type object.
  assert.deepEqual(json("agent/rules/block-frames.json"), [
    { id: 3, priority: 1, action: { type: "block" }, condition: { resourceTypes: ["sub_frame", "object"] } },
  ]);
});

// The receiver's key signs its CRX (scripts/pack-agent.mjs, contract C1): the manifest holds the
// public key only, as a canonical base64 SubjectPublicKeyInfo of an RSA-2048 key.
test("the agent manifest key is the public key of an RSA-2048 key, in canonical base64 DER", () => {
  const der = Buffer.from(receiver.key, "base64");
  assert.equal(der.toString("base64"), receiver.key);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  assert.equal(key.asymmetricKeyType, "rsa");
  assert.equal(key.asymmetricKeyDetails.modulusLength, 2048);
  assert.ok(key.export({ type: "spki", format: "der" }).equals(der));
});

test("ids match docs/protocol.md", () => {
  const sId = extensionId(sender.key);
  const rId = extensionId(receiver.key);
  assert.match(sId, /^[a-p]{32}$/);
  assert.match(rId, /^[a-p]{32}$/);
  assert.notEqual(sId, rId);
  assert.ok(protocol.includes("Sender extension ID: `" + sId + "`"));
  assert.ok(protocol.includes("Receiver extension ID: `" + rId + "`"));
});
