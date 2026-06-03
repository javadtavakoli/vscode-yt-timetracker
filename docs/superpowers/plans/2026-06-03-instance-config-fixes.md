# Instance-Config Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make moving issues target the board's *actual* column field (any field, discovered at runtime) with its full value set, and log the instance's *real* work-item type — with nothing instance-specific hardcoded.

**Architecture:** Two phases with a publish gate. **Phase T** adds an optional `type` to trackpilot's `logWorkItem` and publishes 0.4.0. **Phase M** (monorepo) does both fixes together, package by package (core → vscode-ext → ui), because they edit the same shared files (`types.ts`, both hosts, `App.tsx`) and splitting by feature would churn them twice. Each package compiles independently, so each task ends with that package's build/typecheck.

**Tech Stack:** Node ≥20 ESM + `node --test` (trackpilot); TypeScript strict, `moduleResolution: "Bundler"`, pnpm + Turbo (monorepo). NOTE: the monorepo has **no unit-test runner** — verification is `tsc`/build. `@ylate/ui` is built by Vite which does **not** typecheck, so UI tasks must run `npx tsc --noEmit -p packages/ui` explicitly.

**Generality (overriding):** No field names, board names, project keys, work-item types, URLs, or instance data may be hardcoded. The only constants allowed are generic YouTrack fallbacks (`"State"`, a default state list). Tests/examples use `https://example.youtrack.cloud` / `ACME-1`.

**Branches:** trackpilot work on `feat/logworkitem-type` in `/home/javad/Projects/youtrack-cli`; monorepo work on `feat/instance-config-fixes` (already checked out) in `/home/javad/Downloads/youtrack-time-tracker-source`.

---

## File Structure

**Phase T — `/home/javad/Projects/youtrack-cli`**
- Modify: `src/api.mjs` — `logWorkItem` gains optional `type`.
- Modify: `src/api.d.ts` — `logWorkItem` type signature.
- Modify: `test/api-client.test.mjs` — assert `type:{name}` included/omitted.

**Phase M — monorepo**
- Modify: `packages/core/package.json` — bump `trackpilot` to published 0.4.x.
- Modify: `packages/core/src/youtrackClient.ts` — `getMoveOptions`, `getWorkItemTypes`, `moveIssue(id, field, value)`, `logTime(..., type?)`, `mapIssue(raw, moveField)`, `getIssues/getIssue(moveField)`; remove `getStates`/`getBoardColumns`.
- Modify: `packages/core/src/types.ts` — contract: `Issue.state` doc; remove `BoardColumn` + `ActivityType`; `Session.workItemType`; `LogParams.type?`; `init` carries `moveField`/`moveValues`/`workItemTypes`; `move` carries `value`; `start`/`startCustom` carry `workItemType`.
- Modify: `packages/core/src/timerCore.ts` — `start(... workItemType ...)`; `stop()` description = summary + `type`.
- Modify: `packages/core/src/index.ts` — drop `ActivityType`/`BoardColumn` exports.
- Modify: `packages/vscode-ext/src/timerManager.ts` — `start(... workItemType ...)`, logger passes `type`.
- Modify: `packages/vscode-ext/src/extension.ts` — state vars, connect/refresh, `sendAll`, `move`, `start`, `onLogged`, tray.
- Modify: `packages/ui/src/desktopHost.ts` — state vars, `refresh`, `sendInit`, `move`, `start`, logger, `onLogged`.
- Modify: `packages/ui/src/App.tsx` — drop `ACTIVITIES`/`columnForState`; `moveValues`/`workItemTypes`/`typeById`/`customType`; dropdowns; handlers.

---

# PHASE T — trackpilot `logWorkItem` type

> Run from `/home/javad/Projects/youtrack-cli`. TDD. Conventional Commits.

### Task T1: Optional `type` on `logWorkItem`

**Files:** `src/api.mjs`, `src/api.d.ts`, `test/api-client.test.mjs`.

- [ ] **Step 1: Branch**

```bash
cd /home/javad/Projects/youtrack-cli && git checkout main && git pull --ff-only && git checkout -b feat/logworkitem-type
```

