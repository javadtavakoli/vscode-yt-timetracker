import type { HostMessage, UICommand } from "@ylate/core";

export interface Transport {
  post(cmd: UICommand): void;
  onMessage(handler: (msg: HostMessage) => void): () => void;
}

declare global {
  // Provided by VS Code when the page loads inside a webview.
  function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    setState(state: unknown): void;
    getState(): unknown;
  };
}

/** VS Code webview transport — postMessage + window 'message' events. */
function createVsCodeTransport(): Transport {
  const api = acquireVsCodeApi();
  return {
    post: (cmd) => api.postMessage(cmd),
    onMessage: (handler) => {
      const listener = (e: MessageEvent) => handler(e.data as HostMessage);
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
  };
}

/**
 * Detect the host environment and return an appropriate transport. Tauri will
 * land in Phase 3 — when it does, branch here before the VS Code fallback.
 */
export function getTransport(): Transport {
  if (typeof acquireVsCodeApi !== "undefined") {
    return createVsCodeTransport();
  }
  throw new Error(
    "No supported host transport found. Expected VS Code's acquireVsCodeApi()."
  );
}
