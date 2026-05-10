/**
 * Claude backend driver.
 *
 * Drives `@anthropic-ai/claude-agent-sdk` directly (no claude-agent-acp
 * shim). Implements every method on the {@link BackendDriver} contract
 * with full feature surface advertised through {@link DriverCapabilities}.
 *
 * Translation seam: the Kodizm-canonical wire shapes (NewSessionRequest,
 * PromptRequest, etc.) come in pre-validated by the AcpServer dispatch
 * layer; the driver maps them down to the SDK's `Options` shape. Outgoing
 * events stream out as Kodizm canonical {@link SessionUpdateEvent} values
 * via {@link mapSdkMessage}, which the AcpServer wraps into wire-side
 * `sessionUpdate` notifications.
 *
 * SDK adapter indirection: production code constructs the driver with
 * the real `@anthropic-ai/claude-agent-sdk` query function; tests pass
 * a mock through {@link ClaudeDriverDeps} so unit tests stay free of
 * network calls.
 */

import { randomUUID } from 'node:crypto'

import { SessionNotFoundError } from '../../server/errors.ts'
import { HeartbeatTimer } from '../../server/heartbeat.ts'
import type { DeferredPermissionStore } from '../../session/deferred-store.ts'
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
import type {
  BackendDriver,
  DriverCapabilities,
  EventEmitter,
  InitializeResult,
  NewSessionResult,
  PromptResult,
} from '../driver.ts'
import { askUserQuestionBranch } from './ask-user-question.ts'
import type { ClaudeCredentials } from './auth.ts'
import { findSessionJsonlPath, writeDeferredToolResult } from './deferred-permission.ts'
import { classifyClaudeError } from './error-classifier.ts'
import { type SdkMessage, mapSdkMessage } from './event-mapper.ts'
import { type ClaudeSdkMcpServer, translateMcpServers } from './mcp-bridge.ts'
import { buildCanUseTool } from './permission-bridge.ts'
import { translateToolPolicyToClaude } from './policy.ts'
import { type ClaudeSdkUserMessage, buildClaudePromptInput } from './prompt-input.ts'
import { SubagentTracker } from './subagent.ts'

/**
 * Claude SDK Options subset the driver builds + forwards. Defining
 * this locally instead of importing the SDK's exported type keeps unit
 * tests independent of SDK loading.
 */
export interface ClaudeSdkOptions {
  cwd: string
  mcpServers: Record<string, ClaudeSdkMcpServer>
  additionalDirectories?: string[]
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string }
  model?: string
  /**
   * Skills to pre-load into the session's system prompt. The SDK
   * filters its skill listing to these names; unlisted skills stay
   * hidden from the model. Pass `'all'` (the SDK default) to keep
   * every discovered skill, or omit the field for the SDK default.
   */
  skills?: string[] | 'all'
  resume?: string
  forkSessionId?: string
  abortController?: AbortController
  /**
   * Tool gate. When `defaultMode` is set on the wire, the driver
   * threads it here; otherwise the policy translator defaults to
   * 'bypassPermissions' (Kodizm runs sandboxed).
   */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'
  allowedTools?: string[]
  disallowedTools?: string[]
  /**
   * SDK settings sources. Pass `[]` to disable filesystem settings
   * (SDK isolation mode); the driver does NOT set this by default
   * because production runs want user / project / local settings
   * layered. Integration smokes pass `[]` to keep tests
   * deterministic vs. the developer's local settings.json.
   */
  settingSources?: Array<'user' | 'project' | 'local'>
  /**
   * Optional canUseTool gate. When set, the SDK calls it before every
   * tool_use turn and awaits a PermissionResult. The driver builds
   * this via permission-bridge from the per-session toolPolicy +
   * permissionTimeoutMs.
   */
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: import('./permission-bridge.ts').CanUseToolOptions,
  ) => Promise<import('./permission-bridge.ts').PermissionResult>
  /**
   * Per-call env injection. Used to disable auto-compaction
   * (`DISABLE_AUTO_COMPACT=1`) when `params.autoCompact === false`.
   */
  env?: Record<string, string>
  /**
   * Subset of SDK rule machinery. ToolPolicy.ask becomes a session-scope
   * `addRules` PermissionUpdate; the driver assembles + spreads here.
   */
  permissions?: {
    additionalDirectories?: string[]
    rules?: Array<{
      type: 'addRules'
      rules: Array<{ toolName: string; ruleContent?: string }>
      behavior: 'allow' | 'deny' | 'ask'
      destination: 'session'
    }>
  }
}

