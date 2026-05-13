import * as vscode from "vscode";
import { YouTrackClient, YTIssue } from "./youtrackClient";
import { TimerManager, ActivityType } from "./timerManager";
import { getPanelHtml } from "./panelHtml";

let client: YouTrackClient | null = null;
let issues: YTIssue[] = [];
let states: string[] = [];
let boardColumns: { presentation: string; fieldValues: string[] }[] | null = null;
let timerManager: TimerManager;
let webviewView: vscode.WebviewView | undefined;
let connected = false;
let errorMsg = "";

export async function activate(context: vscode.ExtensionContext) {
  timerManager = new TimerManager(context);

  // Whenever timer state changes, push a lightweight message (NOT a full HTML replace)
  timerManager.onUpdate(() => sendState());

  context.subscriptions.push(
    vscode.commands.registerCommand("ylate.configure", runConfigure),
    vscode.commands.registerCommand("ylate.refreshTasks", refreshTasks),
    vscode.commands.registerCommand("ylate.pauseResume", () => timerManager.togglePause()),
    vscode.commands.registerCommand("ylate.stopTimer", () => timerManager.stopAndLog(true)),
    vscode.commands.registerCommand("ylate.startCustom", cmdStartCustom),
    vscode.commands.registerCommand("ylate.showPanel", () =>
      vscode.commands.executeCommand("workbench.view.extension.youtrack-tracker")
    ),
    vscode.commands.registerCommand("ylate.statusBarMenu", showStatusBarMenu)
  );

  // After a successful log, refresh that issue's spentTime so the next
  // Start of the same task picks up from the new accumulated total.
  timerManager.onLogged(async (issueId) => {
    if (!client) return;
    try {
      const updated = await client.getIssue(issueId);
      const idx = issues.findIndex((i) => i.id === issueId);
      if (idx >= 0) {
        issues[idx].spentTime = updated.spentTime;
        issues[idx].state = updated.state ?? issues[idx].state;
      }
      sendAll();
    } catch {
      // non-fatal
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "youtrackTasks",
      new TrackerWebviewProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  await tryConnect();
}

export function deactivate() {}

class TrackerWebviewProvider implements vscode.WebviewViewProvider {
  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    webviewView = view;
    view.webview.options = { enableScripts: true };

    // Set the static HTML shell ONCE - never replace it again
    view.webview.html = getPanelHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.cmd) {
        case "ready":
          // Webview signals it's ready - send all current state
          sendAll();
          break;
        case "start": {
          const issue = issues.find((i) => i.id === msg.issueId);
          const prior = issue?.spentTime ?? 0;
          timerManager.start(msg.issueId, msg.issueReadable, msg.summary, msg.activity as ActivityType, prior);
          break;
        }
        case "startCustom":
          timerManager.start(null, "", msg.summary, msg.activity as ActivityType, 0);
          break;
        case "pauseResume":
          timerManager.togglePause();
          break;
        case "stop":
          await timerManager.stopAndLog(true);
          break;
        case "refresh":
          await refreshTasks();
          break;
        case "configure":
          await runConfigure();
          break;
        case "move":
          await moveIssue(msg.issueId, msg.state);
          break;
      }
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) sendAll();
    });
  }
}

// Send full state: issues list + timer
function sendAll() {
  if (!webviewView) return;
  webviewView.webview.postMessage({
    type: "init",
    issues,
    states,
    boardColumns,
    session: timerManager.current,
    elapsedMs: timerManager.totalElapsedMs,
    connected,
    errorMsg,
  });
}

// Send only timer update - called on every tick/pause/resume
function sendState() {
  if (!webviewView) return;
  webviewView.webview.postMessage({
    type: "timerUpdate",
    session: timerManager.current,
    elapsedMs: timerManager.totalElapsedMs,
  });
}

async function tryConnect() {
  const cfg = vscode.workspace.getConfiguration("youtrackTracker");
  const baseUrl = cfg.get<string>("baseUrl", "");
  const token = cfg.get<string>("token", "");
  const projectId = cfg.get<string>("projectId", "");

  if (!baseUrl || !token) {
    connected = false;
    errorMsg = "";
    client = null;
    timerManager.setClient(null);
    sendAll();
    return;
  }

  try {
    client = new YouTrackClient(baseUrl, token);
    const name = await client.ping();
    connected = true;
    errorMsg = "";
    timerManager.setClient(client);
    vscode.window.showInformationMessage(`YouTrack: connected as ${name}`);
    if (projectId) await refreshTasks();
    else sendAll();
  } catch (err) {
    connected = false;
    errorMsg = `Connection failed: ${err}`;
    client = null;
    timerManager.setClient(null);
    sendAll();
  }
}

