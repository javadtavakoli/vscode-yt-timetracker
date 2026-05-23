import type { Session } from "./types";

/**
 * Persistent storage adapter for the active session. Implementations live in
 * each host package — workspaceState in VS Code, tauri-plugin-store in the
 * desktop app, etc.
 *
 * Kept synchronous so `TimerCore` can read at startup without a Promise chain.
 * Async-backed hosts should cache the last-known value in memory and flush
 * writes in the background.
 */
export interface SessionStorage {
  load(): Session | null;
  save(session: Session | null): void;
}
