/**
 * Opencode backend driver.
 *
 * Drives the opencode HTTP server via the official
 * `createOpencodeServer()` SDK helper (one server per Kodizm session,
 * same one-process-per-session invariant as codex). The driver
 * translates Kodizm canonical wire shapes (NewSessionRequest,
 * PromptRequest, etc.) to opencode's native REST + SSE protocol; the
 * orchestrator never sees opencode shapes.
 *
 * Phase 3 progressive build:
 *   T1  scaffold (capabilities + initialize, stubs throw MNS)
 *   T2  http-bridge: createOpencodeServer wrapper + lifecycle
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

import { randomUUID } from 'node:crypto'

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
import { OpencodeHttpBridge, type OpencodeHttpBridgeHandle } from './http-bridge.ts'

/**
 * Construction-time dependencies for the opencode driver. Phase 3 T2+
 * extends this with `server` (AcpServerLike for outbound RPCs),
 * `deferredStore`, and `opencodeDataDir` overrides (mirrors
 * `CodexDriverDeps`).
 */
export interface OpencodeDriverDeps {
  /**
   * Agent banner returned by `initialize`. Production reads
   * `package.json#version`; tests inject a fixed value so snapshots
   * are stable.
   */
  agentInfo: { version: string }
  /**
   * Optional bridge factory. Production omits this; tests inject a
   * fake bridge to avoid spawning a real opencode subprocess. Default
   * factory builds {@link OpencodeHttpBridge}.
   */
  bridgeFactory?: () => OpencodeHttpBridge
}

/**
 * Per-session state held by the driver. Mirrors codex's
 * `CodexSessionState` shape so future Phase 1.7 lifecycle modules
 * (heartbeat, inactivity probe, debug recorder, error classifier)
 * plug in unchanged.
 */
interface OpencodeSessionState {
  sessionId: string
  bridge: OpencodeHttpBridge
  /**
   * opencode's own session id, captured from `session.create`.
   * Driver-internal; orchestrator never sees this.
   */
  opencodeSessionId: string
  /**
   * Bridge handle returned from `bridge.start()`; cached so prompt /
   * cancel paths skip re-resolving the SDK client.
   */
  handle: OpencodeHttpBridgeHandle
  /**
   * Snapshot of cwd / mcpServers / model so future loadSession or
   * fork calls have a baseline to merge against.
   */
  configSnapshot: {
    cwd: string
    model?: string
  }
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
 * Default factory: one fresh {@link OpencodeHttpBridge} per session.
 */
const DEFAULT_BRIDGE_FACTORY = (): OpencodeHttpBridge => new OpencodeHttpBridge()

/**
 * Concrete driver implementing every BackendDriver method against the
 * opencode HTTP server. Phase 3 progressive build; T3 ships
 * newSession over a real listener + session.create.
 */
export class OpencodeDriver implements BackendDriver {
  private readonly sessions: Map<string, OpencodeSessionState> = new Map()
  private readonly bridgeFactory: () => OpencodeHttpBridge

  public constructor(private readonly deps: OpencodeDriverDeps) {
    this.bridgeFactory = deps.bridgeFactory ?? DEFAULT_BRIDGE_FACTORY
  }

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

  public async newSession(params: NewSessionRequest): Promise<NewSessionResult> {
    const sessionId = randomUUID()

    // 1. Build the per-session env (Phase 3 D9). The OPENCODE_AUTH_CONTENT
    //    blob carries provider credentials; layered onto process.env
    //    only for the duration of the subprocess spawn.
    const env = this.buildAuthEnv(params)

    // 2. Boot a fresh opencode server for this session. The bridge
    //    spawns 'opencode serve --port 0 --hostname 127.0.0.1' under
    //    the hood and waits for the listening marker.
    const bridge = this.bridgeFactory()
    const handle = await bridge.start({ env })

    // 3. Create the opencode session via the v1 session API. Returns
    //    a server-allocated session id (`ses_...`) we cache for
    //    prompt / cancel routing. Future tasks layer model / permission
    //    rules / per-session config; T3 keeps the create call minimal.
    const createResult = await handle.sdk.session.create({})
    const opencodeSessionId = this.extractSessionId(createResult)

    // 4. Persist driver-internal state. Orchestrator only sees the
    //    Kodizm sessionId; opencode's id stays inside the driver.
    this.sessions.set(sessionId, {
      sessionId,
      bridge,
      opencodeSessionId,
      handle,
      configSnapshot: {
        cwd: params.cwd,
        ...(params.model === undefined ? {} : { model: params.model }),
      },
    })

    return { sessionId }
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
   * Test helper: returns a snapshot of `Kodizm sessionId -> opencode sessionId`
   * pairs so suites can assert distinct ids without touching internal state.
   * Production code never calls this.
   */
  public debugSessionIds(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [k, v] of this.sessions) {
      out.set(k, v.opencodeSessionId)
    }
    return out
  }

  /**
   * Tear down every active session's bridge. Production drivers
   * dispose at process exit through the existing shutdown hook;
   * tests call this in `finally` to avoid leaking subprocesses
   * across cases.
   */
  public async disposeAll(): Promise<void> {
    const bridges = [...this.sessions.values()].map((s) => s.bridge)
    this.sessions.clear()
    await Promise.all(bridges.map((b) => b.stop().catch(() => undefined)))
  }

  /**
   * Translate canonical `_meta.opencodeAuth` (Phase 3 D9) into the
   * `OPENCODE_AUTH_CONTENT` env var the opencode subprocess reads at
   * boot. Empty when the orchestrator does not pass auth; production
   * Kodizm flows attach this from the agent_session row.
   */
  private buildAuthEnv(params: NewSessionRequest): Record<string, string> {
    const meta = (params._meta ?? {}) as { opencodeAuth?: string | Record<string, unknown> }
    if (meta.opencodeAuth === undefined) {
      return {}
    }
    const value = typeof meta.opencodeAuth === 'string' ? meta.opencodeAuth : JSON.stringify(meta.opencodeAuth)
    return { OPENCODE_AUTH_CONTENT: value }
  }

  /**
   * Pull the opencode session id out of the SDK's RequestResult.
   * The SDK returns `{data, error, response}` where `data` is the
   * parsed body. We accept the shape defensively because the SDK's
   * generic typing leaks `unknown` in places.
   */
  private extractSessionId(result: unknown): string {
    const r = result as { data?: { id?: unknown }; id?: unknown }
    const fromData = r?.data?.id
    if (typeof fromData === 'string' && fromData.length > 0) {
      return fromData
    }
    const direct = r?.id
    if (typeof direct === 'string' && direct.length > 0) {
      return direct
    }
    throw new Error('opencode session.create returned no session id')
  }

  /**
   * Build the supported-methods list embedded in the
   * MethodNotSupportedError data payload. Subsequent tasks expand
   * this as each lifecycle method goes live.
   */
  private supportedMethodNames(): ReadonlyArray<string> {
    return ['initialize', 'session/new']
  }
}
