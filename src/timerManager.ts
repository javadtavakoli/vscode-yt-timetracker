import * as vscode from "vscode";
import { YouTrackClient } from "./youtrackClient";

export type ActivityType =
  | "Implementing"
  | "Investigating"
  | "Testing"
  | "Reviewing"
  | "Other";

export interface ActiveSession {
  issueId: string | null; // null = custom task
  issueReadable: string;
  summary: string;
  activity: ActivityType;
  startedAt: number; // epoch ms
  elapsed: number;   // ms accumulated before current start
  paused: boolean;
  pausedAt?: number;
  priorSpentMinutes: number; // YouTrack-recorded spent time when this session started; display = priorSpent + session elapsed
}

type SessionListener = (session: ActiveSession | null) => void;
type LoggedListener = (issueId: string) => void;

export class TimerManager {
  // While a timer runs, every N ticks we roll the segment into `elapsed` and
  // persist. Worst-case data loss on a hard crash is ~CHECKPOINT_TICKS seconds.
  private static readonly CHECKPOINT_TICKS = 60;
  // On restore, gaps shorter than this are credited silently (assume crash /
  // window reload). Longer gaps freeze at the last checkpoint so an overnight
  // close doesn't get counted as worked time.
  private static readonly RESTORE_GRACE_MS = 5 * 60 * 1000;

  private session: ActiveSession | null = null;
  private ticker: NodeJS.Timeout | undefined;
  private ticksSinceCheckpoint = 0;
  private listeners: SessionListener[] = [];
  private loggedListeners: LoggedListener[] = [];
  private statusBar: vscode.StatusBarItem;
  private client: YouTrackClient | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBar.command = "ylate.statusBarMenu";
    context.subscriptions.push(this.statusBar);

