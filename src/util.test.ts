import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsage } from "./util.js";

test("parseUsage: utilization is treated as 0..100 scale (matches API)", () => {
  const usage = parseUsage(JSON.stringify({
    five_hour: { utilization: 42, resets_at: 1746800000 },
  }));
  assert.deepEqual(usage.fiveHour, { pct: 42, resetsAt: 1746800000 });
});

test("parseUsage: utilization=1 means 1% (regression: heuristic used to flip this to 100%)", () => {
  const usage = parseUsage(JSON.stringify({
    seven_day_sonnet: { utilization: 1.0, resets_at: 1746800000 },
  }));
  assert.equal(usage.sevenDaySonnet?.pct, 1);
});

test("parseUsage: utilization=0 means 0%", () => {
  const usage = parseUsage(JSON.stringify({
    seven_day: { utilization: 0, resets_at: 1746800000 },
  }));
  assert.equal(usage.sevenDay?.pct, 0);
});

test("parseUsage: utilization >100 is clamped to 100", () => {
  const usage = parseUsage(JSON.stringify({
    five_hour: { utilization: 150, resets_at: 1746800000 },
  }));
  assert.equal(usage.fiveHour?.pct, 100);
});

test("parseUsage: parses ISO resets_at", () => {
  const usage = parseUsage(JSON.stringify({
    five_hour: { utilization: 10, resets_at: "2026-05-09T15:00:00Z" },
  }));
  assert.equal(usage.fiveHour?.resetsAt, 1778338800);
});

test("parseUsage: missing fields are undefined", () => {
  const usage = parseUsage(JSON.stringify({}));
  assert.equal(usage.fiveHour, undefined);
  assert.equal(usage.sevenDay, undefined);
  assert.equal(usage.sevenDaySonnet, undefined);
  assert.equal(usage.extraCredits, undefined);
});

test("parseUsage: extra_usage maps used_credits and monthly_limit (API returns cents)", () => {
  const usage = parseUsage(JSON.stringify({
    extra_usage: { is_enabled: true, used_credits: 420, monthly_limit: 5000, utilization: 8.4 },
  }));
  assert.deepEqual(usage.extraCredits, { enabled: true, usedUsd: 4.20, limitUsd: 50, pct: 8 });
});

test("parseUsage: throws on invalid JSON", () => {
  assert.throws(() => parseUsage("not json"));
});

import { parseRetryAfter } from "./util.js";

test("parseRetryAfter: numeric seconds", () => {
  assert.equal(parseRetryAfter("120"), 120);
});

test("parseRetryAfter: HTTP-date in the future", () => {
  const now = 1778425200_000; // 2026-05-09T15:00:00Z (in ms)
  const future = new Date(now + 60_000).toUTCString();
  assert.equal(parseRetryAfter(future, now), 60);
});

test("parseRetryAfter: missing → fallback 600", () => {
  assert.equal(parseRetryAfter(undefined), 600);
});

test("parseRetryAfter: garbage → fallback 600", () => {
  assert.equal(parseRetryAfter("Wed banana"), 600);
});

test("parseRetryAfter: past date → fallback 600", () => {
  const now = 1778425200_000;
  const past = new Date(now - 60_000).toUTCString();
  assert.equal(parseRetryAfter(past, now), 600);
});

import { formatTimeRemaining } from "./util.js";

test("formatTimeRemaining: seconds-only window shows minutes", () => {
  const now = 1000;
  assert.equal(formatTimeRemaining(1 + 60 * 5, now / 1000), "5m");
});

test("formatTimeRemaining: hours and minutes", () => {
  const now = 0;
  assert.equal(formatTimeRemaining(2 * 3600 + 30 * 60, now), "2h 30m");
});

test("formatTimeRemaining: days and hours", () => {
  const now = 0;
  assert.equal(formatTimeRemaining(3 * 86400 + 4 * 3600, now), "3d 4h");
});

test("formatTimeRemaining: in the past → 'soon'", () => {
  assert.equal(formatTimeRemaining(0, 1000), "soon");
});

import { formatBar, formatStatusBar } from "./util.js";

test("formatBar: 0% → all empty", () => {
  assert.equal(formatBar(0), "○○○○○○○○○○");
});

