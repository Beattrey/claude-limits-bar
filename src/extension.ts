import * as vscode from "vscode";
import { readKeychainToken } from "./auth.js";
import { fetchUsage, type FetchResult } from "./api.js";
import { formatStatusBar, type DisplayMode, type Usage } from "./util.js";

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
let ctx: vscode.ExtensionContext;

const log = (msg: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  output.appendLine(`[${ts}] ${msg}`);
};

const getConfig = <T>(key: string, fallback: T): T =>
  vscode.workspace.getConfiguration("claudeLimitsBar").get<T>(key, fallback);

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
    statusBar.tooltip = "Click to retry — will re-read Keychain.";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    statusBar.show();
    return;
  }

  const text = formatStatusBar(cached, { mode, showBar, nowSec: nowSec() });
  statusBar.text = text;

  // Background color from worst percentage we are showing
  const pcts: number[] = [];
  if ((mode === "session" || mode === "both") && cached.fiveHour) pcts.push(cached.fiveHour.pct);
  if (mode === "weekly" || mode === "both") {
    const weekly = cached.sevenDay ?? cached.sevenDaySonnet;
    if (weekly) pcts.push(weekly.pct);
  }
  const max = pcts.length ? Math.max(...pcts) : 0;
  if (max >= 90) {
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (max >= 70) {
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusBar.backgroundColor = undefined;
  }

  statusBar.tooltip = buildTooltip();
  statusBar.show();

  ctx.globalState.update(STATE_KEY_LAST_TEXT, text);
  ctx.globalState.update(STATE_KEY_LAST_USAGE, cached);
}

function buildTooltip(): string {
  const lines = ["Claude Limits", "─".repeat(20)];
  const fmt = (label: string, b: { pct: number; resetsAt?: number } | undefined) => {
    if (!b) return;
    const reset = b.resetsAt ? ` · resets ${new Date(b.resetsAt * 1000).toLocaleString()}` : "";
    lines.push(`${label}: ${b.pct}%${reset}`);
  };
  fmt("Session (5h)", cached.fiveHour);
  fmt("Weekly Opus (7d)", cached.sevenDay);
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
  const tok = readKeychainToken();
  if (!tok.ok) {
    log(`Keychain read failed: ${tok.reason}`);
    if (tok.reason === "not-darwin") {
      platformBlocked = true;
      stopPoll();
      render();
    } else if (tok.reason === "not-found") {
      log("Keychain entry 'Claude Code-credentials' not found — sign in to Claude Code first via the CLI or VS Code extension.");
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
  const panel = vscode.window.createWebviewPanel(
    "claudeLimitsBar.details",
    "Claude Limits",
    vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: false }
  );
  panel.webview.html = renderPanelHtml(cached);
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
  const extra = u.extraCredits?.enabled && u.extraCredits.usedUsd != null && u.extraCredits.limitUsd != null
    ? `<div class="row extra">Extra credits: $${u.extraCredits.usedUsd.toFixed(2)} / $${u.extraCredits.limitUsd} (${u.extraCredits.pct ?? 0}%)</div>`
    : "";
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
  .extra { grid-template-columns: 1fr; padding-top: 0.8em; border-top: 1px solid var(--vscode-panel-border); }
</style>
</head><body>
  <h1>Claude Limits</h1>
  ${row("Session (5h)", u.fiveHour)}
  ${row("Weekly Opus (7d)", u.sevenDay)}
  ${row("Weekly Sonnet (7d)", u.sevenDaySonnet)}
  ${extra}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  output = vscode.window.createOutputChannel("Claude Limits Bar");
  context.subscriptions.push(output);
  log("activate v0.1.0");

  cached = context.globalState.get<Usage>(STATE_KEY_LAST_USAGE) ?? {};
  const lastText = context.globalState.get<string>(STATE_KEY_LAST_TEXT);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 52);
  statusBar.command = "claudeLimitsBar.showDetails";
  context.subscriptions.push(statusBar);
  statusBar.text = lastText ?? "$(pulse) Claude: loading…";
  statusBar.show();

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