    // Restore persisted session
    const saved = context.workspaceState.get<ActiveSession>("activeSession");
    if (saved) {
      this.session = saved;
      if (!saved.paused) {
        const gap = Date.now() - saved.startedAt;
        if (gap > TimerManager.RESTORE_GRACE_MS) {
          // Long downtime — freeze at the last checkpoint. User can resume
          // manually if they were actually working through it.
          this.session.paused = true;
          this.session.pausedAt = saved.startedAt;
          this.persist();
          const min = Math.round(gap / 60000);
          vscode.window.showInformationMessage(
            `⏸ Paused "${saved.summary}" — VS Code was away ~${min}m; click the status bar to resume.`
          );
        }
        // else: small gap, leave startedAt — totalElapsedMs naturally credits it.
      }
      this.updateStatusBar();
      this.startTicker();
    }
  }

  setClient(client: YouTrackClient | null) {
    this.client = client;
  }

  onUpdate(fn: SessionListener): vscode.Disposable {
    this.listeners.push(fn);
    return new vscode.Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    });
  }

  onLogged(fn: LoggedListener): vscode.Disposable {
    this.loggedListeners.push(fn);
    return new vscode.Disposable(() => {
      this.loggedListeners = this.loggedListeners.filter((l) => l !== fn);
    });
  }

  private emit() {
    for (const l of this.listeners) l(this.session);
  }

  private fireLogged(issueId: string) {
    for (const l of this.loggedListeners) l(issueId);
  }

  /** Total ms to display: prior YouTrack-logged time + current session elapsed. */
  get totalDisplayMs(): number {
    if (!this.session) return 0;
    const priorMs = (this.session.priorSpentMinutes || 0) * 60_000;
    return priorMs + this.totalElapsedMs;
  }

  get current(): ActiveSession | null {
    return this.session;
  }

  get totalElapsedMs(): number {
    if (!this.session) return 0;
    if (this.session.paused) return this.session.elapsed;
    return this.session.elapsed + (Date.now() - this.session.startedAt);
  }

  start(
    issueId: string | null,
    issueReadable: string,
    summary: string,
    activity: ActivityType,
    priorSpentMinutes: number
  ) {
    // Auto-stop previous
    if (this.session) this.stopAndLog(false);

    this.session = {
      issueId,
      issueReadable,
      summary,
      activity,
      startedAt: Date.now(),
      elapsed: 0,
      paused: false,
      priorSpentMinutes,
    };
    this.persist();
    this.updateStatusBar();
    this.startTicker();
    this.emit();
  }

  pause() {
    if (!this.session || this.session.paused) return;
    this.session.elapsed += Date.now() - this.session.startedAt;
    this.session.paused = true;
    this.session.pausedAt = Date.now();
    this.persist();
    this.updateStatusBar();
    this.emit();
  }

  resume() {
    if (!this.session || !this.session.paused) return;
    this.session.paused = false;
    this.session.startedAt = Date.now();
    delete this.session.pausedAt;
    this.persist();
    this.updateStatusBar();
    this.emit();
    this.startTicker();
  }

  togglePause() {
    if (!this.session) return;
    if (this.session.paused) this.resume();
    else this.pause();
  }

  async stopAndLog(log = true) {
    if (!this.session) return;
    clearInterval(this.ticker);
    this.ticker = undefined;

    const ms = this.totalElapsedMs;
    const minutes = Math.floor(ms / 60000);
    const sess = this.session;
    this.session = null;
    this.context.workspaceState.update("activeSession", undefined);
    this.emit();
    this.statusBar.hide();

    if (log && sess.issueId && this.client && minutes >= 1) {
      try {
        await this.client.logTime(
          sess.issueId,
          minutes,
          `[${sess.activity}] ${sess.summary}`,
          sess.startedAt
        );
        vscode.window.showInformationMessage(
          `✅ Logged ${formatDuration(ms)} on ${sess.issueReadable} (${sess.activity})`
        );
        this.fireLogged(sess.issueId);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to log time: ${err}`);
      }
    } else if (log && !sess.issueId) {
      vscode.window.showInformationMessage(
        `⏱ Custom task "${sess.summary}" stopped after ${formatDuration(ms)}`
      );
    }
  }

  private startTicker() {
    clearInterval(this.ticker);
    this.ticksSinceCheckpoint = 0;
    this.ticker = setInterval(() => {
      if (this.session && !this.session.paused) {
        this.updateStatusBar();
        if (++this.ticksSinceCheckpoint >= TimerManager.CHECKPOINT_TICKS) {
          this.ticksSinceCheckpoint = 0;
          this.checkpoint();
        }
      }
    }, 1000);
  }

  /**
   * Roll the current running segment's elapsed time into `session.elapsed`,
   * reset `startedAt` to now, and persist. After this, the persisted state
   * accurately reflects all worked time up to this moment — so a crash
   * before the next checkpoint loses at most CHECKPOINT_TICKS seconds.
   */
  private checkpoint() {
    if (!this.session || this.session.paused) return;
    const now = Date.now();
    this.session.elapsed += now - this.session.startedAt;
    this.session.startedAt = now;
    this.persist();
  }

  private updateStatusBar() {
    if (!this.session) {
      this.statusBar.hide();
      return;
    }
    const ms = this.totalDisplayMs;
    const paused = this.session.paused;
    const label = this.session.issueReadable || this.session.summary.slice(0, 20);
    const icon = paused ? "$(debug-pause)" : "$(clock)";
    this.statusBar.text = `${icon} ${label}  ${formatDhms(ms)}${paused ? "  PAUSED" : ""}`;
    this.statusBar.tooltip = `${this.session.summary}\n${this.session.activity}\nClick for actions`;
    this.statusBar.backgroundColor = paused
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.statusBar.show();
  }

  private persist() {
    this.context.workspaceState.update("activeSession", this.session);
  }
}

export function formatDhms(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const days = Math.floor(totalSecs / 28800); // 8h day
  const rem = totalSecs % 28800;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  parts.push(`${h}h`);
  parts.push(`${String(m).padStart(2, "0")}m`);
  parts.push(`${String(s).padStart(2, "0")}s`);
  return parts.join(":");
}

export function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
