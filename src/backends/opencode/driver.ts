/**
 * Opencode backend driver.
 *
 * Drives the opencode HTTP server (Effect HttpApi + Hono routes) via
 * an in-process `Server.listen({port: 0, hostname: '127.0.0.1'})`
 * boot per Kodizm session. The driver translates Kodizm canonical
 * wire shapes (NewSessionRequest, PromptRequest, etc.) to opencode's
 * native REST + SSE protocol; the orchestrator never sees opencode
 * shapes.
 *
 * Phase 3 progressive build:
 *   T1  scaffold (capabilities + initialize, stubs throw MNS)
 *   T2  http-bridge: Server.listen() boot + lifecycle
 *   T3  newSession: spawn listener + sdk.session.create + auth env
 *   T4  policy: canonical toolPolicy -> opencode Ruleset
 *   T5  mcp-mapper: canonical mcpServers -> opencode MCP shape
 *   T6  event-mapper: opencode bus -> canonical SessionUpdateEvent
 *   T7  ask-user-question: question.asked -> session/ask_user_question
 *   T8  permission-bridge + Pattern B onDefer hook
 *   T9  prompt-stream: SSE subscription + dispatch
 *   T10 prompt(): wire stream + heartbeat + cancel
 *   T11 error-classifier
 *   T12 cancel(): abort + listener.stop()
 *   T13 loadSession + hydrateSession (cross-process Pattern B)
 *   T14 forkSession
 *   T15 deferred-permission Pattern B opencode-side injection
 */

import { MethodNotSupportedError } from '../../server/errors.ts'
import type {
  CancelRequest,
  ForkSessionRequest,
  InitializeRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from '../../wire/types.ts'
import type {
  BackendDriver,
  DriverCapabilities,
  EventEmitter,
  InitializeResult,
  NewSessionResult,
  PromptResult,
} from '../driver.ts'

/**
 * Construction-time dependencies for the opencode driver. Phase 3 T2+
 * extends this with `httpBridgeFactory`, `server` (AcpServerLike for
 * outbound RPCs), `deferredStore`, and `opencodeDataDir` overrides
 * (mirrors `CodexDriverDeps`).
 */
export interface OpencodeDriverDeps {
  /**
   * Agent banner returned by `initialize`. Production reads
   * `package.json#version`; tests inject a fixed value so snapshots
   * are stable.
   */
  agentInfo: { version: string }
}

/**
 * Capabilities the opencode backend advertises. opencode covers the
 * full Phase 3 surface (resume, fork, file upload, thinking, subagent,
 * debug, askQuestion) but NOT skill events, since opencode has no
 * Anthropic-style skill loader. `askQuestion=true` because opencode
 * ships a first-class `Question.Service` plus `tool/question.ts`
 * native question tool that the driver maps onto the canonical
 * `session/ask_user_question` outbound RPC (see Phase 3 D4).
 */
const FULL_CAPABILITIES: DriverCapabilities = {
  resume: true,
  fork: true,
  fileUpload: true,
  thinking: true,
  subagent: true,
  skillEvents: false,
  debug: true,
  askQuestion: true,
}

/**
 * Concrete driver implementing every BackendDriver method against the
 * opencode HTTP server. Phase 3 T1 ships only the scaffold: capability
 * advertisement + initialize handshake. Subsequent tasks layer the
 * http-bridge, newSession, prompt, etc. on top; until then every
 * lifecycle method throws {@link MethodNotSupportedError} so callers
 * branch on type, not silent no-ops.
 */
export class OpencodeDriver implements BackendDriver {
  public constructor(private readonly deps: OpencodeDriverDeps) {}

  public capabilities(): DriverCapabilities {
    return FULL_CAPABILITIES
  }

  public async initialize(_params: InitializeRequest): Promise<InitializeResult> {
    return {
      protocolVersion: 1,
      agentInfo: this.deps.agentInfo,
      capabilities: FULL_CAPABILITIES,
    }
  }

  public async newSession(_params: NewSessionRequest): Promise<NewSessionResult> {
    throw new MethodNotSupportedError('session/new', this.supportedMethodNames())
  }

  public async prompt(_sessionId: string, _params: PromptRequest, _emit: EventEmitter): Promise<PromptResult> {
    throw new MethodNotSupportedError('session/prompt', this.supportedMethodNames())
  }

  public async cancel(_request: CancelRequest): Promise<void> {
    throw new MethodNotSupportedError('session/cancel', this.supportedMethodNames())
  }

  public async loadSession(_params: LoadSessionRequest): Promise<NewSessionResult> {
    throw new MethodNotSupportedError('session/load', this.supportedMethodNames())
  }

  public async forkSession(_params: ForkSessionRequest): Promise<NewSessionResult> {
    throw new MethodNotSupportedError('session/fork', this.supportedMethodNames())
  }

  /**
   * Build the supported-methods list embedded in the
   * MethodNotSupportedError data payload. Subsequent tasks expand
   * this as each lifecycle method goes live.
   */
  private supportedMethodNames(): ReadonlyArray<string> {
    return ['initialize']
  }
}
