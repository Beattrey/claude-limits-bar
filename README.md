# Claude Limits Bar

A minimal VS Code extension that shows your Claude Code subscription rate-limit utilization in the status bar. macOS only.

## What it shows

- **5-hour rolling window** (`S:`) — session quota
- **Weekly** (`W:`) — overall 7-day quota across all models (falls back to the Sonnet-specific weekly bucket if the overall one is absent)
- **Monthly credits** (`M:`) — dollar-based pay-as-you-go usage, shown when enabled on your plan (e.g. `$140.71 / $500`)

The status-bar item turns **yellow at ≥70%** and **red at ≥90%** of the worst bucket currently shown. Clicking it opens the details panel and dismisses that color until the limit resets or usage climbs higher.

The details panel additionally breaks out the **Weekly Sonnet** bucket separately.

Data comes from `GET https://api.anthropic.com/api/oauth/usage` using the OAuth token Claude Code stores in your macOS Keychain. The extension reads the entry for the **profile that window is using** — `Claude Code-credentials` for the default `~/.claude`, or `Claude Code-credentials-<hash>` for a `CLAUDE_CONFIG_DIR` profile (see [Multiple accounts / profiles](#multiple-accounts--profiles)). Token is read fresh each poll, never written to disk by this extension.

## Screenshots

Status bar:

![Status bar](assets/bar.png)

Status bar with monthly (dollar) credits:

![Status bar — monthly credits](assets/fix_limits_bar.png)

Details panel (click the status-bar item):

![Details panel](assets/details_page.png)

Details panel for a plan with monthly (dollar) credits:

![Details panel — monthly credits](assets/detailed_fix_limits.png)

## Install (from source)

```bash
git clone <this repo>
cd claude-limits-bar
npm install
npm run package    # produces claude-limits-bar-0.1.3.vsix
code --install-extension claude-limits-bar-0.1.3.vsix
```

Reload VS Code. The first fetch will trigger a Keychain prompt; click **Allow** (not "Always Allow" if you want visibility into future reads).

## Settings

| Key | Default | Description |
|---|---|---|
| `claudeLimitsBar.displayMode` | `both` | `session` / `weekly` / `both` |
| `claudeLimitsBar.pollMinutes` | `5` | Poll interval (min `1`) |
| `claudeLimitsBar.showProgressBar` | `true` | Show the dot bar in the status text |
| `claudeLimitsBar.alignment` | `right` | Status-bar side: `left` / `right` (applied immediately) |
| `claudeLimitsBar.configDir` | `""` | Config dir / account this window reads (your `CLAUDE_CONFIG_DIR`); supports `~`. Empty ⇒ follow `CLAUDE_CONFIG_DIR`, then `~/.claude`. Pin per-project in `.vscode/settings.json`. |
| `claudeLimitsBar.showProfileLabel` | `auto` | Status-bar profile tag: `auto` (tag non-default only) / `always` / `never` |

## Multiple accounts / profiles

Run more than one Claude account — e.g. a work `~/.claude` and a personal `~/.claude-personal`, switched with `CLAUDE_CONFIG_DIR`? Each VS Code window can show the limits of the account **that window uses**: a work window shows the work account, a personal window shows the personal one.

### How a window picks its profile

Resolved in this order (first match wins):

1. **`claudeLimitsBar.configDir`** — the account pinned for this workspace (recommended — see below).
2. **`CLAUDE_CONFIG_DIR`** in the window's environment.
3. Default `~/.claude`.

A non-default profile is **tagged** in the bar (e.g. `S: 32%  $(account) personal`) and its account email appears in the tooltip; the work/default window stays untagged. Tune the tag with `claudeLimitsBar.showProfileLabel` (`auto` / `always` / `never`).

### Recommended: pin the account per project

VS Code shares **one** extension-host environment across all windows of a running instance (captured when that instance first launched). So the ambient `CLAUDE_CONFIG_DIR` is usually the *same* for every window — relying on it alone won't distinguish windows unless each profile opens a **fresh** VS Code instance. Pinning the account in the project's workspace settings is the reliable way, which is why the setting takes precedence over the env var.

1. In the project, create **`.vscode/settings.json`**:
   ```jsonc
   { "claudeLimitsBar.configDir": "~/.claude-personal" }
   ```
   ⚠️ The folder must be exactly `.vscode` — a stray leading space (`" .vscode"`) makes a *different* folder that VS Code silently ignores, and the space is invisible in the file tree.
2. **Reload the window**: `Cmd+Shift+P → Developer: Reload Window`. The setting is read on activation and re-read live whenever you change it afterwards.
3. Leave work projects alone — with no setting they use the default `~/.claude`.

> Multi-root workspaces and git worktrees are supported: `configDir` is `resource`-scoped, so a folder-level `.vscode/settings.json` is honored.

### Verify it's working

- Hover the status-bar item → the tooltip shows a line like `Profile: personal — you@example.com` (or `Profile: default — …` for the work account).
- `View → Output → "Claude Limits Bar"` prints, on each fetch:
  ```
  profile: source=setting, service='Claude Code-credentials-5a66096d', dir=/Users/you/.claude-personal
  ```
  `source=setting` confirms your pin was read; `activate v0.1.3` near the top confirms the running version. `source=default` in a window you pinned usually means the setting didn't load — see Troubleshooting.

### Troubleshooting — bar shows the wrong account

- **Reload the window** after installing/updating the extension or first adding the setting; a running window keeps its old state.
- Confirm the folder is exactly **`.vscode`** (no leading/trailing space) and the file is `settings.json` with valid JSON.
- Make sure you're hovering the **right window** — a window without the setting correctly shows the default account.
- **Untrusted workspace?** The `configDir` setting is intentionally ignored until you trust the workspace (see [Security notes](#security-notes)); it then falls back to env / `~/.claude`.

### How the token is located

Exactly the way Claude Code stores it: the macOS Keychain generic-password for that config dir — `Claude Code-credentials` for the default, or `Claude Code-credentials-<sha256(configDir)[:8]>` for a custom `CLAUDE_CONFIG_DIR`. If there's no Keychain entry it falls back to a **read-only** read of `<configDir>/.credentials.json`. The token is read fresh per poll and never written anywhere.

## Commands

- **Claude Limits: Refresh Now** — force one fetch
- **Claude Limits: Show Details** — open the webview panel (also bound to status-bar click)
- **Claude Limits: Switch Display Mode** — cycle session → weekly → both

## Security notes

- Zero runtime dependencies (devDeps only: TypeScript and `@types/*`)
- All outbound traffic goes to `api.anthropic.com` (hardcoded hostname)
- `security` CLI is invoked via `execFileSync` — no shell, no command injection
- Token is sent in `Authorization: Bearer`, never logged or persisted
- Disk access is read-only: the Keychain (via `security`) and, as a fallback, `<configDir>/.credentials.json` — the extension never writes credentials
- The `configDir` setting is honored only in **trusted** workspaces (VS Code Workspace Trust), so an untrusted repo can't redirect which config dir is read
- Webview has CSP `default-src 'none'`; no scripts

## Known limitations

- macOS only (the Keychain access path uses `security`)
- Marketplace publication intentionally skipped — install from source
