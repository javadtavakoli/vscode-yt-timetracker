# Design: route YouTrack access through trackpilot

**Date:** 2026-06-02
**Status:** Approved — pending spec review
**Repos touched:** `trackpilot` (`/home/javad/Projects/youtrack-cli`) and this monorepo (`@ylate/core`).

## Goal

Replace `@ylate/core`'s bespoke YouTrack HTTP logic with the user's own
`trackpilot` package, so the time-tracker drives YouTrack through trackpilot's
`createApi` client instead of a hand-rolled `YouTrackClient` body.

## Guiding principle — keep trackpilot general

trackpilot must stay a **general** authenticated YouTrack REST client. No
custom-field enforcement may sit on the app's code path. The time-tracker only
**reads issues/projects/states**, **logs spent time**, and **moves issue state**
— it never creates issues or sets typed custom fields, so trackpilot's CLI-side
validation machinery (`apply-fields.mjs`, `custom-fields.mjs`, the "did you mean"
suggestions) is never invoked by the app. State changes go through YouTrack's
**command engine** (`applyCommand('State X')`), not a custom-field-id POST, which
also keeps state-setting off the custom-field path.

## Background — what trackpilot 0.2.0 is

- Published as a **CLI binary only**: `package.json` has `bin` but no `main` /
  `exports`. The reusable core is `src/api.mjs`, exporting
  `createApi({ baseUrl, token })` plus pure shaping helpers (`shapeIssue`,
  `fieldValue`, `AppError`, …). It uses the global `fetch` and is plain ESM
  `.mjs` with no TypeScript types.
- `src/api.mjs` imports **nothing** (in particular, not `@napi-rs/keyring`),
  so it is safe to bundle into a browser/webview context. The native keyring
  dep is only reached through the CLI path (`keyring.mjs`, `config.mjs`).

## What the app's `YouTrackClient` requires (the contract to preserve)

`packages/core/src/youtrackClient.ts` exposes these methods, consumed by
`packages/vscode-ext/src/extension.ts`, `packages/vscode-ext/src/timerManager.ts`,
and `packages/ui/src/desktopHost.ts`:

| Method | trackpilot mapping |
|---|---|
| `ping(): Promise<string>` (display name) | **new** `me()` → `{ name, login }` |
| `getProjects(): Promise<Project[]>` | `projects()` |
| `getIssues(projectId, myOnly, query)` | `search(query)` + compose `project: {id} for: me` |
| `getIssue(issueId)` | `readIssue(id)` |
| `logTime(issueId, minutes, description, date)` | **new** `logWorkItem(id, { minutes, text, date })` |
| `moveIssue(issueId, stateName)` | `applyCommand(id, 'State <name>')` |
| `getStates(projectId)` | raw `request` (project customFields bundle) |
| `getBoardColumns(projectShortName)` | raw `request` (`/agiles`) |
| `mapIssue().spentTime` (numeric minutes) | raw `request` with `value(minutes)` |

The class signature, constructor `(baseUrl, token, fetchFn?)`, and all method
signatures stay **identical** so no consumer changes.

## Phase A — trackpilot library changes (`/home/javad/Projects/youtrack-cli`)

All changes additive / backward-compatible. Conventional commits (`feat:`) so the
repo's existing conventional-commit CI bumps the version (≈ `0.3.0`) and publishes
on push to `main`.

1. **Library entry point + types.** Add an `exports` map to `package.json`:

   ```json
   "exports": {
     ".": { "types": "./src/api.d.ts", "import": "./src/api.mjs" }
   }
   ```

   Keep `bin`. Hand-write `src/api.d.ts` typing `createApi`, the returned client
   (all methods, including the new ones and the raw `request`), and the shaped
   data types. Add `src/api.d.ts` to the `files` array. Verified: `@ylate/core`
   uses `moduleResolution: "Bundler"`, so `exports.types` resolves.

