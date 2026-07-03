import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfigDir, keychainServiceName, profileLabel } from "./auth.js";

// sha256("/Users/Mykyta_Tretiak/.claude-personal")[:8] — verified against the real
// Keychain entry Claude Code created for this config dir.
const PERSONAL = "/Users/Mykyta_Tretiak/.claude-personal";
const PERSONAL_SERVICE = "Claude Code-credentials-5a66096d";

test("keychainServiceName: default profile has no suffix", () => {
  assert.equal(keychainServiceName("anything", true), "Claude Code-credentials");
});

test("resolveConfigDir: no setting, no env → default profile", () => {
  const info = resolveConfigDir(undefined, {});
  assert.equal(info.isDefault, true);
  assert.equal(info.service, "Claude Code-credentials");
  assert.equal(info.dir, path.join(os.homedir(), ".claude"));
  assert.equal(info.source, "default");
});

test("resolveConfigDir: setting → hashed service (known value)", () => {
  const info = resolveConfigDir(PERSONAL, {});
  assert.equal(info.service, PERSONAL_SERVICE);
  assert.equal(info.isDefault, false);
  assert.equal(info.source, "setting");
});

test("resolveConfigDir: CLAUDE_CONFIG_DIR env → hashed service", () => {
  const info = resolveConfigDir("", { CLAUDE_CONFIG_DIR: PERSONAL });
  assert.equal(info.service, PERSONAL_SERVICE);
  assert.equal(info.source, "env");
  assert.equal(info.isDefault, false);
});

test("resolveConfigDir: trailing slash is stripped before hashing", () => {
  const info = resolveConfigDir(PERSONAL + "/", {});
  assert.equal(info.service, PERSONAL_SERVICE);
});

test("resolveConfigDir: setting wins over env", () => {
  const info = resolveConfigDir(PERSONAL, { CLAUDE_CONFIG_DIR: "/somewhere/else" });
  assert.equal(info.service, PERSONAL_SERVICE);
  assert.equal(info.source, "setting");
});

test("resolveConfigDir: setting equal to ~/.claude → default profile", () => {
  const info = resolveConfigDir(path.join(os.homedir(), ".claude"), {});
  assert.equal(info.isDefault, true);
  assert.equal(info.service, "Claude Code-credentials");
});

test("resolveConfigDir: ~ in setting is expanded", () => {
  const viaTilde = resolveConfigDir("~/.claude-personal", {});
  const viaAbs = resolveConfigDir(path.join(os.homedir(), ".claude-personal"), {});
  assert.equal(viaTilde.service, viaAbs.service);
  assert.equal(viaTilde.dir, path.join(os.homedir(), ".claude-personal"));
});

test("resolveConfigDir: CLAUDE_SECURESTORAGE_CONFIG_DIR overrides the hash", () => {
  const info = resolveConfigDir(undefined, { CLAUDE_SECURESTORAGE_CONFIG_DIR: PERSONAL });
  assert.equal(info.service, PERSONAL_SERVICE);
  assert.equal(info.isDefault, false);
});

test("profileLabel: non-default dir → short tag; default → undefined", () => {
  assert.equal(
    profileLabel({ dir: "/x/.claude-personal", isDefault: false, service: "s", source: "setting" }),
    "personal",
  );
  assert.equal(
    profileLabel({ dir: "/x/.claude", isDefault: true, service: "s", source: "default" }),
    undefined,
  );
});
