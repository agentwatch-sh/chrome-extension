import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extensionId } from "../scripts/extension-id.mjs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const json = (p) => JSON.parse(read(p));
const sender = json("sender/manifest.json");
const receiver = json("receiver/manifest.json");
const protocol = read("docs/protocol.md");

test("extensionId known vector", () => {
  assert.equal(extensionId("MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtUH8+XV08FK9KGaU8FcmUNec/UsjUDG70wumt2xW2HbcY2hIdCOHxxJFMkU7pEvXKO+fj9O9X8VjAGX7BGh8WCRPVMkNqL3PWNZGYJsCgf13wDeGCGSmtZxzjG1q8224futefeBj5293z/7CwD9NKCqp2pbPOmxSdQoBvBeJpfz4jSaaq4SkpzhHBH1L9/jkRedXLu3kqGoPyQLcR+sEVRoI8wA6ZeMKcV6kec+rrar3UTOlC6s3DG0MI/9xqURESf8mzcjbZ4+1eUwP4EOw0DhFVzOszprGo4JyS0nIB8YNwFxSD5BnDa3MHxxDaXlcjfUtoc/ZxIqMgtgxMdQvDQIDAQAB"), "gdjdfolbhmofnfeagfbobogmbncneffe");
});

test("scripts/extension-id.mjs prints both IDs when it runs, also from a path with a space or through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "extension id "));
  try {
    for (const p of ["scripts/extension-id.mjs", "sender/manifest.json", "receiver/manifest.json"]) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      copyFileSync(new URL("../" + p, import.meta.url), join(dir, p));
    }
    symlinkSync(join(dir, "scripts", "extension-id.mjs"), join(dir, "id-link.mjs"));
    const want = `sender: ${extensionId(sender.key)}\nreceiver: ${extensionId(receiver.key)}\n`;
    for (const script of [join(dir, "scripts", "extension-id.mjs"), join(dir, "id-link.mjs")]) {
      assert.equal(execFileSync(process.execPath, [script], { encoding: "utf8" }), want, script);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sender manifest", () => {
  assert.equal(sender.manifest_version, 3);
  assert.equal(sender.version, "0.1.0");
  assert.equal(sender.name, "agentwatch sender");
  assert.equal(sender.minimum_chrome_version, "132");
  assert.equal(typeof sender.description, "string");
  assert.deepEqual(sender.permissions, ["cookies", "activeTab", "scripting", "storage"]);
  assert.deepEqual(sender.optional_host_permissions, ["*://*/*"]);
  assert.equal("host_permissions" in sender, false);
  assert.equal(sender.action.default_popup, "popup.html");
  assert.equal(sender.options_page, "options.html");
  assert.deepEqual(sender.background, { service_worker: "sw.js", type: "module" });
  assert.equal(typeof sender.key, "string");
  assert.ok(existsSync(new URL("../sender/sw.js", import.meta.url)));
  for (const n of ["16", "32", "48", "128"]) {
    assert.equal(sender.icons[n], `icons/icon-${n}.png`);
    assert.equal(sender.action.default_icon[n], `icons/icon-${n}.png`);
    assert.ok(existsSync(new URL("../sender/" + sender.icons[n], import.meta.url)));
  }
  for (const f of ["popup.html", "popup.js", "popup.css", "options.html", "options.js", "send.js", "read-page.js"]) {
    assert.ok(existsSync(new URL("../sender/" + f, import.meta.url)), f);
  }
});

test("receiver manifest", () => {
  assert.equal(receiver.manifest_version, 3);
  assert.equal(receiver.version, "0.1.0");
  assert.equal(receiver.name, "agentwatch receiver");
  assert.equal(receiver.minimum_chrome_version, "120");
  assert.equal(typeof receiver.description, "string");
  assert.deepEqual(receiver.permissions, [
    "cookies", "scripting", "tabs", "webNavigation",
    "declarativeNetRequest", "nativeMessaging", "debugger", "browsingData",
  ]);
  assert.deepEqual(receiver.host_permissions, ["<all_urls>"]);
  assert.deepEqual(receiver.declarative_net_request.rule_resources, [
    { id: "block_main_frame", enabled: true, path: "rules/block-main-frame.json" },
  ]);
  for (const k of ["content_scripts", "web_accessible_resources", "externally_connectable", "action"]) {
    assert.equal(k in receiver, false, k);
  }
  assert.equal(typeof receiver.key, "string");
  assert.ok(existsSync(new URL("../receiver/sw.js", import.meta.url)));
});

test("block rule is C5 rule 1", () => {
  assert.deepEqual(json("receiver/rules/block-main-frame.json"), [
    { id: 1, priority: 1, action: { type: "block" }, condition: { resourceTypes: ["main_frame"] } },
  ]);
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