- [ ] **Step 2: Write failing tests**

Append to `test/api-client.test.mjs`:

```js
test('logWorkItem includes type:{name} when a type is given', async () => {
  const fetch = stubFetch(() => ({ body: { id: 'wi-2' } }));
  const api = createApi({ baseUrl: 'https://example.youtrack.cloud', token: 't', fetch });
  await api.logWorkItem('ACME-1', { minutes: 30, text: 'x', date: 1700000000000, type: 'Development' });
  const sent = JSON.parse(fetch.calls.at(-1).init.body);
  assert.deepEqual(sent, {
    date: 1700000000000,
    duration: { minutes: 30 },
    text: 'x',
    usesMarkdown: false,
    type: { name: 'Development' },
  });
});

test('logWorkItem omits type when none is given', async () => {
  const fetch = stubFetch(() => ({ body: { id: 'wi-3' } }));
  const api = createApi({ baseUrl: 'https://example.youtrack.cloud', token: 't', fetch });
  await api.logWorkItem('ACME-1', { minutes: 5, text: 'y', date: 1 });
  const sent = JSON.parse(fetch.calls.at(-1).init.body);
  assert.equal('type' in sent, false);
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `node --test test/api-client.test.mjs`
Expected: FAIL — the first new test sees no `type` key in the body.

- [ ] **Step 4: Implement**

In `src/api.mjs`, replace the `logWorkItem` method body with:

```js
    // General YouTrack time-tracking primitive. `date` is epoch millis.
    // `type` (optional) is a work-item type NAME defined by the instance.
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
    },
```

- [ ] **Step 5: Run — expect PASS**

Run: `node --test test/api-client.test.mjs`
Expected: PASS (both new tests + existing).

- [ ] **Step 6: Update types**

In `src/api.d.ts`, change the `logWorkItem` line to:

```ts
  logWorkItem(id: string, item: { minutes: number; text?: string; date?: number; type?: string }): Promise<any>;
```

- [ ] **Step 7: Full suite + commit**

Run: `node --test`
Expected: all pass.

```bash
git add src/api.mjs src/api.d.ts test/api-client.test.mjs
git commit -m "feat(api): support optional work-item type on logWorkItem"
```

### Task T2: Publish gate

- [ ] **Step 1: Merge to main + push (triggers CI publish)**

```bash
cd /home/javad/Projects/youtrack-cli && node --test && git checkout main && git merge --ff-only feat/logworkitem-type && git push origin main && git branch -d feat/logworkitem-type
```

- [ ] **Step 2: Record the published version**

Run (poll until it changes from 0.3.0):
```bash
npm view trackpilot version
```
Expected: the new version (a `feat:` bump → likely `0.4.0`). **Use this exact value in Phase M Task M1.** Confirm the new surface shipped:
```bash
cd /tmp && rm -rf tpv && mkdir tpv && cd tpv && npm pack trackpilot@$(npm view trackpilot version) >/dev/null 2>&1 && tar xzf *.tgz && grep -n "type: { name: type }" package/src/api.mjs
```
Expected: the line is present.

---

# PHASE M — monorepo (both fixes)

> Run from `/home/javad/Downloads/youtrack-time-tracker-source`, branch `feat/instance-config-fixes`.

### Task M1: Core (`@ylate/core`)

**Files:** `packages/core/package.json`, `packages/core/src/youtrackClient.ts`, `packages/core/src/types.ts`, `packages/core/src/timerCore.ts`, `packages/core/src/index.ts`.

- [ ] **Step 1: Bump the trackpilot dependency**

In `packages/core/package.json`, set the published version from Phase T Task T2 (shown as `0.4.0`; substitute the real value):
```json
  "dependencies": {
    "trackpilot": "^0.4.0"
  },
```
Run: `pnpm install`
Expected: resolves trackpilot 0.4.x. (A `minimumReleaseAgeExclude` line for the new version may be auto-added to `pnpm-workspace.yaml` — that is expected; keep it.)

- [ ] **Step 2: Rewrite `packages/core/src/youtrackClient.ts`**

Overwrite the file with:

```ts
import type { Issue, Project } from "./types";
import { createApi, type TrackpilotApi } from "trackpilot";

