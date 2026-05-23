export type ActivityType =
  | "Implementing"
  | "Investigating"
  | "Testing"
  | "Reviewing"
  | "Other";

export interface Session {
  /** YouTrack internal issue id (e.g. "3-1234"), or null for a custom task. */
  issueId: string | null;
  /** Human-readable id like "PROJ-12", empty string for custom tasks. */
  issueReadable: string;
  summary: string;
  activity: ActivityType;
  /** Epoch ms when the current running segment started. Updated on resume and
   * on every checkpoint. */
  startedAt: number;
  /** ms accumulated in this session before the current segment. Combined with
   * `(now - startedAt)` to derive total session time while running. */
  elapsed: number;
  paused: boolean;
  pausedAt?: number;
  /** YouTrack-recorded spent time on this issue at the moment the session
   * started. The display = priorSpentMinutes (in ms) + session elapsed. */
  priorSpentMinutes: number;
}

export interface LogParams {
  issueId: string;
  minutes: number;
  description: string;
  startedAt: number;
}

export interface Issue {
  id: string;
  idReadable: string;
  summary: string;
  state?: string;
  /** Spent time in minutes as reported by YouTrack. */
  spentTime?: number;
}

export interface BoardColumn {
  /** Display name of the column on the agile board. */
  presentation: string;
  /** State field values that map to this column. When the user picks the
   * column we set the issue's state to `fieldValues[0]`. */
  fieldValues: string[];
}

export interface Project {
  id: string;
  name: string;
  shortName: string;
}

export interface FrozenInfo {
  summary: string;
  gapMinutes: number;
}

/* ───────────────────────────── Host ↔ UI messages ───────────────────────────
 * Both shells (VS Code webview + Tauri renderer) speak this protocol.
 * `HostMessage` flows host → UI, `UICommand` flows UI → host.
 * The transport is platform-specific (`vscode.postMessage` vs
 * `@tauri-apps/api` events) but the wire shape is shared.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Sanitized config snapshot — never carries the raw token. */
export interface AppConfig {
  baseUrl: string;
  projectId: string;
  myIssuesOnly: boolean;
  /** True when a token is stored (in the OS keychain on desktop); the value
   * itself is never sent to the UI. */
  hasToken: boolean;
  /** Whether the desktop app is registered to launch on login. Always false
   * on VS Code where this concept doesn't apply. */
  autostartEnabled: boolean;
}

export type HostMessage =
  | {
      type: "init";
      issues: Issue[];
      states: string[];
      boardColumns: BoardColumn[] | null;
      session: Session | null;
      elapsedMs: number;
      connected: boolean;
      errorMsg: string;
    }
  | {
      type: "timerUpdate";
      session: Session | null;
      elapsedMs: number;
    }
  | { type: "config"; config: AppConfig }
  | { type: "showPreferences" };

export type UICommand =
  | { cmd: "ready" }
  | {
      cmd: "start";
      issueId: string;
      issueReadable: string;
      summary: string;
      activity: ActivityType;
    }
  | { cmd: "startCustom"; summary: string; activity: ActivityType }
  | { cmd: "pauseResume" }
  | { cmd: "stop" }
  | { cmd: "refresh" }
  | { cmd: "configure" }
  | { cmd: "move"; issueId: string; state: string }
  | { cmd: "getConfig" }
  | {
      cmd: "saveConfig";
      baseUrl: string;
      /** Only present when the user changed the token field; if `undefined`
       * the host keeps the existing keychain value. Empty string clears it. */
      token: string | undefined;
      projectId: string;
      myIssuesOnly: boolean;
      autostart: boolean;
    };
