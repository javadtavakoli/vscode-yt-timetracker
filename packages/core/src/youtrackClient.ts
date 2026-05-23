import type { Issue, BoardColumn, Project } from "./types";

async function request(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

export class YouTrackClient {
  constructor(private baseUrl: string, private token: string) {}

  private get<T>(path: string): Promise<T> {
    return request(this.baseUrl, this.token, "GET", path) as Promise<T>;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return request(this.baseUrl, this.token, "POST", path, body) as Promise<T>;
  }

  /** Verify connection and return the authenticated user's display name. */
  async ping(): Promise<string> {
    const me = await this.get<{ name: string; login: string }>(
      "api/users/me?fields=name,login"
    );
    return me.name || me.login;
  }

  /** List projects available to the current user. */
  async getProjects(): Promise<Project[]> {
    return this.get<Project[]>(
      "api/admin/projects?fields=id,name,shortName&$top=50"
    );
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
    const enc = encodeURIComponent(q);
    const fields =
      "id,idReadable,summary,customFields(name,value(name,presentation,minutes),$type)";
    const raw = await this.get<Record<string, unknown>[]>(
      `api/issues?query=${enc}&fields=${fields}&$top=100`
    );
    return raw.map((i) => mapIssue(i));
  }

  /** Fetch a single issue's current state. */
  async getIssue(issueId: string): Promise<Issue> {
    const fields =
      "id,idReadable,summary,customFields(name,value(name,presentation,minutes),$type)";
    const raw = await this.get<Record<string, unknown>>(
      `api/issues/${issueId}?fields=${fields}`
    );
    return mapIssue(raw);
  }

  /** Log spent time on an issue as a work item. */
  async logTime(
    issueId: string,
    minutes: number,
    description: string,
    date: number
  ): Promise<void> {
    await this.post(`api/issues/${issueId}/timeTracking/workItems`, {
      date,
      duration: { minutes },
      text: description,
      usesMarkdown: false,
    });
  }

  /** Move an issue to a different state (e.g. between agile columns). */
  async moveIssue(issueId: string, stateName: string): Promise<void> {
    const fields = "id,idReadable,customFields(id,name,value(name))";
    const issue = await this.get<Record<string, unknown>>(
      `api/issues/${issueId}?fields=${fields}`
    );
    const cfs = (issue.customFields as Record<string, unknown>[]) || [];
    const stateField = cfs.find(
      (f) => (f as Record<string, unknown>).name === "State"
    ) as Record<string, unknown> | undefined;

    if (!stateField) {
      throw new Error("No State field found on issue");
    }

    await this.post(
      `api/issues/${issueId}/fields/${stateField.id}?fields=value(name)`,
      { value: { name: stateName } }
    );
  }

  /** Project state field values, used as a fallback when no agile board is set up. */
  async getStates(projectId: string): Promise<string[]> {
    try {
      const raw = await this.get<Record<string, unknown>[]>(
        `api/admin/projects/${projectId}/customFields?fields=field(name),bundle(values(name))&$top=50`
      );
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
      const fields =
        "name,projects(shortName),columnSettings(columns(presentation,fieldValues(name)))";
      const boards = await this.get<Record<string, unknown>[]>(
        `api/agiles?fields=${fields}&$top=50`
      );

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
