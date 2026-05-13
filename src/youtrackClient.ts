import * as https from "https";
import * as http from "http";
import { URL } from "url";

export interface YTIssue {
  id: string;
  idReadable: string;
  summary: string;
  description?: string;
  state?: string;
  assignee?: string;
  spentTime?: number; // minutes
  customFields?: YTCustomField[];
}

export interface YTCustomField {
  name: string;
  value: unknown;
  $type: string;
}

export interface YTBoard {
  id: string;
  name: string;
  columns: YTColumn[];
}

export interface YTColumn {
  id: string;
  name: string;
  issues: YTIssue[];
}

export interface YTProject {
  id: string;
  name: string;
  shortName: string;
}

function request(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const bodyStr = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            resolve({});
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export class YouTrackClient {
  constructor(private baseUrl: string, private token: string) {}

  private get<T>(path: string): Promise<T> {
    return request(this.baseUrl, this.token, "GET", path) as Promise<T>;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return request(this.baseUrl, this.token, "POST", path, body) as Promise<T>;
  }

  /** Verify connection */
  async ping(): Promise<string> {
    const me = await this.get<{ name: string; login: string }>(
      "api/users/me?fields=name,login"
    );
    return me.name || me.login;
  }

  /** List projects */
  async getProjects(): Promise<YTProject[]> {
    return this.get<YTProject[]>(
      "api/admin/projects?fields=id,name,shortName&$top=50"
    );
  }

  /** Fetch issues for a project, optionally filtered to current user */
  async getIssues(
    projectId: string,
    myOnly: boolean,
    query = ""
  ): Promise<YTIssue[]> {
    const base = `project: {${projectId}}`;
    const filter = myOnly ? `${base} for: me` : base;
    const q = query ? `${filter} ${query}` : filter;
    const enc = encodeURIComponent(q);
    const fields =
      "id,idReadable,summary,customFields(name,value(name,presentation,minutes),$type)";
    const raw = await this.get<Record<string, unknown>[]>(
      `api/issues?query=${enc}&fields=${fields}&$top=100`
    );
    return raw.map((i) => this.mapIssue(i));
  }

  /** Get issue details */
  async getIssue(issueId: string): Promise<YTIssue> {
    const fields =
      "id,idReadable,summary,customFields(name,value(name,presentation,minutes),$type)";
    const raw = await this.get<Record<string, unknown>>(
      `api/issues/${issueId}?fields=${fields}`
    );
    return this.mapIssue(raw);
  }

  /** Log spent time on an issue */
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

  /** Move issue to a different state */
  async moveIssue(issueId: string, stateName: string): Promise<void> {
    const fields =
      "id,idReadable,customFields(id,name,value(name))";
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

  /** Get available states for a project */
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
      // ignore
    }
    return ["Open", "In Progress", "In Review", "Done"];
  }

  private mapIssue(raw: Record<string, unknown>): YTIssue {
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
      customFields: cfs as unknown as YTCustomField[],
    };
  }
}