test("formatBar: 50% → half filled", () => {
  assert.equal(formatBar(50), "●●●●●○○○○○");
});

test("formatBar: 100% → all filled", () => {
  assert.equal(formatBar(100), "●●●●●●●●●●");
});

test("formatStatusBar: session-only with bar and reset", () => {
  const usage: import("./util.js").Usage = {
    fiveHour: { pct: 42, resetsAt: 100 + 2 * 3600 + 13 * 60 },
  };
  const text = formatStatusBar(usage, { mode: "session", showBar: true, nowSec: 100 });
  assert.equal(text, "$(pulse) S: ●●●●○○○○○○ 42% · 2h 13m");
});

test("formatStatusBar: weekly-only no bar no reset", () => {
  const usage: import("./util.js").Usage = { sevenDay: { pct: 18 } };
  const text = formatStatusBar(usage, { mode: "weekly", showBar: false, nowSec: 0 });
  assert.equal(text, "$(pulse) W: 18%");
});

test("formatStatusBar: 'both' joins with two spaces", () => {
  const usage: import("./util.js").Usage = {
    fiveHour: { pct: 42 },
    sevenDay: { pct: 18 },
  };
  const text = formatStatusBar(usage, { mode: "both", showBar: false, nowSec: 0 });
  assert.equal(text, "$(pulse) S: 42%  W: 18%");
});

test("formatStatusBar: weekly falls back to seven_day_sonnet when seven_day missing", () => {
  const usage: import("./util.js").Usage = { sevenDaySonnet: { pct: 22 } };
  const text = formatStatusBar(usage, { mode: "weekly", showBar: false, nowSec: 0 });
  assert.equal(text, "$(pulse) W: 22%");
});

test("formatStatusBar: empty usage returns 'OK' marker", () => {
  const text = formatStatusBar({}, { mode: "both", showBar: false, nowSec: 0 });
  assert.equal(text, "$(check) Usage OK");
});

test("formatStatusBar: extra credits only → shows M: in status bar", () => {
  const usage: import("./util.js").Usage = {
    extraCredits: { enabled: true, pct: 42, usedUsd: 15.64, limitUsd: 500 },
  };
  const text = formatStatusBar(usage, { mode: "both", showBar: false, nowSec: 0 });
  assert.equal(text, "$(pulse) M: 42% · $15.64/$500");
});

test("formatStatusBar: extra credits with bar and dollars", () => {
  const usage: import("./util.js").Usage = {
    extraCredits: { enabled: true, pct: 50, usedUsd: 250, limitUsd: 500 },
  };
  const text = formatStatusBar(usage, { mode: "both", showBar: true, nowSec: 0 });
  assert.equal(text, "$(pulse) M: ●●●●●○○○○○ 50% · $250.00/$500");
});

test("formatStatusBar: extra credits without dollar amounts → shows pct only", () => {
  const usage: import("./util.js").Usage = {
    extraCredits: { enabled: true, pct: 42 },
  };
  const text = formatStatusBar(usage, { mode: "both", showBar: false, nowSec: 0 });
  assert.equal(text, "$(pulse) M: 42%");
});

test("formatStatusBar: extra credits combined with session", () => {
  const usage: import("./util.js").Usage = {
    fiveHour: { pct: 20 },
    extraCredits: { enabled: true, pct: 65, usedUsd: 325, limitUsd: 500 },
  };
  const text = formatStatusBar(usage, { mode: "session", showBar: false, nowSec: 0 });
  assert.equal(text, "$(pulse) S: 20%  M: 65% · $325.00/$500");
});

test("formatStatusBar: extra credits disabled → not shown", () => {
  const usage: import("./util.js").Usage = {
    extraCredits: { enabled: false, pct: 42 },
  };
  const text = formatStatusBar(usage, { mode: "both", showBar: false, nowSec: 0 });
  assert.equal(text, "$(check) Usage OK");
});

test("formatStatusBar: extra credits pct undefined → not shown", () => {
  const usage: import("./util.js").Usage = {
    extraCredits: { enabled: true },
  };
  const text = formatStatusBar(usage, { mode: "both", showBar: false, nowSec: 0 });
  assert.equal(text, "$(check) Usage OK");
});

