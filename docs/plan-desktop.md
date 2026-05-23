# Ylate Desktop — Plan

> Status: **Phase 3 (Tauri skeleton) landed; Phase 4 (cross-platform polish) is next**
> Phases done: **0** ✓ • **1** ✓ • **2** ✓ • **3** ✓
> Target platforms: Windows 10+, macOS 11+, Ubuntu 22.04+ (and modern Linux)
> Framework: **Tauri 2**
> Distribution: **GitHub Releases**

## Goals

Ship a standalone desktop Ylate that:

- Tracks the same YouTrack timer / accumulated time / board columns / pause / resume / stop & log as the existing VS Code extension.
- Shows **the current running task + elapsed time in the OS notification bar** (macOS menu bar, Windows system tray, Linux indicator).
- Persists state through crashes — the 60-second checkpoint + smart-restore logic from [src/timerManager.ts](../src/timerManager.ts) ports across unchanged.
- Distributes a single installer per OS through GitHub Releases.
- Lives in the same repo as the VS Code extension, sharing as much code as possible.

**Non-goals for v1.0:** code signing, auto-update, multi-account, cloud sync, mobile.

## Architecture — monorepo

```
ylate/
├── packages/
│   ├── core/         # pure timer state machine + YouTrack HTTP client (no VS Code, no Tauri, no DOM)
│   ├── ui/           # panel HTML/CSS/JS, built as a static bundle (vite)
│   ├── vscode-ext/   # current VS Code extension, refactored to consume core+ui
│   └── desktop/      # new Tauri app
│       ├── src/      # frontend (loads packages/ui)
│       └── src-tauri/# Rust backend (HTTP, tray, storage, IPC)
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

**Reuse boundary:**

- `core` knows nothing about VS Code, Tauri, or the DOM. Storage and UI are injected via small adapter interfaces. Reused 100% by both shells.
- `ui` is the panel as a real frontend bundle. Same artifact loads in VS Code's webview and Tauri's webview; only the message transport differs (`vscode.postMessage` vs `@tauri-apps/api invoke + event`).
- `vscode-ext` and `desktop` are thin host adapters.

**Tauri-specific choice:** API calls to YouTrack are routed **through Rust** (frontend `invoke()` → Rust HTTPS → response). This sidesteps webview CORS entirely and keeps the YouTrack token in the OS keychain instead of in JS-accessible storage.

## Phases & estimate

| # | Phase | Lands | Estimate | Status |
|---|---|---|---|---|
| 0 | Monorepo scaffold | pnpm workspaces, Turbo, code moved verbatim to `packages/vscode-ext/`, VS Code extension still builds and installs identically | 0.5 day | ✓ done |
| 1 | Extract `core` | Timer state machine pulled out of `TimerManager` (no `StatusBarItem`, no `workspaceState` — those become adapters); `YouTrackClient` ported `node:https` → `fetch`; `vscode-ext` rewired through it | 1 day | ✓ done |
| 2 | Extract `ui` | `panelHtml.ts` → real vite bundle; message protocol typed; VS Code webview loads it | 0.5 day | ✓ done |
| 3 | Tauri skeleton | Window, tray (with per-OS title/tooltip), `tauri-plugin-store` for state, single-instance lock, opt-in autostart, IPC plumbing, renderer-side host wiring `TimerCore` to React UI | 1.5 days | ✓ done |
| 4 | Cross-platform polish | Windows tray icon variants for paused/running, Linux tray fallback verified on GNOME (AppIndicator) + KDE, **Preferences window**, **token → keychain** (`tauri-plugin-keyring`), CSP tightening | 1 day | next |
| 5 | Packaging & release | `tauri-action` GitHub workflow building `.dmg` / `.exe` / `.deb` / `.AppImage` on tag push, attached to a GH Release | 0.5 day | |

**Total: ~5 focused days** (≈1 week real-world).

## "Current task in the notification bar" — per-OS reality

The one place the three OSes meaningfully diverge.

- **macOS**: full fidelity. The menu bar entry can show inline text like `$(clock) PROJ-12  1h:23m`, refreshed every second from Rust via `tray.set_title()`. This is the cleanest experience and the one we'll lead the marketing screenshot with.
- **Windows**: the system-tray icon doesn't display inline text. We surface the running task in **the tooltip** (visible on hover) via `tray.set_tooltip()`, and additionally **swap the tray icon** between three states: idle (gray clock), running (blue clock), paused (yellow pause). Right-click opens the menu.
- **Linux**: depends on the desktop environment. KDE Plasma / Cinnamon / XFCE work like Windows (icon + tooltip). GNOME has no tray by default — users need the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/). We'll document this in the README and ensure the main window itself always shows the timer so GNOME-without-extension users aren't blocked.

## Key technical decisions

| Decision | Choice | Why |
|---|---|---|
| Framework | **Tauri 2** | ~10 MB bundle vs Electron's ~150 MB; uses the OS native webview |
| UI bundler | **vite** | Fast dev server, clean static bundle |
| Frontend ↔ backend | `invoke()` commands + Tauri events | Standard Tauri IPC; YouTrack HTTP happens Rust-side |
| State persistence | `tauri-plugin-store` (JSON file under app data dir) | Same data shape as today's `workspaceState`, just relocated |
| Token storage | `tauri-plugin-keyring` (macOS Keychain / Win Credential Vault / Secret Service) | Materially more secure than plaintext settings |
| System tray | `tauri::tray` with per-OS title vs tooltip handling | See section above |
| Auto-launch | `tauri-plugin-autostart`, **opt-in** via Preferences toggle | Default off |
| Window-close | **Hide to tray**, don't quit (Discord-style) | Persistent timer needs the tray to stay alive |
| Single-instance | `tauri-plugin-single-instance` | Second launch focuses existing window |
| Preferences UI | **Dedicated Preferences window** (separate from the main timer panel) | Houses: server URL, token (via keychain), project, my-issues-only, grace period, auto-launch toggle, theme |
| Distribution | GitHub Releases via `tauri-action` | One workflow, three OS runners, builds on tag push |

## Risks / unknowns

1. **Linux GNOME tray** — known limitation, documented in README. Main window always shows the timer as a fallback.
2. **Rust toolchain onboarding** — contributors need `rustup` and platform deps (Xcode CLT on mac, MSVC build tools on Windows, `libwebkit2gtk-4.1-dev` on Ubuntu). Add to CONTRIBUTING.md.
3. **VS Code ↔ desktop token sharing** — they don't share; each is configured once. Acceptable; documenting it.
4. **Build matrix maintenance** — three OS GH runners. `tauri-action` is well-supported but builds take longer than the VS Code extension's. Tag releases sparingly.
5. **Pulling `TimerManager` apart cleanly** — today it owns the `StatusBarItem` directly. The refactor splits it into `TimerCore` (pure state machine) + a `TimerHost` interface (status-bar updates, persistence). All counted in Phase 1; this is the only place where the abstraction matters.

## Out-of-scope for v1 (deferrable)

- Auto-update via `tauri-plugin-updater` — ~0.5 day later, needs an update-server URL (or use GH Releases as the source).
- Code signing — Apple Developer $99/yr, Windows EV cert $200–300/yr; reduces Gatekeeper / SmartScreen warnings.
- Native menu bar items and global keyboard shortcuts beyond Tauri's defaults.
- "Mini timer" floating always-on-top window (Toggl-style).
- Tracking multiple issues in parallel.
- Reporting / CSV export.

## Milestones

- **M0** Monorepo scaffold; VS Code extension still ships from the same repo, verified locally.
- **M1** `packages/core` is consumed by the VS Code extension with feature parity preserved.
- **M2** `packages/ui` loads in both VS Code webview and Tauri renderer.
- **M3** Tauri app does end-to-end start → log on macOS, tray title live-updating.
- **M4** Tauri app passes Windows and Linux smoke tests, tray fallback wired up.
- **M5** First public release: `JavadTavakoli.ylate-desktop@0.1.0` attached to a GitHub Release with three installers.

## To start Phase 0

Green light is all I need. Phase 0 work:

1. `pnpm init` at the root, add `pnpm-workspace.yaml`.
2. Add `turbo.json`.
3. Move existing code into `packages/vscode-ext/` (preserving git history with `git mv`).
4. Update the top-level `package.json` to delegate scripts to Turbo.
5. Verify `pnpm --filter vscode-ext build` produces the same `.vsix` as today.
6. Commit as `chore: monorepo scaffold (Phase 0)`.
