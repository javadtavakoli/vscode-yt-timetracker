# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a **pnpm + Turbo monorepo**.

- [`packages/core`](packages/core) — `@ylate/core`. Pure timer state machine + YouTrack HTTP client + shared types + host↔UI message contract. No VS Code, no DOM, no `setInterval`. Output is ESM (`"type": "module"`) so Vite/Rollup can statically resolve named exports. Runs in Node, browsers, Electron, and Tauri.
- [`packages/ui`](packages/ui) — `@ylate/ui`. React + Vite panel UI, built to a single self-contained HTML (`vite-plugin-singlefile`). Bundle detects host: VS Code's `acquireVsCodeApi()` or Tauri's `window.__TAURI_INTERNALS__`. When running in Tauri it bootstraps an in-renderer host (`desktopHost.ts`) that owns `TimerCore` and persists via `tauri-plugin-store`.
- [`packages/vscode-ext`](packages/vscode-ext) — the VS Code extension (`JavadTavakoli.ylate`). Thin host shell over `@ylate/core`; inlines `@ylate/ui`'s HTML at bundle time via esbuild's `--loader:.html=text`.
- [`packages/desktop`](packages/desktop) — `@ylate/desktop`. Tauri 2 app (Win/Mac/Linux). Rust backend provides system tray (live title on macOS / tooltip on Windows/Linux), window-close-hides-to-tray, single-instance lock, opt-in autostart. Frontend is the same `@ylate/ui` bundle, no separate Vite app. See [packages/desktop/README.md](packages/desktop/README.md) for the system-deps install.

## Commands

```bash
pnpm install                                          # one-time, hydrates all workspaces
pnpm build                                            # turbo build across all JS packages — see warning below
pnpm --filter @ylate/core build                       # core only → packages/core/dist/
pnpm --filter @ylate/ui build                         # ui only → packages/ui/dist/index.html
pnpm --filter ylate build                             # typecheck + esbuild bundle → packages/vscode-ext/dist/extension.js
pnpm --filter ylate watch                             # esbuild --watch (re-bundle on save)
pnpm --filter ylate package                           # produce ylate-<version>.vsix
code --install-extension packages/vscode-ext/ylate-<version>.vsix --force

# Desktop (Tauri) — requires Rust + system deps (see packages/desktop/README.md)
pnpm --filter @ylate/desktop dev                      # opens Tauri window with Vite HMR
pnpm --filter @ylate/desktop tauri-build              # produces .dmg / .deb / .AppImage / .msi
```

**Releasing the desktop app:** push a `desktop-v*` tag (e.g. `desktop-v0.1.0`) and the [`release-desktop`](.github/workflows/release-desktop.yml) workflow builds installers on macOS, Windows, and Linux runners via `tauri-action` and uploads them to a draft GH Release. Bump the version in three places before tagging: `packages/desktop/package.json`, `packages/desktop/src-tauri/Cargo.toml`, `packages/desktop/src-tauri/tauri.conf.json`.

There is no test suite and no linter. TypeScript `strict` is on; the typecheck step in `vscode-ext`'s build script runs `tsc --noEmit`. esbuild is what actually emits the runtime bundle.

**Build a fresh `.vsix` with all UI changes:** the `vscode-ext` package script does NOT re-run upstream package builds — running `pnpm --filter ylate build` after editing `packages/ui/src/*.tsx` will silently inline the *stale* `packages/ui/dist/index.html`. Either run `pnpm build` from the repo root (Turbo orchestrates the order) or chain the upstream builds explicitly:

```bash
pnpm build && pnpm --filter ylate package          # safest one-liner
# or:
pnpm --filter @ylate/ui build && pnpm --filter ylate package
```

**pnpm 11 quirk:** [.npmrc](.npmrc) sets `verify-deps-before-run=false` because pnpm's default escalates the `IGNORED_BUILDS` warning into a hard failure on every `pnpm run` invocation. [pnpm-workspace.yaml](pnpm-workspace.yaml) lists `esbuild` under `onlyBuiltDependencies` so its native-binary postinstall actually runs; everything else (vsce-sign, keytar) is silently skipped. Don't undo these without understanding the failure mode.

