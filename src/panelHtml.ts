import * as vscode from "vscode";

// Returns a STATIC shell. All data is pushed via postMessage after "ready".
export function getPanelHtml(webview: vscode.Webview): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ylate</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@300;400;500;600&display=swap');

  :root {
    --bg: #0d0f14;
    --surface: #13161e;
    --surface2: #1a1f2e;
    --border: #252a3a;
    --accent: #4f8ef7;
    --accent2: #7c5cf6;
    --green: #2dd4a0;
    --yellow: #f5c842;
    --red: #f2545b;
    --text: #e8eaf0;
    --muted: #6b7591;
    --radius: 8px;
    font-family: 'Inter', sans-serif;
    font-size: 13px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); min-height: 100vh; padding: 12px; line-height: 1.5; }

  .header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .header-title { font-size: 13px; font-weight: 600; color: var(--accent); letter-spacing: 0.5px; }
  .header-status { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--red); }
  .dot.ok { background: var(--green); }
  .status-text { font-size: 11px; color: var(--muted); }

  .timer-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; margin-bottom: 12px; position: relative; overflow: hidden; }
  .timer-card.active { border-color: var(--accent); }
  .timer-card.paused { border-color: var(--yellow); }
  .timer-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, var(--accent), var(--accent2)); opacity: 0; transition: opacity .3s; }
  .timer-card.active::before { opacity: 1; }
  .timer-card.paused::before { background: var(--yellow); opacity: 1; }

  .timer-idle { text-align: center; padding: 8px 0; color: var(--muted); font-size: 12px; }
  .timer-label { font-size: 10px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  .timer-issue { font-weight: 600; font-size: 13px; color: var(--accent); margin-bottom: 2px; }
  .timer-summary { color: var(--text); margin-bottom: 8px; font-size: 12px; }
  .timer-activity { display: inline-block; padding: 2px 8px; background: #7c5cf622; color: var(--accent2); border-radius: 20px; font-size: 11px; font-weight: 500; margin-bottom: 10px; }
  .timer-display { font-family: 'JetBrains Mono', monospace; font-size: 26px; font-weight: 700; color: var(--text); letter-spacing: 2px; margin-bottom: 12px; }
  .timer-display.paused { color: var(--yellow); }
  .timer-btns { display: flex; gap: 6px; }

  button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border: none; border-radius: 5px; font-family: 'Inter', sans-serif; font-size: 11px; font-weight: 500; cursor: pointer; transition: all .15s; outline: none; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: #6fa3ff; }
  .btn-ghost { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent); }
  .btn-danger { background: #f2545b22; color: var(--red); border: 1px solid #f2545b44; }
  .btn-danger:hover { background: #f2545b44; }
  .btn-sm { padding: 3px 7px; font-size: 10px; }

  .section-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .section-count { background: var(--surface2); padding: 1px 6px; border-radius: 20px; }

  .custom-form { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; margin-bottom: 12px; }
  input, select { width: 100%; padding: 6px 9px; background: var(--bg); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-family: 'Inter', sans-serif; font-size: 12px; outline: none; transition: border-color .15s; margin-bottom: 6px; }
  input:focus, select:focus { border-color: var(--accent); }
  input::placeholder { color: var(--muted); }
  select option { background: var(--surface2); }

  .issues-list { display: flex; flex-direction: column; gap: 6px; }
  .issue-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; transition: border-color .15s; }
  .issue-card:hover { border-color: #4f8ef766; }
  .issue-card.running { border-color: var(--green); }
  .issue-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .issue-id { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600; color: var(--accent); }
  .issue-state-badge { font-size: 10px; padding: 1px 7px; border-radius: 20px; background: var(--surface2); color: var(--muted); margin-left: auto; }
  .issue-summary { font-size: 12px; color: var(--text); margin-bottom: 6px; line-height: 1.4; }
  .issue-spent { font-size: 10px; color: var(--muted); margin-bottom: 6px; }
  .issue-actions { display: flex; gap: 5px; flex-wrap: wrap; }
  .activity-select { width: auto; padding: 3px 7px; font-size: 10px; flex: 1; min-width: 110px; margin-bottom: 0; }
  .state-select { width: auto; padding: 3px 7px; font-size: 10px; flex: 1; min-width: 90px; margin-bottom: 0; }

  .filter-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .filter-row input { flex: 1; margin-bottom: 0; }

  .error-banner { background: #f2545b22; border: 1px solid #f2545b44; border-radius: var(--radius); padding: 8px 12px; font-size: 11px; color: var(--red); margin-bottom: 10px; display: none; }
  .error-banner.show { display: block; }

  .badge-running { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--green); }
  .pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.8)} }
  .empty-state { text-align: center; padding: 24px; color: var(--muted); font-size: 12px; }
  details summary { cursor: pointer; user-select: none; }
  details summary::-webkit-details-marker { display: none; }
