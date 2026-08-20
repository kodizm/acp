/**
 * BackendDriver contract.
 *
 * Every backend (Claude, opencode) implements this interface.
 * The AcpServer dispatch layer routes incoming JSON-RPC requests into
 * the appropriate driver method; capability gating happens before the
 * call so an unsupported method raises {@link MethodNotSupportedError}
 * instead of silently no-op'ing or surfacing a backend-specific error.
 *
 * Mirrors the Laravel-side `App\Services\Project\Acp\Contracts\AgentDriver`
 * interface so both sides have a parallel mental model.
 */

import { MethodNotSupportedError } from '../server/errors.ts'
import type { SessionFailedReason, SessionUpdateEvent } from '../wire/events.ts'
import type {
  CancelRequest,
  CompactSessionRequest,
  ForkSessionRequest,
  InitializeRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from '../wire/types.ts'

/**
 * Boolean feature flags advertised by the driver. The dispatcher
 * checks these before invoking the corresponding methods or routing
 * the matching event types. Adding a feature here means extending
 * every backend driver + the wire's sessionUpdate union.
 */
export interface DriverCapabilities {
  /** session/load is implemented (transcript replay). */
  resume: boolean

  /** session/fork is implemented (branching with overrides). */
  fork: boolean

  /** image + document content blocks accepted in prompt[]. */
  fileUpload: boolean

  /** thinking_chunk sessionUpdate events emitted. */
  thinking: boolean

  /** subagent_spawn + subagent_complete events emitted. */
  subagent: boolean

  /** skill_activation events emitted. */
  skillEvents: boolean

  /**
   * Phase 1.7 debug recorder is wired into the driver. When true, the
   * driver tees raw backend messages + RPC frames into a
   * {@link import('../util/debug-recorder.ts').DebugRecorder} when
   * the orchestrator opts in via `NewSessionRequest.debug` (or the
   * process-wide `KODIZM_DEBUG=1` env). When false, the driver
   * ignores debug toggles entirely.
   */
  debug: boolean

  /**
   * Phase 3 addition: the backend exposes a first-class user-question
   * channel mapped onto the canonical `session/ask_user_question`
   * outbound RPC. Claude (SDK `AskUserQuestion` plugin) and opencode
   * (`item/tool/requestUserInput` + `mcpServer/elicitation/request`)
   * both surface it; opencode goes a step further with native
   * `Question.Service` + `tool/question.ts`. When false, the driver
   * does NOT translate any backend prompt into the canonical
   * question event; the orchestrator should not surface a "model
   * asked a question" UI for that backend.
   */
  askQuestion: boolean
}

/**
 * Result of `initialize`: the agent's protocol version + version
 * banner + advertised capabilities.
 */
export interface InitializeResult {
  protocolVersion: number
  agentInfo: { version: string }
  capabilities: DriverCapabilities
}

/**
 * Result of `newSession`, `loadSession`, `forkSession`: the new
 * session id allocated by the backend.
 */
export interface NewSessionResult {
  sessionId: string
}

/**
 * Result of a `prompt` call. `stopReason` mirrors Anthropic's SDK
 * stop reasons; opencode normalizes to this enum.
 *
 * `session_failed` is the Phase 1.7 addition: surfaces a structured
 * lifecycle failure (sdk_stall, sdk_throw, transport_error, etc.)
 * to callers that prefer the typed return shape over catching a
 * thrown error. The matching `failureReason` + `failureDetail`
 * fields carry the same data the parallel `session_failed`
 * sessionUpdate event emits.
 */
export interface PromptResult {
  stopReason: 'end_turn' | 'cancelled' | 'process_died' | 'max_tokens' | 'tool_use' | 'session_failed'
  /**
   * Set when stopReason === 'session_failed'. Mirrors the
   * `session_failed` event's `reason` field.
   */
  failureReason?: SessionFailedReason
  /**
   * Set when stopReason === 'session_failed'. Human-readable detail
   * the orchestrator can render in audit / UI.
   */
  failureDetail?: string
}

/**
 * Sink the prompt method writes events into. The AcpServer wraps the
 * transport with an emitter that fans out to `notify('sessionUpdate', ...)`.
 * Tests pass a no-op emitter or a recording one.
 */
export interface EventEmitter {
  send(event: SessionUpdateEvent): void
}

/**
 * Contract every backend driver implements. Method names match the
 * ACP wire `method` strings (without the namespace prefix on the
 * driver side; AcpServer adds `session/` when registering handlers).
 */
export interface BackendDriver {
  /**
   * Returns the static feature set the driver supports. Called once
   * at startup by the dispatcher.
   */
  capabilities(): DriverCapabilities

  /**
   * `initialize` handshake. Returns the protocol version + agent info.
   */
  initialize(params: InitializeRequest): Promise<InitializeResult>

  /**
   * `session/new`: open a fresh session. Returns the allocated id.
   */
  newSession(params: NewSessionRequest): Promise<NewSessionResult>

  /**
   * `session/prompt`: a turn in an existing session. Stream events
   * via `emit.send()`; the method resolves once the SDK signals stop.
   */
  prompt(sessionId: string, params: PromptRequest, emit: EventEmitter): Promise<PromptResult>

  /**
   * `session/cancel`: abort the in-flight prompt for the session id.
   * The 2s grace window before raising {@link CancelledError} lives
   * in the lifecycle module, not here.
   */
  cancel(request: CancelRequest): Promise<void>

  /**
   * `session/load`: re-attach to a prior session, replaying its
   * transcript. Gated on `capabilities().resume`.
   */
  loadSession(params: LoadSessionRequest): Promise<NewSessionResult>

  /**
   * `session/fork`: branch an existing session with optional
   * overrides. Gated on `capabilities().fork`.
   */
  forkSession(params: ForkSessionRequest): Promise<NewSessionResult>

  /**
   * `session/compact`: orchestrator-driven manual context compaction.
   * Drivers translate to their backend's native lever (Claude SDK
   * `/compact` slash command,
   * opencode `session.summarize({auto: false})`). Implementations
   * MUST set a per-session `pendingManualCompact` latch before
   * dispatching so the matching `compaction_started` /
   * `compaction_completed` events can be re-tagged
   * `trigger: 'manual'` on the way back out. Drivers without a
   * manual compact lever throw {@link MethodNotSupportedError}.
   *
   * Events fire through `emit` exactly like a `prompt()` turn so the
   * AcpServer can fan them out as `sessionUpdate` notifications.
   *
   * @throws {MethodNotSupportedError} when the backend has no manual compact lever
   */
  compact(request: CompactSessionRequest, emit: EventEmitter): Promise<void>

  /**
   * Release every per-session resource the driver owns. Optional: a
   * backend that holds nothing beyond the process (the Claude SDK
   * path) can leave it unimplemented.
   *
   * The bin calls this from its SIGTERM / SIGINT handler. It is load
   * bearing for opencode, which boots one `opencode serve` subprocess
   * per session: without it those children outlive the bin. Six of
   * them accumulated in a production container and filled its 1 GiB
   * cgroup to 99.4 %, with two OOM kills.
   */
  disposeAll?(): Promise<void>
}

/**
 * Throw {@link MethodNotSupportedError} when the driver does not
 * advertise the requested capability. Used by the AcpServer's
 * dispatch handlers immediately before calling driver methods.
 *
 * @param caps - the driver's advertised capability set
 * @param required - the capability flag the method requires
 * @param method - the wire-level method name to embed in the error
 *
 * @throws {MethodNotSupportedError} when `caps[required] === false`
 */
export function ensureCapability(caps: DriverCapabilities, required: keyof DriverCapabilities, method: string): void {
  if (caps[required]) {
    return
  }

  // Build the supported-methods list for the error's data payload so
  // clients can discover what this driver does support.
  const supported: string[] = []
  for (const [name, value] of Object.entries(caps)) {
    if (value === true) {
      supported.push(name)
    }
  }

  throw new MethodNotSupportedError(method, supported)
}
