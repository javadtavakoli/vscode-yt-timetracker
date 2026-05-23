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
      build-essential curl wget file \
      libxdo-dev libssl-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev
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

Hooking up `tauri-action` to build on each OS runner on tag push is on the roadmap (see [docs/plan-desktop.md](../../docs/plan-desktop.md) Phase 5). For now, build locally on each target OS.

## Architecture pointers

- The renderer is `@ylate/ui` (single bundled HTML). When it detects `window.__TAURI_INTERNALS__` it bootstraps [src/desktopHost.ts](../ui/src/desktopHost.ts), which runs `TimerCore` in the renderer process and persists session state via `tauri-plugin-store`. The React UI's transport contract is unchanged from the VS Code shell.
- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) provides the system tray (live title on macOS, tooltip on Windows/Linux), window-close-hides-to-tray, single-instance lock, and `set_tray_text` / `set_autostart` / `is_autostart_enabled` / `open_preferences` IPC commands.
- YouTrack HTTP currently goes via the renderer's global `fetch`. If a Tauri webview blocks cross-origin requests for your YouTrack instance we can move HTTP into a Rust command without touching `@ylate/core` — `YouTrackClient` would just use a different `fetch` adapter.

## Known limitations (v0.1)

- Token is stored in plaintext via `tauri-plugin-store` (`config.json` under the app data dir). Migration to the system keychain (`tauri-plugin-keyring`) is planned but not in v0.1.
- Linux GNOME without the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/) won't show the tray icon. The main window always reflects the current timer state as a fallback.
- No Preferences window yet — the `configure` button in the panel currently shows an error placeholder. Configure manually by editing the store file (path printed by `tauri-plugin-store` on first run) until the Preferences UI lands.
- No auto-update yet. `pnpm tauri-build` produces installers; manual upgrade between versions until `tauri-plugin-updater` is wired in.
