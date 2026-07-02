import * as vscode from "vscode";
import {
  readKeychainToken,
  resolveConfigDir,
  profileLabel,
  readAccountEmail,
  type ConfigDirInfo,
} from "./auth.js";
import { fetchUsage, type FetchResult } from "./api.js";
import {
  formatStatusBar,
  worstShownBucket,
  resolveHighlight,
  type DisplayMode,
  type DismissState,
  type Usage,
} from "./util.js";

const STATE_KEY_LAST_USAGE = "claudeLimitsBar.lastUsage";
const STATE_KEY_LAST_TEXT = "claudeLimitsBar.lastGoodText";

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let pollHandle: ReturnType<typeof setTimeout> | undefined;
let displayTickHandle: ReturnType<typeof setInterval> | undefined;
let cached: Usage = {};
let backoffUntil = 0;
let authBlocked = false;
let platformBlocked = false;
let dismiss: DismissState | undefined;
let ctx: vscode.ExtensionContext;
let currentInfo: ConfigDirInfo;
let currentProfile: { label?: string; email?: string } = {};

const log = (msg: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  output.appendLine(`[${ts}] ${msg}`);
};

const getConfig = <T>(key: string, fallback: T): T =>
  vscode.workspace.getConfiguration("claudeLimitsBar").get<T>(key, fallback);

// Resolve which Claude profile this window is bound to (config dir + Keychain
// service) plus its display label/email. Does file I/O for the email — call on
// fetch / config change / activation, never on the 30s render tick.
function resolveProfile(): void {
  // configDir is resource-scoped so it can be pinned in a folder's .vscode/settings.json
  // even in multi-root workspaces. Read it against the workspace folder so folder-level
  // settings actually apply.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  // Only honor the workspace-provided configDir when the workspace is TRUSTED: it
  // selects the directory we read .credentials.json/.claude.json from, so an untrusted
  // repo must not be able to redirect it. VS Code also enforces this declaratively via
  // capabilities.untrustedWorkspaces.restrictedConfigurations in package.json.
  const configDir = vscode.workspace.isTrusted
    ? vscode.workspace.getConfiguration("claudeLimitsBar", folder).get<string>("configDir", "").trim()
    : "";
  currentInfo = resolveConfigDir(configDir || undefined);
  currentProfile = { label: profileLabel(currentInfo), email: readAccountEmail(currentInfo) };
}

// Last-good cache is keyed by profile so windows on different accounts don't show
// each other's numbers (globalState is shared across a profile's windows).
const usageKey = (): string => `${STATE_KEY_LAST_USAGE}:${currentInfo.service}`;
const textKey = (): string => `${STATE_KEY_LAST_TEXT}:${currentInfo.service}`;

// One-line profile identity for tooltips.
function profileSuffix(): string {
  const who = currentProfile.email ?? currentInfo?.dir;
  return `Profile: ${currentProfile.label ?? "default"}${who ? ` — ${who}` : ""}`;
}

