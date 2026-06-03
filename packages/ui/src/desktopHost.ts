import {
  TimerCore,
  YouTrackClient,
  type AppConfig,
  type Issue,
  type Session,
  type SessionStorage,
  type UICommand,
} from "@ylate/core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  /** In-memory token, sourced from the OS keychain via the Rust `get_token`
   * command. Empty string when no token is set. Never persisted to a file. */
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

  // Token loading: prefer the OS keychain via the Rust `get_token` command,
  // fall back to the config file. The fallback exists because Linux Secret
  // Service / gnome-keyring can be unavailable for several reasons
  // (keyring locked, D-Bus session timing, headless / minimal installs,
  // AppImage running before the keyring daemon is up) — silently treating
  // those as "no token" would make the user re-enter on every launch.
  //
  // On save we always write to BOTH so the token survives whichever backend
  // happens to work on a given system. Plaintext token in tauri-plugin-store
  // is a security downgrade vs. keyring-only; document accordingly.
  const keyringToken =
    (await invoke<string | null>("get_token").catch(() => null)) ?? "";
  const fileToken = (await configStore.get<string>("token")) ?? "";

  const config: DesktopConfig = {
    baseUrl: (await configStore.get<string>("baseUrl")) ?? "",
    token: keyringToken || fileToken,
    projectId: (await configStore.get<string>("projectId")) ?? "",
    myIssuesOnly: (await configStore.get<boolean>("myIssuesOnly")) ?? true,
  };

  // Keep the two stores in sync: if one has a token and the other doesn't,
  // propagate so the next launch can read from either side.
  if (keyringToken && !fileToken) {
    await configStore.set("token", keyringToken);
    await configStore.save();
  } else if (fileToken && !keyringToken) {
    await invoke("set_token", { token: fileToken }).catch(() => {});
  }

  const storage = await TauriStoreSessionStorage.create(stateStore);
  const core = new TimerCore(storage);

  let client: YouTrackClient | null = null;
  let issues: Issue[] = [];
  let moveField = "State";
  let moveValues: string[] = [];
  let workItemTypes: string[] = [];
  let connected = false;
  let errorMsg = "";

  function sendInit(): void {
    transport.deliverToUI({
      type: "init",
      issues,
      moveField,
      moveValues,
      workItemTypes,
      session: core.session,
      elapsedMs: core.totalElapsedMs,
      connected,
      errorMsg,
      baseUrl: config.baseUrl,
    });
  }

  // Tray text only changes once per *minute* (we truncate to minutes), so
  // calling the Rust IPC every second is wasted work — on Linux it churns
  // GTK + libayatana-appindicator and contributes to occasional UI freezes.
  // Cache the last sent value and only invoke on change.
  let lastTrayText = "";
  function sendTimerUpdate(): void {
    transport.deliverToUI({
      type: "timerUpdate",
      session: core.session,
      elapsedMs: core.totalElapsedMs,
    });
    const text = formatTrayLine(core.session, core.displayMs);
    if (text !== lastTrayText) {
      lastTrayText = text;
      void invoke("set_tray_text", { text }).catch(() => {
        /* tray may not be ready yet */
      });
    }
  }

  core.onUpdate(sendTimerUpdate);
  core.onLogged(async (issueId) => {
    if (!client) return;
    try {
      const updated = await client.getIssue(issueId, moveField);
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
      // tauri-plugin-http's fetch runs through Rust → reqwest, sidestepping
      // the WebKit2GTK CORS policy that throws "TypeError: Load failed" on
      // Linux for cross-origin YouTrack requests.
      client = new YouTrackClient(config.baseUrl, config.token, tauriFetch);
      await client.ping();
      connected = true;
      errorMsg = "";
      core.setLogger(async ({ issueId, minutes, description, startedAt, type }) => {
        await client!.logTime(issueId, minutes, description, startedAt, type);
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
      const move = await client.getMoveOptions(config.projectId);
      moveField = move.field;
      moveValues = move.values;
      const [fetchedIssues, fetchedTypes] = await Promise.all([
        client.getIssues(config.projectId, config.myIssuesOnly, "", moveField),
        client.getWorkItemTypes(),
      ]);
      issues = fetchedIssues;
      workItemTypes = fetchedTypes;
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
          cmd.workItemType,
          prior
        );
        break;
      }
      case "startCustom":
        core.start(null, "", cmd.summary, cmd.workItemType, 0);
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
        // The React UI handles this itself in Tauri mode (switches view).
        // This branch is for completeness — VS Code never reaches here.
        transport.deliverToUI({ type: "showPreferences" });
        break;
      case "getConfig":
        transport.deliverToUI({
          type: "config",
          config: await snapshotConfig(),
        });
        break;
      case "saveConfig": {
        config.baseUrl = cmd.baseUrl;
        config.projectId = cmd.projectId;
        config.myIssuesOnly = cmd.myIssuesOnly;
        if (cmd.token !== undefined) {
          config.token = cmd.token;
          if (cmd.token === "") {
            // Wipe from both backends.
            await invoke("delete_token").catch(() => {});
            await configStore.set("token", null);
          } else {
            // Write to both backends — keyring is best-effort, file is
            // the fallback that always works.
            await invoke("set_token", { token: cmd.token }).catch(() => {});
            await configStore.set("token", cmd.token);
          }
        }
        await configStore.set("baseUrl", config.baseUrl);
        await configStore.set("projectId", config.projectId);
        await configStore.set("myIssuesOnly", config.myIssuesOnly);
        await configStore.save();
        await invoke("set_autostart", { enabled: cmd.autostart }).catch(() => {});

        await connect();
        if (connected) await refresh();
        sendInit();
        transport.deliverToUI({
          type: "config",
          config: await snapshotConfig(),
        });
        break;
      }
      case "move":
        if (!client) return;
        try {
          await client.moveIssue(cmd.issueId, moveField, cmd.value);
          const issue = issues.find((i) => i.id === cmd.issueId);
          if (issue) issue.state = cmd.value;
          sendInit();
        } catch (err) {
          errorMsg = `Failed to move issue: ${err}`;
          sendInit();
        }
        break;
      case "openExternal":
        if (cmd.url) {
          try {
            await openUrl(cmd.url);
          } catch {
            /* user's default handler will surface the error */
          }
        }
        break;
    }
  });

  async function snapshotConfig(): Promise<AppConfig> {
    const autostartEnabled =
      (await invoke<boolean>("is_autostart_enabled").catch(() => false)) ??
      false;
    return {
      baseUrl: config.baseUrl,
      projectId: config.projectId,
      myIssuesOnly: config.myIssuesOnly,
      hasToken: !!config.token,
      autostartEnabled,
    };
  }

  // Tray menu "Preferences" / open_preferences IPC → switch UI to prefs view.
  void listen("show-preferences", () => {
    transport.deliverToUI({ type: "showPreferences" });
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
