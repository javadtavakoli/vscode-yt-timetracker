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
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined
  );
}

export function isVsCode(): boolean {
  return typeof acquireVsCodeApi !== "undefined";
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
 * In-renderer transport. Used by the desktop (Tauri) shell where the host
 * runs in the same renderer process as the UI. Both ends share this object;
 * the host calls `deliverToUI` to push HostMessages, the UI calls `post` to
 * send UICommands which the host receives via `onCommand`.
 */
export class InMemoryTransport implements Transport {
  private uiHandler: ((msg: HostMessage) => void) | null = null;
  private commandHandler: ((cmd: UICommand) => void) | null = null;

  post(cmd: UICommand): void {
    this.commandHandler?.(cmd);
  }
  onMessage(handler: (msg: HostMessage) => void): () => void {
    this.uiHandler = handler;
    return () => {
      this.uiHandler = null;
    };
  }
  // Host-side methods
  deliverToUI(msg: HostMessage): void {
    this.uiHandler?.(msg);
  }
  onCommand(handler: (cmd: UICommand) => void): () => void {
    this.commandHandler = handler;
    return () => {
      this.commandHandler = null;
    };
  }
}

let sharedDesktopTransport: InMemoryTransport | null = null;
export function getDesktopTransport(): InMemoryTransport {
  if (!sharedDesktopTransport) sharedDesktopTransport = new InMemoryTransport();
  return sharedDesktopTransport;
}

export function getTransport(): Transport {
  if (isTauri()) return getDesktopTransport();
  if (isVsCode()) return createVsCodeTransport();
  throw new Error(
    "No supported host transport found. Expected VS Code's acquireVsCodeApi() or Tauri's window.__TAURI_INTERNALS__."
  );
}
