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
    // Brace BOTH tokens: a multi-word field name (e.g. "Kanban State") would
    // otherwise be split on whitespace by the command parser.
    await this.api.applyCommand(issueId, `{${field}} {${value}}`);
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
