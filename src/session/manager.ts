/**
 * Multi-session storage for the ACP server process.
 *
 * The ACP spec allows one process to host N concurrent sessions. The
 * manager is the one place that maps sessionId -> {@link SessionState}
 * for every backend; the driver layer threads its own state through
 * this surface so cross-cutting concerns (cancel, close, list) work
 * uniformly across backends.
 *
 * Cancel propagation: {@link close} aborts the session's
 * AbortController before deleting the entry, so any in-flight SDK
 * `query()` promise observes the cancellation cleanly.
 */

import { SessionNotFoundError } from '../server/errors.ts'
import type { SessionState } from './state.ts'

/**
 * Subset of {@link SessionState} the manager fills on creation:
 * `sessionId` and `createdAt` are owned by the manager.
 */
export type SessionStateInput = Omit<SessionState, 'sessionId' | 'createdAt'>

/**
 * In-memory session store. One instance per server process.
 */
export class SessionManager {
  private readonly sessions: Map<string, SessionState> = new Map()

  /**
   * Register a new session. The manager stamps `createdAt` and the
   * stable `sessionId`; callers provide everything else.
   *
   * @throws {Error} when the id is already registered (caller bug).
   */
  public create(sessionId: string, input: SessionStateInput): SessionState {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session ${sessionId} already exists`)
    }
    const state: SessionState = {
      ...input,
      sessionId,
      createdAt: Date.now(),
    }
    this.sessions.set(sessionId, state)
    return state
  }

  /**
   * Look up a session by id. Throws {@link SessionNotFoundError} on
   * miss so the dispatch layer can surface a typed JSON-RPC error
   * (mapped to code -32004).
   */
  public get(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(sessionId)
    }
    return state
  }

  /**
   * Cheap presence check for tests + housekeeping. Does not throw.
   */
  public has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Tear down a session: aborts the in-flight turn (if any) and
   * removes the entry. Idempotent on a missing id is rejected so
   * mismatched lifecycle calls surface as typed errors.
   */
  public close(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(sessionId)
    }
    state.abortController.abort()
    this.sessions.delete(sessionId)
  }

  /**
   * Number of active sessions. Used for diagnostics + retention
   * tooling.
   */
  public size(): number {
    return this.sessions.size
  }

  /**
   * Active session ids in insertion order. JavaScript `Map`
   * iteration is insertion-ordered, so this is a stable sequence
   * suitable for stable display in the orchestrator UI.
   */
  public list(): string[] {
    return [...this.sessions.keys()]
  }
}
