import type { Memento } from "vscode";
import type { Session, SessionStorage } from "@ylate/core";

const KEY = "activeSession";

/**
 * Persists the active session in VS Code's workspaceState. The underlying
 * `update` is async (returns a Thenable) but we don't await it — fire and
 * forget is the standard VS Code pattern for `workspaceState`, and the
 * `SessionStorage` contract is synchronous.
 */
export class WorkspaceStateStorage implements SessionStorage {
  constructor(private state: Memento) {}

  load(): Session | null {
    return this.state.get<Session>(KEY) ?? null;
  }

  save(session: Session | null): void {
    this.state.update(KEY, session ?? undefined);
  }
}
