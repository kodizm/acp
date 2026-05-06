/**
 * Per-session state held by the session manager.
 *
 * Generic enough to span every backend driver: each driver lays its
 * own typed `sdkOptions` shape into this struct (Claude uses
 * {@link ClaudeSdkOptions}; codex / opencode will plug in their own
 * once phases 2-3 land). The shared fields ({@link sessionId},
 * {@link backend}, {@link createdAt}, {@link abortController},
 * {@link parentChildMap}) belong to every driver and live here.
 */

/**
 * Backend identifier that produced this session. Mirrors the
 * `KODIZM_BACKEND` env value used at process boot.
 */
export type BackendName = 'claude' | 'codex' | 'opencode'

/**
 * Session lifecycle struct. The session manager holds one of these
 * per active session id.
 */
export interface SessionState {
  /**
   * Stable session identifier allocated at newSession time. Lives for
   * the session's lifetime.
   */
  sessionId: string
  /**
   * Backend that owns this session. The dispatcher uses this when
   * routing CRUD calls back to the originating driver.
   */
  backend: BackendName
  /**
   * Driver-shaped options the backend driver hands to its SDK on each
   * turn. Untyped at the manager seam so codex / opencode can each
   * carry their own option shapes.
   */
  sdkOptions: unknown
  /**
   * Per-turn abort controller. Reassigned by the driver at the start
   * of each turn; {@link SessionManager.close} fires it to interrupt
   * an in-flight turn at session teardown.
   */
  abortController: AbortController
  /**
   * Subagent observability map: parent_tool_use_id -> child session
   * uuid. Populated by {@link SubagentTracker} mid-turn and read by
   * the orchestrator for cross-turn audit.
   */
  parentChildMap: Map<string, string>
  /**
   * Wall-clock timestamp (ms since epoch) when the session was first
   * created. Used for per-session retention windows.
   */
  createdAt: number
}
