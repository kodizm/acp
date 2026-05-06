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
import type { ClaudeCredentials } from './auth.ts'
import { type SdkMessage, mapSdkMessage } from './event-mapper.ts'
import { type ClaudeSdkMcpServer, translateMcpServers } from './mcp-bridge.ts'
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
  resume?: string
  forkSessionId?: string
  abortController?: AbortController
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
    this.sessions.set(sessionId, { sessionId, options })
    return { sessionId }
  }

  public async loadSession(params: LoadSessionRequest): Promise<NewSessionResult> {
    // The SDK's resume mode replays the prior transcript; we reuse the
    // canonical newSession shape for the options + tag the resume id.
    const options: ClaudeSdkOptions = {
      ...this.buildBaseSdkOptions(params),
      resume: params.sessionId,
    }
    this.sessions.set(params.sessionId, { sessionId: params.sessionId, options })
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
    const effectiveOptions: ClaudeSdkOptions = {
      ...state.options,
      ...(params.model === undefined ? {} : { model: params.model }),
    }

    // Allocate a fresh abort controller per turn; cancel() flips it.
    const abortController = new AbortController()
    state.abortController = abortController
    effectiveOptions.abortController = abortController

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

    return {
      cwd: params.cwd,
      mcpServers: translateMcpServers(params.mcpServers),
      ...additional,
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
