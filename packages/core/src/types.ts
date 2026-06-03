export interface Session {
  /** YouTrack internal issue id (e.g. "3-1234"), or null for a custom task. */
  issueId: string | null;
  /** Human-readable id like "PROJ-12", empty string for custom tasks. */
  issueReadable: string;
  summary: string;
  /** Selected work-item type NAME (from the instance), "" if none. */
  workItemType: string;
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
  /** Work-item type NAME, if one was selected. */
  type?: string;
}

export interface Issue {
  id: string;
  idReadable: string;
  summary: string;
  /** Current value of the board's move field (e.g. the State/Stage value). */
  state?: string;
  /** Spent time in minutes as reported by YouTrack. */
  spentTime?: number;
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
      moveField: string;
      moveValues: string[];
      workItemTypes: string[];
      session: Session | null;
      elapsedMs: number;
      connected: boolean;
      errorMsg: string;
      /** YouTrack base URL — used by the UI to build per-issue deep links. */
      baseUrl: string;
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
      workItemType: string;
    }
  | { cmd: "startCustom"; summary: string; workItemType: string }
  | { cmd: "pauseResume" }
  | { cmd: "stop" }
  | { cmd: "refresh" }
  | { cmd: "configure" }
  | { cmd: "move"; issueId: string; value: string }
  | { cmd: "openExternal"; url: string }
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
