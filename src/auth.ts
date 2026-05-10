import { execFileSync } from "node:child_process";
import * as os from "node:os";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY_TIMEOUT_MS = 5000;

export type ReadTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "not-darwin" | "not-found" | "malformed" | "denied" };

/**
 * Reads the OAuth token Claude Code stores in the macOS Keychain.
 * Returns a tagged result so callers can distinguish "user denied prompt"
 * (which we should not retry on every poll) from "missing entry"
 * (which means Claude Code was never signed in here).
 */
export function readKeychainToken(): ReadTokenResult {
  if (process.platform !== "darwin") return { ok: false, reason: "not-darwin" };

  const username = process.env.USER || os.userInfo().username || "claude-user";

  let raw: string;
  try {
    raw = execFileSync(
      "security",
      ["find-generic-password", "-a", username, "-w", "-s", KEYCHAIN_SERVICE],
      { encoding: "utf-8", timeout: SECURITY_TIMEOUT_MS }
    ).trim();
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (stderr.includes("could not be found")) return { ok: false, reason: "not-found" };
    return { ok: false, reason: "denied" };
  }

  try {
    const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };
    return { ok: true, token };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