/**
 * SDK adapter contract. Production injects the real claude-agent-sdk
 * query function; tests inject a mock generator.
 */
export interface SdkAdapter {
  /**
   * Run a single turn against the SDK. The async generator yields
   * SDK messages until the turn settles (assistant emits a stop
   * reason or the abort controller fires).
   */
  query(options: {
    prompt: string | AsyncIterable<ClaudeSdkUserMessage>
    options: ClaudeSdkOptions
  }): AsyncIterable<SdkMessage>
}

/**
 * Driver dependencies. Construction accepts everything the driver
 * needs to operate; nothing is read from a global scope.
 */
export interface ClaudeDriverDeps {
  credentials: ClaudeCredentials
  agentInfo: { version: string }
  sdk: SdkAdapter
  /**
   * AcpServer reference used by the driver to issue outbound RPCs
   * (`session/request_permission`, `session/ask_user_question`).
   * Optional so unit tests that exercise the driver without a wire
   * surface (e.g., basic newSession + prompt smoke) keep working.
   * The integration tests + production bin always provide it.
   */
  server?: import('./permission-bridge.ts').AcpServerLike
  /**
   * Optional Pattern B deferred-permission store. When provided + the
   * session opts in via `permissionDeferTimeoutMs`, the driver
   * persists deferred state here on Process A and reads cached
   * answers from it on Process B. Phase 4 wires the production
   * Laravel-DB binding; Phase 1.6 ships the in-memory binding for
   * tests + local dev.
   */
  deferredStore?: DeferredPermissionStore
  /**
   * Override for the `~/.claude` config home. Used by tests to
   * isolate JSONL writes from the developer's real transcript dir.
   * Production omits this (defaults to `homedir()/.claude`).
   */
  claudeConfigHome?: string
}

/**
 * Per-session state held by the driver. Keyed on the sessionId
 * allocated at newSession time.
 */
interface SessionState {
  sessionId: string
  options: ClaudeSdkOptions
  abortController?: AbortController
  parentSessionId?: string
  /**
   * SDK's own session identifier, captured from the first
   * `system init` message in `prompt()`. The SDK persists the
   * transcript JSONL keyed on this id, so {@link loadSession}
   * passes it back as the SDK's `resume` option. Stays `undefined`
   * until the first prompt completes.
   */
  sdkSessionId?: string
  /**
   * Opt-in deadline for outbound permission / question RPC awaits.
   * Set from `NewSessionRequest.permissionTimeoutMs`; absent means
   * no timeout (only abort signal unhooks).
   */
  permissionTimeoutMs?: number
  /**
   * Opt-in soft-defer threshold for Pattern B (Phase 1.6). When set,
   * the driver writes a synthetic JSONL row + persists deferred state
   * + emits permission_deferred when the orchestrator does not answer
   * the outbound permission RPC by this deadline. Mutually exclusive
   * with permissionTimeoutMs at the schema layer.
   */
  permissionDeferTimeoutMs?: number
  /**
   * Latch that flips true after Process B's first prompt has checked
   * the orchestrator-side store for cached deferred state. The check
   * is one-shot per session: subsequent prompts skip the lookup.
   */
  checkedDeferredOnce?: boolean
  /**
   * Cached permission answer the orchestrator wrote after the user's
   * dialog. Populated by the one-shot deferred-state check on
   * Process B's first prompt; consumed by the wrapped canUseTool in
   * T9 and cleared once consumed.
   */
  cachedDeferredAnswer?: {
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
    message?: string
    interrupt?: boolean
  }
  /**
   * Tool name of the deferred call. The wrapped canUseTool fires the
   * cached answer ONLY when the resumed tool call's `toolName`
   * matches this value (one-shot, then drops through). Matching by
   * name (not by SDK tool_use_id) is required because the SDK
   * assigns a fresh id every time the model re-issues the tool, so
   * the original id from Process A never reappears.
   */
  deferredToolName?: string
  /**
   * Original tool_use_id from Process A. Carried across only for
   * audit + the retry prefix injection ("re-issue the deferred tool
   * call (id: <toolUseId>)"); the canUseTool wrap matches on
   * {@link deferredToolName} instead.
   */
  deferredToolUseId?: string
  /**
   * Phase 1.7 heartbeat cadence (ms). When set, the driver instantiates
   * a HeartbeatTimer at prompt entry and emits canonical heartbeat
   * sessionUpdate events on each tick.
   */
  heartbeatIntervalMs?: number
  /**
   * Phase 1.7 inactivity threshold (ms). When set, the driver runs a
   * timer-based probe; if Date.now() - lastSdkMessageAt exceeds this
   * value the driver fires session_failed:'sdk_stall' + aborts the
   * SDK turn. Distinct from {@link permissionTimeoutMs} which gates
   * the outbound permission RPC.
   */
  inactivityThresholdMs?: number
  /**
   * Latch that flips true when {@link ClaudeDriver.compact} dispatches
   * the synthetic `/compact` prompt + flips back to false the moment
   * the matching `compact_boundary` event arrives. While true, the
   * event-mapper override re-tags `compaction_started` +
   * `compaction_completed` events with `trigger: 'manual'` (the SDK's
   * `compact_metadata` already says 'manual' on the boundary itself,
   * but the preceding `system status: 'compacting'` carries no
   * trigger field, so the mapper defaults to 'auto' without this
   * latch).
   */
  pendingManualCompact?: boolean
}

