# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a **pnpm + Turbo monorepo**.

- [`packages/core`](packages/core) — `@ylate/core`. Pure timer state machine + YouTrack HTTP client + shared types. No VS Code, no DOM, no `setInterval`. Runs in Node, browsers, Electron, and Tauri.
- [`packages/vscode-ext`](packages/vscode-ext) — the VS Code extension (`JavadTavakoli.ylate`). Thin host shell over `@ylate/core`.
- Planned (see [docs/plan-desktop.md](docs/plan-desktop.md)): `packages/ui`, `packages/desktop` (Tauri).

## Commands

```bash
pnpm install                                          # one-time, hydrates all workspaces
pnpm build                                            # turbo build across all packages
pnpm --filter @ylate/core build                       # build core only → packages/core/dist/
pnpm --filter ylate build                             # typecheck + esbuild bundle → packages/vscode-ext/dist/extension.js
pnpm --filter ylate watch                             # esbuild --watch (re-bundle on save)
pnpm --filter ylate package                           # produce ylate-<version>.vsix
code --install-extension packages/vscode-ext/ylate-<version>.vsix --force
```

There is no test suite and no linter. TypeScript `strict` is on; the typecheck step in `vscode-ext`'s build script runs `tsc --noEmit`. esbuild is what actually emits the runtime bundle.

To exercise the extension after a code change: `pnpm --filter ylate package && code --install-extension packages/vscode-ext/ylate-*.vsix --force`, then **Developer: Reload Window**.

**pnpm 11 quirk:** [.npmrc](.npmrc) sets `verify-deps-before-run=false` because pnpm's default escalates the `IGNORED_BUILDS` warning into a hard failure on every `pnpm run` invocation. [pnpm-workspace.yaml](pnpm-workspace.yaml) lists `esbuild` under `onlyBuiltDependencies` so its native-binary postinstall actually runs; everything else (vsce-sign, keytar) is silently skipped. Don't undo these without understanding the failure mode.

## Architecture

### `@ylate/core` — what's portable

[`packages/core/src/timerCore.ts`](packages/core/src/timerCore.ts) is a pure state machine. It owns the `Session` object and emits update / log / freeze events through small listener APIs (`onUpdate`, `onLogged`, `onLogError`, `onRestoreFrozen`). It does **not** own a timer, a status bar, or a YouTrack client.

- **Storage is injected** via a `SessionStorage { load(), save() }` interface ([`storage.ts`](packages/core/src/storage.ts)). The VS Code host implements it on `workspaceState`; the desktop host will implement it on `tauri-plugin-store`.
- **The host owns the ticker.** Once per second, the host calls `core.tick()`. Core counts ticks internally and runs `checkpoint()` every 60 — that's the 60-second crash-resilience window.
- **YouTrack logging is injected** via `core.setLogger(fn)`. When `stop(true)` is called and there's an issue id + ≥ 1 minute, the logger fn is awaited. Success fires `onLogged(issueId)`; failure fires `onLogError`.
- **`displayMs`** = `priorSpentMinutes * 60_000 + totalElapsedMs`. The first term is YouTrack's recorded spent time at session start; the second is the live session elapsed. Stop & Log only posts the second term — the server adds it to its running total.

[`packages/core/src/youtrackClient.ts`](packages/core/src/youtrackClient.ts) uses the global `fetch` (Node ≥ 18, browsers, Tauri webview — one impl everywhere). Issue conversion lives in `mapIssue()`. **Adding a new visible field still means extending both the `fields=` query string and `mapIssue` in lockstep** — forgetting the query string silently returns empty values.

### `packages/vscode-ext` — the VS Code shell

Four source files. The non-obvious bits are the contracts between them.

**[`extension.ts`](packages/vscode-ext/src/extension.ts) — host-side controller.** Activates on `onStartupFinished`, owns module-level state (`client`, `issues`, `states`, `boardColumns`, `connected`, `errorMsg`), registers commands, provides the webview view, and orchestrates connect / refresh / move. Doesn't render — pushes state to the webview and reads from `timerManager`.

