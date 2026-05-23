# @ylate/desktop

Ylate as a native Tauri 2 app for Windows, macOS, and Linux. Loads the same `@ylate/ui` React bundle the VS Code extension uses; runs `TimerCore` in the renderer process and persists state via `tauri-plugin-store`.

## Prerequisites

- **Node 18+ and pnpm** (used everywhere in this repo)
- **Rust + cargo** — install via [rustup](https://rustup.rs/) if you don't have it
- **Platform-specific system packages:**

  - **Ubuntu / Debian:**
    ```bash
    sudo apt install \
      libwebkit2gtk-4.1-dev \
      build-essential curl wget file pkg-config \
      libxdo-dev libssl-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libsecret-1-dev libdbus-1-dev   # keychain-backed YouTrack token
    ```
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Windows:** Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 10/11)

  See Tauri's [prerequisites guide](https://v2.tauri.app/start/prerequisites/) for the full list per OS.

## Running locally

```bash
# from repo root
pnpm install                              # one-time
pnpm --filter @ylate/desktop dev          # launches the Tauri window; HMR via Vite
```

`dev` runs `pnpm --filter @ylate/ui dev` first to start the Vite dev server on port 5173, then opens a Tauri window pointed at it.

## Building distributables

```bash
pnpm --filter @ylate/desktop tauri-build
```

Output goes to `src-tauri/target/release/bundle/`:
- macOS: `.dmg` and `.app`
- Linux: `.deb` and `.AppImage`
- Windows: `.msi` (NSIS) and `.exe`

## Icons

The committed icons are a placeholder (a single 128×128 PNG copied from the VS Code extension). For a release build with proper per-OS icons run:

```bash
pnpm --filter @ylate/desktop icons
```

That regenerates `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, and `icon.ico` from `packages/vscode-ext/resources/icon.png` via Tauri's icon generator. These extra files are gitignored — regenerate locally before each release.

## Distribution: GitHub Releases

The repo ships a [`release-desktop` workflow](../../.github/workflows/release-desktop.yml) (`tauri-action`) that builds on three OS runners and attaches the installers to a draft GitHub Release.

**To cut a release:**

```bash
# 1. Bump the version in three places (keep them in sync):
#    packages/desktop/package.json                "version"
#    packages/desktop/src-tauri/Cargo.toml        version
#    packages/desktop/src-tauri/tauri.conf.json   version
#
# 2. Commit the bump, then push a `desktop-v…` tag:
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
#
# 3. Wait ~10–20 min for the workflow. Review the draft Release on GitHub,
#    edit the body if you want, then publish.
```

`workflow_dispatch` (Run workflow button on the Actions tab) builds the same binaries without creating a release — useful for verifying CI before tagging.

## Architecture pointers

- The renderer is `@ylate/ui` (single bundled HTML). When it detects `window.__TAURI_INTERNALS__` it bootstraps [src/desktopHost.ts](../ui/src/desktopHost.ts), which runs `TimerCore` in the renderer process and persists session state via `tauri-plugin-store`. The React UI's transport contract is unchanged from the VS Code shell.
- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) provides the system tray (live title on macOS, tooltip on Windows/Linux), window-close-hides-to-tray, single-instance lock, and `set_tray_text` / `set_autostart` / `is_autostart_enabled` / `open_preferences` IPC commands.
- YouTrack HTTP currently goes via the renderer's global `fetch`. If a Tauri webview blocks cross-origin requests for your YouTrack instance we can move HTTP into a Rust command without touching `@ylate/core` — `YouTrackClient` would just use a different `fetch` adapter.

## Known limitations (v0.1)

- Linux GNOME without the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/) won't show the tray icon. The main window always reflects the current timer state as a fallback.
- No paused/running tray-icon variants on Windows — only the title/tooltip changes for now.
- No auto-update yet. `pnpm tauri-build` produces installers; manual upgrade between versions until `tauri-plugin-updater` is wired in.
- No code signing — distributables will trigger Gatekeeper/SmartScreen warnings on first launch.

## Configuration

After install, open the app and click the ⚙ button in the panel header (or the Preferences entry in the tray menu) to set:

- **Base URL** — your YouTrack instance, e.g. `https://yourcompany.youtrack.cloud`
- **Permanent token** — generate at *Profile → Account Security → Tokens* in YouTrack. **Stored in the OS keychain** (macOS Keychain, Windows Credential Manager, Linux libsecret), never written to a file.
- **Project short name** — e.g. `PROJ`
- **My issues only** — filter the issue list to yourself
- **Launch on login** — opt-in autostart toggle