async function refreshTasks() {
  if (!client) { await tryConnect(); return; }
  const cfg = vscode.workspace.getConfiguration("youtrackTracker");
  const projectId = cfg.get<string>("projectId", "");
  const myOnly = cfg.get<boolean>("myIssuesOnly", true);

  if (!projectId) {
    errorMsg = "No project configured. Run 'Ylate: Configure Connection'.";
    sendAll();
    return;
  }

  try {
    const [fetchedIssues, fetchedStates, fetchedColumns] = await Promise.all([
      client.getIssues(projectId, myOnly),
      client.getStates(projectId),
      client.getBoardColumns(projectId),
    ]);
    issues = fetchedIssues;
    states = fetchedStates;
    boardColumns = fetchedColumns;
    errorMsg = "";
  } catch (err) {
    errorMsg = `Failed to load issues: ${err}`;
  }
  sendAll();
}

async function moveIssue(issueId: string, state: string) {
  if (!client) return;
  try {
    await client.moveIssue(issueId, state);
    const issue = issues.find((i) => i.id === issueId);
    if (issue) issue.state = state;
    vscode.window.showInformationMessage(`Moved issue to "${state}"`);
    sendAll();
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to move issue: ${err}`);
  }
}

async function runConfigure() {
  const cfg = vscode.workspace.getConfiguration("youtrackTracker");

  const baseUrl = await vscode.window.showInputBox({
    title: "YouTrack Base URL",
    prompt: "e.g. https://yourcompany.youtrack.cloud",
    value: cfg.get<string>("baseUrl", ""),
    ignoreFocusOut: true,
  });
  if (baseUrl === undefined) return;

  const token = await vscode.window.showInputBox({
    title: "YouTrack Permanent Token",
    prompt: "Generate at Profile → Account Security → Tokens",
    value: cfg.get<string>("token", ""),
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) return;

  let projectId = cfg.get<string>("projectId", "");
  try {
    const tmpClient = new YouTrackClient(baseUrl, token);
    const projects = await tmpClient.getProjects();
    const picks = projects.map((p) => ({ label: p.shortName, description: p.name, id: p.shortName }));
    const picked = await vscode.window.showQuickPick(picks, { title: "Select YouTrack Project", ignoreFocusOut: true });
    if (picked) projectId = picked.id;
  } catch {
    const manual = await vscode.window.showInputBox({
      title: "Project Short Name",
      prompt: "Could not fetch projects. Enter manually (e.g. PROJ)",
      value: projectId,
      ignoreFocusOut: true,
    });
    if (manual !== undefined) projectId = manual;
  }

  const myOnly = await vscode.window.showQuickPick(["Yes", "No"], {
    title: "Show only issues assigned to me?",
    ignoreFocusOut: true,
  });

  await cfg.update("baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
  await cfg.update("token", token, vscode.ConfigurationTarget.Global);
  await cfg.update("projectId", projectId, vscode.ConfigurationTarget.Global);
  await cfg.update("myIssuesOnly", myOnly !== "No", vscode.ConfigurationTarget.Global);

  await tryConnect();
}

async function cmdStartCustom() {
  const name = await vscode.window.showInputBox({
    title: "Custom Task Name",
    prompt: "What are you working on?",
  });
  if (!name) return;

  const actPick = await vscode.window.showQuickPick(
    ["Implementing", "Investigating", "Testing", "Reviewing", "Other"],
    { title: "Activity Type" }
  );
  if (!actPick) return;

  timerManager.start(null, "", name, actPick as ActivityType, 0);
}

async function showStatusBarMenu() {
  const session = timerManager.current;
  if (!session) {
    // No active timer — just open the panel
    vscode.commands.executeCommand("workbench.view.extension.youtrack-tracker");
    return;
  }

  const pauseLabel = session.paused ? "$(play) Resume" : "$(debug-pause) Pause";
  const items: vscode.QuickPickItem[] = [
    { label: pauseLabel },
    { label: "$(debug-stop) Stop & Log" },
    { label: "$(layout-sidebar-left) Open Panel" },
  ];

  const headerLabel = session.issueReadable || session.summary;
  const pick = await vscode.window.showQuickPick(items, {
    title: `${headerLabel} — ${session.activity}`,
    placeHolder: "What now?",
  });
  if (!pick) return;

  if (pick.label.includes("Resume") || pick.label.includes("Pause")) {
    timerManager.togglePause();
  } else if (pick.label.includes("Stop")) {
    await timerManager.stopAndLog(true);
  } else {
    vscode.commands.executeCommand("workbench.view.extension.youtrack-tracker");
  }
}
