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
