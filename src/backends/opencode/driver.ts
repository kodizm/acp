/**
 * Opencode backend driver.
 *
 * Drives the opencode HTTP server via the official
 * `createOpencodeServer()` SDK helper (one server per Kodizm session,
 * one process per session). The driver
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
import { createLogger } from '../../util/logger.ts'
import type { SessionUpdateEvent } from '../../wire/events.ts'
import type {
  CancelRequest,
  CompactSessionRequest,
  ForkSessionRequest,
  InitializeRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from '../../wire/types.ts'
import type { AcpServerLike } from '../claude/permission-bridge.ts'
import type {
  BackendDriver,
  DriverCapabilities,
  EventEmitter,
  InitializeResult,
  NewSessionResult,
  PromptResult,
} from '../driver.ts'
import { handleOpencodeQuestion } from './ask-user-question.ts'
import { classifyOpencodeError } from './error-classifier.ts'
import { OpencodeEventMapper } from './event-mapper.ts'
import { OpencodeHttpBridge, type OpencodeHttpBridgeHandle } from './http-bridge.ts'
import { buildOpencodeMcpAdds } from './mcp-mapper.ts'
import { handleOpencodePermission } from './permission-bridge.ts'
import { buildOpencodeRuleset } from './policy.ts'
import { type OpencodePart, buildOpencodeParts } from './prompt-input.ts'
import { dispatchOpencodeEvent, isTurnComplete } from './prompt-stream.ts'

/**
 * Construction-time dependencies for the opencode driver. Phase 3 T2+
 * extends this with `server` (AcpServerLike for outbound RPCs),
 * `deferredStore`, and `opencodeDataDir` overrides (mirrors
 * the claude driver's deps shape).
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
  /**
   * AcpServer reference used to send outbound permission +
   * AskUserQuestion RPCs. Optional so unit tests that exercise the
   * driver without a wire surface keep working. Production +
   * integration smokes always provide it.
   */
  server?: AcpServerLike
}

/**
 * Per-session state held by the driver. Mirrors the claude driver's
 * per-session state shape so future lifecycle modules
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
   * Reverse MCP name map produced by `buildOpencodeMcpAdds` so the
   * event-mapper can resolve `<sanitizedServer>_<tool>` keys back to
   * the canonical `mcp__<server>__<tool>` shape.
   */
  mcpReverseMap: Map<string, string>
  /**
   * Snapshot of cwd / mcpServers / model so future loadSession or
   * fork calls have a baseline to merge against.
   */
  configSnapshot: {
    cwd: string
    model?: string
  }
  /**
   * Per-turn abort controller. T10 sets this before opening the SSE
   * stream; cancel() flips it to terminate dispatch + the outbound
   * SDK prompt call.
   */
  activePromptController?: AbortController
  /**
   * One-shot latch for `model_advertisement`. The driver emits the
   * event the first time prompt() runs against this session so the
   * orchestrator can stamp the session row's model field; later
   * prompts skip re-advertising the same model unless the orchestrator
   * passes a per-turn override.
   */
  modelAdvertised?: boolean
  /**
   * Latch flipped true by {@link OpencodeDriver.compact} before the
   * `session.summarize({auto: false})` SDK call. Cleared the moment
   * the matching `session.compacted` SSE event arrives. While true,
   * the compact flow's local mapper override re-tags
   * `compaction_started` + `compaction_completed` with
   * `trigger: 'manual'` (opencode's `session.compacted` SSE event
   * carries no trigger field, so the default mapper falls back to
   * 'auto').
   */
  pendingManualCompact?: boolean
  /**
   * Captured providerID + modelID for the session. opencode's
   * `session.summarize` requires both; we cache them at session.create
   * time so compact() can fire without rebuilding the model identity.
   */
  providerID?: string
  modelID?: string
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
/**
 * Stderr-only logger. The event loop used to exit silently on every
 * unexpected condition, which is why a mis-scoped subscription looked
 * like a protocol bug for hours.
 */