</style>
</head>
<body>

<div class="header">
  <span class="header-title">⏱ Ylate</span>
  <div class="header-status">
    <div class="dot" id="connDot"></div>
    <span class="status-text" id="connText">connecting…</span>
    <button class="btn-ghost btn-sm" onclick="refresh()">↻</button>
    <button class="btn-ghost btn-sm" onclick="configure()">⚙</button>
  </div>
</div>

<div class="error-banner" id="errorBanner"></div>

<!-- Active Timer -->
<div class="timer-card" id="timerCard">
  <div class="timer-idle" id="timerIdle">No active session — start tracking below</div>
  <div id="timerActive" style="display:none">
    <div class="timer-label">Now tracking</div>
    <div class="timer-issue" id="tIssue"></div>
    <div class="timer-summary" id="tSummary"></div>
    <span class="timer-activity" id="tActivity"></span>
    <div class="timer-display" id="tDisplay">0h:00m:00s</div>
    <div class="timer-btns">
      <button class="btn-ghost" id="btnPause" onclick="pauseResume()">⏸ Pause</button>
      <button class="btn-danger" onclick="stopTimer()">⏹ Stop &amp; Log</button>
    </div>
  </div>
</div>

<!-- Custom Task -->
<div class="custom-form">
  <details>
    <summary style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;padding:2px 0;">+ Track custom task</summary>
    <div style="margin-top:10px;">
      <input type="text" id="customName" placeholder="Task name…" />
      <select id="customActivity">
        <option>Implementing</option><option>Investigating</option>
        <option>Testing</option><option>Reviewing</option><option>Other</option>
      </select>
      <button class="btn-primary" onclick="startCustom()" style="width:100%;justify-content:center;">Start Timer</button>
    </div>
  </details>
</div>

<!-- Issues -->
<div class="section-header">
  <span>YouTrack Issues</span>
  <span class="section-count" id="issueCount">—</span>
</div>
<div class="filter-row">
  <input type="text" id="searchInput" placeholder="Search issues…" oninput="renderIssues()" />
</div>
<div class="issues-list" id="issuesList">
  <div class="empty-state">Connecting to YouTrack…</div>
</div>

<script>
const vscode = acquireVsCodeApi();

const ACTIVITIES = ['Implementing','Investigating','Testing','Reviewing','Other'];

let issues = [];
let states = [];
let boardColumns = null;   // [{ presentation, fieldValues }] or null when no agile board
let session = null;
let elapsedMs = 0;
let sessionStartLocal = 0; // local Date.now() when session started/resumed
let tickerId = null;

// Find the board column an issue's state belongs to (so the badge / dropdown
// show the column's display name instead of the raw state value).
function columnForState(state) {
  if (!boardColumns || !state) return null;
  return boardColumns.find(c => c.fieldValues.includes(state)) || null;
}

