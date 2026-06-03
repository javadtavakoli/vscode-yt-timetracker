import type { Session, LogParams, FrozenInfo } from "./types";
import type { SessionStorage } from "./storage";

export type UpdateListener = () => void;
export type LoggedListener = (issueId: string) => void;
export type FrozenListener = (info: FrozenInfo) => void;
export type LogErrorListener = (info: { issueId: string; error: unknown }) => void;
export type LoggerFn = (params: LogParams) => Promise<void>;

export interface Disposable {
  dispose(): void;
}

/**
 * Pure session/timer state machine. Knows about Session shape, persistence
 * adapter, and a YouTrack logger callback — nothing about UI, status bars,
 * or `setInterval`. Hosts own the 1-second ticker and call `tick()`.
 */
export class TimerCore {
  /** Number of `tick()` calls between checkpoints (writes to storage). At 1
   * tick / second that's a 60-second checkpoint interval — worst-case crash
   * loss is ~60 seconds. */
  static readonly CHECKPOINT_TICKS = 60;
  /** On restore, gaps shorter than this since `saved.startedAt` are credited
   * silently (crash / window reload). Longer gaps freeze at the last
   * checkpoint so an overnight close isn't counted as worked time. */
  static readonly RESTORE_GRACE_MS = 5 * 60 * 1000;

  private _session: Session | null = null;
  private tickCount = 0;
  private logger: LoggerFn | null = null;

  private updateListeners: UpdateListener[] = [];
  private loggedListeners: LoggedListener[] = [];
  private frozenListeners: FrozenListener[] = [];
  private logErrorListeners: LogErrorListener[] = [];

  constructor(private storage: SessionStorage) {}

  /** Read persisted state and apply smart-restore. Call after listeners are
   * registered (so onRestoreFrozen fires correctly). */
  restore(): void {
    const saved = this.storage.load();
    if (!saved) return;
    this._session = saved;

    if (!saved.paused) {
      const gap = Date.now() - saved.startedAt;
      if (gap > TimerCore.RESTORE_GRACE_MS) {
        this._session.paused = true;
        this._session.pausedAt = saved.startedAt;
        this.persist();
        const min = Math.round(gap / 60000);
        for (const l of this.frozenListeners) {
          l({ summary: saved.summary, gapMinutes: min });
        }
      }
      // else: small gap, leave startedAt — totalElapsedMs naturally credits it.
    }
    this.emitUpdate();
  }

  /** The current session (read-only snapshot). */
  get session(): Session | null {
    return this._session;
  }

  /** Total session time in ms (does NOT include prior YouTrack-logged time). */
  get totalElapsedMs(): number {
    if (!this._session) return 0;
    if (this._session.paused) return this._session.elapsed;
    return this._session.elapsed + (Date.now() - this._session.startedAt);
  }

  /** What to show on screen: prior YouTrack-logged time + current session. */
  get displayMs(): number {
    if (!this._session) return 0;
    const priorMs = (this._session.priorSpentMinutes || 0) * 60_000;
    return priorMs + this.totalElapsedMs;
  }

  start(
    issueId: string | null,
    issueReadable: string,
    summary: string,
    workItemType: string,
    priorSpentMinutes: number
  ): void {
    if (this._session) {
      // Auto-stop the previous session without logging it.
      this._session = null;
      this.persist();
    }
    this._session = {
      issueId,
      issueReadable,
      summary,
      workItemType,
      startedAt: Date.now(),
      elapsed: 0,
      paused: false,
      priorSpentMinutes,
    };
    this.tickCount = 0;
    this.persist();
    this.emitUpdate();
  }

  pause(): void {
    if (!this._session || this._session.paused) return;
    this._session.elapsed += Date.now() - this._session.startedAt;
    this._session.paused = true;
    this._session.pausedAt = Date.now();
    this.persist();
    this.emitUpdate();
  }

  resume(): void {
    if (!this._session || !this._session.paused) return;
    this._session.paused = false;
    this._session.startedAt = Date.now();
    delete this._session.pausedAt;
    this.tickCount = 0;
    this.persist();
    this.emitUpdate();
  }

  togglePause(): void {
    if (!this._session) return;
    if (this._session.paused) this.resume();
    else this.pause();
  }

  /**
   * End the current session. If `log` is true, has an issue id, a configured
   * logger, and ≥ 1 minute of elapsed time, the logger is invoked and
   * `onLogged` fires on success / `onLogError` fires on failure.
   */
  async stop(log: boolean = true): Promise<void> {
    if (!this._session) return;
    const sess = this._session;
    const ms = this.totalElapsedMs;
    const minutes = Math.floor(ms / 60_000);

    this._session = null;
    this.persist();
    this.emitUpdate();

    if (log && sess.issueId && this.logger && minutes >= 1) {
      try {
        await this.logger({
          issueId: sess.issueId,
          minutes,
          description: sess.summary,
          startedAt: sess.startedAt,
          type: sess.workItemType || undefined,
        });
        for (const l of this.loggedListeners) l(sess.issueId);
      } catch (err) {
        for (const l of this.logErrorListeners) {
          l({ issueId: sess.issueId, error: err });
        }
      }
    }
  }

  /** Host calls this once per second while running. */
  tick(): void {
    if (!this._session || this._session.paused) return;
    this.emitUpdate();
    if (++this.tickCount >= TimerCore.CHECKPOINT_TICKS) {
      this.tickCount = 0;
      this.checkpoint();
    }
  }

  setLogger(logger: LoggerFn | null): void {
    this.logger = logger;
  }

  onUpdate(handler: UpdateListener): Disposable {
    this.updateListeners.push(handler);
    return {
      dispose: () => {
        this.updateListeners = this.updateListeners.filter((l) => l !== handler);
      },
    };
  }

  onLogged(handler: LoggedListener): Disposable {
    this.loggedListeners.push(handler);
    return {
      dispose: () => {
        this.loggedListeners = this.loggedListeners.filter((l) => l !== handler);
      },
    };
  }

  onLogError(handler: LogErrorListener): Disposable {
    this.logErrorListeners.push(handler);
    return {
      dispose: () => {
        this.logErrorListeners = this.logErrorListeners.filter((l) => l !== handler);
      },
    };
  }

  onRestoreFrozen(handler: FrozenListener): Disposable {
    this.frozenListeners.push(handler);
    return {
      dispose: () => {
        this.frozenListeners = this.frozenListeners.filter((l) => l !== handler);
      },
    };
  }

  /** Roll segment time into `elapsed`, reset `startedAt`, persist. */
  private checkpoint(): void {
    if (!this._session || this._session.paused) return;
    const now = Date.now();
    this._session.elapsed += now - this._session.startedAt;
    this._session.startedAt = now;
    this.persist();
  }

  private persist(): void {
    this.storage.save(this._session);
  }

  private emitUpdate(): void {
    for (const l of this.updateListeners) l();
  }
}