2. **Injectable fetch.** `createApi({ baseUrl, token, fetch })`, defaulting to
   `globalThis.fetch`. The internal `request` uses the injected fetch. Required
   for the Tauri/Linux desktop host, which injects a native `tauriFetch` to
   bypass WebKit2GTK's CORS ("Load failed").

3. **`me()`** → `GET /users/me?fields=name,login` → `{ name, login }`.

4. **`logWorkItem(id, { minutes, text, date })`** →
   `POST /issues/{id}/timeTracking/workItems` with
   `{ date, duration: { minutes }, text, usesMarkdown: false }`. General
   time-tracking primitive; no custom field involved.

5. **Raw escape hatch.** Expose the internal `request(method, path, { query, body })`
   on the returned client so consumers can perform arbitrary authenticated reads
   (agile boards, project state bundles, numeric spent-time minutes) through
   trackpilot's fetch-injected, error-handling layer — without trackpilot
   needing to model those domain shapes. This is what keeps trackpilot general.

6. **Tests** (`node --test`) covering the new public surface (`me`,
   `logWorkItem`, injectable fetch, raw `request`), since `api.mjs` is becoming a
   versioned public contract. Use a stub `fetch` injected via `createApi`.

`@napi-rs/keyring` stays a normal dependency (the CLI needs it); since the
library entry never imports it, it is never bundled into or run by the app.

## Publish gate

After Phase A, push trackpilot to `main` (self-push via the existing git remote;
CI auto-publishes). Note the **actual** published version — conventional-commit
versioning is not fully predictable — and use that exact version when bumping the
dependency in Phase B.

## Phase B — `@ylate/core` integration (this repo)

Rewrite **only the body** of `packages/core/src/youtrackClient.ts`; the public
class and method signatures are unchanged.

1. Add `trackpilot@^0.3.x` (exact published version) to `@ylate/core`'s
   `dependencies`.
2. `YouTrackClient` constructor builds
   `createApi({ baseUrl, token, fetch: this.fetchFn })` once and stores it.
3. Each method delegates:
   - `ping` → `api.me()` → `name || login`.
   - `getProjects` → `api.projects()` mapped to `Project[]`.
   - `getIssue` / `getIssues` → `api.readIssue` / `api.search` (compose the
     `project: {id} [for: me] <query>` filter in core).
   - `moveIssue` → `api.applyCommand(id, 'State ' + stateName)`.
   - `logTime` → `api.logWorkItem(id, { minutes, text: description, date })`.
   - `getStates`, `getBoardColumns`, numeric `spentTime` → `api.request(...)`
     with the existing field selections; domain mapping stays in core's
     `mapIssue` / board-column shaping.
4. Local typecheck de-risk: temporarily point `@ylate/core` at
   `/home/javad/Projects/youtrack-cli` (pnpm `link:`/`file:`, **not committed**)
   to run `pnpm --filter @ylate/core build` and a full `pnpm build`, then switch
   the manifest to the published npm version before committing.

## Named risks (verify before declaring done)

- **spentTime numeric, not presentation.** trackpilot's `shapeIssue`/`fieldValue`
  flattens "Spent time" to a presentation string ("1h 30m"); `displayMs` /
  `priorSpentMinutes` needs **numeric minutes**. The raw read must request
  `customFields(name,value(name,presentation,minutes),$type)` and core must read
  `value.minutes`. Confirm a real issue returns numeric minutes.
- **`applyCommand` ≠ field POST.** State moves via the command engine hit a
  different permission surface, and state names with spaces/special characters
  parse differently than a direct field write. Verify a real state transition end
  to end.
- **Phase B unverifiable until publish.** First real `pnpm build` of the
  integration depends on 0.3.x being on npm; the local-link typecheck mitigates
  but does not replace a post-publish build.
- **Public-contract cost.** Exposing `api.mjs` via `exports` makes it a versioned
  public API for trackpilot; future changes there must be versioned carefully.

## Out of scope

- No changes to `extension.ts`, `timerManager.ts`, `desktopHost.ts`, the UI, or
  the timer state machine.
- No new app features; behavior parity only.
- No changes to trackpilot's CLI commands or its create/update validation.