**[`timerManager.ts`](packages/vscode-ext/src/timerManager.ts) — thin shell around `TimerCore`.** Owns the `StatusBarItem`, the 1-second `setInterval` ticker, the toasts ("✅ Logged …", "⏸ Paused …"), and a `WorkspaceStateStorage` adapter. Public API surface (`start`, `pause`, `togglePause`, `stopAndLog`, `current`, `totalElapsedMs`, `onUpdate`, `onLogged`) is compatible with the pre-Phase-1 class so callers in `extension.ts` are unchanged. **Session state lives inside `TimerCore`, not here — don't add session fields to this class.**

**[`storage.ts`](packages/vscode-ext/src/storage.ts) — `WorkspaceStateStorage`.** Wraps `vscode.Memento` to implement the `SessionStorage` interface from core. Update is async on the VS Code side but fire-and-forget here; the contract is sync.

**[`panelHtml.ts`](packages/vscode-ext/src/panelHtml.ts) — webview body.** Returns a single self-contained HTML string with CSS and JS inline. Communicates with the host through `vscode.postMessage` / `acquireVsCodeApi()`.

### Build pipeline

`vscode-ext` is bundled with **esbuild**, not tsc — `@ylate/core` is a workspace package and the published `.vsix` uses `--no-dependencies`, so the core code has to be inlined into a single `dist/extension.js`. tsc is used only for typechecking (`--noEmit`).

Turbo's `dependsOn: ["^build"]` ensures `@ylate/core` builds before `vscode-ext` reads `dist/index.js` for type resolution.

### Webview contract — "static shell + postMessage"

The webview HTML is set **exactly once**, in `resolveWebviewView`. After that, the host never replaces `webview.html`; it only sends messages:

- `init` — full state (issues, states, boardColumns, session, connection). Sent on `ready` and on visibility changes. Webview re-renders everything.
- `timerUpdate` — session + elapsed only. Sent on every timer tick / pause / resume / start / stop. Webview re-renders the timer card and re-runs `renderIssues()` to refresh the running badge.

The webview's `'ready'` message is the handshake — the host doesn't know the webview exists until that arrives, so initial state is pushed in response to `'ready'`, not at activation time.

### Event delegation in the webview is non-negotiable

Issue card actions (Start, Stop, state-change dropdown) use `data-action` / `data-issue-id` attributes plus delegated listeners on `#issuesList`. Do **not** introduce inline `onclick="…"` handlers that interpolate `issue.id` — earlier code did `onclick="startIssue(' + JSON.stringify(issue.id) + ')"` which produced `onclick="startIssue("3-123")"`, and the inner `"` closed the attribute, silently breaking every Start button (and as a downstream effect, leaving the status bar permanently hidden because no session was ever created). If you need a new card-level action, add a `data-action` value and extend the delegated handlers in [`panelHtml.ts`](packages/vscode-ext/src/panelHtml.ts).

### Crash-resilient session persistence

The active session is persisted under `workspaceState` key `activeSession`. Two pieces work together (both live in `TimerCore`):

1. **Periodic checkpoint** — every 60 `tick()` calls while running, `checkpoint()` rolls `(now − startedAt)` into `session.elapsed`, sets `startedAt = now`, and persists. Worst-case crash loss is ~60 seconds.
2. **Smart restore** — on reopen, if a running session is found, compute `gap = now − saved.startedAt`. If `≤ 5 min` keep `startedAt` so the gap is silently credited (your "just resume" case for crash recovery and window reloads); if `> 5 min` pause at the last checkpoint and fire `onRestoreFrozen` so the host shows a toast — avoids treating an overnight close as worked time.

Issues, states, board columns, and connection are always re-fetched at startup. Do **not** revive the old `startedAt = Date.now()` reset that was here pre-1.1.1 — it silently zeroed the current segment on every reload.

### Time-logging quirks

`TimerCore.stop()` posts a single work item to `/api/issues/{id}/timeTracking/workItems` only when the session is bound to a real YouTrack issue, a logger is bound, **and** `minutes >= 1`. Sub-minute sessions are silently dropped — intentional, but it makes "I clicked Stop and nothing happened" a common false alarm. Custom (non-YouTrack) tasks always skip the logger entirely.

## Configuration surface

User settings under `youtrackTracker.*` (`baseUrl`, `token`, `projectId`, `myIssuesOnly`). `runConfigure` in [`extension.ts`](packages/vscode-ext/src/extension.ts) is the canonical way to populate them — it also calls `tryConnect()` afterwards, so any flow that mutates these settings should call `tryConnect()` to refresh the client.
