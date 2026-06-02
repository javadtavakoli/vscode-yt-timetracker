# trackpilot Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the time-tracker drive YouTrack through the user's `trackpilot` package instead of `@ylate/core`'s hand-rolled HTTP body, while keeping trackpilot a general (non-custom-field-specific) YouTrack client.

**Architecture:** Two repos, two phases with a publish gate between them. **Phase A** turns trackpilot into a consumable library: an `exports` entry + hand-written types, an injectable `fetch`, two new general primitives (`me()`, `logWorkItem()`), and a raw `request()` escape hatch — all additive and backward-compatible, covered by `node --test`. **Phase B** rewrites only the *body* of `@ylate/core`'s `YouTrackClient` to delegate to trackpilot's `createApi`; every public method signature is preserved, so the three host consumers (`extension.ts`, `timerManager.ts`, `desktopHost.ts`) are untouched. Reads route through the raw `request` hatch so core keeps its own `mapIssue` (internal `id` + numeric `spentTime`); only `ping`/`projects`/`moveIssue`/`logTime` use high-level helpers.

**Tech Stack:** Node ≥ 20 ESM, plain `.mjs` + hand-written `.d.ts` (trackpilot); TypeScript strict, `moduleResolution: "Bundler"`, pnpm + Turbo monorepo (`@ylate/core`); `node --test` (trackpilot); esbuild/Vite bundling downstream.

**Repo paths:**
- trackpilot: `/home/javad/Projects/youtrack-cli` (package name `trackpilot`, remote `javadtavakoli/trackpilot`, conventional-commit CI auto-publishes on push to `main`).
- monorepo: `/home/javad/Downloads/youtrack-time-tracker-source`.

---

## File Structure

**Phase A — `/home/javad/Projects/youtrack-cli`**
- Modify: `package.json` — add `exports` map, add `src/api.d.ts` to `files`.
- Modify: `src/api.mjs` — injectable `fetch`; add `me()`, `logWorkItem()`, expose `request`.
- Create: `src/api.d.ts` — hand-written types for `createApi` and the returned client.
- Create: `test/api-client.test.mjs` — tests for the new public surface via an injected stub `fetch`.

**Phase B — `/home/javad/Downloads/youtrack-time-tracker-source`**
- Modify: `packages/core/package.json` — add `trackpilot` dependency.
- Modify: `packages/core/src/youtrackClient.ts` — rewrite body to delegate to `createApi`; keep class + method signatures and `mapIssue`.
- Unchanged: `packages/core/src/types.ts`, `packages/core/src/index.ts`, all of `vscode-ext` and `ui`.

---

# PHASE A — trackpilot library (`/home/javad/Projects/youtrack-cli`)

> All Phase A commands run from `/home/javad/Projects/youtrack-cli`.
> Commit messages use Conventional Commits so the repo's CI computes the version bump (`feat:` → minor → ≈ `0.3.0`).

### Task A1: Injectable fetch in `createApi`

**Files:**
- Modify: `src/api.mjs:65` (the `createApi` signature) and `src/api.mjs` `request` (the `fetch(` call inside it).
- Test: `test/api-client.test.mjs` (create).

- [ ] **Step 1: Write the failing test**