## Architecture

### `@ylate/core` — what's portable

[`packages/core/src/timerCore.ts`](packages/core/src/timerCore.ts) is a pure state machine. It owns the `Session` object and emits update / log / freeze events through small listener APIs (`onUpdate`, `onLogged`, `onLogError`, `onRestoreFrozen`). It does **not** own a timer, a status bar, or a YouTrack client.

- **Storage is injected** via a `SessionStorage { load(), save() }` interface ([`storage.ts`](packages/core/src/storage.ts)). The VS Code host implements it on `workspaceState`; the desktop host will implement it on `tauri-plugin-store`.
- **The host owns the ticker.** Once per second, the host calls `core.tick()`. Core counts ticks internally and runs `checkpoint()` every 60 — that's the 60-second crash-resilience window.
- **YouTrack logging is injected** via `core.setLogger(fn)`. When `stop(true)` is called and there's an issue id + ≥ 1 minute, the logger fn is awaited. Success fires `onLogged(issueId)`; failure fires `onLogError`.
- **`displayMs`** = `priorSpentMinutes * 60_000 + totalElapsedMs`. The first term is YouTrack's recorded spent time at session start; the second is the live session elapsed. Stop & Log only posts the second term — the server adds it to its running total.

[`packages/core/src/youtrackClient.ts`](packages/core/src/youtrackClient.ts) uses the global `fetch` (Node ≥ 18, browsers, Tauri webview — one impl everywhere). Issue conversion lives in `mapIssue()`. **Adding a new visible field still means extending both the `fields=` query string and `mapIssue` in lockstep** — forgetting the query string silently returns empty values.

### `packages/ui` — the React panel

Single Vite app, single self-contained HTML output (`vite-plugin-singlefile`). 155 KB raw, ~50 KB gzipped — React + DOM-side code + CSS all inlined into one `dist/index.html`.

- [`src/main.tsx`](packages/ui/src/main.tsx) is the React entry. Renders `<App/>` into `#root`.
- [`src/App.tsx`](packages/ui/src/App.tsx) is the whole panel: `Header`, `TimerCard`, `CustomTaskForm`, `IssueCard` — kept inline as small function components. Promote one out only when it grows or starts being reused.
- [`src/api.ts`](packages/ui/src/api.ts) is the **host-transport abstraction**. Detects `acquireVsCodeApi()` (VS Code webview) and returns a `Transport { post, onMessage }`. The Tauri branch will be added in Phase 3 — don't put platform-specific code in components.
- [`src/styles.css`](packages/ui/src/styles.css) is the CSS (CSS variables, no preprocessor). Imported once from `main.tsx`; Vite bundles + inlines it.

**The per-second tick that drives the timer display lives in `App.tsx`** as a `useEffect` + `setInterval` that calls `setNowTick`. It is **deliberately not memoized** — `computeDisplayMs(...)` is a plain function called inline in JSX so `Date.now()` re-evaluates on every render. Wrapping it in `useMemo` would freeze the timer because the deps wouldn't change between ticks. Found this the hard way in Phase 2.

### `packages/vscode-ext` — the VS Code shell

Three source files (plus a tiny type declaration). The non-obvious bits are the contracts between them.

**[`extension.ts`](packages/vscode-ext/src/extension.ts) — host-side controller.** Activates on `onStartupFinished`, owns module-level state (`client`, `issues`, `states`, `boardColumns`, `connected`, `errorMsg`), registers commands, provides the webview view, and orchestrates connect / refresh / move. The webview body comes from `import panelHtml from "@ylate/ui"` — esbuild inlines the HTML string at bundle time via `--loader:.html=text`, so no separate resource files ship in the `.vsix`.

**[`timerManager.ts`](packages/vscode-ext/src/timerManager.ts) — thin shell around `TimerCore`.** Owns the `StatusBarItem`, the 1-second `setInterval` ticker, the toasts ("✅ Logged …", "⏸ Paused …"), and a `WorkspaceStateStorage` adapter. Public API surface (`start`, `pause`, `togglePause`, `stopAndLog`, `current`, `totalElapsedMs`, `onUpdate`, `onLogged`) is preserved so callers in `extension.ts` don't churn. **Session state lives inside `TimerCore`, not here — don't add session fields to this class.**

