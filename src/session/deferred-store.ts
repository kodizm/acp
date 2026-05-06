/**
 * Deferred-permission state store contract for Phase 1.6 (Pattern B).
 *
 * When the orchestrator leaves a permission_request unanswered past
 * `permissionDeferTimeoutMs`, the driver writes a synthetic tool_result
 * row to the SDK transcript and persists `DeferredState` to the store.
 * Container A then exits gracefully. Hours or days later, the
 * orchestrator collects an answer through its UI; a fresh container
 * spawns, calls `get(sessionId)` on first prompt, finds the cached
 * answer, wraps `canUseTool` with a one-shot returner, and lets the
 * model continue from where it stopped.
 *
 * Phase 1.6 ships this interface plus the in-memory binding used by
 * unit + integration tests. Phase 4 wires the production binding
 * (Laravel DB-backed) in `KodizmAcpBridgeDriver`.
 */

/**
 * Permission decision the orchestrator answered with after the user's
 * dialog round-trip. Mirrors the Claude SDK's PermissionResult shape.
 */
export interface CachedPermissionAnswer {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  message?: string
  interrupt?: boolean
}

/**
 * Persistent state recorded when a permission is deferred. Carries
 * everything Process B needs to consume the cached answer on resume.
 */
export interface DeferredState {
  /**
   * SDK toolUseId of the original tool call. The wrapped canUseTool on
   * Process B short-circuits when `options.toolUseID` matches.
   */
  toolUseId: string
  /**
   * Tool name (e.g., `Bash`, `Write`, `mcp__kodizm__create_task`).
   * Mirrors the value the orchestrator UI rendered.
   */
  toolName: string
  /**
   * Raw input payload the model sent. Echoed back to the orchestrator
   * so the resume container can reconstruct the dialog if needed.
   */
  rawInput: Record<string, unknown>
  /**
   * Wall-clock time (ms since epoch) when the defer fired on Process A.
   */
  deferredAt: number
  /**
   * Subagent attribution: set when the original call originated from a
   * Claude Task-tool subagent. Mirrors `permission_request.agentId`.
   */
  agentId?: string
  /**
   * Permission answer the orchestrator wrote after the user's dialog.
   * Absent until the orchestrator side records it; presence is the
   * signal Process B uses to know it has work to do.
   */
  cachedAnswer?: CachedPermissionAnswer
}

/**
 * Deferred-permission state store contract. Async on every method so
 * the production Laravel binding (Phase 4) can speak DB without
 * refactoring the driver-side call sites.
 */
export interface DeferredPermissionStore {
  /**
   * Persist a deferred-permission record for the given session.
   * Overwrites any prior value (one deferred call at a time per
   * session in Phase 1.6).
   */
  set(sessionId: string, state: DeferredState): Promise<void>
  /**
   * Read the deferred-permission record. Returns `null` when no record
   * is present for the sessionId.
   */
  get(sessionId: string): Promise<DeferredState | null>
  /**
   * Remove the deferred-permission record. Called by Process B after
   * the cached answer has been consumed and the original tool call
   * has settled.
   */
  delete(sessionId: string): Promise<void>
}

/**
 * In-memory binding used by unit + integration tests. The production
 * binding (Laravel DB) lands in Phase 4 (`KodizmAcpBridgeDriver`).
 */
export class InMemoryDeferredStore implements DeferredPermissionStore {
  private readonly store: Map<string, DeferredState> = new Map()

  /**
   * Persist a deferred-permission record.
   *
   * @param sessionId - canonical session identifier
   * @param state - deferred state payload
   */
  async set(sessionId: string, state: DeferredState): Promise<void> {
    this.store.set(sessionId, state)
  }

  /**
   * Read the deferred-permission record. Returns `null` on miss.
   *
   * @param sessionId - canonical session identifier
   * @returns the deferred state, or `null` when absent
   */
  async get(sessionId: string): Promise<DeferredState | null> {
    return this.store.get(sessionId) ?? null
  }

  /**
   * Remove the deferred-permission record. No-op on miss.
   *
   * @param sessionId - canonical session identifier
   */
  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId)
  }
}
