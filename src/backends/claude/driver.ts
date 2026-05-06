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
import type { DeferredPermissionStore } from '../../session/deferred-store.ts'
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
import { askUserQuestionBranch } from './ask-user-question.ts'
import type { ClaudeCredentials } from './auth.ts'
import { findSessionJsonlPath, writeDeferredToolResult } from './deferred-permission.ts'
import { type SdkMessage, mapSdkMessage } from './event-mapper.ts'
import { type ClaudeSdkMcpServer, translateMcpServers } from './mcp-bridge.ts'
import { buildCanUseTool } from './permission-bridge.ts'
import { translateToolPolicyToClaude } from './policy.ts'
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
  query(options: { prompt: string; options: ClaudeSdkOptions }): AsyncIterable<SdkMessage>
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
}

const FULL_CAPABILITIES: DriverCapabilities = {
  resume: true,
  fork: true,
  fileUpload: true,
  thinking: true,
  subagent: true,
  skillEvents: true,
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

  public async prompt(sessionId: string, params: PromptRequest, emit: EventEmitter): Promise<PromptResult> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(sessionId)
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
              onDefer: this.buildOnDeferHandler(sessionId, state, emit),
            }),
      })
      effectiveOptions.canUseTool = async (toolName, input, options) => {
        const askResult = await ask(toolName, input, options)
        if (askResult !== null) {
          return askResult
        }
        return await gate(toolName, input, options)
      }
    }

    // Per-turn subagent tracker: cross-message link from parent
    // tool_use_id to child session uuid. Cleared between turns so
    // stale mappings cannot leak.
    const tracker = new SubagentTracker()

    let stopReason: PromptResult['stopReason'] = 'end_turn'

    try {
      for await (const message of this.deps.sdk.query({
        prompt: this.serializePrompt(params),
        options: effectiveOptions,
      })) {
        // Capture the SDK's own session id from the first system init
        // so loadSession can resume the right JSONL transcript later.
        if (message.type === 'system' && message.subtype === 'init' && state.sdkSessionId === undefined) {
          const sdkId = (message as { session_id?: string }).session_id
          if (sdkId !== undefined && sdkId.length > 0) {
            state.sdkSessionId = sdkId
          }
        }
        tracker.observe(message)
        const events = tracker.rewrite(mapSdkMessage(sessionId, message))
        for (const event of events) {
          emit.send(event)
        }
        // Track stop reason: result messages carry the final state.
        if (message.type === 'result') {
          stopReason = (message.stop_reason as PromptResult['stopReason']) ?? 'end_turn'
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        stopReason = 'cancelled'
        emit.send({ sessionId, type: 'cancelled', reason: 'user_cancel' })
      } else {
        throw error
      }
    } finally {
      state.abortController = undefined
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
  ): import('./permission-bridge.ts').DeferHandler {
    return async ({ toolName, input, options }) => {
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
   * Serialize the canonical prompt[] (content blocks) into the SDK's
   * input format. The SDK's query() accepts either a string OR an
   * iterable of UserMessage objects; for phase 1 we string-flatten
   * text blocks and rely on the SDK's own content-block roundtrip
   * for image/document blocks (set on options as a separate field
   * in T21's content-mapper extension).
   */
  private serializePrompt(params: PromptRequest): string {
    const text: string[] = []
    for (const block of params.prompt) {
      if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
        text.push((block as { text: string }).text)
      }
    }
    return text.join('\n')
  }
}