// Append a compact profile tag to the status-bar text per `showProfileLabel`.
function withProfileTag(base: string): string {
  const mode = getConfig<string>("showProfileLabel", "auto");
  let tag: string | undefined;
  if (mode === "always") tag = currentProfile.label ?? "default";
  else if (mode === "auto") tag = currentProfile.label;
  return tag ? `${base}  $(account) ${tag}` : base;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function render(): void {
  const mode = getConfig<DisplayMode>("displayMode", "both");
  const showBar = getConfig<boolean>("showProgressBar", true);

  if (platformBlocked) {
    statusBar.text = "$(warning) Claude: macOS only";
    statusBar.tooltip = "Claude Limits Bar requires macOS Keychain — disable the extension on this platform.";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    statusBar.show();
    return;
  }

  if (authBlocked) {
    statusBar.text = "$(warning) Claude: Auth expired";
    statusBar.tooltip = `Click to retry — will re-read Keychain.\n${profileSuffix()}`;
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    statusBar.show();
    return;
  }

  const base = formatStatusBar(cached, { mode, showBar, nowSec: nowSec() });
  const text = withProfileTag(base);
  statusBar.text = text;

  // Background color from the worst percentage we are showing — unless the user
  // acknowledged it by opening the details panel (see acknowledgeHighlight).
  const worst = worstShownBucket(cached, mode);
  const resolved = resolveHighlight(worst?.pct ?? 0, dismiss, nowSec());
  dismiss = resolved.dismiss;
  statusBar.backgroundColor =
    resolved.highlight === "error"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : resolved.highlight === "warning"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;

  statusBar.tooltip = buildTooltip();
  statusBar.show();

  ctx.globalState.update(textKey(), text);
  ctx.globalState.update(usageKey(), cached);
}

function buildTooltip(): string {
  const lines = ["Claude Limits", "─".repeat(20), profileSuffix(), ""];
  const fmt = (label: string, b: { pct: number; resetsAt?: number } | undefined) => {
    if (!b) return;
    const reset = b.resetsAt ? ` · resets ${new Date(b.resetsAt * 1000).toLocaleString()}` : "";
    lines.push(`${label}: ${b.pct}%${reset}`);
  };
  fmt("Session (5h)", cached.fiveHour);
  fmt("Weekly (7d)", cached.sevenDay);
  fmt("Weekly Sonnet (7d)", cached.sevenDaySonnet);
  if (cached.extraCredits?.enabled && cached.extraCredits.usedUsd != null && cached.extraCredits.limitUsd != null) {
    lines.push(`Extra credits: $${cached.extraCredits.usedUsd.toFixed(2)} / $${cached.extraCredits.limitUsd} (${cached.extraCredits.pct ?? 0}%)`);
  }
  lines.push("", "Click to open details panel.");
  return lines.join("\n");
}

function applyResult(result: FetchResult): void {
  switch (result.kind) {
    case "ok":
      authBlocked = false;
      cached = result.usage;
      log("fetched fresh usage data");
      break;
    case "auth-error":
      authBlocked = true;
      log("auth expired; pausing poll until manual refresh");
      stopPoll();
      break;
    case "rate-limited":
      backoffUntil = Date.now() + (result.retryAfterSec + 30) * 1000;
      log(`rate-limited; backing off ${Math.ceil(result.retryAfterSec / 60)} min`);
      break;
    case "transient":
      log(`transient error: ${result.reason}`);
      break;
  }
  render();
}

async function fetchOnce(): Promise<void> {
  if (platformBlocked) return;
  if (Date.now() < backoffUntil) {
    log("still in backoff; skipping");
    return;
  }
  resolveProfile();
  log(`profile: source=${currentInfo.source}, service='${currentInfo.service}', dir=${currentInfo.dir}`);
  const tok = readKeychainToken(currentInfo);
  if (!tok.ok) {
    log(`Keychain read failed: ${tok.reason}`);
    if (tok.reason === "not-darwin") {
      platformBlocked = true;
      stopPoll();
      render();
    } else if (tok.reason === "not-found") {
      log(`Keychain entry '${currentInfo.service}' not found — sign in to Claude Code for config dir ${currentInfo.dir}.`);
      render();
    } else {
      // "denied" and other transient keychain failures: log only, keep last-good display, retry on next poll
      render();
    }
    return;
  }
  authBlocked = false;
  const result = await fetchUsage(tok.token);
  applyResult(result);
}

function scheduleNextPoll(): void {
  const minutes = Math.max(1, getConfig<number>("pollMinutes", 5));
  const jitter = Math.floor(Math.random() * 60_000);
  pollHandle = setTimeout(async () => {
    await fetchOnce();
    scheduleNextPoll();
  }, minutes * 60_000 + jitter);
}

function stopPoll(): void {
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = undefined;
  }
}

function showDetailsPanel(): void {
  acknowledgeHighlight();
  const panel = vscode.window.createWebviewPanel(
    "claudeLimitsBar.details",
    "Claude Limits",
    vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: false }
  );
  panel.webview.html = renderPanelHtml(cached);
}

// Opening the details panel counts as "I've seen the warning": suppress the
// status-bar highlight until the limit resets or usage climbs higher than now.
function acknowledgeHighlight(): void {
  const mode = getConfig<DisplayMode>("displayMode", "both");
  const worst = worstShownBucket(cached, mode);
  if (worst && worst.pct >= 70) {
    dismiss = { pct: worst.pct, until: worst.resetsAt };
    render();
  }
}

