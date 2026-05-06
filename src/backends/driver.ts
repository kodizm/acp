/**
 * BackendDriver contract.
 *
 * Every backend (Claude, codex, opencode) implements this interface.
 * The AcpServer dispatch layer routes incoming JSON-RPC requests into
 * the appropriate driver method; capability gating happens before the
 * call so an unsupported method raises {@link MethodNotSupportedError}
 * instead of silently no-op'ing or surfacing a backend-specific error.
 *
 * Mirrors the Laravel-side `App\Services\Project\Acp\Contracts\AgentDriver`
 * interface so both sides have a parallel mental model.
 */

import { MethodNotSupportedError } from '../server/errors.ts'
import type { SessionUpdateEvent } from '../wire/events.ts'
import type {
  CancelRequest,
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
 * stop reasons; codex / opencode normalize to this enum.
 */
export interface PromptResult {
  stopReason: 'end_turn' | 'cancelled' | 'process_died' | 'max_tokens' | 'tool_use'
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