test("formatStatusBar: extra credits pct=0 → shows 0%", () => {
  const usage: import("./util.js").Usage = {
    extraCredits: { enabled: true, pct: 0 },
  };
  const text = formatStatusBar(usage, { mode: "both", showBar: false, nowSec: 0 });
  assert.equal(text, "$(pulse) M: 0%");
});

import { worstShownBucket, resolveHighlight } from "./util.js";

test("worstShownBucket: 'both' picks the higher of session/weekly", () => {
  const usage: import("./util.js").Usage = { fiveHour: { pct: 42 }, sevenDay: { pct: 88 } };
  assert.equal(worstShownBucket(usage, "both")?.pct, 88);
});

test("worstShownBucket: 'session' ignores weekly", () => {
  const usage: import("./util.js").Usage = { fiveHour: { pct: 42 }, sevenDay: { pct: 88 } };
  assert.equal(worstShownBucket(usage, "session")?.pct, 42);
});

test("worstShownBucket: 'weekly' ignores session and falls back to sonnet", () => {
  const usage: import("./util.js").Usage = { fiveHour: { pct: 99 }, sevenDaySonnet: { pct: 30 } };
  assert.equal(worstShownBucket(usage, "weekly")?.pct, 30);
});

test("worstShownBucket: enabled extra credits counted in any mode", () => {
  const usage: import("./util.js").Usage = { fiveHour: { pct: 10 }, extraCredits: { enabled: true, pct: 77 } };
  assert.equal(worstShownBucket(usage, "both")?.pct, 77);
});

test("worstShownBucket: disabled extra credits ignored", () => {
  const usage: import("./util.js").Usage = { extraCredits: { enabled: false, pct: 77 } };
  assert.equal(worstShownBucket(usage, "both"), undefined);
});

test("worstShownBucket: empty usage → undefined", () => {
  assert.equal(worstShownBucket({}, "both"), undefined);
});

test("worstShownBucket: carries resetsAt of the worst bucket", () => {
  const usage: import("./util.js").Usage = {
    fiveHour: { pct: 42, resetsAt: 111 },
    sevenDay: { pct: 88, resetsAt: 222 },
  };
  assert.equal(worstShownBucket(usage, "both")?.resetsAt, 222);
});

test("resolveHighlight: thresholds none/warning/error", () => {
  assert.equal(resolveHighlight(69, undefined, 0).highlight, "none");
  assert.equal(resolveHighlight(70, undefined, 0).highlight, "warning");
  assert.equal(resolveHighlight(89, undefined, 0).highlight, "warning");
  assert.equal(resolveHighlight(90, undefined, 0).highlight, "error");
});

test("resolveHighlight: active dismiss suppresses the highlight", () => {
  const r = resolveHighlight(95, { pct: 95, until: 1000 }, 500);
  assert.equal(r.highlight, "none");
  assert.deepEqual(r.dismiss, { pct: 95, until: 1000 });
});

test("resolveHighlight: dismiss cleared once usage climbs higher", () => {
  const r = resolveHighlight(96, { pct: 95, until: 1000 }, 500);
  assert.equal(r.highlight, "error");
  assert.equal(r.dismiss, undefined);
});

test("resolveHighlight: equal usage keeps the dismiss", () => {
  const r = resolveHighlight(95, { pct: 95, until: 1000 }, 500);
  assert.equal(r.highlight, "none");
  assert.deepEqual(r.dismiss, { pct: 95, until: 1000 });
});

test("resolveHighlight: dismiss expires when the window resets", () => {
  const r = resolveHighlight(80, { pct: 95, until: 1000 }, 1000);
  assert.equal(r.highlight, "warning");
  assert.equal(r.dismiss, undefined);
});

test("resolveHighlight: dismiss without 'until' only clears on higher usage", () => {
  const stay = resolveHighlight(80, { pct: 95 }, 9_999_999);
  assert.equal(stay.highlight, "none");
  assert.deepEqual(stay.dismiss, { pct: 95 });
  const gone = resolveHighlight(96, { pct: 95 }, 9_999_999);
  assert.equal(gone.highlight, "error");
  assert.equal(gone.dismiss, undefined);
});
