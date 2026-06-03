import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppConfig,
  HostMessage,
  Issue,
  Session,
} from "@ylate/core";
import { getTransport, isTauri, type Transport } from "./api";
import { PreferencesView } from "./PreferencesView";

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
  const [moveValues, setMoveValues] = useState<string[]>([]);
  const [workItemTypes, setWorkItemTypes] = useState<string[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [serverElapsedMs, setServerElapsedMs] = useState(0);
  const [serverSyncAt, setServerSyncAt] = useState(Date.now());
  const [connected, setConnected] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  const [search, setSearch] = useState("");
  const [customName, setCustomName] = useState("");
  const [customType, setCustomType] = useState<string>("");
  // Work-item type selection per issue
  const [typeById, setTypeById] = useState<Record<string, string>>({});

  // Preferences view state — only used in the desktop shell. VS Code keeps
  // its own native input-box flow on `configure`.
  const [view, setView] = useState<"main" | "preferences">("main");
  const [config, setConfig] = useState<AppConfig | null>(null);

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
        setMoveValues(msg.moveValues);
        setWorkItemTypes(msg.workItemTypes);
        setCustomType((prev) => prev || msg.workItemTypes[0] || "");
        setSession(msg.session);
        setServerElapsedMs(msg.elapsedMs);
        setServerSyncAt(Date.now());
        setConnected(msg.connected);
        setErrorMsg(msg.errorMsg);
        setBaseUrl(msg.baseUrl);
      } else if (msg.type === "timerUpdate") {
        setSession(msg.session);
        setServerElapsedMs(msg.elapsedMs);
        setServerSyncAt(Date.now());
      } else if (msg.type === "config") {
        setConfig(msg.config);
      } else if (msg.type === "showPreferences") {
        setView("preferences");
        // request a fresh config snapshot so the form pre-fills
        transport.post({ cmd: "getConfig" });
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
      workItemType: typeById[issue.id] ?? workItemTypes[0] ?? "",
    });
  };
  const startCustom = () => {
    const summary = customName.trim();
    if (!summary) return;
    post?.({ cmd: "startCustom", summary, workItemType: customType });
    setCustomName("");
  };
  const pauseResume = () => post?.({ cmd: "pauseResume" });
  const stopTimer = () => post?.({ cmd: "stop" });
  const refresh = () => post?.({ cmd: "refresh" });
  const configure = () => {
    if (isTauri()) {
      // Desktop: switch to the in-app Preferences view and ask for fresh state.
      setView("preferences");
      post?.({ cmd: "getConfig" });
    } else {
      // VS Code: host handles the input-box flow.
      post?.({ cmd: "configure" });
    }
  };
  const moveIssue = (issueId: string, value: string) =>
    post?.({ cmd: "move", issueId, value });
  const openIssue = (issueReadable: string) => {
    if (!baseUrl || !issueReadable) return;
    const trimmed = baseUrl.replace(/\/$/, "");
    post?.({ cmd: "openExternal", url: `${trimmed}/issue/${issueReadable}` });
  };
  const savePreferences = (cfg: {
    baseUrl: string;
    token: string | undefined;
    projectId: string;
    myIssuesOnly: boolean;
    autostart: boolean;
  }) => {
    post?.({ cmd: "saveConfig", ...cfg });
    setView("main");
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (view === "preferences") {
    return (
      <PreferencesView
        initialConfig={config}
        onSave={savePreferences}
        onCancel={() => setView("main")}
      />
    );
  }
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
        type={customType}
        typeOptions={workItemTypes}
        onNameChange={setCustomName}
        onTypeChange={setCustomType}
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
              moveValues={moveValues}
              activityOptions={workItemTypes}
              selectedType={typeById[issue.id] ?? workItemTypes[0] ?? ""}
              onActivityChange={(t) =>
                setTypeById((prev) => ({ ...prev, [issue.id]: t }))
              }
              onStart={() => startIssue(issue)}
              onStop={stopTimer}
              onMove={(value) => moveIssue(issue.id, value)}
              onOpenInYouTrack={
                baseUrl ? () => openIssue(issue.idReadable) : undefined
              }
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
      <span className="timer-activity">{session.workItemType}</span>
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
  type,
  typeOptions,
  onNameChange,
  onTypeChange,
  onStart,
}: {
  name: string;
  type: string;
  typeOptions: string[];
  onNameChange: (v: string) => void;
  onTypeChange: (v: string) => void;
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
            value={type}
            onChange={(e) => onTypeChange(e.target.value)}
          >
            {typeOptions.map((a) => (
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
  moveValues,
  activityOptions,
  selectedType,
  onActivityChange,
  onStart,
  onStop,
  onMove,
  onOpenInYouTrack,
}: {
  issue: Issue;
  isRunning: boolean;
  moveValues: string[];
  activityOptions: string[];
  selectedType: string;
  onActivityChange: (a: string) => void;
  onStart: () => void;
  onStop: () => void;
  onMove: (value: string) => void;
  onOpenInYouTrack?: () => void;
}) {
  const spent = issue.spentTime
    ? `⏱ ${Math.floor(issue.spentTime / 60)}h ${issue.spentTime % 60}m spent`
    : null;

  const badgeText = issue.state || "—";
  // Always include the issue's current value, even if it's not among the
  // discovered move values (e.g. a resolved/archived state) — otherwise the
  // controlled <select> would render blank.
  const baseOptions = moveValues.map((v) => ({ value: v, label: v }));
  const dropdownOptions =
    issue.state && !moveValues.includes(issue.state)
      ? [{ value: issue.state, label: issue.state }, ...baseOptions]
      : baseOptions;
  const selectedValue = issue.state ?? dropdownOptions[0]?.value ?? "";

  return (
    <div className={`issue-card${isRunning ? " running" : ""}`}>
      <div className="issue-top">
        {onOpenInYouTrack ? (
          <button
            type="button"
            className="issue-id issue-id-link"
            onClick={onOpenInYouTrack}
            title="Open in YouTrack"
          >
            {issue.idReadable} ↗
          </button>
        ) : (
          <span className="issue-id">{issue.idReadable}</span>
        )}
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
          value={selectedType}
          onChange={(e) => onActivityChange(e.target.value)}
        >
          {activityOptions.map((a) => (
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