const logger = createLogger({ env: process.env as Record<string, string | undefined> })

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
    //    prompt / cancel routing. The `permission` ruleset comes from
    //    the policy translator (D5); when the orchestrator omits
    //    toolPolicy the ruleset is empty and opencode falls back to
    //    its own per-tool ask flow. `directory` is the per-session
    //    project root opencode walks for AGENTS.md / CLAUDE.md / CONTEXT.md
    //    (`references/opencode/packages/opencode/src/session/instruction.ts:79,121`).
    //    Mirrors the upstream ACP impl at
    //    `references/opencode/packages/opencode/src/acp/session.ts:24`.
    const ruleset = buildOpencodeRuleset(params.toolPolicy)
    const createParams: Record<string, unknown> = { directory: params.cwd }
    if (ruleset.length > 0) {
      createParams.permission = ruleset
    }
    const createResult = await handle.sdk.session.create(createParams)
    const opencodeSessionId = this.extractSessionId(createResult)

    // 4. Inject MCP servers via per-session add(). Returns the reverse
    //    name map so subsequent prompt() calls can translate
    //    `<sanitizedServer>_<tool>` event names back to canonical
    //    `mcp__<server>__<tool>` (D6).
    const mcpAdds = buildOpencodeMcpAdds(params.mcpServers)
    for (const entry of mcpAdds.adds) {
      await this.tryAddMcpServer(handle, opencodeSessionId, entry.name, entry.config).catch(() => undefined)
    }

    // 5. Persist driver-internal state. Orchestrator only sees the
    //    Kodizm sessionId; opencode's id stays inside the driver.
    const parsedModel = this.parseCanonicalModel(params.model)
    this.sessions.set(sessionId, {
      sessionId,
      bridge,
      opencodeSessionId,
      handle,
      mcpReverseMap: mcpAdds.reverseMap,
      configSnapshot: {
        cwd: params.cwd,
        ...(params.model === undefined ? {} : { model: params.model }),
      },
      ...(parsedModel === undefined ? {} : { providerID: parsedModel.providerID, modelID: parsedModel.modelID }),
    })

    return { sessionId }
  }

  /**
   * Best-effort MCP add via opencode's mcp/add HTTP endpoint. Older
   * builds expose the call differently; the catch-all in newSession
   * means an unsupported add does not crash session create.
   */
  private async tryAddMcpServer(
    handle: OpencodeHttpBridgeHandle,
    opencodeSessionId: string,
    name: string,
    config: { type: 'remote'; url: string; headers?: Record<string, string> },
  ): Promise<void> {
    const mcpApi = handle.sdk.mcp as unknown as {
      add?: (params: unknown) => Promise<unknown>
    }
    if (typeof mcpApi.add !== 'function') return
    await mcpApi.add({
      name,
      body: config,
      sessionID: opencodeSessionId,
    })
  }

  public async prompt(sessionId: string, params: PromptRequest, emit: EventEmitter): Promise<PromptResult> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      throw new MethodNotSupportedError('session/prompt', this.supportedMethodNames())
    }

    // 1. Per-turn abort controller; cancel() flips this.
    const controller = new AbortController()
    state.activePromptController = controller

    // 2. Bus event mapper translates opencode -> canonical sessionUpdate.
    //    Wrap emit with the manual-compact latch override so the events
    //    mapped from `session.updated.time.compacting` + `session.compacted`
    //    re-tag trigger:'manual' when compact() initiated the compaction.
    const eventMapper = new OpencodeEventMapper({
      sessionId,
      emit: (e) => emit.send(this.applyManualCompactLatch(state, e)),
      mcpReverseMap: state.mcpReverseMap,
    })

    // 3. Subscribe to the SSE event stream + dispatch in parallel
    //    with the prompt RPC. The dispatch loop resolves on
    //    isTurnComplete() OR on signal abort. Permission + question
    //    bridges fire only when the orchestrator wired a server ref;
    //    otherwise opencode's own UI prompts continue to handle them.
    const server = this.deps.server
    const subscriptionPromise = this.runEventLoop({
      handle: state.handle,
      controller,
      directory: state.configSnapshot.cwd,
      handlers: {
        onMessageBus: (method, properties) => eventMapper.handle(method, properties),
        onPermissionAsked: (properties) => {
          if (server === undefined) return
          void handleOpencodePermission({
            params: properties as Parameters<typeof handleOpencodePermission>[0]['params'],
            server,
            sessionId,
            sdk: state.handle.sdk as unknown as Parameters<typeof handleOpencodePermission>[0]['sdk'],
            emit: { send: (e) => emit.send(e) },
            signal: controller.signal,
            mcpReverseMap: state.mcpReverseMap,
          })
        },
        onQuestionAsked: (properties) => {
          if (server === undefined) return
          void handleOpencodeQuestion({
            params: properties as Parameters<typeof handleOpencodeQuestion>[0]['params'],
            server,
            sessionId,
            sdk: state.handle.sdk as unknown as Parameters<typeof handleOpencodeQuestion>[0]['sdk'],
            emit: { send: (e) => emit.send(e) },
            signal: controller.signal,
          })
        },
        onSessionError: (properties) => {
          logger.error('opencode session.error on the event bus', {
            sessionId,
            properties: JSON.stringify(properties).slice(0, 400),
          })
        },
      },
    })

    // 4. Send the actual prompt to opencode. Either v2 prompt or v1
    //    fallback depending on what the SDK exposes.
    const parts = buildOpencodeParts(params)
    let stopReason: PromptResult['stopReason'] = 'end_turn'
    let failureDetail: string | undefined
    let failureReason: PromptResult['failureReason']

    try {
      // Per-turn model precedence: PromptRequest.model > session
      // newSession.model. Either string is canonical
      // 'providerID/modelID' (D13).
      const turnModel = params.model ?? state.configSnapshot.model

      // One-shot model_advertisement at first prompt with a known
      // model (or when the per-turn override changes it). Mirrors the
      // the claude driver's modelAdvertised latch.
      if (turnModel !== undefined && state.modelAdvertised !== true) {
        state.modelAdvertised = true
        emit.send({
          sessionId,
          type: 'model_advertisement',
          model: turnModel,
        })
      }
      await this.sendPrompt({
        handle: state.handle,
        opencodeSessionId: state.opencodeSessionId,
        parts,
        model: turnModel,
        signal: controller.signal,
      })
      // Turn is done at the SDK level. Give the SSE loop a tiny grace
      // window so any tail events that arrive between SDK resolve and
      // the message.updated frame still flow through; then abort.
      await Promise.race([subscriptionPromise, new Promise<void>((resolve) => setTimeout(resolve, 750))])
      controller.abort()
      await subscriptionPromise.catch(() => undefined)
    } catch (err) {
      if (controller.signal.aborted) {
        stopReason = 'cancelled'
      } else {
        const classified = classifyOpencodeError(err)
        if (classified === null) {
          stopReason = 'cancelled'
        } else {
          stopReason = 'session_failed'
          failureReason = classified.reason
          failureDetail = classified.detail
        }
      }
    } finally {
      state.activePromptController = undefined
    }

    const result: PromptResult = { stopReason }
    if (failureReason !== undefined) result.failureReason = failureReason
    if (failureDetail !== undefined) result.failureDetail = failureDetail
    return result
  }

  private async runEventLoop(args: {
    handle: OpencodeHttpBridgeHandle
    controller: AbortController
    directory: string
    handlers: Parameters<typeof dispatchOpencodeEvent>[1]
  }): Promise<void> {
    const eventApi = args.handle.sdk.event as unknown as {
      subscribe?: (
        params?: unknown,
        options?: unknown,
      ) => Promise<{
        stream?: AsyncIterable<{ event?: string; data?: unknown }>
      }>
    }
    if (typeof eventApi.subscribe !== 'function') {
      logger.error('opencode sdk exposes no event.subscribe; no session events will be mapped')
      return
    }

    let result: { stream?: AsyncIterable<{ event?: string; data?: unknown }> }
    try {
      // `directory` is REQUIRED, not optional. The v2 client builds the
      // /event request with `directory` + `workspace` as query params
      // (see `v2/gen/sdk.gen.js`, buildClientParams), so an empty
      // parameters object scopes the stream to whatever directory the
      // bin's own process cwd resolves to. Sessions run in
      // /workspace/<repo> while the bin is spawned elsewhere, so the
      // subscription then listens to the wrong scope and receives only
      // global frames (`server.connected`, `server.heartbeat`) while
      // every `message.part.updated` for the turn goes to the scope
      // nobody is watching.
      //
      // Measured: session cwd equal to process cwd emits
      // model_advertisement + output_chunk + usage; session cwd
      // different emits model_advertisement alone. The second case is
      // every production session.
      result = await eventApi.subscribe({ directory: args.directory }, { signal: args.controller.signal })
    } catch (e) {
      logger.error('opencode event.subscribe rejected; the turn will emit no content', {
        error: e instanceof Error ? e.message : String(e),
        directory: args.directory,
      })
      return
    }

    const stream = result?.stream
    if (stream === undefined) {
      logger.error('opencode event.subscribe returned no stream', {
        keys: Object.keys((result ?? {}) as Record<string, unknown>).join(','),
      })
      return
    }

    for await (const frame of stream) {
      if (args.controller.signal.aborted) break

      const parsed = this.parseEventFrame(frame)
      if (parsed === undefined) continue

      dispatchOpencodeEvent(parsed, args.handlers)
      if (isTurnComplete(parsed)) break
    }
  }

  private parseEventFrame(frame: unknown): { type: string; properties: unknown } | undefined {
    if (frame === null || typeof frame !== 'object') return undefined
    const f = frame as { event?: string; type?: string; data?: unknown; properties?: unknown }
    const type = f.event ?? f.type
    if (typeof type !== 'string') return undefined
    return { type, properties: f.properties ?? f.data ?? {} }
  }

  private async sendPrompt(args: {
    handle: OpencodeHttpBridgeHandle
    opencodeSessionId: string
    parts: OpencodePart[]
    model: string | undefined
    signal: AbortSignal
  }): Promise<void> {
    const v1Session = args.handle.sdk.session as unknown as {
      prompt?: (params: unknown) => Promise<{ data?: unknown; error?: unknown }>
    }
    if (v1Session.prompt === undefined) {
      throw new Error('opencode SDK session.prompt is not available on this build')
    }

    // Build the v1 SessionPromptParams: parts array + optional model
    // tuple (providerID + modelID). The canonical wire model is
    // 'providerID/modelID' (D13); split on the first '/' before
    // forwarding.
    const promptParams: Record<string, unknown> = {
      sessionID: args.opencodeSessionId,
      parts: args.parts,
    }
    const parsedModel = this.parseCanonicalModel(args.model)
    if (parsedModel !== undefined) {
      promptParams.model = parsedModel
    }

    const result = await v1Session.prompt(promptParams)
    if (result?.error !== undefined && this.errorEnvelopeIsNonEmpty(result.error)) {
      throw new Error(`opencode session.prompt error: ${JSON.stringify(result.error).slice(0, 200)}`)
    }
  }

  private errorEnvelopeIsNonEmpty(error: unknown): boolean {
    if (error === null || typeof error !== 'object') return false
    return Object.keys(error as Record<string, unknown>).length > 0
  }

  /**
   * Split canonical 'providerID/modelID' into the {providerID, modelID}
   * shape opencode's session.prompt accepts. Returns undefined when
   * the orchestrator omitted model (opencode falls back to its
   * provider default).
   */
  private parseCanonicalModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
    if (model === undefined || model === '') return undefined
    const slash = model.indexOf('/')
    if (slash <= 0 || slash === model.length - 1) return undefined
    return {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    }
  }

  public async cancel(request: CancelRequest): Promise<void> {
    const state = this.sessions.get(request.sessionId)
    if (state === undefined) return

    // 1. Cancel any in-flight prompt at the SDK layer; this fires a
    //    POST /session/:id/abort against the opencode HTTP server.
    if (state.activePromptController !== undefined) {
      state.activePromptController.abort()
      state.activePromptController = undefined
    }
    try {
      const sessionApi = state.handle.sdk.session as unknown as {
        abort?: (params: { sessionID: string }) => Promise<unknown>
      }
      if (typeof sessionApi.abort === 'function') {
        await sessionApi.abort({ sessionID: state.opencodeSessionId })
      }
    } catch {
      // Best-effort abort; subprocess teardown below catches the rest.
    }

    // 2. Tear down the per-session bridge (subprocess termination).
    //    Removes the entry from the map so the next prompt() returns
    //    SessionNotFoundError instead of resurrecting a dead listener.
    const bridge = state.bridge
    this.sessions.delete(request.sessionId)
    await bridge.stop().catch(() => undefined)
  }

  public async loadSession(params: LoadSessionRequest): Promise<NewSessionResult> {
    // 1. Already-known session: validate the cached state and return.
    const cached = this.sessions.get(params.sessionId)
    if (cached !== undefined) {
      return { sessionId: params.sessionId }
    }

    // 2. Cross-process resume (Pattern B). The orchestrator passes the
    //    Kodizm sessionId; opencode SQLite-persists the underlying
    //    server-side session, so a fresh listener plus a get() probe
    //    seats the state without re-creating the opencode session.
    //    The orchestrator side is responsible for reconciling the
    //    Kodizm <-> opencode id mapping via _meta.opencodeSessionId
    //    (cross-process Pattern B contract).
    const meta = (params._meta ?? {}) as { opencodeSessionId?: string }
    if (meta.opencodeSessionId === undefined) {
      throw new MethodNotSupportedError('session/load', this.supportedMethodNames())
    }

    const bridge = this.bridgeFactory()
    const handle = await bridge.start({})

    const sessionApi = handle.sdk.session as unknown as {
      get?: (parameters: { sessionID: string; directory?: string }) => Promise<unknown>
    }
    if (typeof sessionApi.get === 'function') {
      try {
        await sessionApi.get({ sessionID: meta.opencodeSessionId, directory: params.cwd })
      } catch (err) {
        await bridge.stop().catch(() => undefined)
        throw err
      }
    }

    this.sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      bridge,
      opencodeSessionId: meta.opencodeSessionId,
      handle,
      mcpReverseMap: new Map(),
      configSnapshot: { cwd: params.cwd },
    })

    return { sessionId: params.sessionId }
  }

  public async forkSession(params: ForkSessionRequest): Promise<NewSessionResult> {
    const source = this.sessions.get(params.sourceSessionId)
    if (source === undefined) {
      throw new MethodNotSupportedError('session/fork', this.supportedMethodNames())
    }

    const newSessionId = randomUUID()

    // 1. Reuse the source session's listener (no fresh subprocess; the
    //    fork shares the opencode HTTP server with the parent so the
    //    SQLite-side fork is atomic). Capability isolation is handled
    //    on the opencode side: each fork gets its own session row.
    const sessionApi = source.handle.sdk.session as unknown as {
      fork?: (parameters: {
        sessionID: string
        directory?: string
        messageID?: string
      }) => Promise<{ data?: { id?: string }; id?: string }>
    }

    if (typeof sessionApi.fork !== 'function') {
      throw new MethodNotSupportedError('session/fork', this.supportedMethodNames())
    }

    const forkResult = await sessionApi.fork({
      sessionID: source.opencodeSessionId,
      directory: params.cwd,
    })
    const forkedOpencodeId = this.extractSessionId(forkResult)

    this.sessions.set(newSessionId, {
      sessionId: newSessionId,
      bridge: source.bridge,
      opencodeSessionId: forkedOpencodeId,
      handle: source.handle,
      mcpReverseMap: source.mcpReverseMap,
      configSnapshot: {
        cwd: params.cwd,
        ...(params.model === undefined ? {} : { model: params.model }),
      },
    })

    return { sessionId: newSessionId }
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
   * Test helper: expose the per-session bridge handle (URL + SDK
   * client) so smoke suites can subscribe to opencode bus events
   * directly while exercising the driver. Production code routes
   * everything through the driver's internal dispatch and never
   * needs this. Returns undefined when the session is not active.
   */
  public debugHandleFor(sessionId: string): OpencodeHttpBridgeHandle | undefined {
    return this.sessions.get(sessionId)?.handle
  }

  /**
   * Tear down every active session's bridge, which is what actually
   * terminates the per-session `opencode serve` subprocess.
   *
   * The bin's SIGTERM / SIGINT handler calls this through
   * `ShutdownOptions.disposeDriver`. It did not until 0.6.2: this
   * docblock previously claimed production disposed at process exit
   * while the only callers were tests, so every session leaked its
   * server. Six accumulated in one production container and filled
   * its 1 GiB cgroup to 99.4 % with two OOM kills.
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
   * `session/compact`: dispatches opencode's
   * `sdk.session.summarize({sessionID, providerID, modelID, auto: false})`
   * against the session's running opencode HTTP server. Sets
   * {@link OpencodeSessionState.pendingManualCompact} on the state
   * before the dispatch so the local mapper override re-tags the
   * resulting `compaction_started` / `compaction_completed` events
   * with `trigger: 'manual'` (opencode's `session.compacted` SSE
   * event carries no trigger field).
   *
   * Unlike Claude, opencode's compaction is fire-and-track:
   * the SDK call returns immediately with a 202; the actual
   * `compaction_started` (mapped from `session.updated.time.compacting`)
   * + `compaction_completed` (mapped from `session.compacted`)
   * notifications flow on the persistent SSE stream the prompt()
   * loop subscribes to. compact() awaits the latch's clear so the
   * caller observes a settled compaction.
   *
   * @throws {SessionNotFoundError} when the session id is unknown OR
   *         when providerID / modelID was never captured (session
   *         opened with no model field; opencode requires both for
   *         summarize)
   */
  public async compact(request: CompactSessionRequest, _emit: EventEmitter): Promise<void> {
    const state = this.sessions.get(request.sessionId)
    if (state === undefined) {
      throw new MethodNotSupportedError('session/compact', this.supportedMethodNames())
    }
    if (state.providerID === undefined || state.modelID === undefined) {
      throw new MethodNotSupportedError('session/compact (no model captured)', this.supportedMethodNames())
    }

    state.pendingManualCompact = true

    const sessionApi = state.handle.sdk.session as unknown as {
      summarize?: (parameters: {
        path: { sessionID: string }
        body: { providerID: string; modelID: string; auto: boolean }
      }) => Promise<unknown>
    }

    if (typeof sessionApi.summarize !== 'function') {
      state.pendingManualCompact = false
      throw new MethodNotSupportedError('session/compact (sdk.summarize unavailable)', this.supportedMethodNames())
    }

    try {
      await sessionApi.summarize({
        path: { sessionID: state.opencodeSessionId },
        body: {
          providerID: state.providerID,
          modelID: state.modelID,
          auto: false,
        },
      })
    } catch (error) {
      state.pendingManualCompact = false
      throw error
    }

    // Resulting compaction_started + compaction_completed events flow
    // on the persistent SSE stream that the active prompt() loop
    // subscribes to via OpencodeEventMapper. The mapper's emit hook
    // (wired in T8 alongside this compact() impl) checks the latch
    // and re-tags trigger:'manual' before firing through to the
    // emit passed in here. The latch self-clears the moment
    // compaction_completed lands, so callers do NOT need to await
    // here; subsequent calls to compact() simply re-arm the latch.
  }

  /**
   * Build the supported-methods list embedded in the
   * MethodNotSupportedError data payload. Subsequent tasks expand
   * this as each lifecycle method goes live.
   */
  private supportedMethodNames(): ReadonlyArray<string> {
    return ['initialize', 'session/new']
  }

  /**
   * Override `compaction_started` / `compaction_completed` events to
   * carry `trigger: 'manual'` while the per-session
   * {@link OpencodeSessionState.pendingManualCompact} latch is on.
   * Clears the latch the moment a `compaction_completed` event lands
   * so a subsequent unrelated auto-compaction stays correctly tagged.
   *
   * opencode's `session.compacted` SSE event carries no trigger
   * field; without the latch the mapper defaults to 'auto'. The
   * latch is the only signal distinguishing manual from auto on
   * this backend.
   */
  private applyManualCompactLatch(state: OpencodeSessionState, event: SessionUpdateEvent): SessionUpdateEvent {
    if (state.pendingManualCompact !== true) {
      return event
    }
    if (event.type === 'compaction_started') {
      return { ...event, trigger: 'manual' }
    }
    if (event.type === 'compaction_completed') {
      state.pendingManualCompact = false
      return { ...event, trigger: 'manual' }
    }
    return event
  }
}