/**
 * Fetch-compatible function. Defaults to `globalThis.fetch`. Hosts where the
 * webview enforces CORS for cross-origin requests (Tauri's WebKit2GTK on
 * Linux is the loud one — "TypeError: Load failed") inject a host-side fetch
 * implementation that runs through Rust / native HTTP and isn't subject to
 * the same-origin policy.
 */
export type FetchFn = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

const ISSUE_FIELDS =
  "id,idReadable,summary,customFields(name,value(name,presentation,minutes),$type)";

/** Generic fallback when a project is on no board and the field bundle can't be read. */
const DEFAULT_STATES = ["Open", "In Progress", "In Review", "Done"];

export class YouTrackClient {
  private api: TrackpilotApi;

  constructor(baseUrl: string, token: string, fetchFn?: FetchFn) {
    this.api = createApi({
      // trackpilot joins `${baseUrl}/api` without normalizing, so a trailing
      // slash would yield `//api` and break every request — strip it here.
      baseUrl: baseUrl.replace(/\/$/, ""),
      token,
      fetch: fetchFn,
    });
  }

  /** Verify connection and return the authenticated user's display name. */
  async ping(): Promise<string> {
    const me = await this.api.me();
    return me.name || me.login || "";
  }

  /** List projects available to the current user. */
  async getProjects(): Promise<Project[]> {
    const projects = await this.api.projects();
    return projects.map((p) => ({ id: p.id, name: p.name, shortName: p.shortName }));
  }

  /**
   * The field that moving an issue should set, and its full set of values.
   * The field is whatever the project's agile board is organized by (any
   * state-type custom field, not necessarily the built-in "State"). When the
   * project is on no board, falls back to "State".
   */
  async getMoveOptions(projectId: string): Promise<{ field: string; values: string[] }> {
    const field = await this.resolveMoveField(projectId);
    const values = await this.fieldValues(projectId, field);
    return { field, values: values.length ? values : DEFAULT_STATES };
  }

  private async resolveMoveField(projectId: string): Promise<string> {
    try {
      const boards = (await this.api.request("GET", "/agiles", {
        query: { fields: "projects(shortName),columnSettings(field(name))", $top: 50 },
      })) as Record<string, unknown>[];
      const board = boards.find((b) => {
        const projects = (b.projects as Record<string, unknown>[]) || [];
        return projects.some((p) => p.shortName === projectId);
      });
      const cs = board?.columnSettings as Record<string, unknown> | undefined;
      const f = cs?.field as Record<string, unknown> | undefined;
      const name = f?.name as string | undefined;
      if (name) return name;
    } catch {
      // ignore — fall back to State
    }
    return "State";
  }

