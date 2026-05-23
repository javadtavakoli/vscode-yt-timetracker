import {
  TimerCore,
  YouTrackClient,
  type ActivityType,
  type BoardColumn,
  type Issue,
  type Session,
  type SessionStorage,
  type UICommand,
} from "@ylate/core";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { getDesktopTransport } from "./api";

/**
 * Renderer-side host for the Tauri shell. Mirrors what extension.ts +
 * timerManager.ts do in the VS Code package, but lives in the same renderer
 * process as the React UI and communicates with it via an in-memory message
 * bus (so the React app's transport contract stays unchanged).
 *
 * Persistence lives in `~/.local/share/.../ylate-state.json` via
 * tauri-plugin-store. The YouTrack token + URL live in a separate config
 * store; the active session lives in the state store.
 *
 * YouTrack HTTP is **not** routed through Rust here — we use the global
 * fetch which works in Tauri's webview because the renderer is privileged.
 * If a host's webview blocks cross-origin fetches we can switch to a Rust
 * `youtrack_request` command without touching @ylate/core.
 */

const STATE_FILE = "state.json";
const CONFIG_FILE = "config.json";
const SESSION_KEY = "activeSession";

interface DesktopConfig {
  baseUrl: string;
  token: string;
  projectId: string;
  myIssuesOnly: boolean;
}

class TauriStoreSessionStorage implements SessionStorage {
  /** Cached value of the most recent saved session — keeps the contract sync. */
  private cached: Session | null = null;
  constructor(private store: Store) {}

  static async create(store: Store): Promise<TauriStoreSessionStorage> {
    const s = new TauriStoreSessionStorage(store);
    s.cached = (await store.get<Session>(SESSION_KEY)) ?? null;
    return s;
  }

  load(): Session | null {
    return this.cached;
  }
  save(session: Session | null): void {
    this.cached = session;
    // Fire-and-forget — the cached value above is authoritative for sync reads.
    void this.store
      .set(SESSION_KEY, session)
      .then(() => this.store.save())
      .catch(() => {
        /* TODO: surface as a renderer error */
      });
  }
}

