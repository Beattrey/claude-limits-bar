export type UsageBucket = { pct: number; resetsAt?: number };

export type ExtraCredits = {
  enabled: boolean;
  usedUsd?: number;
  limitUsd?: number;
  pct?: number;
};

export type Usage = {
  fiveHour?: UsageBucket;
  sevenDay?: UsageBucket;
  sevenDaySonnet?: UsageBucket;
  extraCredits?: ExtraCredits;
};

function pct(util: unknown): number | undefined {
  if (typeof util !== "number" || !Number.isFinite(util)) return undefined;
  // /api/oauth/usage returns utilization on a 0-100 scale (observed: 37 = 37%, 1 = 1%, 0 = 0%).
  // The previous heuristic `util > 1 ? util / 100 : util` collapsed `1` (= 1%) into `1.0` (= 100%).
  return Math.max(0, Math.min(100, Math.floor(util)));
}

function epochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
  }
  return undefined;
}

function bucket(raw: unknown): UsageBucket | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const p = pct(r.utilization);
  if (p === undefined) return undefined;
  return { pct: p, resetsAt: epochSeconds(r.resets_at) };
}

export function formatBar(pct: number): string {
  const length = 10;
  const filled = Math.max(0, Math.min(length, Math.round((pct / 100) * length)));
  return "●".repeat(filled) + "○".repeat(length - filled);
}

export type DisplayMode = "session" | "weekly" | "both";

export type FormatOptions = {
  mode: DisplayMode;
  showBar: boolean;
  nowSec: number;
};

function formatBucket(label: string, b: UsageBucket, opts: FormatOptions): string {
  const bar = opts.showBar ? ` ${formatBar(b.pct)}` : "";
  const reset = b.resetsAt ? ` · ${formatTimeRemaining(b.resetsAt, opts.nowSec)}` : "";
  return `${label}${bar} ${b.pct}%${reset}`;
}

export function formatStatusBar(usage: Usage, opts: FormatOptions): string {
  const showSession = opts.mode === "session" || opts.mode === "both";
  const showWeekly = opts.mode === "weekly" || opts.mode === "both";

  const parts: string[] = [];
  if (showSession && usage.fiveHour) {
    parts.push(formatBucket("S:", usage.fiveHour, opts));
  }
  if (showWeekly) {
    const weekly = usage.sevenDay ?? usage.sevenDaySonnet;
    if (weekly) parts.push(formatBucket("W:", weekly, opts));
  }
  if (usage.extraCredits?.enabled && usage.extraCredits.pct != null) {
    const bar = opts.showBar ? ` ${formatBar(usage.extraCredits.pct)}` : "";
    const dollars = usage.extraCredits.usedUsd != null && usage.extraCredits.limitUsd != null
      ? ` · $${usage.extraCredits.usedUsd.toFixed(2)}/$${usage.extraCredits.limitUsd}`
      : "";
    parts.push(`M:${bar} ${usage.extraCredits.pct}%${dollars}`);
  }
  if (parts.length === 0) return "$(check) Usage OK";
  return `$(pulse) ${parts.join("  ")}`;
}

export type BarHighlight = "none" | "warning" | "error";

// A user-acknowledged ("dismissed") highlight: suppress the status-bar color
// until the window resets (`until`, epoch seconds) or usage climbs above `pct`.
export type DismissState = { pct: number; until?: number };

// The worst (highest-utilization) bucket currently shown for `mode`. Drives both
// the status-bar background color and what opening the details panel acknowledges.
export function worstShownBucket(usage: Usage, mode: DisplayMode): UsageBucket | undefined {
  const candidates: UsageBucket[] = [];
  if (mode === "session" || mode === "both") {
    if (usage.fiveHour) candidates.push(usage.fiveHour);
  }
  if (mode === "weekly" || mode === "both") {
    const weekly = usage.sevenDay ?? usage.sevenDaySonnet;
    if (weekly) candidates.push(weekly);
  }
  if (usage.extraCredits?.enabled && usage.extraCredits.pct != null) {
    candidates.push({ pct: usage.extraCredits.pct });
  }
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (b.pct > a.pct ? b : a));
}

// Decide the status-bar background, honoring a dismiss the user set by opening
// the details panel. The dismiss expires once its window resets or usage climbs
// higher than when it was dismissed — so a worsening or fresh limit still lights
// up. Returns the (possibly cleared) dismiss so the caller can persist it.
export function resolveHighlight(
  maxPct: number,
  dismiss: DismissState | undefined,
  nowSec: number,
): { highlight: BarHighlight; dismiss: DismissState | undefined } {
  let active = dismiss;
  if (active && ((active.until != null && nowSec >= active.until) || maxPct > active.pct)) {
    active = undefined;
  }
  if (active) return { highlight: "none", dismiss: active };
  if (maxPct >= 90) return { highlight: "error", dismiss: undefined };
  if (maxPct >= 70) return { highlight: "warning", dismiss: undefined };
  return { highlight: "none", dismiss: undefined };
}

export function formatTimeRemaining(resetsAt: number, nowSec: number = Date.now() / 1000): string {
  const diff = Math.floor(resetsAt - nowSec);
  if (diff <= 0) return "soon";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function parseRetryAfter(header: string | undefined, now: number = Date.now()): number {
  const FALLBACK = 600;
  if (!header) return FALLBACK;
  const numeric = Number(header);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const ts = Date.parse(header);
  if (Number.isNaN(ts)) return FALLBACK;
  const diffSec = Math.floor((ts - now) / 1000);
  return diffSec > 0 ? diffSec : FALLBACK;
}

export function parseUsage(body: string): Usage {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const out: Usage = {};
  out.fiveHour = bucket(parsed.five_hour);
  out.sevenDay = bucket(parsed.seven_day);
  out.sevenDaySonnet = bucket(parsed.seven_day_sonnet);
  const eu = parsed.extra_usage as Record<string, unknown> | undefined;
  if (eu && typeof eu === "object") {
    out.extraCredits = {
      enabled: Boolean(eu.is_enabled),
      usedUsd: typeof eu.used_credits === "number" ? eu.used_credits / 100 : undefined,
      limitUsd: typeof eu.monthly_limit === "number" ? eu.monthly_limit / 100 : undefined,
      pct: pct(eu.utilization),
    };
  }
  return out;
}