// ── Formatting ──────────────────────────────────────────────────
function formatDhms(ms) {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 28800);
  const rem = s % 28800;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const sec = rem % 60;
  let out = '';
  if (days) out += days + 'd:';
  out += h + 'h:' + String(m).padStart(2,'0') + 'm:' + String(sec).padStart(2,'0') + 's';
  return out;
}

// ── Timer rendering ─────────────────────────────────────────────
function renderTimer() {
  const card = document.getElementById('timerCard');
  const idle = document.getElementById('timerIdle');
  const active = document.getElementById('timerActive');

  if (!session) {
    idle.style.display = '';
    active.style.display = 'none';
    card.className = 'timer-card';
    clearInterval(tickerId); tickerId = null;
    return;
  }

  idle.style.display = 'none';
  active.style.display = '';
  card.className = 'timer-card ' + (session.paused ? 'paused' : 'active');
  document.getElementById('tIssue').textContent = session.issueReadable || '(custom)';
  document.getElementById('tSummary').textContent = session.summary;
  document.getElementById('tActivity').textContent = session.activity;
  document.getElementById('tDisplay').className = 'timer-display' + (session.paused ? ' paused' : '');
  document.getElementById('tDisplay').textContent = formatDhms(getCurrentElapsed());
  document.getElementById('btnPause').textContent = session.paused ? '▶ Resume' : '⏸ Pause';
}

function getCurrentElapsed() {
  if (!session) return 0;
  // Display = previously-logged spent time on this task + current session elapsed,
  // so restarting a task picks up from the accumulated total instead of zero.
  const priorMs = (session.priorSpentMinutes || 0) * 60000;
  const sessionMs = session.paused
    ? elapsedMs
    : elapsedMs + (Date.now() - sessionStartLocal);
  return priorMs + sessionMs;
}

function startTick() {
  clearInterval(tickerId);
  tickerId = setInterval(() => {
    if (session && !session.paused) {
      document.getElementById('tDisplay').textContent = formatDhms(getCurrentElapsed());
    }
  }, 1000);
}