**[`storage.ts`](packages/vscode-ext/src/storage.ts) — `WorkspaceStateStorage`.** Wraps `vscode.Memento` to implement the `SessionStorage` interface from core. Update is async on the VS Code side but fire-and-forget here; the contract is sync.

**[`ui-html.d.ts`](packages/vscode-ext/src/ui-html.d.ts)** — module declaration so TypeScript accepts `import panelHtml from "@ylate/ui"` as a string. The actual loading is done by esbuild at build time.

### Build pipeline

`vscode-ext` is bundled with **esbuild**, not tsc. Two reasons:

1. `@ylate/core` is a workspace package; the published `.vsix` uses `--no-dependencies`, so the core code has to be inlined into a single `dist/extension.js`.
2. `@ylate/ui`'s `main` is `./dist/index.html`. esbuild's `--loader:.html=text` reads that file as a string at bundle time and inlines it.

tsc is used only for typechecking (`--noEmit`). Turbo's `dependsOn: ["^build"]` ensures `@ylate/core` and `@ylate/ui` build before `vscode-ext`. **Direct `pnpm --filter ylate build` does not re-run upstream builds** — see the Commands section above.

### Webview contract — "static shell + postMessage"

The webview HTML is set **exactly once**, in `resolveWebviewView`. After that, the host never replaces `webview.html`; it only sends messages:

- `init` — full state (issues, states, boardColumns, session, connection). Sent on `ready` and on visibility changes. Webview re-renders everything.
- `timerUpdate` — session + elapsed only. Sent on every timer tick / pause / resume / start / stop. Webview re-renders the timer card and re-runs `renderIssues()` to refresh the running badge.

The webview's `'ready'` message is the handshake — the host doesn't know the webview exists until that arrives, so initial state is pushed in response to `'ready'`, not at activation time.

### (Historical) Event delegation footgun

Pre-Phase 2 the panel was a hand-rolled HTML string and a Start-button bug landed where the code did `onclick="startIssue(' + JSON.stringify(issue.id) + ')"`, producing `onclick="startIssue("3-123")"` — the inner `"` closed the attribute and every Start button silently broke (and the status bar stayed hidden as a downstream effect). React handlers in the new UI avoid this entirely; keep them as JSX callbacks (`onClick={() => startIssue(issue)}`), don't reach for `dangerouslySetInnerHTML` or hand-built HTML strings.

### Crash-resilient session persistence

The active session is persisted under `workspaceState` key `activeSession`. Two pieces work together (both live in `TimerCore`):

1. **Periodic checkpoint** — every 60 `tick()` calls while running, `checkpoint()` rolls `(now − startedAt)` into `session.elapsed`, sets `startedAt = now`, and persists. Worst-case crash loss is ~60 seconds.
2. **Smart restore** — on reopen, if a running session is found, compute `gap = now − saved.startedAt`. If `≤ 5 min` keep `startedAt` so the gap is silently credited (your "just resume" case for crash recovery and window reloads); if `> 5 min` pause at the last checkpoint and fire `onRestoreFrozen` so the host shows a toast — avoids treating an overnight close as worked time.

Issues, states, board columns, and connection are always re-fetched at startup. Do **not** revive the old `startedAt = Date.now()` reset that was here pre-1.1.1 — it silently zeroed the current segment on every reload.

### Time-logging quirks

`TimerCore.stop()` posts a single work item to `/api/issues/{id}/timeTracking/workItems` only when the session is bound to a real YouTrack issue, a logger is bound, **and** `minutes >= 1`. Sub-minute sessions are silently dropped — intentional, but it makes "I clicked Stop and nothing happened" a common false alarm. Custom (non-YouTrack) tasks always skip the logger entirely.

## Configuration surface

User settings under `youtrackTracker.*` (`baseUrl`, `token`, `projectId`, `myIssuesOnly`). `runConfigure` in [`extension.ts`](packages/vscode-ext/src/extension.ts) is the canonical way to populate them — it also calls `tryConnect()` afterwards, so any flow that mutates these settings should call `tryConnect()` to refresh the client.
