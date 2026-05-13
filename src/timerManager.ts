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
}

type SessionListener = (session: ActiveSession | null) => void;

export class TimerManager {
  private session: ActiveSession | null = null;
  private ticker: NodeJS.Timeout | undefined;
  private listeners: SessionListener[] = [];
  private statusBar: vscode.StatusBarItem;
  private client: YouTrackClient | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBar.command = "youtrack.showPanel";
    context.subscriptions.push(this.statusBar);

    // Restore persisted session
    const saved = context.workspaceState.get<ActiveSession>("activeSession");
    if (saved) {
      this.session = saved;
      if (!saved.paused) {
        // adjust startedAt so elapsed calc is correct
        this.session!.startedAt = Date.now();
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

  private emit() {
    for (const l of this.listeners) l(this.session);
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
    activity: ActivityType
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
    this.ticker = setInterval(() => {
      if (!this.session?.paused) {
        this.updateStatusBar();
      }
    }, 1000);
  }

  private updateStatusBar() {
    if (!this.session) {
      this.statusBar.hide();
      return;
    }
    const ms = this.totalElapsedMs;
    const paused = this.session.paused;
    const label = this.session.issueReadable || this.session.summary.slice(0, 20);
    const icon = paused ? "$(debug-pause)" : "$(clock)";
    this.statusBar.text = `${icon} ${label}  ${formatDhms(ms)}${paused ? "  PAUSED" : ""}`;
    this.statusBar.tooltip = `${this.session.summary}\n${this.session.activity}\nClick to open tracker`;
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
