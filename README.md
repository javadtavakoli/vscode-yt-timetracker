# YouTrack Time Tracker

Track time on YouTrack issues directly from VS Code. Start, pause, resume, and stop a per-issue timer with an activity tag (Implementing / Investigating / Testing / Reviewing / Other), and the elapsed time is automatically logged back to YouTrack as a work item when you stop. The current task is always visible in the status bar.

## Features

- **Fetch issues** from your YouTrack project (filterable to your assignments)
- **Start / pause / resume / stop** timers per issue from the side panel or the command palette
- **Activity types**: Implementing, Investigating, Testing, Reviewing, Other
- **Auto-log** spent time back to YouTrack on stop (creates a work item with the elapsed minutes and your activity tag)
- **Move issues** between states/columns from the panel
- **Track custom tasks** (non-YouTrack work) — time is shown but not posted
- **Status bar** shows the current task and `Dd:Hh:MMm:SSs` elapsed, ticking every second (`1d` = 8 hours)
- **Survives reloads** — an active session is restored when you reopen VS Code

## Setup

1. Install the extension from the VS Code Marketplace.
2. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **YouTrack: Configure Connection**.
3. Enter:
   - **Base URL** — e.g. `https://yourcompany.youtrack.cloud`
   - **Permanent Token** — generate at *Profile → Account Security → Tokens* in YouTrack
   - **Project** — pick from the list, or enter the short name (e.g. `PROJ`)
   - **My issues only** — filter to issues assigned to you

The token needs `Read Issue`, `Update Issue`, and `Create Work Item` permissions.

## Usage

### Tracking a YouTrack issue

1. Open the **YouTrack Tracker** panel from the activity bar (clock icon).
2. Find the issue, choose an activity type, click **▶ Start**.
3. The status bar shows the running timer.
4. Click **⏸ Pause** to pause (status bar turns yellow); click again to resume.
5. Click **⏹ Stop & Log** — time is posted to YouTrack as a work item.

> Sessions shorter than one minute are not posted to YouTrack — the work item API rounds down to whole minutes.

### Moving issues between columns

Use the state dropdown on each issue card.

### Tracking a custom (non-YouTrack) task

Expand **+ Track custom task**, enter a name, pick an activity, click Start. Time is tracked locally but not posted anywhere.

### Command palette

| Command | Description |
|---|---|
| `YouTrack: Configure Connection` | Setup or reconfigure |
| `YouTrack: Refresh Tasks` | Reload issues |
| `YouTrack: Pause / Resume Timer` | Toggle pause |
| `YouTrack: Stop Timer` | Stop and log |
| `YouTrack: Track Custom Task` | Start a non-YouTrack task |
| `YouTrack: Open Tracker Panel` | Show the side panel |

## Settings

| Setting | Description |
|---|---|
| `youtrackTracker.baseUrl` | YouTrack base URL |
| `youtrackTracker.token` | YouTrack permanent token |
| `youtrackTracker.projectId` | YouTrack project short name |
| `youtrackTracker.myIssuesOnly` | Show only issues assigned to you |

## Time format

`Dd:Hh:MMm:SSs` — `1d` is 8 hours (a working day).

## License

[MIT](LICENSE) © 2026 Javad Tavakoli

## Issues / feedback

[Open an issue](https://github.com/javadtavakoli/vscode-yt-timetracker/issues) on GitHub.