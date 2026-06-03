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
