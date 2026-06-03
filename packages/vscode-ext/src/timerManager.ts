import * as vscode from "vscode";
import {
  TimerCore,
  YouTrackClient,
  formatDhms,
  formatDuration,
  type Session,
} from "@ylate/core";
import { WorkspaceStateStorage } from "./storage";

/**
 * VS Code-specific shell around `TimerCore`. Owns:
 *   - the StatusBarItem (driven by core updates)
 *   - the 1-second ticker (drives `core.tick()`)
 *   - the workspaceState storage adapter
 *   - toast messages on log success / failure / restore-freeze
 *
 * Public surface is kept compatible with the pre-Phase-1 TimerManager so
 * `extension.ts` doesn't need to know that the state machine moved.
 */
export class TimerManager {
  private core: TimerCore;
  private statusBar: vscode.StatusBarItem;
  private ticker: NodeJS.Timeout | undefined;
  private loggedListeners: ((issueId: string) => void)[] = [];

  constructor(context: vscode.ExtensionContext) {
    const storage = new WorkspaceStateStorage(context.workspaceState);
    this.core = new TimerCore(storage);

    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBar.command = "ylate.statusBarMenu";
    context.subscriptions.push(this.statusBar);

    // Drive the status bar off the core's update stream.
    this.core.onUpdate(() => this.updateStatusBar());

    // Surface the long-gap-on-restore freeze as a toast.
    this.core.onRestoreFrozen(({ summary, gapMinutes }) => {
      vscode.window.showInformationMessage(
        `⏸ Paused "${summary}" — VS Code was away ~${gapMinutes}m; click the status bar to resume.`
      );
    });

    // Re-emit `onLogged` so extension.ts can refresh the issue list when a
    // work item posts. Issue-list refresh isn't core's job.
    this.core.onLogged((issueId) => {
      for (const l of this.loggedListeners) l(issueId);
    });

    // Show the YouTrack error to the user when the work item POST fails.
    this.core.onLogError(({ error }) => {
      vscode.window.showErrorMessage(`Failed to log time: ${error}`);
    });

    this.core.restore();
    this.startTicker();
  }

  /** Bind a YouTrack client so `stop(true)` actually posts work items. */
  setClient(client: YouTrackClient | null) {
    if (client) {
      this.core.setLogger(async ({ issueId, minutes, description, startedAt, type }) => {
        await client.logTime(issueId, minutes, description, startedAt, type);
      });
    } else {
      this.core.setLogger(null);
    }
  }

  get current(): Session | null {
    return this.core.session;
  }

  get totalElapsedMs(): number {
    return this.core.totalElapsedMs;
  }

  start(
    issueId: string | null,
    issueReadable: string,
    summary: string,
    workItemType: string,
    priorSpentMinutes: number
  ): void {
    this.core.start(issueId, issueReadable, summary, workItemType, priorSpentMinutes);
  }

  pause(): void {
    this.core.pause();
  }

  resume(): void {
    this.core.resume();
  }

  togglePause(): void {
    this.core.togglePause();
  }

  /**
   * End the active session and (optionally) post a work item. Shows a toast
   * describing what happened — success on a YouTrack issue, the elapsed-time
   * confirmation on a custom task, or no toast at all when `log` is false
   * (auto-stop on Start).
   */
  async stopAndLog(log = true): Promise<void> {
    const sess = this.core.session;
    if (!sess) return;

    const ms = this.core.totalElapsedMs;
    const wasIssue = !!sess.issueId;
    const issueReadable = sess.issueReadable;
    const workItemType = sess.workItemType;
    const summary = sess.summary;

    await this.core.stop(log);

    if (log && wasIssue && ms >= 60_000) {
      vscode.window.showInformationMessage(
        `✅ Logged ${formatDuration(ms)} on ${issueReadable}${workItemType ? ` (${workItemType})` : ""}`
      );
    } else if (log && !wasIssue) {
      vscode.window.showInformationMessage(
        `⏱ Custom task "${summary}" stopped after ${formatDuration(ms)}`
      );
    }
  }

  onUpdate(handler: () => void): vscode.Disposable {
    const disp = this.core.onUpdate(handler);
    return new vscode.Disposable(() => disp.dispose());
  }

  onLogged(handler: (issueId: string) => void): vscode.Disposable {
    this.loggedListeners.push(handler);
    return new vscode.Disposable(() => {
      this.loggedListeners = this.loggedListeners.filter((l) => l !== handler);
    });
  }

  private startTicker(): void {
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.core.tick(), 1000);
  }

  private updateStatusBar(): void {
    const sess = this.core.session;
    if (!sess) {
      this.statusBar.hide();
      return;
    }
    const ms = this.core.displayMs;
    const paused = sess.paused;
    const label = sess.issueReadable || sess.summary.slice(0, 20);
    const icon = paused ? "$(debug-pause)" : "$(clock)";
    this.statusBar.text = `${icon} ${label}  ${formatDhms(ms)}${paused ? "  PAUSED" : ""}`;
    this.statusBar.tooltip = `${sess.summary}${sess.workItemType ? `\n${sess.workItemType}` : ""}\nClick for actions`;
    this.statusBar.backgroundColor = paused
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.statusBar.show();
  }
}
