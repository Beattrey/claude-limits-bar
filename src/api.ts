import * as https from "node:https";
import { parseUsage, parseRetryAfter, type Usage } from "./util.js";

const ANTHROPIC_BETA = "oauth-2025-04-20";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;

export type FetchResult =
  | { kind: "ok"; usage: Usage }
  | { kind: "auth-error" }                   // 401/403
  | { kind: "rate-limited"; retryAfterSec: number }
  | { kind: "transient"; reason: string };   // network, timeout, 5xx, parse error

export function fetchUsage(token: string): Promise<FetchResult> {
  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": ANTHROPIC_BETA,
      },
      timeout: REQUEST_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let body = "";
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        if (body.length + chunk.length > MAX_RESPONSE_BYTES) {
          truncated = true;
          return;
        }
        body += chunk.toString("utf-8");
      });
      res.on("end", () => {
        if (truncated) {
          resolve({ kind: "transient", reason: "response too large" });
          return;
        }
        const status = res.statusCode ?? 0;
        if (status === 401 || status === 403) {
          resolve({ kind: "auth-error" });
          return;
        }
        if (status === 429) {
          const raw = res.headers["retry-after"];
          const headerStr = Array.isArray(raw) ? raw[0] : raw;
          const retry = parseRetryAfter(headerStr);
          resolve({ kind: "rate-limited", retryAfterSec: retry });
          return;
        }
        if (status < 200 || status >= 300) {
          resolve({ kind: "transient", reason: `HTTP ${status}` });
          return;
        }
        try {
          resolve({ kind: "ok", usage: parseUsage(body) });
        } catch (err) {
          resolve({ kind: "transient", reason: `parse error: ${(err as Error).message}` });
        }
      });
    });
    req.on("error", (err) => resolve({ kind: "transient", reason: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ kind: "transient", reason: "timeout" });
    });
    req.end();
  });
}