  /** All possible values of a state-type field, read via schema-via-issue. */
  private async fieldValues(projectId: string, field: string): Promise<string[]> {
    try {
      const list = (await this.api.request("GET", "/issues", {
        query: {
          query: `project: {${projectId}}`,
          $top: 1,
          fields:
            "customFields(name,$type,projectCustomField(field(name),bundle(values(name))))",
        },
      })) as Record<string, unknown>[];
      const cfs = (list?.[0]?.customFields as Record<string, unknown>[]) || [];
      const cf = cfs.find((c) => c.name === field);
      const pcf = cf?.projectCustomField as Record<string, unknown> | undefined;
      const bundle = pcf?.bundle as Record<string, unknown> | undefined;
      const values = (bundle?.values as Record<string, unknown>[]) || [];
      return values.map((v) => String(v.name)).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Work-item types defined by the instance. Empty when not readable. */
  async getWorkItemTypes(): Promise<string[]> {
    try {
      const raw = (await this.api.request("GET", "/admin/timeTrackingSettings/workItemTypes", {
        query: { fields: "name", $top: 100 },
      })) as Record<string, unknown>[];
      return (raw || []).map((t) => String(t.name)).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Fetch issues for a project, optionally filtered to the current user. */
  async getIssues(
    projectId: string,
    myOnly: boolean,
    query = "",
    moveField = "State"
  ): Promise<Issue[]> {
    const base = `project: {${projectId}}`;
    const filter = myOnly ? `${base} for: me` : base;
    const q = query ? `${filter} ${query}` : filter;
    const raw = await this.api.request("GET", "/issues", {
      query: { query: q, fields: ISSUE_FIELDS, $top: 100 },
    });
    return (raw as Record<string, unknown>[]).map((i) => mapIssue(i, moveField));
  }

  /** Fetch a single issue's current state. */
  async getIssue(issueId: string, moveField = "State"): Promise<Issue> {
    const raw = await this.api.request(
      "GET",
      `/issues/${encodeURIComponent(issueId)}`,
      { query: { fields: ISSUE_FIELDS } }
    );
    return mapIssue(raw as Record<string, unknown>, moveField);
  }

  /** Log spent time on an issue as a work item, optionally with a type. */
  async logTime(
    issueId: string,
    minutes: number,
    description: string,
    date: number,
    type?: string
  ): Promise<void> {
    await this.api.logWorkItem(issueId, { minutes, text: description, date, type });
  }

  /** Move an issue by setting the board's column field via the command engine. */
  async moveIssue(issueId: string, field: string, value: string): Promise<void> {
    await this.api.applyCommand(issueId, `${field} {${value}}`);
  }
}

function mapIssue(raw: Record<string, unknown>, moveField: string): Issue {
  const cfs = (raw.customFields as Record<string, unknown>[]) || [];
  let state: string | undefined;
  let spentTime: number | undefined;

  for (const cf of cfs) {
    const name = cf.name as string;
    const val = cf.value as Record<string, unknown> | null;
    if (name === moveField && val) state = val.name as string;
    if (name === "Spent time" && val) {
      spentTime = (val.minutes as number) || 0;
    }
  }

  return {
    id: raw.id as string,
    idReadable: raw.idReadable as string,
    summary: raw.summary as string,
    state,
    spentTime,
  };
}
```

- [ ] **Step 3: Update `packages/core/src/types.ts`**

(a) Remove the `ActivityType` block (lines defining `export type ActivityType = ...`).

(b) Change `Session.activity` to `workItemType`:
```ts
  /** Selected work-item type NAME (from the instance), "" if none. */
  workItemType: string;
```
(replacing the `activity: ActivityType;` line).

(c) In `Issue`, update the `state` doc to reflect it's the move-field value:
```ts
  /** Current value of the board's move field (e.g. the State/Stage value). */
  state?: string;
```

(d) Remove the entire `export interface BoardColumn { ... }` block.

(e) In `LogParams`, add a `type`:
```ts
export interface LogParams {
  issueId: string;
  minutes: number;
  description: string;
  startedAt: number;
  /** Work-item type NAME, if one was selected. */
  type?: string;
}
```

(f) In `HostMessage`'s `init` member, replace the two lines
```ts
      states: string[];
      boardColumns: BoardColumn[] | null;
```
with
```ts
      moveField: string;
      moveValues: string[];
      workItemTypes: string[];
```

(g) In `UICommand`, change the `start`, `startCustom`, and `move` members:
```ts
  | {
      cmd: "start";
      issueId: string;
      issueReadable: string;
      summary: string;
      workItemType: string;
    }
  | { cmd: "startCustom"; summary: string; workItemType: string }
```
and
```ts
  | { cmd: "move"; issueId: string; value: string }
```

- [ ] **Step 4: Update `packages/core/src/timerCore.ts`**

(a) Line 1 import — remove `ActivityType`:
```ts
import type { Session, LogParams, FrozenInfo } from "./types";
```
(b) `start` signature + assignment — replace `activity: ActivityType,` param with `workItemType: string,` and the `activity,` field in the session literal with `workItemType,`.
(c) In `stop()`, change the logger payload:
```ts
        await this.logger({
          issueId: sess.issueId,
          minutes,
          description: sess.summary,
          startedAt: sess.startedAt,
          type: sess.workItemType || undefined,
        });
```

- [ ] **Step 5: Update `packages/core/src/index.ts`**

In the `export type { ... }` block, remove `ActivityType,` and `BoardColumn,`. Leave the rest.

- [ ] **Step 6: Build core**

Run: `pnpm --filter @ylate/core build`
Expected: clean `tsc` (zero errors). If errors mention `ActivityType`/`BoardColumn` still imported somewhere in core, remove those references.

- [ ] **Step 7: Commit**

```bash
git add packages/core pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(core): discover board move-field + instance work-item types"
```

### Task M2: VS Code host (`@ylate/ylate`)

**Files:** `packages/vscode-ext/src/timerManager.ts`, `packages/vscode-ext/src/extension.ts`.

- [ ] **Step 1: `timerManager.ts`**

(a) Remove `ActivityType` from the `@ylate/core` import line.
(b) `start` signature: replace `activity: ActivityType,` with `workItemType: string,` and the inner `this.core.start(issueId, issueReadable, summary, activity, priorSpentMinutes);` with `... summary, workItemType, priorSpentMinutes);`.
(c) The logger in `setClient` — find:
```ts
      this.core.setLogger(async ({ issueId, minutes, description, startedAt }) => {
        await client.logTime(issueId, minutes, description, startedAt);
      });
```
replace with:
```ts
      this.core.setLogger(async ({ issueId, minutes, description, startedAt, type }) => {
        await client.logTime(issueId, minutes, description, startedAt, type);
      });
```

- [ ] **Step 2: `extension.ts` — state vars**

Replace:
```ts
let states: string[] = [];
let boardColumns: BoardColumn[] | null = null;
```
with:
```ts
let moveField = "State";
let moveValues: string[] = [];
let workItemTypes: string[] = [];
```
Remove `BoardColumn` (and `ActivityType`, see below) from the `@ylate/core` import.

- [ ] **Step 3: `extension.ts` — start/startCustom/move handlers**

Replace the `start` case body:
```ts
        case "start": {
          const issue = issues.find((i) => i.id === msg.issueId);
          const prior = issue?.spentTime ?? 0;
          timerManager.start(msg.issueId, msg.issueReadable, msg.summary, msg.workItemType, prior);
          break;
        }
        case "startCustom":
          timerManager.start(null, "", msg.summary, msg.workItemType, 0);
          break;
```
Replace the `move` case:
```ts
        case "move":
          await moveIssue(msg.issueId, msg.value);
          break;
```
(`msg.activity as ActivityType` is gone, so the `ActivityType` import can be dropped.)

- [ ] **Step 4: `extension.ts` — `sendAll`**

Replace the `states,` / `boardColumns,` lines in the `postMessage({...})` with:
```ts
    moveField,
    moveValues,
    workItemTypes,
```

- [ ] **Step 5: `extension.ts` — `refresh` (fetch)**

Replace the `Promise.all` block:
```ts
    const [fetchedIssues, fetchedMove, fetchedTypes] = await Promise.all([
      client.getIssues(projectId, myOnly, "", moveField),
      client.getMoveOptions(projectId),
      client.getWorkItemTypes(),
    ]);
    issues = fetchedIssues;
    moveField = fetchedMove.field;
    moveValues = fetchedMove.values;
    workItemTypes = fetchedTypes;
    errorMsg = "";
```
NOTE: `getIssues` is called with the *previous* `moveField`; immediately re-map current values once the real field is known by appending after the assignments:
```ts
    if (moveField !== "State" || !issues.length) {
      issues = await client.getIssues(projectId, myOnly, "", moveField);
    }
```
This second fetch guarantees `issue.state` reflects the discovered field. (Two small GETs; acceptable.)

- [ ] **Step 6: `extension.ts` — `moveIssue` fn + `onLogged`**

Replace the `moveIssue` function header/body start:
```ts
async function moveIssue(issueId: string, value: string) {
  if (!client) return;
  try {
    await client.moveIssue(issueId, moveField, value);
    const issue = issues.find((i) => i.id === issueId);
    if (issue) issue.state = value;
```
In the `onLogged` handler near the top of `activate`, change `client.getIssue(issueId)` to `client.getIssue(issueId, moveField)`.

- [ ] **Step 7: `extension.ts` — tray title**

Change `title: \`${headerLabel} — ${session.activity}\`,` to:
```ts
    title: session.workItemType ? `${headerLabel} — ${session.workItemType}` : headerLabel,
```

- [ ] **Step 8: Build (typechecks via tsc)**

Run: `pnpm --filter @ylate/core build && pnpm --filter ylate build`
Expected: clean. Fix any remaining `states`/`boardColumns`/`activity`/`ActivityType` references the compiler flags.

- [ ] **Step 9: Commit**

```bash
git add packages/vscode-ext
git commit -m "feat(vscode-ext): wire move-field + work-item type through the host"
```

### Task M3: UI + desktop host (`@ylate/ui`)

**Files:** `packages/ui/src/desktopHost.ts`, `packages/ui/src/App.tsx`.

- [ ] **Step 1: `desktopHost.ts` — state vars + import**

Remove `ActivityType` and `BoardColumn` from the `@ylate/core` import. Replace:
```ts
  let states: string[] = [];
  let boardColumns: BoardColumn[] | null = null;
```
with:
```ts
  let moveField = "State";
  let moveValues: string[] = [];
  let workItemTypes: string[] = [];
```

- [ ] **Step 2: `desktopHost.ts` — `sendInit`**

Replace `states,` / `boardColumns,` in the `deliverToUI({ type: "init", ... })` with:
```ts
      moveField,
      moveValues,
      workItemTypes,
```

- [ ] **Step 3: `desktopHost.ts` — `refresh`**

Replace the `Promise.all` block:
```ts
      const [fetchedIssues, fetchedMove, fetchedTypes] = await Promise.all([
        client.getIssues(config.projectId, config.myIssuesOnly, "", moveField),
        client.getMoveOptions(config.projectId),
        client.getWorkItemTypes(),
      ]);
      issues = fetchedIssues;
      moveField = fetchedMove.field;
      moveValues = fetchedMove.values;
      workItemTypes = fetchedTypes;
      if (moveField !== "State" || !issues.length) {
        issues = await client.getIssues(config.projectId, config.myIssuesOnly, "", moveField);
      }
      errorMsg = "";
```

- [ ] **Step 4: `desktopHost.ts` — start/move/logger/onLogged**

(a) `start` case: `cmd.activity as ActivityType` → `cmd.workItemType`:
```ts
        core.start(cmd.issueId, cmd.issueReadable, cmd.summary, cmd.workItemType, prior);
```
(b) `startCustom` case:
```ts
        core.start(null, "", cmd.summary, cmd.workItemType, 0);
```
(c) `move` case:
```ts
      case "move":
        if (!client) return;
        try {
          await client.moveIssue(cmd.issueId, moveField, cmd.value);
          const issue = issues.find((i) => i.id === cmd.issueId);
          if (issue) issue.state = cmd.value;
          sendInit();
        } catch (err) {
          errorMsg = `Failed to move issue: ${err}`;
          sendInit();
        }
        break;
```
(d) logger in `connect`:
```ts
      core.setLogger(async ({ issueId, minutes, description, startedAt, type }) => {
        await client!.logTime(issueId, minutes, description, startedAt, type);
```
(e) `onLogged`: `client.getIssue(issueId)` → `client.getIssue(issueId, moveField)`.

- [ ] **Step 5: `App.tsx` — imports + remove ACTIVITIES + columnForState**

Remove `ActivityType` and `BoardColumn` from the `@ylate/core` import. Delete the `const ACTIVITIES: ActivityType[] = [ ... ];` block and the entire `function columnForState(...) { ... }`.

- [ ] **Step 6: `App.tsx` — state**

Replace:
```ts
  const [states, setStates] = useState<string[]>([]);
  const [boardColumns, setBoardColumns] = useState<BoardColumn[] | null>(null);
```
with (the UI does **not** track `moveField` — the host owns it; the `move` command sends only the value):
```ts
  const [moveValues, setMoveValues] = useState<string[]>([]);
  const [workItemTypes, setWorkItemTypes] = useState<string[]>([]);
```
Replace:
```ts
  const [customActivity, setCustomActivity] = useState<ActivityType>("Implementing");
```
with:
```ts
  const [customType, setCustomType] = useState<string>("");
```
Replace:
```ts
  const [activityById, setActivityById] = useState<Record<string, ActivityType>>({});
```
with:
```ts
  const [typeById, setTypeById] = useState<Record<string, string>>({});
```

- [ ] **Step 7: `App.tsx` — init handler**

Replace:
```ts
        setStates(msg.states);
        setBoardColumns(msg.boardColumns);
```
with:
```ts
        setMoveValues(msg.moveValues);
        setWorkItemTypes(msg.workItemTypes);
        setCustomType((prev) => prev || msg.workItemTypes[0] || "");
```

- [ ] **Step 8: `App.tsx` — handlers**

`startIssue`:
```ts
  const startIssue = (issue: Issue) => {
    post?.({
      cmd: "start",
      issueId: issue.id,
      issueReadable: issue.idReadable,
      summary: issue.summary,
      workItemType: typeById[issue.id] ?? workItemTypes[0] ?? "",
    });
  };
```
`startCustom`:
```ts
  const startCustom = () => {
    const summary = customName.trim();
    if (!summary) return;
    post?.({ cmd: "startCustom", summary, workItemType: customType });
    setCustomName("");
  };
```
`moveIssue`:
```ts
  const moveIssue = (issueId: string, value: string) =>
    post?.({ cmd: "move", issueId, value });
```

- [ ] **Step 9: `App.tsx` — IssueCard usage (in the issues `.map`)**

Update the `<IssueCard .../>` props: replace `states={states}` / `boardColumns={boardColumns}` with `moveValues={moveValues}`; replace `selectedActivity={activityById[issue.id] ?? "Implementing"}` with `selectedType={typeById[issue.id] ?? workItemTypes[0] ?? ""}`; the activity-change handler `setActivityById(...)` becomes `setTypeById((prev) => ({ ...prev, [issue.id]: act }))`; pass `activityOptions={workItemTypes}`; `onMove={(value) => moveIssue(issue.id, value)}`.

- [ ] **Step 10: `App.tsx` — IssueCard component**

In the `IssueCard` function: update its prop types — remove `states: string[]`, `boardColumns: BoardColumn[] | null`; add `moveValues: string[]`, `activityOptions: string[]`; rename `selectedActivity: ActivityType` → `selectedType: string`, `selectedActivity` usages → `selectedType`; `onActivityChange: (a: ActivityType) => void` → `onActivityChange: (a: string) => void`; `onMove: (newState: string) => void` → `onMove: (value: string) => void`.

Replace the dropdown-options block:
```ts
  const badgeText = issue.state || "—";
  const dropdownOptions = moveValues.map((v) => ({ value: v, label: v, selected: v === issue.state }));
  const selectedValue =
    dropdownOptions.find((o) => o.selected)?.value ?? issue.state ?? dropdownOptions[0]?.value ?? "";
```
(remove `currentColumn`/`columnForState` usage entirely.)

Replace the activity `<select>` options source `{ACTIVITIES.map(...)}` with `{activityOptions.map((a) => (<option key={a}>{a}</option>))}` and its `value={selectedActivity}` with `value={selectedType}`. The state `<select>` already maps `dropdownOptions`; keep it.

- [ ] **Step 11: `App.tsx` — TimerCard + CustomTaskForm**

TimerCard: `<span className="timer-activity">{session.activity}</span>` → `{session.workItemType}`.

CustomTaskForm: change its prop types `activity: ActivityType` → `type: string`, `onActivityChange: (v: ActivityType) => void` → `onTypeChange: (v: string) => void`; add `typeOptions: string[]`. Replace `{ACTIVITIES.map(...)}` with `{typeOptions.map((a) => (<option key={a}>{a}</option>))}`, `value={activity}` → `value={type}`, `onChange={(e) => onActivityChange(...)}` → `onChange={(e) => onTypeChange(e.target.value)}`. Update the `<CustomTaskForm .../>` call site: `activity={customActivity}` → `type={customType}`, `onActivityChange={setCustomActivity}` → `onTypeChange={setCustomType}`, add `typeOptions={workItemTypes}`.

- [ ] **Step 12: Typecheck UI (build does NOT)**

Run: `npx tsc --noEmit -p packages/ui`
Expected: zero errors. Fix any remaining `states`/`boardColumns`/`activity`/`ActivityType`/`columnForState` references. (Also check `packages/ui/src/PreferencesView.tsx` does not reference `ActivityType` — `grep -rn "ActivityType" packages/ui/src` should be empty.)

- [ ] **Step 13: Full build + package**

Run: `pnpm build && pnpm --filter ylate package`
Expected: 3/3 tasks succeed; `.vsix` produced. Sanity:
```bash
grep -c "napi-rs/keyring" packages/vscode-ext/dist/extension.js   # expect 0
```

- [ ] **Step 14: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): board move-field dropdown + instance work-item type selector"
```

### Task M4: Live verification (USER — gates completion)

**Files:** none.

- [ ] **Step 1: Install + reload**

```bash
code --install-extension packages/vscode-ext/ylate-*.vsix --force
```
- [ ] **Step 2: Move** — pick a multi-word column whose board uses a non-`State` field → the board's field changes (not `State`).
- [ ] **Step 3: Columns** — the dropdown shows the field's full value set (not a first-board subset).
- [ ] **Step 4: Type** — Stop & Log with a selected type → the YouTrack work item shows that type; description is just the summary.
- [ ] **Step 5:** If anything fails, report; fix on-branch and re-verify. On success, proceed to finishing-a-development-branch (merge to main).

---

## Self-Review

**Spec coverage:**
- Generality (no hardcoded field/types/instance data) → M1 `resolveMoveField`/`getWorkItemTypes` discover at runtime; only `DEFAULT_STATES`/`"State"` constants. ✓
- `getMoveOptions {field,values}` replacing getStates/getBoardColumns → M1 Step 2. ✓
- `moveIssue(id, field, value)` w/ brace-wrapped value → M1 Step 2. ✓
- `Issue.state` repurposed (read `moveField`) → M1 Step 2 `mapIssue` + Step 3c. ✓
- Contract: `moveField`/`moveValues`/`workItemTypes` in init; `move {value}`; `start/startCustom {workItemType}` → M1 Step 3. ✓
- trackpilot `logWorkItem` type + publish + core bump → T1/T2/M1 Step 1. ✓
- `getWorkItemTypes` + `logTime(type)` → M1 Step 2. ✓
- `activity → workItemType` rename across Session/LogParams/timerCore/hosts/UI; drop `[activity]` prefix → M1 Steps 3-4, M2, M3. ✓
- Tray shows type → M2 Step 7. ✓
- Graceful degradation (empty types, no board) → M1 `DEFAULT_STATES`, `getWorkItemTypes` catch, `getMoveOptions` fallback. ✓
- UI typecheck gap (Vite no tsc) → M3 Step 12. ✓

**Placeholder scan:** none. Published version is read from `npm view` (T2/M1 Step 1) — correct, the value doesn't exist until publish.

**Type consistency:** `getMoveOptions → {field, values}` consumed as `fetchedMove.field`/`.values` (M2 S5, M3 S3); `moveField`/`moveValues`/`workItemTypes` names identical in core contract (M1 S3f), both hosts (M2 S2/S4, M3 S1/S2), and UI init (M3 S7); `moveIssue(issueId, field, value)` called with `(id, moveField, value)` in both hosts; `logTime(...,type?)` matches `LogParams.type` and the logger destructure in both hosts; `workItemType` used consistently in `start`/`startCustom` commands, `Session`, timerCore, and UI handlers. `Issue.state` name retained everywhere it's read (badge/dropdown).