Create `test/api-client.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.mjs';

// A stub fetch that records the last call and returns a canned JSON body.
function stubFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = null } = responder(String(url), init) || {};
    return new Response(body == null ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

test('createApi uses the injected fetch (not global) and sends bearer auth', async () => {
  const fetch = stubFetch(() => ({ body: { login: 'me', name: 'Me' } }));
  const api = createApi({ baseUrl: 'https://x.youtrack.cloud', token: 'perm:abc', fetch });
  await api.me();
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0].url, /^https:\/\/x\.youtrack\.cloud\/api\/users\/me/);
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer perm:abc');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-client.test.mjs`
Expected: FAIL — `api.me is not a function` (me() added in Task A2; this task's assertion that the injected fetch is used will also drive the signature change). If `me` blocks the run, temporarily assert against `api.projects()` instead; either proves the injected-fetch path. Keep the `me()` version — Task A2 makes it pass fully.

- [ ] **Step 3: Implement injectable fetch**

In `src/api.mjs`, change the signature and capture the fetch:

```js
export function createApi({ baseUrl, token, fetch: fetchFn } = {}) {
  if (!baseUrl) {
    throw new AppError('no baseUrl: run `trackpilot config set --base-url <url>`');
  }
  if (!token) {
    throw new AppError('no token: run `trackpilot config set-token` or export YOUTRACK_TOKEN');
  }

  const doFetch = fetchFn ?? globalThis.fetch;
  const apiBase = `${baseUrl}/api`;
```

Then inside `request`, replace the `fetch(url, {...})` call with `doFetch(url, {...})`:

```js
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new AppError(`network error calling YouTrack: ${err.message}`);
    }
```

- [ ] **Step 4: Run test (still expected to fail on `me`)**

Run: `node --test test/api-client.test.mjs`
Expected: still FAIL on `api.me is not a function` — that's fixed in Task A2. The injected-fetch wiring is now in place.

- [ ] **Step 5: Commit**

```bash
git add src/api.mjs test/api-client.test.mjs
git commit -m "feat(api): allow injecting a fetch implementation into createApi"
```

---

### Task A2: `me()` primitive

**Files:**
- Modify: `src/api.mjs` (add `me` to the returned object).
- Test: `test/api-client.test.mjs` (the A1 test now passes; add a name-precedence assertion).

- [ ] **Step 1: Extend the test**

Append to `test/api-client.test.mjs`:

```js
test('me() returns { name, login } from /users/me', async () => {
  const fetch = stubFetch(() => ({ body: { login: 'jt', name: 'Javad Tavakoli' } }));
  const api = createApi({ baseUrl: 'https://x.youtrack.cloud', token: 't', fetch });
  const me = await api.me();
  assert.deepEqual(me, { name: 'Javad Tavakoli', login: 'jt' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-client.test.mjs`
Expected: FAIL — `api.me is not a function`.

- [ ] **Step 3: Implement `me()`**

In `src/api.mjs`, inside the `return { ... }` object of `createApi`, add (next to `projects()`):

```js
    async me() {
      const data = await request('GET', '/users/me', {
        query: { fields: 'name,login' },
      });
      return { name: data?.name ?? null, login: data?.login ?? null };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api-client.test.mjs`
Expected: PASS (both A1 and A2 `me` tests).

- [ ] **Step 5: Commit**

```bash
git add src/api.mjs test/api-client.test.mjs
git commit -m "feat(api): add me() to read the authenticated user"
```

---

### Task A3: `logWorkItem()` primitive

**Files:**
- Modify: `src/api.mjs` (add `logWorkItem` to the returned object).
- Test: `test/api-client.test.mjs`.

- [ ] **Step 1: Write the failing test**

Append to `test/api-client.test.mjs`:

```js
test('logWorkItem posts a duration workItem to the issue', async () => {
  const fetch = stubFetch(() => ({ body: { id: 'wi-1' } }));
  const api = createApi({ baseUrl: 'https://x.youtrack.cloud', token: 't', fetch });
  await api.logWorkItem('ABC-123', { minutes: 42, text: 'work', date: 1700000000000 });
  const call = fetch.calls.at(-1);
  assert.match(call.url, /\/api\/issues\/ABC-123\/timeTracking\/workItems$/);
  assert.equal(call.init.method, 'POST');
  const sent = JSON.parse(call.init.body);
  assert.deepEqual(sent, {
    date: 1700000000000,
    duration: { minutes: 42 },
    text: 'work',
    usesMarkdown: false,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-client.test.mjs`
Expected: FAIL — `api.logWorkItem is not a function`.

- [ ] **Step 3: Implement `logWorkItem()`**

In `src/api.mjs`, inside the returned object, add:

```js
    // General YouTrack time-tracking primitive. `date` is epoch millis.
    async logWorkItem(id, { minutes, text, date } = {}) {
      return request('POST', `/issues/${encodeURIComponent(id)}/timeTracking/workItems`, {
        body: {
          date,
          duration: { minutes },
          text: text ?? '',
          usesMarkdown: false,
        },
      });
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api.mjs test/api-client.test.mjs
git commit -m "feat(api): add logWorkItem() time-tracking primitive"
```

---

### Task A4: Expose the raw `request` escape hatch

**Files:**
- Modify: `src/api.mjs` (add `request` to the returned object).
- Test: `test/api-client.test.mjs`.

- [ ] **Step 1: Write the failing test**

Append to `test/api-client.test.mjs`:

```js
test('request escape hatch performs arbitrary authenticated GETs with query', async () => {
  const fetch = stubFetch(() => ({ body: [{ id: '0-0', name: 'Board' }] }));
  const api = createApi({ baseUrl: 'https://x.youtrack.cloud', token: 't', fetch });
  const data = await api.request('GET', '/agiles', { query: { fields: 'name', $top: 50 } });
  const call = fetch.calls.at(-1);
  assert.match(call.url, /\/api\/agiles\?/);
  assert.match(call.url, /fields=name/);
  assert.match(call.url, /%24top=50|\$top=50/);
  assert.deepEqual(data, [{ id: '0-0', name: 'Board' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-client.test.mjs`
Expected: FAIL — `api.request is not a function`.

- [ ] **Step 3: Expose `request`**

In `src/api.mjs`, inside the returned object (alongside `webUrl`), add:

```js
    // Low-level escape hatch: authenticated, fetch-injected YouTrack REST call.
    // Lets consumers read shapes trackpilot doesn't model, without baking those
    // shapes (or custom-field assumptions) into trackpilot.
    request,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api.mjs test/api-client.test.mjs
git commit -m "feat(api): expose low-level request() escape hatch"
```

---

### Task A5: Hand-written types + library entry point

**Files:**
- Create: `src/api.d.ts`.
- Modify: `package.json` (`exports`, `files`).

- [ ] **Step 1: Write `src/api.d.ts`**

Create `src/api.d.ts`:

```ts
export class AppError extends Error {}

export type FetchFn = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface CreateApiOptions {
  baseUrl: string;
  token: string;
  /** Defaults to globalThis.fetch. Inject a host fetch (e.g. Tauri) here. */
  fetch?: FetchFn;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

export interface ShapedIssue {
  id: string; // idReadable
  summary: string;
  description: string | null;
  project: string | null;
  state: string | null;
  type: string | null;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  tags: string[];
  links: { type: string | null; direction: string | null; id: string | null }[];
  customFields: Record<string, string | null>;
  url?: string;
}

export interface TrackpilotProject {
  id: string;
  shortName: string;
  name: string;
  archived: boolean;
}

export interface TrackpilotApi {
  request(method: string, path: string, opts?: RequestOptions): Promise<any>;
  me(): Promise<{ name: string | null; login: string | null }>;
  projects(): Promise<TrackpilotProject[]>;
  resolveProjectId(shortName: string): Promise<string>;
  readIssue(id: string): Promise<ShapedIssue & { comments: { author: string | null; text: string }[] }>;
  search(query: string, limit?: number): Promise<ShapedIssue[]>;
  createIssue(input: { project: string; summary: string; description?: string; customFields?: unknown[] }): Promise<string>;
  setCustomFields(id: string, customFields: unknown[]): Promise<void>;
  updateIssue(id: string, patch: { summary?: string; description?: string; state?: string }): Promise<ShapedIssue>;
  applyCommand(id: string, query: string): Promise<void>;
  addComment(id: string, text: string): Promise<{ id: string; comment: { author: string | null; text: string } }>;
  logWorkItem(id: string, item: { minutes: number; text?: string; date?: number }): Promise<any>;
  tags(): Promise<string[]>;
  users(): Promise<{ login: string; name: string; fullName: string }[]>;
  projectSchema(projectKey: string): Promise<{ name: string; type: string | null; values: string[] }[]>;
  assist(idReadable: string, query: string): Promise<{ description: string; error: boolean }[]>;
  applyCommands(idReadable: string, commands: { command: string }[]): Promise<void>;
  webUrl(idReadable: string): string;
}

export function createApi(options: CreateApiOptions): TrackpilotApi;
export function shapeIssue(issue: any): ShapedIssue;
export function shapeLinks(links: any[]): { type: string | null; direction: string | null; id: string | null }[];
export function shapeSchema(issue: any): { name: string; type: string | null; values: string[] }[];
export function fieldValue(cf: any): string | null;
export function renderOne(v: any): string | null;
```

- [ ] **Step 2: Add the library entry point to `package.json`**

In `package.json`, add an `exports` map (keep `bin` and `main`-less layout). Place `exports` right after `"bin"`:

```json
  "bin": "bin/trackpilot.mjs",
  "exports": {
    ".": {
      "types": "./src/api.d.ts",
      "import": "./src/api.mjs"
    }
  },
```

And add `src/api.d.ts` to the published files. Change:

```json
  "files": [
    "bin",
    "src",
    "README.md",
    "LICENSE"
  ],
```

`src` already covers `src/api.d.ts`, so no change is strictly required to `files` — but confirm `src` is listed (it is). No edit needed if `"src"` is present.

- [ ] **Step 3: Verify the package resolves as a library**

Run:
```bash
node -e "import('trackpilot').then(m => console.log(typeof m.createApi)).catch(e => { console.error(e); process.exit(1); })" 2>/dev/null \
  || node --input-type=module -e "import { createApi } from './src/api.mjs'; console.log(typeof createApi)"
```
Expected: prints `function`. (The first form needs the package linked/installed by name; the fallback always works from the repo root and proves the entry module loads.)

- [ ] **Step 4: Run the full test suite**

Run: `node --test`
Expected: PASS — all existing tests plus `test/api-client.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add src/api.d.ts package.json
git commit -m "feat(api): publish createApi as a typed library entry point"
```

---

### Task A6: Publish gate

- [ ] **Step 1: Confirm clean tree and full suite green**

Run: `git status -s && node --test`
Expected: clean tree, all tests PASS.

- [ ] **Step 2: Push to publish**

```bash
git push origin main
```
This triggers the conventional-commit CI, which bumps the version (≈ `0.3.0`, minor bump from the `feat:` commits) and publishes to npm.

- [ ] **Step 3: Record the actual published version**

Run (poll until it appears):
```bash
npm view trackpilot version
```
Expected: the new version string (e.g. `0.3.0`). **Use this exact version in Phase B, Task B3.** Do not assume `0.3.0` — read the real value.

---

# PHASE B — `@ylate/core` integration (monorepo)

> All Phase B commands run from `/home/javad/Downloads/youtrack-time-tracker-source`.
> The monorepo has **no test runner**; verification is `tsc` typecheck + `pnpm build` + manual smoke. Do not invent a test framework.

### Task B1: Local-link de-risk setup (temporary, not committed)

**Files:**
- Modify (temporarily): `packages/core/package.json` (local dependency), root `pnpm-lock.yaml` (regenerated). These changes are reverted in Task B3 before the integration commit.

- [ ] **Step 1: Add trackpilot as a local file dependency**

Edit `packages/core/package.json` to add a `dependencies` block (it currently has none) pointing at the local trackpilot checkout:

```json
  "dependencies": {
    "trackpilot": "link:../../../../Projects/youtrack-cli"
  },
```

Note: the path is relative to `packages/core/`. Verify it resolves to `/home/javad/Projects/youtrack-cli`:
Run: `node -e "console.log(require('path').resolve('packages/core', '../../../../Projects/youtrack-cli'))"`
Expected: `/home/javad/Projects/youtrack-cli`. If not, adjust the number of `../` segments until it does.

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: completes; `packages/core/node_modules/trackpilot` resolves to the local checkout.

- [ ] **Step 3: Confirm the typed entry resolves**

Run: `node --input-type=module -e "import { createApi } from 'trackpilot'; console.log(typeof createApi)"` from `packages/core/`:
```bash
cd packages/core && node --input-type=module -e "import { createApi } from 'trackpilot'; console.log(typeof createApi)"; cd ../..
```
Expected: prints `function`. (No commit in this task — it's scaffolding for B2.)

---

### Task B2: Rewrite `YouTrackClient` to delegate to trackpilot

**Files:**
- Modify: `packages/core/src/youtrackClient.ts` (replace the body; keep class + method signatures and `mapIssue`).

- [ ] **Step 1: Replace the file contents**

Overwrite `packages/core/src/youtrackClient.ts` with:

```ts
import type { Issue, BoardColumn, Project } from "./types";
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

export class YouTrackClient {
  private api: TrackpilotApi;

  constructor(
    private baseUrl: string,
    private token: string,
    fetchFn?: FetchFn
  ) {
    this.api = createApi({
      baseUrl,
      token,
      fetch: fetchFn as unknown as typeof fetch | undefined,
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
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      shortName: p.shortName,
    }));
  }

  /** Fetch issues for a project, optionally filtered to the current user. */
  async getIssues(
    projectId: string,
    myOnly: boolean,
    query = ""
  ): Promise<Issue[]> {
    const base = `project: {${projectId}}`;
    const filter = myOnly ? `${base} for: me` : base;
    const q = query ? `${filter} ${query}` : filter;
    const raw = await this.api.request("GET", "/issues", {
      query: { query: q, fields: ISSUE_FIELDS, $top: 100 },
    });
    return (raw as Record<string, unknown>[]).map((i) => mapIssue(i));
  }

  /** Fetch a single issue's current state. */
  async getIssue(issueId: string): Promise<Issue> {
    const raw = await this.api.request(
      "GET",
      `/issues/${encodeURIComponent(issueId)}`,
      { query: { fields: ISSUE_FIELDS } }
    );
    return mapIssue(raw as Record<string, unknown>);
  }

  /** Log spent time on an issue as a work item. */
  async logTime(
    issueId: string,
    minutes: number,
    description: string,
    date: number
  ): Promise<void> {
    await this.api.logWorkItem(issueId, { minutes, text: description, date });
  }

  /** Move an issue to a different state via the YouTrack command engine. */
  async moveIssue(issueId: string, stateName: string): Promise<void> {
    await this.api.applyCommand(issueId, `State ${stateName}`);
  }

  /** Project state field values, used as a fallback when no agile board is set up. */
  async getStates(projectId: string): Promise<string[]> {
    try {
      const raw = (await this.api.request(
        "GET",
        `/admin/projects/${encodeURIComponent(projectId)}/customFields`,
        { query: { fields: "field(name),bundle(values(name))", $top: 50 } }
      )) as Record<string, unknown>[];
      for (const cf of raw) {
        const field = cf.field as Record<string, unknown> | undefined;
        if (field?.name === "State") {
          const bundle = cf.bundle as Record<string, unknown> | undefined;
          const values = (bundle?.values as Record<string, unknown>[]) || [];
          return values.map((v) => String(v.name)).filter(Boolean);
        }
      }
    } catch {
      // ignore — falls through to the default list
    }
    return ["Open", "In Progress", "In Review", "Done"];
  }

  /**
   * Columns of an agile board associated with this project. Returns null when
   * the project isn't on a board the token can see — caller should fall back
   * to flat state values from `getStates()`.
   */
  async getBoardColumns(
    projectShortName: string
  ): Promise<BoardColumn[] | null> {
    try {
      const boards = (await this.api.request("GET", "/agiles", {
        query: {
          fields:
            "name,projects(shortName),columnSettings(columns(presentation,fieldValues(name)))",
          $top: 50,
        },
      })) as Record<string, unknown>[];

      const myBoard = boards.find((b) => {
        const projects = (b.projects as Record<string, unknown>[]) || [];
        return projects.some((p) => p.shortName === projectShortName);
      });
      if (!myBoard) return null;

      const cs = myBoard.columnSettings as Record<string, unknown> | undefined;
      const cols = (cs?.columns as Record<string, unknown>[]) || [];
      const out = cols
        .map((c) => {
          const fvs = (c.fieldValues as Record<string, unknown>[]) || [];
          return {
            presentation: String(c.presentation || ""),
            fieldValues: fvs.map((fv) => String(fv.name || "")).filter(Boolean),
          };
        })
        .filter((c) => c.presentation && c.fieldValues.length);

      return out.length ? out : null;
    } catch {
      return null;
    }
  }
}

function mapIssue(raw: Record<string, unknown>): Issue {
  const cfs = (raw.customFields as Record<string, unknown>[]) || [];
  let state: string | undefined;
  let spentTime: number | undefined;

  for (const cf of cfs) {
    const name = cf.name as string;
    const val = cf.value as Record<string, unknown> | null;
    if (name === "State" && val) state = val.name as string;
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

- [ ] **Step 2: Check that `index.ts` still exports the same surface**

The export in `packages/core/src/index.ts:26` is `export { YouTrackClient, type FetchFn } from "./youtrackClient";`. Both `YouTrackClient` and `FetchFn` are still declared above, so no change is needed.
Run: `grep -n "YouTrackClient\|FetchFn" packages/core/src/index.ts`
Expected: the existing export line is present and unchanged.

- [ ] **Step 3: Typecheck + build core against the local link**

Run: `pnpm --filter @ylate/core build`
Expected: PASS (`tsc -p ./` emits `dist/` with no type errors). If `createApi` / `TrackpilotApi` are reported as untyped or unresolved, re-check that `src/api.d.ts` exists in the linked checkout and that `exports.types` points to it.

- [ ] **Step 4: Full monorepo build against the local link**

Run: `pnpm build`
Expected: PASS — Turbo builds `@ylate/core`, then `@ylate/ui`, then `ylate` (esbuild bundles `trackpilot`'s `api.mjs` inline; no keyring import is pulled). Confirm no "Could not resolve 'trackpilot'" or keyring-related errors.

- [ ] **Step 5: Commit the source rewrite only (NOT the local link)**

Do not commit the `link:` dependency. Commit only the rewritten client:
```bash
git add packages/core/src/youtrackClient.ts
git commit -m "refactor(core): drive YouTrack through trackpilot's createApi"
```

---

### Task B3: Switch to the published npm version

**Files:**
- Modify: `packages/core/package.json` (replace the `link:` dep with the published version).
- Modify: root `pnpm-lock.yaml` (regenerated by install).

- [ ] **Step 1: Replace the local link with the published version**

Set the dependency to the **actual** version recorded in Phase A Task A6 Step 3 (shown here as `0.3.0` — substitute the real value):

```json
  "dependencies": {
    "trackpilot": "^0.3.0"
  },
```

- [ ] **Step 2: Reinstall against npm**

Run: `pnpm install`
Expected: resolves `trackpilot` from the npm registry (not the local path); `pnpm-lock.yaml` updates with the registry entry + `@napi-rs/keyring`.

- [ ] **Step 3: Rebuild end to end**

Run: `pnpm build`
Expected: PASS — same as Task B2 Step 4, now against the published package.

- [ ] **Step 4: Commit the dependency switch**

```bash
git add packages/core/package.json pnpm-lock.yaml
git commit -m "build(core): depend on published trackpilot@^0.3.0"
```

---

### Task B4: Package and manually verify (named-risk checks)

**Files:** none (verification only).

- [ ] **Step 1: Build the VS Code extension `.vsix`**

Run: `pnpm build && pnpm --filter ylate package`
Expected: produces `packages/vscode-ext/ylate-<version>.vsix` with no bundling errors. Confirm the bundle does not pull `@napi-rs/keyring`:
Run: `grep -c "napi-rs/keyring" packages/vscode-ext/dist/extension.js`
Expected: `0`.

- [ ] **Step 2: Install and smoke-test the extension against a real YouTrack instance**

```bash
code --install-extension packages/vscode-ext/ylate-*.vsix --force
```
Then in VS Code: open the panel, run configure (baseUrl + token), and confirm:
- The panel connects (proves `ping` → `me()`), and your display name / issue list loads (proves `getProjects` + `getIssues` through `request`).
- An issue row shows prior spent time (**named risk: spentTime must be numeric minutes**, not "1h 30m"). Confirm the running/elapsed math is sane, not wildly off — that proves `mapIssue` reads `value.minutes`.

- [ ] **Step 2b: Verify a state move (named risk: applyCommand vs field POST)**

In the panel, move an issue to a different state/column.
Expected: YouTrack reflects the new state. If it fails with a command-parse or permission error, that is the documented `applyCommand` risk. Fallback: change `moveIssue` to use the raw `request` field-POST instead — read the issue's `State` custom-field id via
`request("GET", "/issues/{id}", { query: { fields: "customFields(id,name)" } })`, then
`request("POST", "/issues/{id}/fields/{stateFieldId}", { query: { fields: "value(name)" }, body: { value: { name: stateName } } })`.
If you apply the fallback, re-run Steps 1–2b.

- [ ] **Step 2c: Verify Stop & Log writes time**

Start the timer on an issue, let it run ≥ 1 minute, Stop & Log. Confirm a work item appears in YouTrack's Spent time (proves `logTime` → `logWorkItem`). Sub-minute sessions are intentionally dropped — use ≥ 1 minute.

- [ ] **Step 3 (optional): Desktop (Tauri) smoke on Linux**

If a Tauri toolchain is available, run `pnpm --filter @ylate/desktop dev` and repeat connect + Stop & Log. This is the case that needs the **injected `tauriFetch`** — a successful connect (no "Load failed") proves the injectable-fetch wiring end to end. Skip if no Rust/Tauri deps; note it as unverified.

- [ ] **Step 4: Final commit (if any verification fix was applied)**

```bash
git add -A && git commit -m "fix(core): adjust trackpilot integration after manual verification"
```
If no fix was needed, skip — nothing to commit.

---

## Self-Review

**Spec coverage:**
- Library entry + types → A5. ✓
- Injectable fetch → A1. ✓
- `me()` → A2. ✓
- `logWorkItem()` → A3. ✓
- Raw `request` hatch → A4. ✓
- `node --test` for new public surface → A1–A4 (tests precede each impl). ✓
- Publish gate / record actual version → A6. ✓
- Phase B rewrite, signatures preserved → B2. ✓
- `trackpilot` dependency added → B1 (local), B3 (published). ✓
- Local-link de-risk → B1. ✓
- Named risk: numeric spentTime → B2 `mapIssue` (`value(minutes)` in `ISSUE_FIELDS`) + B4 Step 2. ✓
- Named risk: applyCommand vs field POST → B2 `moveIssue` + B4 Step 2b with documented fallback. ✓
- Named risk: Phase B unverifiable until publish → B1 local link + B4 post-publish smoke. ✓
- "Keep trackpilot general" → app never calls `createIssue`/`setCustomFields`; only reads/logs/moves; raw `request` keeps domain shapes in core. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/vague steps. The one substitution — the published version number — is explicitly flagged to read from `npm view` (A6 S3, B3 S1), which is correct (the value genuinely doesn't exist until publish).

**Type consistency:** `createApi`, `TrackpilotApi`, `request`, `me`, `logWorkItem`, `applyCommand`, `projects` are named identically in `src/api.d.ts` (A5), `src/api.mjs` (A1–A4), and `youtrackClient.ts` (B2). `Issue`/`Project`/`BoardColumn`/`FetchFn` match `packages/core/src/types.ts` and the preserved `index.ts` export. `ISSUE_FIELDS` includes `value(minutes)` so `mapIssue` reads numeric minutes consistently in `getIssues` and `getIssue`.
