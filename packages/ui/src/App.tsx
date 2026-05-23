import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BoardColumn,
  HostMessage,
  Issue,
  Session,
  ActivityType,
} from "@ylate/core";
import { getTransport, type Transport } from "./api";

const ACTIVITIES: ActivityType[] = [
  "Implementing",
  "Investigating",
  "Testing",
  "Reviewing",
  "Other",
];

/** Same Dd:Hh:MMm:SSs format as the host status bar. 1d = 8h working day. */
function formatDhms(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 28800);
  const rem = s % 28800;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const sec = rem % 60;
  let out = "";
  if (days) out += days + "d:";
  out += `${h}h:${String(m).padStart(2, "0")}m:${String(sec).padStart(2, "0")}s`;
  return out;
}

function columnForState(
  state: string | undefined,
  cols: BoardColumn[] | null
): BoardColumn | null {
  if (!cols || !state) return null;
  return cols.find((c) => c.fieldValues.includes(state)) ?? null;
}

/** prior YouTrack spent + current session elapsed, in ms. */
function computeDisplayMs(
  session: Session | null,
  serverElapsedMs: number,
  serverSyncAt: number
): number {
  if (!session) return 0;
  const priorMs = (session.priorSpentMinutes || 0) * 60_000;
  const sessionMs = session.paused
    ? serverElapsedMs
    : serverElapsedMs + (Date.now() - serverSyncAt);
  return priorMs + sessionMs;
}

export function App() {
  const transportRef = useRef<Transport | null>(null);

  const [issues, setIssues] = useState<Issue[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [boardColumns, setBoardColumns] = useState<BoardColumn[] | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [serverElapsedMs, setServerElapsedMs] = useState(0);
  const [serverSyncAt, setServerSyncAt] = useState(Date.now());
  const [connected, setConnected] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const [search, setSearch] = useState("");
  const [customName, setCustomName] = useState("");
  const [customActivity, setCustomActivity] = useState<ActivityType>("Implementing");
  // Activity selection per issue (default "Implementing")
  const [activityById, setActivityById] = useState<Record<string, ActivityType>>({});

  // Per-second ticker — drives the timer display without round-tripping the host.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!session || session.paused) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [session, session?.paused]);

  // Transport: subscribe once on mount, post `ready` so the host pushes init.
  useEffect(() => {
    const transport = getTransport();
    transportRef.current = transport;

    const unsubscribe = transport.onMessage((msg: HostMessage) => {
      if (msg.type === "init") {
        setIssues(msg.issues);
        setStates(msg.states);
        setBoardColumns(msg.boardColumns);
        setSession(msg.session);
        setServerElapsedMs(msg.elapsedMs);
        setServerSyncAt(Date.now());
        setConnected(msg.connected);
        setErrorMsg(msg.errorMsg);
      } else if (msg.type === "timerUpdate") {
        setSession(msg.session);
        setServerElapsedMs(msg.elapsedMs);
        setServerSyncAt(Date.now());
      }
    });

    transport.post({ cmd: "ready" });
    return unsubscribe;
  }, []);

  const post = transportRef.current?.post.bind(transportRef.current);

  // ── Derived ───────────────────────────────────────────────────────────────
  const filteredIssues = useMemo(() => {
    const q = search.toLowerCase();
    return issues.filter((i) =>
      (i.idReadable + " " + i.summary).toLowerCase().includes(q)
    );
  }, [issues, search]);

  // NOT memoized: Date.now() needs to be re-read on every render. The
  // per-second ticker above forces a re-render while the timer is running,
  // and pause/resume re-renders trigger naturally via state changes.
  const currentDisplayMs = computeDisplayMs(
    session,
    serverElapsedMs,
    serverSyncAt
  );

  // ── Handlers ──────────────────────────────────────────────────────────────
  const startIssue = (issue: Issue) => {
    post?.({
      cmd: "start",
      issueId: issue.id,
      issueReadable: issue.idReadable,
      summary: issue.summary,
      activity: activityById[issue.id] ?? "Implementing",
    });
  };
  const startCustom = () => {
    const summary = customName.trim();
    if (!summary) return;
    post?.({ cmd: "startCustom", summary, activity: customActivity });
    setCustomName("");
  };
  const pauseResume = () => post?.({ cmd: "pauseResume" });
  const stopTimer = () => post?.({ cmd: "stop" });
  const refresh = () => post?.({ cmd: "refresh" });
  const configure = () => post?.({ cmd: "configure" });
  const moveIssue = (issueId: string, state: string) =>
    post?.({ cmd: "move", issueId, state });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <Header connected={connected} onRefresh={refresh} onConfigure={configure} />
      {errorMsg && <div className="error-banner">⚠ {errorMsg}</div>}

      <TimerCard
        session={session}
        displayMs={currentDisplayMs}
        onPauseResume={pauseResume}
        onStop={stopTimer}
      />

      <CustomTaskForm
        name={customName}
        activity={customActivity}
        onNameChange={setCustomName}
        onActivityChange={setCustomActivity}
        onStart={startCustom}
      />

      <div className="section-header">
        <span>YouTrack Issues</span>
        <span className="section-count">{filteredIssues.length}</span>
      </div>
      <div className="filter-row">
        <input
          type="text"
          placeholder="Search issues…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="issues-list" id="issuesList">
        {filteredIssues.length === 0 ? (
          <div className="empty-state">
            {connected ? "No issues found" : "Connecting to YouTrack…"}
          </div>
        ) : (
          filteredIssues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              isRunning={session?.issueId === issue.id}
              states={states}
              boardColumns={boardColumns}
              selectedActivity={activityById[issue.id] ?? "Implementing"}
              onActivityChange={(act) =>
                setActivityById((prev) => ({ ...prev, [issue.id]: act }))
              }
              onStart={() => startIssue(issue)}
              onStop={stopTimer}
              onMove={(state) => moveIssue(issue.id, state)}
            />
          ))
        )}
      </div>
    </>
  );
}