const FULL_CAPABILITIES: DriverCapabilities = {
  resume: true,
  fork: true,
  fileUpload: true,
  thinking: true,
  subagent: true,
  skillEvents: true,
  debug: true,
  askQuestion: true,
}

/**
 * Concrete driver implementing every BackendDriver method against
 * the Claude SDK adapter. Holds session state in an internal Map so
 * the AcpServer's multi-session dispatch works without any external
 * session manager.
 */
export class ClaudeDriver implements BackendDriver {
  private readonly sessions: Map<string, SessionState> = new Map()

  public constructor(private readonly deps: ClaudeDriverDeps) {}

  /**
   * Attach the AcpServer reference after construction.
   *
   * The bin entrypoint creates the driver before the server (server
   * needs the driver as its backend), then wires the server back into
   * the driver here so outbound RPCs (`session/request_permission`,
   * `session/ask_user_question`) can flow during prompt(). Idempotent:
   * re-attaching replaces the prior reference, which is useful when a
   * test harness rebuilds the server between scenarios.
   *
   * @param server - the AcpServer (or AcpServerLike) the driver issues
   *                 outbound RPCs against
   */
  public attachServer(server: import('./permission-bridge.ts').AcpServerLike): void {
    ;(this.deps as { server?: import('./permission-bridge.ts').AcpServerLike }).server = server
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
    const options = this.buildSdkOptions(params)
    this.sessions.set(sessionId, {
      sessionId,
      options,
      ...(params.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: params.permissionTimeoutMs }),
      ...(params.permissionDeferTimeoutMs === undefined
        ? {}
        : { permissionDeferTimeoutMs: params.permissionDeferTimeoutMs }),
      ...(params.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: params.heartbeatIntervalMs }),
      ...(params.inactivityThresholdMs === undefined ? {} : { inactivityThresholdMs: params.inactivityThresholdMs }),
    })
    return { sessionId }
  }

  public async loadSession(params: LoadSessionRequest): Promise<NewSessionResult> {
    // Resume key is the SDK's own session_id (captured during the
    // original prompt's first system init). When the orchestrator
    // already ran prompts in this process, we reuse the stored
    // SDK id; otherwise we pass the orchestrator's id as a best-effort
    // (works only if the JSONL was persisted under that id, e.g.
    // by an earlier run that pinned the SDK session).
    const existing = this.sessions.get(params.sessionId)
    const resumeKey = existing?.sdkSessionId ?? params.sessionId

    const options: ClaudeSdkOptions = {
      ...this.buildBaseSdkOptions(params),
      resume: resumeKey,
    }
    this.sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      options,
      sdkSessionId: existing?.sdkSessionId,
    })
    return { sessionId: params.sessionId }
  }

  public async forkSession(params: ForkSessionRequest): Promise<NewSessionResult> {
    const sessionId = randomUUID()
    const options: ClaudeSdkOptions = {
      ...this.buildBaseSdkOptions(params),
      forkSessionId: params.sourceSessionId,
      systemPrompt: this.buildSystemPrompt(params.systemPrompt),
      ...(params.model === undefined ? {} : { model: params.model }),
    }
    this.sessions.set(sessionId, {
      sessionId,
      options,
      parentSessionId: params.sourceSessionId,
    })
    return { sessionId }
  }

  /**
   * `session/compact`: dispatches the SDK's `/compact` slash command
   * as a synthetic prompt turn. Sets `pendingManualCompact` on the
   * session state before the dispatch so the event-mapper override
   * re-tags the resulting `compaction_started` /
   * `compaction_completed` events with `trigger: 'manual'` (the SDK's
   * `system status: 'compacting'` carries no trigger field, so the
   * default would be 'auto' without the latch).
   *
   * The latch clears the moment a `compaction_completed` event lands
   * (whether or not the compaction succeeded). Back-to-back compact()
   * calls re-arm the latch each time.
   *
   * @throws {SessionNotFoundError} when the session id is unknown
   */
  public async compact(request: CompactSessionRequest, emit: EventEmitter): Promise<void> {
    const state = this.sessions.get(request.sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(request.sessionId)
    }

    state.pendingManualCompact = true

    await this.prompt(
      request.sessionId,
      {
        sessionId: request.sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      },
      emit,
    )
  }

  public async prompt(sessionId: string, params: PromptRequest, emit: EventEmitter): Promise<PromptResult> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(sessionId)
    }

    // One-shot Process B deferred-state check (Phase 1.6 T8). Runs at
    // most once per session lifetime: if the orchestrator persisted a
    // cached answer while the prior container was offline, fetch it
    // here so T9's wrapped canUseTool can short-circuit the matching
    // tool_use without rolling another permission roundtrip.
    if (state.checkedDeferredOnce !== true) {
      state.checkedDeferredOnce = true
      await this.consumeDeferredAnswerOnResume(state)
    }

    // Snapshot the resume payload to closure-local scope, then clear
    // session-level fields so this prompt is the ONLY one that gets
    // the retry prefix injected and the canUseTool wrap. Subsequent
    // prompts in the same process behave as plain follow-up turns.
    const resumeAnswer = state.cachedDeferredAnswer
    const resumeToolName = state.deferredToolName
    const resumeToolUseId = state.deferredToolUseId
    if (resumeAnswer !== undefined) {
      state.cachedDeferredAnswer = undefined
      state.deferredToolName = undefined
      state.deferredToolUseId = undefined
    }

    // Per-turn model override: spread on top of the session's bound
    // options so the original session model survives later turns.
    //
    // Auto-resume: once the SDK has reported a session_id (captured
    // on the first system init below), subsequent turns must pass
    // it as `resume` so the SDK continues the same transcript
    // instead of starting fresh. forkSessionId is dropped on the
    // second-and-later turns because the fork has already been
    // created; the fork's own sdkSessionId is what subsequent turns
    // resume from.
    const baseOptions: ClaudeSdkOptions = { ...state.options }
    if (state.sdkSessionId !== undefined) {
      baseOptions.forkSessionId = undefined
      baseOptions.resume = state.sdkSessionId
    }

    const effectiveOptions: ClaudeSdkOptions = {
      ...baseOptions,
      ...(params.model === undefined ? {} : { model: params.model }),
    }

    // Allocate a fresh abort controller per turn; cancel() flips it.
    const abortController = new AbortController()
    state.abortController = abortController
    effectiveOptions.abortController = abortController

    // Wire canUseTool when an AcpServer reference is available. Driver
    // can run without one (legacy unit tests mock the SDK directly),
    // but production + real-API smokes always provide it so tool-use
    // gating + AskUserQuestion + ExitPlanMode flow through the wire.
    //
    // Composition: AskUserQuestion branch first (returns null for
    // other tools), generic permission-bridge fallback. Two closures
    // chained in one outer canUseTool so the SDK sees a single hook.
    // Capture the cached-answer one-shot fire so the wrap below can
    // close over the local state and then null it out after consumption.
    let cachedAnswerSlot = resumeAnswer
    // Turn-local flag flipped by onDefer when Pattern B fires. The
    // SDK throws on the resulting deny+interrupt; the catch block
    // checks this flag to distinguish "defer-fired clean exit" from
    // a real protocol error.
    const deferDidFire = { value: false }

    if (this.deps.server !== undefined) {
      const ask = askUserQuestionBranch({
        server: this.deps.server,
        sessionId,
        emit,
        signal: abortController.signal,
        ...(state.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: state.permissionTimeoutMs }),
      })
      const gate = buildCanUseTool({
        server: this.deps.server,
        sessionId,
        emit,
        signal: abortController.signal,
        ...(state.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: state.permissionTimeoutMs }),
        ...(state.permissionDeferTimeoutMs === undefined
          ? {}
          : {
              deferTimeoutMs: state.permissionDeferTimeoutMs,
              onDefer: this.buildOnDeferHandler(sessionId, state, emit, deferDidFire),
            }),
      })
      effectiveOptions.canUseTool = async (toolName, input, options) => {
        // Resume short-circuit: cached answer fires once for the
        // matching tool name (the SDK assigns a fresh tool_use_id on
        // every retry, so matching by id never works in practice).
        if (cachedAnswerSlot !== undefined && toolName === resumeToolName) {
          const answer = cachedAnswerSlot
          cachedAnswerSlot = undefined
          emit.send({
            sessionId,
            type: 'permission_resumed',
            toolUseId: options.toolUseID,
            decision: answer.behavior,
          })
          if (this.deps.deferredStore !== undefined) {
            await this.deps.deferredStore.delete(sessionId)
          }
          return this.materializeCachedAnswer(answer, input)
        }
        const askResult = await ask(toolName, input, options)
        if (askResult !== null) {
          return askResult
        }
        return await gate(toolName, input, options)
      }
    } else if (cachedAnswerSlot !== undefined) {
      // No AcpServer in deps but we still have a cached answer to fire
      // (test setup or local dev). Provide a minimal canUseTool that
      // only short-circuits the resume id; everything else throws as
      // un-gated, mirroring the SDK default.
      effectiveOptions.canUseTool = async (toolName, input, options) => {
        if (cachedAnswerSlot !== undefined && toolName === resumeToolName) {
          const answer = cachedAnswerSlot
          cachedAnswerSlot = undefined
          emit.send({
            sessionId,
            type: 'permission_resumed',
            toolUseId: options.toolUseID,
            decision: answer.behavior,
          })
          if (this.deps.deferredStore !== undefined) {
            await this.deps.deferredStore.delete(sessionId)
          }
          return this.materializeCachedAnswer(answer, input)
        }
        return { behavior: 'deny', message: 'No permission gate wired' }
      }
    }

    // Per-turn subagent tracker: cross-message link from parent
    // tool_use_id to child session uuid. Cleared between turns so
    // stale mappings cannot leak.
    const tracker = new SubagentTracker()

    let stopReason: PromptResult['stopReason'] = 'end_turn'
    let failureReason: PromptResult['failureReason']
    let failureDetail: PromptResult['failureDetail']

    const resumePrefix =
      resumeAnswer !== undefined && resumeToolUseId !== undefined
        ? this.buildDeferredResumePrefix(resumeAnswer.behavior, resumeToolUseId)
        : undefined
    const finalPrompt = buildClaudePromptInput(params, resumePrefix)

    // Phase 1.7 lifecycle timers. Heartbeat fires while prompt runs;
    // inactivity probe fires when SDK message gap exceeds threshold.
    const promptStartedAt = Date.now()
    let lastSdkMessageAt = promptStartedAt
    const inactivityThresholdMs = state.inactivityThresholdMs
    const heartbeatIntervalMs = state.heartbeatIntervalMs

    let heartbeat: HeartbeatTimer | undefined
    if (heartbeatIntervalMs !== undefined) {
      heartbeat = new HeartbeatTimer({
        sessionId,
        intervalMs: heartbeatIntervalMs,
        emit,
        getLastSdkMs: () => lastSdkMessageAt,
      })
      heartbeat.start(promptStartedAt)
    }

    let inactivityProbe: ReturnType<typeof setInterval> | undefined
    let inactivityFired = false
    if (inactivityThresholdMs !== undefined) {
      const probeIntervalMs = Math.max(10, Math.min(Math.floor(inactivityThresholdMs / 2), 10_000))
      inactivityProbe = setInterval(() => {
        const gap = Date.now() - lastSdkMessageAt
        if (gap > inactivityThresholdMs && !inactivityFired) {
          inactivityFired = true
          const detail = `no SDK message for ${gap}ms (threshold=${inactivityThresholdMs}ms)`
          emit.send({
            sessionId,
            type: 'session_failed',
            reason: 'sdk_stall',
            detail,
            capturedAt: Date.now(),
          })
          failureReason = 'sdk_stall'
          failureDetail = detail
          stopReason = 'session_failed'
          abortController.abort()
        }
      }, probeIntervalMs)
    }

    try {
      for await (const message of this.deps.sdk.query({
        prompt: finalPrompt,
        options: effectiveOptions,
      })) {
        lastSdkMessageAt = Date.now()
        // Capture the SDK's own session id from the first system init
        // so loadSession can resume the right JSONL transcript later.
        if (message.type === 'system' && message.subtype === 'init' && state.sdkSessionId === undefined) {
          const sdkId = (message as { session_id?: string }).session_id
          if (sdkId !== undefined && sdkId.length > 0) {
            state.sdkSessionId = sdkId
          }
        }
        tracker.observe(message)
        const rawEvents = tracker.rewrite(mapSdkMessage(sessionId, message))
        const events = this.applyManualCompactLatch(state, rawEvents)
        for (const event of events) {
          emit.send(event)
        }
        // Track stop reason: result messages carry the final state.
        if (message.type === 'result' && stopReason !== 'session_failed') {
          stopReason = (message.stop_reason as PromptResult['stopReason']) ?? 'end_turn'
        }
      }
    } catch (error) {
      if (inactivityFired) {
        // Stall already classified; SDK threw because we aborted it.
      } else if (abortController.signal.aborted) {
        stopReason = 'cancelled'
        emit.send({ sessionId, type: 'cancelled', reason: 'user_cancel' })
      } else if (deferDidFire.value) {
        // Pattern B: SDK aborted via deny+interrupt:true after defer
        // fired. Side-effects (synthetic JSONL row, store persist,
        // permission_deferred event) already settled in onDefer.
        // Treat as clean turn end so the container exits gracefully.
        stopReason = 'end_turn'
      } else {
        // Phase 1.7: classify the SDK throw and surface a structured
        // session_failed event + extended PromptResult. Tool-use-aborted
        // is the one classifier that returns null (it is the
        // defer-fired sentinel and was supposed to land in the
        // deferDidFire branch above; if we got here, the abort was
        // initiated by something else and we re-throw).
        const classified = classifyClaudeError(error)
        if (classified === null) {
          throw error
        }
        const errAsErr = error instanceof Error ? error : undefined
        emit.send({
          sessionId,
          type: 'session_failed',
          reason: classified.reason,
          detail: classified.detail,
          capturedAt: Date.now(),
          ...(errAsErr === undefined
            ? {}
            : {
                cause: {
                  name: errAsErr.name,
                  message: errAsErr.message,
                  ...(errAsErr.stack === undefined ? {} : { stack: errAsErr.stack.slice(0, 4000) }),
                },
              }),
        })
        failureReason = classified.reason
        failureDetail = classified.detail
        stopReason = 'session_failed'
      }
    } finally {
      heartbeat?.stop()
      if (inactivityProbe !== undefined) {
        clearInterval(inactivityProbe)
      }
      state.abortController = undefined
    }

    if (stopReason === 'session_failed') {
      return {
        stopReason,
        ...(failureReason === undefined ? {} : { failureReason }),
        ...(failureDetail === undefined ? {} : { failureDetail }),
      }
    }
    return { stopReason }
  }

  public async cancel(request: CancelRequest): Promise<void> {
    const state = this.sessions.get(request.sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(request.sessionId)
    }
    state.abortController?.abort()
  }

  /**
   * Map the orchestrator-cached PermissionAnswer to the SDK's
   * PermissionResult shape. Allow paths default to passing the
   * SDK's input through unchanged when no `updatedInput` was cached.
   */
  private materializeCachedAnswer(
    answer: NonNullable<SessionState['cachedDeferredAnswer']>,
    input: Record<string, unknown>,
  ): import('./permission-bridge.ts').PermissionResult {
    if (answer.behavior === 'allow') {
      return {
        behavior: 'allow',
        updatedInput: answer.updatedInput ?? input,
      }
    }
    return {
      behavior: 'deny',
      message: answer.message ?? 'User denied the deferred permission',
      ...(answer.interrupt === undefined ? {} : { interrupt: answer.interrupt }),
    }
  }

  /**
   * Build the retry prefix injected into the user's first prompt
   * after a Pattern B resume. The model reads its own context
   * (which includes the synthetic deferred tool_result row) plus
   * this prefix and re-issues the deferred tool call with the
   * same arguments; the wrapped canUseTool then short-circuits
   * with the cached answer.
   *
   * Locked decision 2 from `phase-01c-deferred-permission.md`.
   */
  private buildDeferredResumePrefix(decision: 'allow' | 'deny', toolUseId: string): string {
    return decision === 'allow'
      ? `User has approved the deferred permission. Please re-issue the deferred tool call (id: ${toolUseId}) with the same arguments so the transcript records the result. Original user request: `
      : `User has denied the deferred permission (id: ${toolUseId}). The tool will not run; please acknowledge the denial and continue without retrying it. Original user request: `
  }

  /**
   * Process B one-shot resume hook. Pulls deferred state from the
   * local store (preferred when available) or via outbound
   * `session/permission_deferred_state` RPC. When the state carries
   * a {@link DeferredState.cachedAnswer}, populates the session's
   * resume fields so T9's wrapped canUseTool can fire on the matching
   * tool_use_id.
   *
   * No-ops when no state record exists or the record carries no
   * cached answer (Process A may have persisted state without an
   * answer yet; the orchestrator races a fresh container only once
   * the user has answered).
   */
  private async consumeDeferredAnswerOnResume(state: SessionState): Promise<void> {
    let record: import('../../session/deferred-store.ts').DeferredState | null = null

    if (this.deps.deferredStore !== undefined) {
      record = await this.deps.deferredStore.get(state.sessionId)
    } else if (this.deps.server !== undefined) {
      // Production path: orchestrator stores deferred state on its
      // side. Tolerate orchestrators that do not advertise the RPC
      // (legacy Phase 1.5 servers): treat any error or unexpected
      // shape as "no state" so the resume kickoff never throws.
      try {
        const response = await this.deps.server.request<{
          state?: import('../../session/deferred-store.ts').DeferredState | null
        }>('session/permission_deferred_state', { sessionId: state.sessionId })
        record = response?.state ?? null
      } catch {
        record = null
      }
    }

    if (record === null || record === undefined || record.cachedAnswer === undefined) {
      return
    }

    state.cachedDeferredAnswer = record.cachedAnswer
    state.deferredToolName = record.toolName
    state.deferredToolUseId = record.toolUseId
  }

  /**
   * Build the onDefer handler the permission-bridge calls when the
   * defer racer wins. The handler:
   *
   *   1. Locates the SDK's session JSONL path.
   *   2. Appends the synthetic deferred tool_result row.
   *   3. Persists deferred state to the orchestrator side
   *      (in-memory store when {@link ClaudeDriverDeps.deferredStore}
   *      is provided; outbound RPC fallback in T7).
   *   4. Emits the canonical {@link permission_deferred} event.
   *   5. Returns a deny+interrupt PermissionResult so the SDK turn
   *      unwinds with the synthetic tool_result already written.
   */
  private buildOnDeferHandler(
    sessionId: string,
    state: SessionState,
    emit: EventEmitter,
    deferDidFire?: { value: boolean },
  ): import('./permission-bridge.ts').DeferHandler {
    return async ({ toolName, input, options }) => {
      if (deferDidFire !== undefined) {
        deferDidFire.value = true
      }
      // 1. Resolve the JSONL path; defer requires a captured SDK session id.
      if (state.sdkSessionId === undefined) {
        return { behavior: 'deny', message: 'Permission deferred before SDK session id captured', interrupt: true }
      }
      const jsonlPath = findSessionJsonlPath(state.options.cwd, state.sdkSessionId, this.deps.claudeConfigHome)

      // 2. Append the synthetic deferred row.
      await writeDeferredToolResult(jsonlPath, options.toolUseID)

      // 3. Persist deferred state. Local store wins when both are
      //    provided; RPC fallback to session/permission_deferred_persist
      //    fires when only the AcpServer reference is available
      //    (production path: orchestrator handles persistence over the
      //    wire via Laravel DB binding).
      if (this.deps.deferredStore !== undefined) {
        await this.deps.deferredStore.set(sessionId, {
          toolUseId: options.toolUseID,
          toolName,
          rawInput: input,
          deferredAt: Date.now(),
          ...(options.agentID === undefined ? {} : { agentId: options.agentID }),
        })
      } else if (this.deps.server !== undefined) {
        await this.deps.server.request('session/permission_deferred_persist', {
          sessionId,
          toolUseId: options.toolUseID,
          toolName,
          rawInput: input,
          deferredAt: Date.now(),
          ...(options.agentID === undefined ? {} : { agentId: options.agentID }),
        })
      }

      // 4. Emit canonical permission_deferred event.
      emit.send({
        sessionId,
        type: 'permission_deferred',
        toolUseId: options.toolUseID,
        name: toolName,
        ...(options.agentID === undefined ? {} : { agentId: options.agentID }),
      })

      // 5. Unwind the SDK turn cleanly.
      return { behavior: 'deny', message: 'Permission deferred', interrupt: true }
    }
  }

  /**
   * Build the SDK options from a NewSessionRequest. Public-facing
   * helper kept on the class so subclasses (or tests) can override
   * specific mappings without re-implementing the whole flow.
   */
  public buildSdkOptions(params: NewSessionRequest): ClaudeSdkOptions {
    return {
      ...this.buildBaseSdkOptions(params),
      systemPrompt: this.buildSystemPrompt(params.systemPrompt),
      ...(params.model === undefined ? {} : { model: params.model }),
    }
  }

  /**
   * Shared subset built from any options-carrying request (new, load,
   * fork). Excludes systemPrompt / model so callers can layer overrides.
   */
  private buildBaseSdkOptions(
    params: NewSessionRequest | LoadSessionRequest | ForkSessionRequest,
  ): Omit<ClaudeSdkOptions, 'systemPrompt'> {
    const additional =
      'additionalDirectories' in params && params.additionalDirectories !== undefined
        ? { additionalDirectories: [...params.additionalDirectories] }
        : {}

    // Skills only flow on session/new (not load / fork; load reuses
    // the persisted system prompt and fork inherits the source's).
    const skills =
      'skills' in params && params.skills !== undefined && params.skills.length > 0
        ? { skills: [...params.skills] }
        : {}

    // Tool policy: translate canonical pattern strings to SDK's
    // allowedTools / disallowedTools / permissionMode. Defaults to
    // bypassPermissions when no defaultMode is set (Kodizm sandboxed
    // Project containers self-approve every tool unless the
    // orchestrator explicitly downgrades).
    const policyTranslation =
      'toolPolicy' in params && params.toolPolicy !== undefined ? translateToolPolicyToClaude(params.toolPolicy) : {}

    const policyOptions: Pick<ClaudeSdkOptions, 'allowedTools' | 'disallowedTools' | 'permissionMode' | 'permissions'> =
      {
        ...(policyTranslation.allowedTools !== undefined ? { allowedTools: policyTranslation.allowedTools } : {}),
        ...(policyTranslation.disallowedTools !== undefined
          ? { disallowedTools: policyTranslation.disallowedTools }
          : {}),
        permissionMode: policyTranslation.permissionMode ?? 'bypassPermissions',
        ...(policyTranslation.askRules !== undefined && policyTranslation.askRules.length > 0
          ? {
              permissions: {
                rules: [
                  {
                    type: 'addRules' as const,
                    rules: policyTranslation.askRules.map((toolName) => ({ toolName })),
                    behavior: 'ask' as const,
                    destination: 'session' as const,
                  },
                ],
              },
            }
          : {}),
      }

    // Auto-compact opt-out via env. SDK default is on; when the
    // orchestrator passes autoCompact:false the driver injects the
    // SDK's documented disable env var. Merge with process.env so
    // the SDK's own auth env (CLAUDE_CODE_OAUTH_TOKEN,
    // ANTHROPIC_API_KEY) survives the injection — the SDK passes
    // `Options.env` as the FULL subprocess env, not an addition.
    const compactEnv =
      'autoCompact' in params && params.autoCompact === false
        ? {
            env: {
              ...(process.env as Record<string, string>),
              DISABLE_AUTO_COMPACT: '1',
            },
          }
        : {}

    return {
      cwd: params.cwd,
      mcpServers: translateMcpServers(params.mcpServers),
      ...additional,
      ...skills,
      ...policyOptions,
      ...compactEnv,
    }
  }

  /**
   * Translate the Kodizm canonical systemPrompt union to the SDK's
   * shape. Mirrors claude-agent-acp's mapping (acp-agent.ts:1775+).
   *
   * - undefined: keep the SDK preset
   * - string: full replacement
   * - { append }: preset + append
   */
  private buildSystemPrompt(input: NewSessionRequest['systemPrompt']): ClaudeSdkOptions['systemPrompt'] {
    if (input === undefined) {
      return { type: 'preset', preset: 'claude_code' }
    }
    if (typeof input === 'string') {
      return input
    }
    return { type: 'preset', preset: 'claude_code', append: input.append }
  }

  /**
   * Override `compaction_started` / `compaction_completed` events to
   * carry `trigger: 'manual'` while the per-session
   * {@link SessionState.pendingManualCompact} latch is on. Clears
   * the latch the moment a `compaction_completed` event lands so a
   * subsequent unrelated auto-compact does not get mis-tagged.
   *
   * The SDK does NOT include a `trigger` field on the preceding
   * `system status: 'compacting'` message so the mapper defaults to
   * 'auto'. The matching `compact_boundary` carries authoritative
   * metadata, but only on success; failures surface as
   * `system status: null + compact_result: 'failed'` which also
   * defaults to 'auto'. The latch covers both paths.
   *
   * @param state - the session this event batch belongs to (carries the latch)
   * @param events - events freshly produced by mapSdkMessage() in this turn
   * @returns the same list with trigger overrides applied (and latch consumed on completion)
   */
  private applyManualCompactLatch(state: SessionState, events: SessionUpdateEvent[]): SessionUpdateEvent[] {
    if (state.pendingManualCompact !== true) {
      return events
    }
    return events.map((event) => {
      if (event.type === 'compaction_started') {
        return { ...event, trigger: 'manual' }
      }
      if (event.type === 'compaction_completed') {
        state.pendingManualCompact = false
        return { ...event, trigger: 'manual' }
      }
      return event
    })
  }
}