function renderPanelHtml(u: Usage): string {
  const row = (label: string, b: { pct: number; resetsAt?: number } | undefined) => {
    if (!b) return "";
    const resetTxt = b.resetsAt ? new Date(b.resetsAt * 1000).toLocaleString() : "—";
    const color = b.pct >= 90 ? "#e06c75" : b.pct >= 70 ? "#e5c07b" : "#98c379";
    return `
      <div class="row">
        <div class="label">${escapeHtml(label)}</div>
        <div class="bar"><div class="fill" style="width:${b.pct}%; background:${color};"></div></div>
        <div class="pct">${b.pct}%</div>
        <div class="reset">resets ${escapeHtml(resetTxt)}</div>
      </div>`;
  };
  const extra = (() => {
    const ec = u.extraCredits;
    if (!ec?.enabled || ec.pct == null) return "";
    const color = ec.pct >= 90 ? "#e06c75" : ec.pct >= 70 ? "#e5c07b" : "#98c379";
    const dollarStr = ec.usedUsd != null && ec.limitUsd != null
      ? `$${ec.usedUsd.toFixed(2)} / $${ec.limitUsd}`
      : "monthly";
    return `
      <div class="row">
        <div class="label">Monthly credits</div>
        <div class="bar"><div class="fill" style="width:${ec.pct}%; background:${color};"></div></div>
        <div class="pct">${ec.pct}%</div>
        <div class="reset">${escapeHtml(dollarStr)}</div>
      </div>`;
  })();
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 1.5em; color: var(--vscode-foreground); }
  h1 { font-size: 1.1em; margin: 0 0 1em 0; }
  .row { display: grid; grid-template-columns: 11em 1fr 3em 11em; align-items: center; gap: 0.8em; margin-bottom: 0.6em; }
  .label { font-weight: 600; }
  .bar { height: 0.6em; background: var(--vscode-editorWidget-background); border-radius: 3px; overflow: hidden; }
  .fill { height: 100%; transition: width 0.3s; }
  .pct { text-align: right; font-variant-numeric: tabular-nums; }
  .reset { color: var(--vscode-descriptionForeground); font-size: 0.85em; }

</style>
</head><body>
  <h1>Claude Limits</h1>
  ${row("Session (5h)", u.fiveHour)}
  ${row("Weekly (7d)", u.sevenDay)}
  ${row("Weekly Sonnet (7d)", u.sevenDaySonnet)}
  ${extra}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function alignment(): vscode.StatusBarAlignment {
  return getConfig<string>("alignment", "right") === "left"
    ? vscode.StatusBarAlignment.Left
    : vscode.StatusBarAlignment.Right;
}

// (Re)create the status-bar item on the configured side. Alignment is fixed at
// creation time, so changing the setting means disposing and rebuilding the item.
function buildStatusBar(initialText?: string): void {
  const previous: vscode.StatusBarItem | undefined = statusBar;
  statusBar = vscode.window.createStatusBarItem(alignment(), 52);
  statusBar.command = "claudeLimitsBar.showDetails";
  ctx.subscriptions.push(statusBar);
  if (initialText !== undefined) statusBar.text = initialText;
  statusBar.show();
  previous?.dispose();
}

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  output = vscode.window.createOutputChannel("Claude Limits Bar");
  context.subscriptions.push(output);
  log("activate v0.1.3");

  resolveProfile();
  cached = context.globalState.get<Usage>(usageKey()) ?? {};
  const lastText = context.globalState.get<string>(textKey());

  buildStatusBar(lastText ?? "$(pulse) Claude: loading…");

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeLimitsBar.refresh", async () => {
      authBlocked = false;
      backoffUntil = 0;
      stopPoll();
      await fetchOnce();
      scheduleNextPoll();
    }),
    vscode.commands.registerCommand("claudeLimitsBar.showDetails", () => showDetailsPanel()),
    vscode.commands.registerCommand("claudeLimitsBar.switchDisplayMode", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeLimitsBar");
      const cur = cfg.get<DisplayMode>("displayMode", "both");
      const next: DisplayMode = cur === "session" ? "weekly" : cur === "weekly" ? "both" : "session";
      await cfg.update("displayMode", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Claude Limits: showing ${next}`, 2500);
      render();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("claudeLimitsBar")) return;
      if (e.affectsConfiguration("claudeLimitsBar.configDir")) {
        // Profile changed — reset error state, swap to the new account's cached
        // numbers so we don't flash the old account's figures, then re-read now.
        authBlocked = false;
        backoffUntil = 0;
        platformBlocked = false;
        stopPoll();
        resolveProfile();
        cached = ctx.globalState.get<Usage>(usageKey()) ?? {};
        render();
        fetchOnce().finally(() => scheduleNextPoll());
        return;
      }
      if (e.affectsConfiguration("claudeLimitsBar.alignment")) {
        buildStatusBar(statusBar.text);
      }
      render();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      // Trust just granted — a pinned configDir now applies; re-read the profile.
      stopPoll();
      fetchOnce().finally(() => scheduleNextPoll());
    })
  );

  // Initial fetch immediately, then schedule
  fetchOnce().finally(() => scheduleNextPoll());

  // Tick every 30s to keep "resets in Xm" countdown current
  displayTickHandle = setInterval(render, 30_000);

  context.subscriptions.push({
    dispose: () => {
      stopPoll();
      if (displayTickHandle) clearInterval(displayTickHandle);
    },
  });
}

export function deactivate(): void {
  stopPoll();
  if (displayTickHandle) clearInterval(displayTickHandle);
}
