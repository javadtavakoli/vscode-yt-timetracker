# Design: read real instance config for moving + work-item type

**Date:** 2026-06-03
**Status:** Approved — pending spec review
**Repos touched:** this monorepo (`@ylate/core`, `@ylate/ui`, both hosts) and `trackpilot` (`/home/javad/Projects/youtrack-cli`, → publish 0.4.0).
**Builds on:** the merged trackpilot integration (`@ylate/core` drives YouTrack through `trackpilot`'s `createApi`).

## Generality requirement (overriding constraint)

This tool ships to arbitrary YouTrack instances. **Nothing instance-specific may be
hardcoded** — not field names, board names, project keys, work-item types, URLs, or
example data. Every per-instance value is *discovered at runtime* from the YouTrack
REST API. The only constants permitted are generic YouTrack defaults used as
last-resort fallbacks (e.g. a `"State"` field name, a small default state list). Tests
and docs use neutral placeholders (`https://example.youtrack.cloud`, `ACME-1`).

## Problem

Two pre-existing bugs, both rooted in the app **guessing** YouTrack config instead of
reading it (verified generally against a live instance — details kept instance-agnostic):

1. **Moving sets the wrong field, and the column list can be truncated.** A YouTrack
   agile board can be organized by *any* custom field of state type — not necessarily
   the built-in `State`. An issue may carry several such fields at once. But `moveIssue`
   hardcodes the command `State <value>`, so when a board is organized by a different
   field, picking a column sets the wrong field. Separately, a project can belong to
   **multiple boards** with differing column sets, and `getBoardColumns` blindly uses
   the *first*, so the dropdown shows only a subset of the available columns.
2. **Work-item type is never logged.** YouTrack work items have a standard `type` field
   whose allowed values are **defined per instance** (readable via
   `/admin/timeTrackingSettings/workItemTypes` with a normal token). The app instead
   ships a fixed list of "activities" that won't match an instance's configured types,
   and embeds the chosen activity only in the work-item *description* (`[activity]
   summary`) — never sending the real `type`.

## Fix #1 — generic board-field-aware moving

The board's column field is **discovered**, never assumed.

### Core

Replace `getStates(projectId)` + `getBoardColumns(projectShortName)` with one method:

```
getMoveOptions(projectId): Promise<{ field: string; values: string[] }>
```

Implementation (all via the trackpilot raw `request` hatch — no trackpilot change needed):
1. `GET /agiles` with `fields=projects(shortName),columnSettings(field(name),columns(presentation))`, `$top=50`. Find boards whose `projects[].shortName === projectId`. Take `columnSettings.field.name` from the first match — **whatever it is**. If no board matches, default `field = "State"` (generic YouTrack built-in).
2. Read that field's **complete** value set via schema-via-issue: `GET /issues` with `query=project: {projectId}`, `$top=1`, `fields=customFields(name,$type,projectCustomField(field(name),bundle(values(name))))`; find the custom field whose `name === field`; return its `projectCustomField.bundle.values[].name` in bundle order. If the lookup fails/empty, fall back to the generic `["Open","In Progress","In Review","Done"]`.
3. Return `{ field, values }`.

Change `moveIssue`:

```
moveIssue(issueId: string, field: string, value: string): Promise<void>
  → api.applyCommand(issueId, `${field} {${value}}`)
```

The `field` is passed in (discovered, not hardcoded). Braces wrap the value so multi-word values parse correctly under the command engine (e.g. `<field> {Ready to Publish}`).

`mapIssue` takes the move `field` and reads the issue's current value of that field into `Issue.state` (repurposed: "current value of the board's move field"). `getIssues`/`getIssue` accept the move field so they map the right value. `ISSUE_FIELDS` already fetches all custom fields generically, so no field-string change is needed. `Issue.state`'s doc comment is updated; the field name stays `state` to avoid UI churn.

### Contract (`HostMessage`/`UICommand` in `types.ts`)

- `init`: replace `states: string[]` and `boardColumns: BoardColumn[] | null` with `moveField: string` and `moveValues: string[]`.
- `move` command: `{ cmd: "move"; issueId: string; value: string }` (was `state`). The host stores `moveField` at connect, so the UI sends only the value.
- Remove the now-unused `BoardColumn` interface.

### Hosts (`extension.ts`, `desktopHost.ts`)

- At connect/refresh: call `getMoveOptions(projectId)` (parallel with `getIssues`), store `moveField` + `moveValues` in module/closure state, then fetch issues passing `moveField` so current values map. Send `moveField` + `moveValues` in `init`.
- `move` handler: `client.moveIssue(issueId, moveField, value)`.

### UI (`App.tsx`)

- Drop `columnForState` / `BoardColumn` / the board-vs-states branch. Dropdown options = `moveValues`; selected = `issue.state`; badge = `issue.state || "—"`; `onMove(value)` → `{ cmd: "move", issueId, value }`.

## Fix #2 — log the real, instance-defined work-item type

### trackpilot 0.4.0 (`/home/javad/Projects/youtrack-cli`)

Extend `logWorkItem` to accept an optional `type`:

```js
async logWorkItem(id, { minutes, text, date, type } = {}) {
  return request('POST', `/issues/${encodeURIComponent(id)}/timeTracking/workItems`, {
    body: {
      date,
      duration: { minutes },
      text: text ?? '',
      usesMarkdown: false,
      ...(type ? { type: { name: type } } : {}),
    },
  });
}
```

Update `src/api.d.ts` (`logWorkItem(id, item: { minutes: number; text?: string; date?: number; type?: string })`) and add a `node --test` case asserting `type: { name }` is included when provided and omitted when not (neutral test data). Conventional commit (`feat:`) → CI publishes (≈ `0.4.0`); bump `@ylate/core` to the actual published version.

### Core

- New `getWorkItemTypes(): Promise<string[]>` → `GET /admin/timeTrackingSettings/workItemTypes` with `fields=name`, `$top=100` → names; on error return `[]`. (Instance-defined; no list is baked in.)
- `logTime(issueId, minutes, description, date, type?)` → `api.logWorkItem(issueId, { minutes, text: description, date, type })`.

### Contract + timer

- Rename `Session.activity: ActivityType` → `Session.workItemType: string`. Add `type?: string` to `LogParams`. Remove the `ActivityType` enum (its fixed values were the instance-specific guess we're eliminating).
- `timerCore.start(issueId, issueReadable, summary, workItemType, priorSpentMinutes)` (param renamed). `stop()` builds `description = summary` (drop the `[activity]` prefix; the type is now a real field) and includes `type: sess.workItemType` in `LogParams`.
- `start`/`startCustom` commands carry `workItemType: string` (was `activity`). `init` gains `workItemTypes: string[]`.

### Hosts

- At connect/refresh: `getWorkItemTypes()` (parallel), store, send in `init`. `start` passes `workItemType`. The logger callback passes `type` to `client.logTime`. Tray title (`extension.ts`) shows `session.workItemType`.

### UI (`App.tsx`)

- Replace the hardcoded `ACTIVITIES` and `activityById` with `workItemTypes` (from `init`) and `typeById: Record<string, string>`. The per-issue dropdown lists `workItemTypes`; the custom-task form's type select likewise. Default selection = first type (or empty). `start` sends the selected `workItemType`.

## Graceful degradation

- Empty `workItemTypes` (endpoint blocked on an instance) → empty dropdown; work items logged with no `type` (trackpilot omits the field). No regression.
- Project on no board → `moveField = "State"`, values from that field's bundle (or the generic fallback list if even that read fails).

## Plan phasing

- **Phase T:** trackpilot `logWorkItem` type + test → publish 0.4.0 → bump core dep.
- **Phase 1:** Fix #1 (move field + columns). No trackpilot dependency; can land independently.
- **Phase 2:** Fix #2 (work-item type). Depends on Phase T's published version.

## Verification (live, gates completion)

Run against any YouTrack instance configured in the app (results described generically):
- **Move:** pick a multi-word column on an issue whose board is organized by a non-`State` field → the **board's** field changes (not `State`).
- **Columns:** the dropdown shows the board field's full value set, not a first-board subset.
- **Type:** Stop & Log with a selected type → the YouTrack work item shows that **type**, and the description is just the summary.
- Build green; `.vsix` packages; keyring absent from both bundles.

## Out of scope

- No per-project work-item-type filtering (the global list is authoritative across instances).
- No board picker (we use the discovered field's full value set, decided during brainstorming).
- No changes to timer/persistence semantics beyond the `activity → workItemType` rename.