// ── Issues rendering ────────────────────────────────────────────
function renderIssues() {
  const q = (document.getElementById('searchInput').value || '').toLowerCase();
  const filtered = issues.filter(i =>
    (i.idReadable + ' ' + i.summary).toLowerCase().includes(q)
  );
  document.getElementById('issueCount').textContent = filtered.length;
  const list = document.getElementById('issuesList');

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No issues found</div>';
    return;
  }

  list.innerHTML = filtered.map(issue => {
    const isRunning = session && session.issueId === issue.id;
    const spent = issue.spentTime
      ? '⏱ ' + Math.floor(issue.spentTime/60) + 'h ' + (issue.spentTime%60) + 'm spent'
      : '';

    // Prefer board columns when the project is on an agile board; the option
    // value is the first underlying state value (what we POST to YouTrack).
    let stateOpts;
    if (boardColumns && boardColumns.length) {
      const currentCol = columnForState(issue.state);
      stateOpts = boardColumns.map(c => {
        const isCurrent = currentCol && currentCol.presentation === c.presentation;
        return '<option value="' + escHtml(c.fieldValues[0]) + '"' +
               (isCurrent ? ' selected' : '') + '>' + escHtml(c.presentation) + '</option>';
      }).join('');
    } else {
      stateOpts = states.map(s =>
        '<option' + (s === issue.state ? ' selected' : '') + '>' + escHtml(s) + '</option>'
      ).join('');
    }

    const badgeText = (columnForState(issue.state)?.presentation) || issue.state || '—';
    const actOpts = ACTIVITIES.map(a => '<option>' + a + '</option>').join('');
    const idAttr = escHtml(issue.id);

    return (
      '<div class="issue-card' + (isRunning ? ' running' : '') + '" data-issue-id="' + idAttr + '">' +
        '<div class="issue-top">' +
          '<span class="issue-id">' + escHtml(issue.idReadable) + '</span>' +
          (isRunning ? '<span class="badge-running"><span class="pulse"></span>tracking</span>' : '') +
          '<span class="issue-state-badge" style="margin-left:auto">' + escHtml(badgeText) + '</span>' +
        '</div>' +
        '<div class="issue-summary">' + escHtml(issue.summary) + '</div>' +
        (spent ? '<div class="issue-spent">' + spent + '</div>' : '') +
        '<div class="issue-actions">' +
          '<select class="activity-select" data-role="activity" data-issue-id="' + idAttr + '">' + actOpts + '</select>' +
          (isRunning
            ? '<button class="btn-danger btn-sm" data-action="stop">⏹ Stop</button>'
            : '<button class="btn-primary btn-sm" data-action="start" data-issue-id="' + idAttr + '">▶ Start</button>'
          ) +
          '<select class="state-select" data-action="move" data-issue-id="' + idAttr + '">' + stateOpts + '</select>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

// Event delegation - inline onclick with data values is fragile across quote/escape edges
document.getElementById('issuesList').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'start') startIssue(btn.dataset.issueId);
  else if (action === 'stop') stopTimer();
});
document.getElementById('issuesList').addEventListener('change', e => {
  const sel = e.target;
  if (sel.dataset && sel.dataset.action === 'move') {
    moveIssue(sel.dataset.issueId, sel.value);
  }
});

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Commands ────────────────────────────────────────────────────
function startIssue(id) {
  const issue = issues.find(i => i.id === id);
  if (!issue) return;
  const sel = document.querySelector('select[data-role="activity"][data-issue-id="' + id.replace(/"/g,'\\"') + '"]');
  const activity = (sel && sel.value) || 'Implementing';
  vscode.postMessage({ cmd:'start', issueId:id, issueReadable:issue.idReadable, summary:issue.summary, activity });
}

function startCustom() {
  const name = document.getElementById('customName').value.trim();
  const activity = document.getElementById('customActivity').value;
  if (!name) return;
  vscode.postMessage({ cmd:'startCustom', summary:name, activity });
  document.getElementById('customName').value = '';
}

function pauseResume() { vscode.postMessage({ cmd:'pauseResume' }); }
function stopTimer()   { vscode.postMessage({ cmd:'stop' }); }
function refresh()     { vscode.postMessage({ cmd:'refresh' }); }
function configure()   { vscode.postMessage({ cmd:'configure' }); }
function moveIssue(id, state) { vscode.postMessage({ cmd:'move', issueId:id, state }); }

// ── Messages from extension ─────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;

  if (msg.type === 'init') {
    // Full state update (issues list changed, connection changed, etc.)
    issues  = msg.issues  || [];
    states  = msg.states  || [];
    boardColumns = msg.boardColumns || null;
    session = msg.session || null;
    elapsedMs = msg.elapsedMs || 0;
    sessionStartLocal = Date.now();

    // Connection status
    const dot  = document.getElementById('connDot');
    const text = document.getElementById('connText');
    dot.className  = 'dot' + (msg.connected ? ' ok' : '');
    text.textContent = msg.connected ? 'connected' : 'disconnected';

    // Error banner
    const banner = document.getElementById('errorBanner');
    if (msg.errorMsg) {
      banner.textContent = '⚠ ' + msg.errorMsg;
      banner.className = 'error-banner show';
    } else {
      banner.className = 'error-banner';
    }

    renderTimer();
    renderIssues();
    if (session && !session.paused) startTick();
    else { clearInterval(tickerId); tickerId = null; }
  }

  if (msg.type === 'timerUpdate') {
    // Lightweight: only timer changed
    session   = msg.session || null;
    elapsedMs = msg.elapsedMs || 0;
    sessionStartLocal = Date.now();

    renderTimer();
    renderIssues(); // update running badge on issue card
    if (session && !session.paused) startTick();
    else { clearInterval(tickerId); tickerId = null; }
  }
});

// Signal ready to extension so it sends initial state
vscode.postMessage({ cmd: 'ready' });
</script>
</body>
</html>`;
}
