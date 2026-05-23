# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a **pnpm + Turbo monorepo**. The VS Code extension lives in `packages/vscode-ext/`. Planned siblings (see [docs/plan-desktop.md](docs/plan-desktop.md)): `packages/core`, `packages/ui`, `packages/desktop` (Tauri app for Win/Mac/Linux).

## Commands

```bash
pnpm install                                          # one-time, hydrates all workspaces
pnpm --filter ylate build                             # tsc -p ./   →  packages/vscode-ext/out/*.js
pnpm --filter ylate watch                             # tsc --watch
pnpm --filter ylate package                           # build .vsix (drops in packages/vscode-ext/)
code --install-extension packages/vscode-ext/ylate-<version>.vsix --force
```

There is no test suite and no linter. TypeScript `strict` is on, so the compiler is the only static check.

To exercise the extension after a code change: `pnpm --filter ylate package && code --install-extension packages/vscode-ext/ylate-*.vsix --force`, then `Developer: Reload Window` from the command palette in any open VS Code instance.

**pnpm 11 quirk:** the `verify-deps-before-run` policy is set to `false` in [.npmrc](.npmrc) because pnpm's default escalates the `IGNORED_BUILDS` warning (for `@vscode/vsce-sign` + `keytar`) into a hard failure on every `pnpm run` invocation. The setting lives in the repo so contributors don't have to discover this.

## Architecture

All source paths below are inside `packages/vscode-ext/`. Four files, each with a focused responsibility. The non-obvious bits are the contracts between them.

**[packages/vscode-ext/src/extension.ts](packages/vscode-ext/src/extension.ts) — host-side controller.** Activates on `onStartupFinished`, owns module-level state (`client`, `issues`, `states`, `connected`, `errorMsg`), registers commands, and provides the webview view. It does not render anything itself; it pushes state to the webview and the status bar.

**[packages/vscode-ext/src/timerManager.ts](packages/vscode-ext/src/timerManager.ts) — single source of truth for the active session.** Owns the `StatusBarItem`, the 1-second `setInterval` ticker, and persistence to `context.workspaceState` (key `activeSession`). The status bar item is **hidden whenever there is no session** — there is no idle state. Both the webview and the host read from `timerManager.current` / `timerManager.totalElapsedMs`; on every state change `emit()` fires the `onUpdate` listener which `extension.ts` uses to push a `timerUpdate` to the webview. Never write to session state from outside this class.

**[packages/vscode-ext/src/youtrackClient.ts](packages/vscode-ext/src/youtrackClient.ts) — HTTP client.** Uses raw `node:https` / `node:http` (no fetch, no axios — keep it that way; no transitive deps means `vsce package --no-dependencies` works). Issue shape conversion lives in `mapIssue()`: YouTrack returns a polymorphic `customFields` array, and `mapIssue` flattens named fields (`State`, `Spent time`) onto the `YTIssue`. **Adding a new visible issue field means extending both the `fields=` query string and `mapIssue` in lockstep** — forgetting the query string yields silently empty values.

**[packages/vscode-ext/src/panelHtml.ts](packages/vscode-ext/src/panelHtml.ts) — webview body.** Returns a single self-contained HTML string with CSS and JS inline. Communicates with the host through `vscode.postMessage` / `acquireVsCodeApi()`.

### Webview contract — "static shell + postMessage"

The webview HTML is set **exactly once**, in `resolveWebviewView`. After that, the host never replaces `webview.html`; it only sends messages:

- `init` — full state (issues, states, session, connection). Sent on `ready` and on visibility changes. Webview re-renders everything.
- `timerUpdate` — session + elapsed only. Sent on every timer tick / pause / resume / start / stop. Webview re-renders the timer card and re-runs `renderIssues()` to refresh the running badge.

The webview's `'ready'` message is the handshake — the host doesn't know the webview exists until that arrives, so initial state is pushed in response to `'ready'`, not at activation time.

### Event delegation in the webview is non-negotiable

Issue card actions (Start, Stop, state-change dropdown) use `data-action` / `data-issue-id` attributes plus delegated listeners on `#issuesList`. Do **not** introduce inline `onclick="…"` handlers that interpolate `issue.id` — earlier code did `onclick="startIssue(' + JSON.stringify(issue.id) + ')"` which produced `onclick="startIssue("3-123")"`, and the inner `"` closed the attribute, silently breaking every Start button (and as a downstream effect, leaving the status bar permanently hidden because no session was ever created). If you need a new card-level action, add a `data-action` value and extend the delegated handlers in [packages/vscode-ext/src/panelHtml.ts](packages/vscode-ext/src/panelHtml.ts).

### Crash-resilient session persistence

The active session is persisted under `workspaceState` key `activeSession`. Two pieces work together:

1. **Periodic checkpoint** — every 60 ticks while running, [`checkpoint()`](packages/vscode-ext/src/timerManager.ts) rolls `(now − startedAt)` into `session.elapsed`, sets `startedAt = now`, and persists. Worst-case crash loss is ~60 seconds.
2. **Smart restore** — on reopen, if a running session is found, compute `gap = now − saved.startedAt`. If `≤ 5 min` keep `startedAt` so the gap is silently credited (your "just resume" case for crash recovery and window reloads); if `> 5 min` pause at the last checkpoint with an info toast — avoids treating an overnight close as worked time.

Issues, states, board columns, and connection are always re-fetched at startup. Do **not** revive the old `startedAt = Date.now()` reset that was here pre-1.1.1 — it silently zeroed the current segment on every reload.

### Time-logging quirks

`stopAndLog` posts a single work item to `/api/issues/{id}/timeTracking/workItems` only when the session is bound to a real YouTrack issue, the client is connected, **and** `minutes >= 1`. Sub-minute sessions are silently dropped — intentional, but it makes "I clicked Stop and nothing happened" a common false alarm. Custom (non-YouTrack) tasks always skip the API call.

## Configuration surface

User settings under `youtrackTracker.*` (`baseUrl`, `token`, `projectId`, `myIssuesOnly`). `runConfigure` in [packages/vscode-ext/src/extension.ts](packages/vscode-ext/src/extension.ts) is the canonical way to populate them — it also calls `tryConnect()` afterwards, so any flow that mutates these settings should call `tryConnect()` to refresh the client.