export async function bootstrapDesktopHost(): Promise<void> {
  const transport = getDesktopTransport();
  const stateStore = await Store.load(STATE_FILE);
  const configStore = await Store.load(CONFIG_FILE);

  const config: DesktopConfig = {
    baseUrl: (await configStore.get<string>("baseUrl")) ?? "",
    token: (await configStore.get<string>("token")) ?? "",
    projectId: (await configStore.get<string>("projectId")) ?? "",
    myIssuesOnly: (await configStore.get<boolean>("myIssuesOnly")) ?? true,
  };

  const storage = await TauriStoreSessionStorage.create(stateStore);
  const core = new TimerCore(storage);

  let client: YouTrackClient | null = null;
  let issues: Issue[] = [];
  let states: string[] = [];
  let boardColumns: BoardColumn[] | null = null;
  let connected = false;
  let errorMsg = "";

  function sendInit(): void {
    transport.deliverToUI({
      type: "init",
      issues,
      states,
      boardColumns,
      session: core.session,
      elapsedMs: core.totalElapsedMs,
      connected,
      errorMsg,
    });
  }

  function sendTimerUpdate(): void {
    transport.deliverToUI({
      type: "timerUpdate",
      session: core.session,
      elapsedMs: core.totalElapsedMs,
    });
    void invoke("set_tray_text", { text: formatTrayLine(core.session, core.displayMs) })
      .catch(() => {/* tray may not be ready yet */});
  }

  core.onUpdate(sendTimerUpdate);
  core.onLogged(async (issueId) => {
    if (!client) return;
    try {
      const updated = await client.getIssue(issueId);
      const idx = issues.findIndex((i) => i.id === issueId);
      if (idx >= 0) {
        issues[idx].spentTime = updated.spentTime;
        issues[idx].state = updated.state ?? issues[idx].state;
      }
      sendInit();
    } catch {
      /* non-fatal */
    }
  });
  core.onLogError(({ error }) => {
    errorMsg = `Failed to log time: ${error}`;
    sendInit();
  });
  core.onRestoreFrozen(({ summary, gapMinutes }) => {
    errorMsg = `⏸ Paused "${summary}" — Ylate was away ~${gapMinutes}m; click resume to continue.`;
    sendInit();
  });

  async function connect(): Promise<void> {
    if (!config.baseUrl || !config.token) {
      connected = false;
      errorMsg = "";
      client = null;
      core.setLogger(null);
      return;
    }
    try {
      client = new YouTrackClient(config.baseUrl, config.token);
      await client.ping();
      connected = true;
      errorMsg = "";
      core.setLogger(async ({ issueId, minutes, description, startedAt }) => {
        await client!.logTime(issueId, minutes, description, startedAt);
      });
    } catch (err) {
      connected = false;
      errorMsg = `Connection failed: ${err}`;
      client = null;
      core.setLogger(null);
    }
  }

  async function refresh(): Promise<void> {
    if (!client) {
      await connect();
      return;
    }
    if (!config.projectId) {
      errorMsg = "No project configured. Open Preferences to set one.";
      return;
    }
    try {
      const [fetchedIssues, fetchedStates, fetchedColumns] = await Promise.all([
        client.getIssues(config.projectId, config.myIssuesOnly),
        client.getStates(config.projectId),
        client.getBoardColumns(config.projectId),
      ]);
      issues = fetchedIssues;
      states = fetchedStates;
      boardColumns = fetchedColumns;
      errorMsg = "";
    } catch (err) {
      errorMsg = `Failed to load issues: ${err}`;
    }
  }

  transport.onCommand(async (cmd: UICommand) => {
    switch (cmd.cmd) {
      case "ready":
        await connect();
        if (connected) await refresh();
        sendInit();
        break;
      case "start": {
        const issue = issues.find((i) => i.id === cmd.issueId);
        const prior = issue?.spentTime ?? 0;
        core.start(
          cmd.issueId,
          cmd.issueReadable,
          cmd.summary,
          cmd.activity as ActivityType,
          prior
        );
        break;
      }
      case "startCustom":
        core.start(null, "", cmd.summary, cmd.activity as ActivityType, 0);
        break;
      case "pauseResume":
        core.togglePause();
        break;
      case "stop":
        await core.stop(true);
        break;
      case "refresh":
        await refresh();
        sendInit();
        break;
      case "configure":
        // Surface the configure event to Rust so it can open the Preferences
        // window. The Rust side reads/writes the config store and emits a
        // `config-changed` event we'll listen for in a follow-up.
        await invoke("open_preferences").catch(() => {
          errorMsg = "Preferences window is not wired up yet.";
          sendInit();
        });
        break;
      case "move":
        if (!client) return;
        try {
          await client.moveIssue(cmd.issueId, cmd.state);
          const issue = issues.find((i) => i.id === cmd.issueId);
          if (issue) issue.state = cmd.state;
          sendInit();
        } catch (err) {
          errorMsg = `Failed to move issue: ${err}`;
          sendInit();
        }
        break;
    }
  });

  // 1-second ticker drives TimerCore checkpoint policy (every 60 ticks)
  setInterval(() => core.tick(), 1000);

  core.restore();
  sendInit();
}

function formatTrayLine(session: Session | null, displayMs: number): string {
  if (!session) return "Ylate";
  const totalSecs = Math.floor(displayMs / 1000);
  const days = Math.floor(totalSecs / 28800);
  const rem = totalSecs % 28800;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const time =
    (days ? days + "d:" : "") +
    h +
    "h:" +
    String(m).padStart(2, "0") +
    "m";
  const label = session.issueReadable || session.summary.slice(0, 20);
  return `${label} ${time}${session.paused ? " (paused)" : ""}`;
}
