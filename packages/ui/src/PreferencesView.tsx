import { useEffect, useState } from "react";
import type { AppConfig } from "@ylate/core";

interface Props {
  initialConfig: AppConfig | null;
  onSave: (cfg: {
    baseUrl: string;
    token: string | undefined;
    projectId: string;
    myIssuesOnly: boolean;
    autostart: boolean;
  }) => void;
  onCancel: () => void;
}

/**
 * Native-style Preferences page for the desktop shell. VS Code keeps its
 * input-box flow (extension.ts `runConfigure`) — this component is only
 * rendered when the app is running inside Tauri.
 */
export function PreferencesView({ initialConfig, onSave, onCancel }: Props) {
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl ?? "");
  const [projectId, setProjectId] = useState(initialConfig?.projectId ?? "");
  const [myIssuesOnly, setMyIssuesOnly] = useState(
    initialConfig?.myIssuesOnly ?? true
  );
  const [autostart, setAutostart] = useState(
    initialConfig?.autostartEnabled ?? false
  );
  // Token uses a dirty-only model: empty means "keep what's already stored".
  // Typing into it (even to clear) marks it dirty.
  const [token, setToken] = useState("");
  const [tokenDirty, setTokenDirty] = useState(false);

  // Re-sync state if the host pushes a fresh config (e.g., after save).
  useEffect(() => {
    if (!initialConfig) return;
    setBaseUrl(initialConfig.baseUrl);
    setProjectId(initialConfig.projectId);
    setMyIssuesOnly(initialConfig.myIssuesOnly);
    setAutostart(initialConfig.autostartEnabled);
  }, [initialConfig]);

  const handleSave = () => {
    onSave({
      baseUrl: baseUrl.trim(),
      token: tokenDirty ? token : undefined,
      projectId: projectId.trim(),
      myIssuesOnly,
      autostart,
    });
  };

  const tokenPlaceholder = initialConfig?.hasToken
    ? "•••••••• (leave blank to keep current)"
    : "Permanent token from YouTrack";

  return (
    <>
      <div className="header">
        <span className="header-title">⚙ Preferences</span>
        <div className="header-status">
          <button className="btn-ghost btn-sm" onClick={onCancel}>
            ✕ Close
          </button>
        </div>
      </div>

      <div
        className="custom-form"
        style={{ marginBottom: 10 }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: 1,
            marginBottom: 8,
          }}
        >
          YouTrack connection
        </div>

        <label
          style={{
            display: "block",
            fontSize: 11,
            color: "var(--muted)",
            marginBottom: 4,
          }}
        >
          Base URL
        </label>
        <input
          type="text"
          placeholder="https://yourcompany.youtrack.cloud"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <label
          style={{
            display: "block",
            fontSize: 11,
            color: "var(--muted)",
            marginBottom: 4,
            marginTop: 6,
          }}
        >
          Permanent token
        </label>
        <input
          type="password"
          placeholder={tokenPlaceholder}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setTokenDirty(true);
          }}
        />
        <div
          style={{
            fontSize: 10,
            color: "var(--muted)",
            marginBottom: 6,
            marginTop: -2,
          }}
        >
          Stored in your OS keychain. Generate one at <em>Profile → Account Security → Tokens</em> in YouTrack.
        </div>

        <label
          style={{
            display: "block",
            fontSize: 11,
            color: "var(--muted)",
            marginBottom: 4,
            marginTop: 6,
          }}
        >
          Project short name
        </label>
        <input
          type="text"
          placeholder="PROJ"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        />
      </div>

      <div className="custom-form" style={{ marginBottom: 10 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: 1,
            marginBottom: 8,
          }}
        >
          Behavior
        </div>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            marginBottom: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={myIssuesOnly}
            onChange={(e) => setMyIssuesOnly(e.target.checked)}
            style={{ width: "auto", marginBottom: 0 }}
          />
          Show only issues assigned to me
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autostart}
            onChange={(e) => setAutostart(e.target.checked)}
            style={{ width: "auto", marginBottom: 0 }}
          />
          Launch Ylate when I sign in
        </label>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button
          className="btn-primary"
          onClick={handleSave}
          style={{ flex: 1, justifyContent: "center" }}
        >
          Save
        </button>
        <button
          className="btn-ghost"
          onClick={onCancel}
          style={{ flex: 1, justifyContent: "center" }}
        >
          Cancel
        </button>
      </div>
    </>
  );
}