// ── Sub-components (kept inline; promote to separate files if any grows.) ───

function Header({
  connected,
  onRefresh,
  onConfigure,
}: {
  connected: boolean;
  onRefresh: () => void;
  onConfigure: () => void;
}) {
  return (
    <div className="header">
      <span className="header-title">⏱ Ylate</span>
      <div className="header-status">
        <div className={connected ? "dot ok" : "dot"} />
        <span className="status-text">
          {connected ? "connected" : "disconnected"}
        </span>
        <button className="btn-ghost btn-sm" onClick={onRefresh} title="Refresh">
          ↻
        </button>
        <button className="btn-ghost btn-sm" onClick={onConfigure} title="Configure">
          ⚙
        </button>
      </div>
    </div>
  );
}

function TimerCard({
  session,
  displayMs,
  onPauseResume,
  onStop,
}: {
  session: Session | null;
  displayMs: number;
  onPauseResume: () => void;
  onStop: () => void;
}) {
  if (!session) {
    return (
      <div className="timer-card">
        <div className="timer-idle">No active session — start tracking below</div>
      </div>
    );
  }
  return (
    <div className={`timer-card ${session.paused ? "paused" : "active"}`}>
      <div className="timer-label">Now tracking</div>
      <div className="timer-issue">{session.issueReadable || "(custom)"}</div>
      <div className="timer-summary">{session.summary}</div>
      <span className="timer-activity">{session.activity}</span>
      <div className={`timer-display ${session.paused ? "paused" : ""}`}>
        {formatDhms(displayMs)}
      </div>
      <div className="timer-btns">
        <button className="btn-ghost" onClick={onPauseResume}>
          {session.paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button className="btn-danger" onClick={onStop}>
          ⏹ Stop &amp; Log
        </button>
      </div>
    </div>
  );
}

function CustomTaskForm({
  name,
  activity,
  onNameChange,
  onActivityChange,
  onStart,
}: {
  name: string;
  activity: ActivityType;
  onNameChange: (v: string) => void;
  onActivityChange: (v: ActivityType) => void;
  onStart: () => void;
}) {
  return (
    <div className="custom-form">
      <details>
        <summary
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: 1,
            padding: "2px 0",
          }}
        >
          + Track custom task
        </summary>
        <div style={{ marginTop: 10 }}>
          <input
            type="text"
            placeholder="Task name…"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
          <select
            value={activity}
            onChange={(e) => onActivityChange(e.target.value as ActivityType)}
          >
            {ACTIVITIES.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <button
            className="btn-primary"
            onClick={onStart}
            style={{ width: "100%", justifyContent: "center" }}
          >
            Start Timer
          </button>
        </div>
      </details>
    </div>
  );
}

function IssueCard({
  issue,
  isRunning,
  states,
  boardColumns,
  selectedActivity,
  onActivityChange,
  onStart,
  onStop,
  onMove,
}: {
  issue: Issue;
  isRunning: boolean;
  states: string[];
  boardColumns: BoardColumn[] | null;
  selectedActivity: ActivityType;
  onActivityChange: (a: ActivityType) => void;
  onStart: () => void;
  onStop: () => void;
  onMove: (newState: string) => void;
}) {
  const spent = issue.spentTime
    ? `⏱ ${Math.floor(issue.spentTime / 60)}h ${issue.spentTime % 60}m spent`
    : null;

  const currentColumn = columnForState(issue.state, boardColumns);
  const badgeText = currentColumn?.presentation || issue.state || "—";

  // State dropdown options. Prefer agile board columns when available.
  let dropdownOptions: { value: string; label: string; selected: boolean }[];
  if (boardColumns && boardColumns.length) {
    dropdownOptions = boardColumns.map((c) => ({
      value: c.fieldValues[0],
      label: c.presentation,
      selected: !!currentColumn && currentColumn.presentation === c.presentation,
    }));
  } else {
    dropdownOptions = states.map((s) => ({
      value: s,
      label: s,
      selected: s === issue.state,
    }));
  }
  const selectedValue =
    dropdownOptions.find((o) => o.selected)?.value ?? dropdownOptions[0]?.value ?? "";

  return (
    <div className={`issue-card${isRunning ? " running" : ""}`}>
      <div className="issue-top">
        <span className="issue-id">{issue.idReadable}</span>
        {isRunning && (
          <span className="badge-running">
            <span className="pulse" />
            tracking
          </span>
        )}
        <span className="issue-state-badge" style={{ marginLeft: "auto" }}>
          {badgeText}
        </span>
      </div>
      <div className="issue-summary">{issue.summary}</div>
      {spent && <div className="issue-spent">{spent}</div>}
      <div className="issue-actions">
        <select
          className="activity-select"
          value={selectedActivity}
          onChange={(e) => onActivityChange(e.target.value as ActivityType)}
        >
          {ACTIVITIES.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        {isRunning ? (
          <button className="btn-danger btn-sm" onClick={onStop}>
            ⏹ Stop
          </button>
        ) : (
          <button className="btn-primary btn-sm" onClick={onStart}>
            ▶ Start
          </button>
        )}
        <select
          className="state-select"
          value={selectedValue}
          onChange={(e) => onMove(e.target.value)}
        >
          {dropdownOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
