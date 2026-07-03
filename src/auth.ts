import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Base Keychain service name. Claude Code appends OAUTH_FILE_SUFFIX (empty in prod
// builds) and, for a non-default config dir, "-<sha256(configDir)[:8]>". See
// resolveConfigDir / keychainServiceName below — this mirrors Claude Code's own
// credential-storage logic so we read the right account per profile.
const SERVICE_BASE = "Claude Code-credentials";
const SECURITY_TIMEOUT_MS = 5000;
const ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/;

export type ReadTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "not-darwin" | "not-found" | "malformed" | "denied" };

/**
 * A resolved Claude profile: which config directory this VS Code window is bound
 * to, and the derived macOS Keychain service name that holds its OAuth token.
 */
export type ConfigDirInfo = {
  /** Resolved config dir (used for the file fallback and account-email lookup). */
  dir: string;
  /** True when this is the default `~/.claude` profile — its service has no suffix. */
  isDefault: boolean;
  /** Full Keychain service name for this profile's credentials. */
  service: string;
  /** Where the config dir came from, for logging. */
  source: "setting" | "env" | "default";
};

function defaultConfigDir(): string {
  return path.join(os.homedir(), ".claude");
}

/** Expand a leading `~` / `~/…` in a user-authored setting value. */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Strip trailing slashes (keeping the root "/") — load-bearing: the hash of
 *  `/foo/` differs from `/foo`, and Claude Code hashes the un-slashed form. */
function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * Compute the Keychain service name for a config dir, mirroring Claude Code:
 *   default            → "Claude Code-credentials"
 *   custom config dir  → "Claude Code-credentials-" + sha256(NFC(dir)).hex[:8]
 */
export function keychainServiceName(hashInput: string, isDefault: boolean): string {
  if (isDefault) return SERVICE_BASE;
  const suffix = createHash("sha256").update(hashInput.normalize("NFC")).digest("hex").slice(0, 8);
  return `${SERVICE_BASE}-${suffix}`;
}

/**
 * Resolve which Claude profile the current window should read, and the Keychain
 * service name for it. Precedence: explicit setting → `CLAUDE_CONFIG_DIR` env →
 * default `~/.claude`.
 *
 * - setting: human-authored, so expand `~`; treated as the default profile only
 *   when it points at `~/.claude`.
 * - env: the shell already expanded it and Claude Code hashes that literal value,
 *   so an env config dir is always non-default (matches Claude Code's rule).
 * - `CLAUDE_SECURESTORAGE_CONFIG_DIR`, if set, replaces the hashed dir (rare).
 */
export function resolveConfigDir(
  settingValue?: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigDirInfo {
  const setting = settingValue?.trim();
  const envDir = env.CLAUDE_CONFIG_DIR;

  let dir: string;
  let source: ConfigDirInfo["source"];
  let isDefault: boolean;
  let hashInput: string;

  if (setting) {
    dir = stripTrailingSlash(expandTilde(setting)).normalize("NFC");
    source = "setting";
    isDefault = dir === defaultConfigDir();
    hashInput = dir;
  } else if (envDir) {
    // Non-empty env var ⇒ Claude Code treats it as a non-default profile.
    dir = stripTrailingSlash(envDir).normalize("NFC");
    source = "env";
    isDefault = false;
    hashInput = dir;
  } else {
    dir = defaultConfigDir();
    source = "default";
    isDefault = true;
    hashInput = dir;
  }

  // CLAUDE_SECURESTORAGE_CONFIG_DIR overrides only the Keychain hash input; the
  // config dir used for the file fallback / email lookup is unchanged.
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) {
    isDefault = secure === "";
    hashInput = stripTrailingSlash(secure).normalize("NFC");
  }

  return { dir, isDefault, service: keychainServiceName(hashInput, isDefault), source };
}

/** Keychain account attribute (`-a`), mirroring Claude Code's validation. */
function keychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  let raw: string | undefined;
  try {
    raw = env.USER || os.userInfo().username;
  } catch {
    return "claude-code-user";
  }
  return raw && ACCOUNT_RE.test(raw) ? raw : "claude-code-user";
}

function parseToken(raw: string): ReadTokenResult {
  try {
    const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };
    return { ok: true, token };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/**
 * Read the file-based credential Claude Code writes on non-macOS platforms (and,
 * defensively, as a macOS fallback): `<configDir>/.credentials.json`, same shape
 * as the Keychain payload. Reads only — never writes.
 */
function readCredentialsFile(dir: string): ReadTokenResult {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, ".credentials.json"), "utf-8");
  } catch {
    return { ok: false, reason: "not-found" };
  }
  return parseToken(raw);
}

/**
 * Read the OAuth token Claude Code stored for the given profile. On macOS this is
 * the Keychain entry `info.service`; if that entry is missing we fall back to a
 * file-based credential under the config dir.
 *
 * Returns a tagged result so callers can distinguish "user denied prompt" (do not
 * retry every poll) from "missing entry" (never signed in for this profile).
 */
export function readKeychainToken(info: ConfigDirInfo): ReadTokenResult {
  if (process.platform !== "darwin") return { ok: false, reason: "not-darwin" };

  const account = keychainAccount();
  let raw: string;
  try {
    raw = execFileSync(
      "security",
      ["find-generic-password", "-a", account, "-w", "-s", info.service],
      { encoding: "utf-8", timeout: SECURITY_TIMEOUT_MS }
    ).trim();
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (stderr.includes("could not be found")) {
      // No Keychain entry for this profile — try a file-based credential.
      const file = readCredentialsFile(info.dir);
      return file.ok ? file : { ok: false, reason: "not-found" };
    }
    // "denied" and other transient failures: a token may exist but access failed;
    // do NOT mask it with the file fallback (would loop the sign-in prompt).
    return { ok: false, reason: "denied" };
  }

  return parseToken(raw);
}

/**
 * A short, human-friendly tag for a non-default profile (e.g. `.claude-personal`
 * → `personal`). Returns undefined for the default profile so the primary window
 * stays untagged.
 */
export function profileLabel(info: ConfigDirInfo): string | undefined {
  if (info.isDefault) return undefined;
  const base = path.basename(info.dir);
  const short = base.replace(/^\.?claude[-_.]?/i, "");
  return short || base.replace(/^\./, "") || base;
}

/**
 * Best-effort account email for the profile, read from `.claude.json`'s
 * `oauthAccount.emailAddress`. The default profile's file lives at `~/.claude.json`
 * (home), not inside `~/.claude/`. Swallows all errors (the file is large — call
 * off the render hot path).
 */
export function readAccountEmail(info: ConfigDirInfo): string | undefined {
  const file = info.isDefault
    ? path.join(os.homedir(), ".claude.json")
    : path.join(info.dir, ".claude.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      oauthAccount?: { emailAddress?: string };
    };
    return parsed.oauthAccount?.emailAddress;
  } catch {
    return undefined;
  }
}
