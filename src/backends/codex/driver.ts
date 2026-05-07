/**
 * Codex backend driver.
 *
 * Drives the codex CLI's `codex app-server` JSON-RPC stdio interface.
 * Translates Kodizm canonical wire shapes (NewSessionRequest,
 * PromptRequest, etc.) to codex's native protocol (thread/start,
 * turn/start, etc.). The orchestrator never sees the codex protocol;
 * driver-internal mapping handles every translation.
 *
 * Phase 2 progressive build:
 *   T1 scaffold (capabilities + initialize + UUID newSession)
 *   T3 newSession spawns subprocess + writes config.toml + thread/start
 *   T4 prompt() turn/start + cancel via turn/interrupt + heartbeat
 *   T5 loadSession via thread/resume
 *   T6 forkSession via thread/fork
 *   T7-T9 event-mapper + subagent + model_advertisement
 *   T10 permission-bridge (3 codex approval RPCs collapse)
 *   T11 deferred-permission Pattern B
 *   T12-T13 error-classifier + structured throw -> session_failed
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { MethodNotSupportedError, SessionNotFoundError } from '../../server/errors.ts'
import { HeartbeatTimer } from '../../server/heartbeat.ts'
import type { DeferredPermissionStore } from '../../session/deferred-store.ts'
import type {
  CancelRequest,
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
import { CodexAppServerProcess, type CodexDebugSink } from './app-server-spawn.ts'
import { handleCodexRequestUserInput } from './ask-user-question.ts'
import { buildCodexConfigToml } from './config-mapper.ts'
import { findCodexJsonlPath, writeDeferredRolloutItem } from './deferred-permission.ts'
import { classifyCodexError } from './error-classifier.ts'
import { CodexEventMapper } from './event-mapper.ts'
import { handleCodexApproval } from './permission-bridge.ts'
import { buildSandboxPolicy, mapPermissionMode } from './policy.ts'

/**
 * Options the driver passes to {@link CodexDriverDeps.spawnFactory}
 * when constructing the codex subprocess. Production factory wires
 * these into a `CodexAppServerProcess.spawn()` call.
 */
export interface CodexSpawnFactoryOptions {
  configPath: string
  codexHome?: string
  env?: Record<string, string>
  debugSink?: CodexDebugSink
}

export interface CodexDriverDeps {
  agentInfo: { version: string }
  /**
   * Directory where temp config TOML files are written. Defaults to
   * `os.tmpdir()`. Tests pass an isolated temp dir.
   */
  configDir?: string
  /**
   * Factory for the codex subprocess. Production passes a closure
   * that calls `CodexAppServerProcess.spawn()` with codex binary
   * resolution from PATH. Tests inject a closure that points at a
   * fake codex script via `bun run <script>`.
   */
  spawnFactory?: (options: CodexSpawnFactoryOptions) => Promise<CodexAppServerProcess>
  /**
   * AcpServer reference used to send outbound permission /
   * AskUserQuestion RPCs. Optional so unit tests that exercise the
   * driver without a wire surface (basic newSession + prompt) keep
   * working. Production + integration smokes always provide it.
   */
  server?: AcpServerLike
  /**
   * Optional Pattern B deferred-permission store. When provided +
   * the session opts in via `permissionDeferTimeoutMs`, the driver
   * persists deferred state here on Process A and reads cached
   * answers from it on Process B. Phase 4 wires production
   * Laravel-DB binding; Phase 1.6 ships in-memory binding.
   */
  deferredStore?: DeferredPermissionStore
  /**
   * Override for `~/.codex` home dir. Used by tests to isolate JSONL
   * writes from the developer's real codex transcript dir. Production
   * omits this; codex defaults to homedir/.codex.
   */
  codexHome?: string
}

/**
 * Per-session state held by the driver. Mirrors ClaudeDriver's
 * SessionState shape so future Phase 1.7 lifecycle modules (heartbeat,
 * inactivity probe, debug recorder, error classifier) plug in
 * unchanged.
 */
interface CodexSessionState {
  sessionId: string
  /**
   * Codex's own thread id, captured from `thread/start` response.
   * Driver-internal; orchestrator never sees this.
   */
  codexThreadId?: string
  /**
   * Codex's transcript path, captured from `thread/start` response.
   * Used by Phase 2 T11 Pattern B injection (`thread/resume { path }`).
   */
  codexJsonlPath?: string
  /**
   * The subprocess wrapper. Created at newSession; killed at cancel
   * or container exit.
   */
  process?: CodexAppServerProcess
  /**
   * Path to the temp config.toml; tracked for cleanup at session
   * close (Phase 2 T13 wires it).
   */
  configPath?: string
  /**
   * Per-turn abort controller; flipped by cancel().
   */
  abortController?: AbortController
  /**
   * Active turn id during prompt(); set after `turn/start` response,
   * used by `cancel()` to dispatch `turn/interrupt`.
   */
  activeTurnId?: string
  /**
   * Phase 1.7 heartbeat cadence (ms). When set, the driver runs a
   * HeartbeatTimer at prompt entry.
   */
  heartbeatIntervalMs?: number
  /**
   * Phase 1.7 inactivity threshold (ms). When set, the driver fires
   * a setInterval probe; gap > threshold -> session_failed:'sdk_stall'.
   */
  inactivityThresholdMs?: number
  /**
   * Codex model id captured from `thread/start`. Used to emit
   * canonical `model_advertisement` at the first prompt entry.
   */
  codexModel?: string
  /**
   * Latch that flips after the first `model_advertisement` emission;
   * subsequent prompts skip re-advertising the same model.
   */
  modelAdvertised?: boolean
  /**
   * Phase 1.6 Pattern B soft-defer threshold. Mutually exclusive with
   * permissionTimeoutMs at the schema layer.
   */
  permissionDeferTimeoutMs?: number
  /**
   * One-shot resume check latch (Pattern B Process B).
   */
  checkedDeferredOnce?: boolean
  /**
   * Cached permission answer the orchestrator wrote after the user's
   * dialog. Populated by consumeDeferredAnswerOnResume on Process B's
   * first prompt; consumed by the wrapped onServerRequest handler
   * for the matching tool name.
   */
  cachedDeferredAnswer?: 'allow' | 'deny'
  /**
   * Tool name (codex_exec / codex_apply_patch / codex_permission_grant)
   * of the deferred call. Used to short-circuit the matching codex
   * approval RPC on Process B.
   */
  deferredToolName?: string
  /**
   * Original tool_use_id (item_id) from Process A. Used in retry
   * prefix injection.
   */
  deferredToolUseId?: string
}

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

const DEFAULT_SPAWN_FACTORY = async (options: CodexSpawnFactoryOptions): Promise<CodexAppServerProcess> => {
  const proc = new CodexAppServerProcess({
    configPath: options.configPath,
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.debugSink === undefined ? {} : { debugSink: options.debugSink }),
  })
  await proc.spawn()
  return proc
}

/**
 * Concrete driver implementing every BackendDriver method against the
 * codex app-server protocol. Phase 2 progressive build.
 */
export class CodexDriver implements BackendDriver {
  private readonly sessions: Map<string, CodexSessionState> = new Map()
  private readonly spawnFactory: (options: CodexSpawnFactoryOptions) => Promise<CodexAppServerProcess>
  private readonly configDir: string

  public constructor(private readonly deps: CodexDriverDeps) {
    this.spawnFactory = deps.spawnFactory ?? DEFAULT_SPAWN_FACTORY
    this.configDir = deps.configDir ?? tmpdir()
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

    // 1. Build temp codex config.toml carrying mcpServers (locked decision 8).
    const configPath = await buildCodexConfigToml({
      sessionId,
      dir: this.configDir,
      mcpServers: params.mcpServers,
    })

    // 2. Spawn the codex app-server subprocess.
    const proc = await this.spawnFactory({ configPath })

    // 3. Send initialize handshake.
    await proc.initialize({ protocolVersion: 1 })

    // 4. Send thread/start with cwd + approval_policy + sandbox_policy.
    const mode = params.toolPolicy?.defaultMode ?? 'bypassPermissions'
    const approvalPolicy = mapPermissionMode(mode)
    const sandboxPolicy = buildSandboxPolicy({
      cwd: params.cwd,
      mode,
      additionalDirectories: params.additionalDirectories,
    })

    // Map canonical systemPrompt to codex baseInstructions /
    // developerInstructions per `v2/ThreadStartParams.ts`:
    //   string                -> baseInstructions (full replacement)
    //   { append: string }    -> developerInstructions (append on top)
    const systemPromptFields: { baseInstructions?: string; developerInstructions?: string } = {}
    if (typeof params.systemPrompt === 'string') {
      systemPromptFields.baseInstructions = params.systemPrompt
    } else if (
      params.systemPrompt !== undefined &&
      typeof params.systemPrompt === 'object' &&
      typeof params.systemPrompt.append === 'string'
    ) {
      systemPromptFields.developerInstructions = params.systemPrompt.append
    }

    const threadResponse = await proc.request<{
      thread: { id: string; path?: string }
      model?: string
    }>('thread/start', {
      cwd: params.cwd,
      approvalPolicy,
      sandboxPolicy,
      ...(params.model === undefined ? {} : { model: params.model }),
      ...systemPromptFields,
    })

    // 5. Persist driver-internal state. Orchestrator only sees sessionId.
    this.sessions.set(sessionId, {
      sessionId,
      codexThreadId: threadResponse.thread.id,
      ...(threadResponse.thread.path === undefined ? {} : { codexJsonlPath: threadResponse.thread.path }),
      process: proc,
      configPath,
      ...(params.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: params.heartbeatIntervalMs }),
      ...(params.inactivityThresholdMs === undefined ? {} : { inactivityThresholdMs: params.inactivityThresholdMs }),
      ...(threadResponse.model === undefined ? {} : { codexModel: threadResponse.model }),
      ...(params.permissionDeferTimeoutMs === undefined
        ? {}
        : { permissionDeferTimeoutMs: params.permissionDeferTimeoutMs }),
    })

    return { sessionId }
  }

  public async prompt(sessionId: string, params: PromptRequest, emit: EventEmitter): Promise<PromptResult> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(sessionId)
    }
    if (state.process === undefined || state.codexThreadId === undefined) {
      throw new SessionNotFoundError(`${sessionId} (no codex thread)`)
    }

    // 0a. One-shot Pattern B deferred-state check (Process B resume).
    if (state.checkedDeferredOnce !== true) {
      state.checkedDeferredOnce = true
      await this.consumeDeferredAnswerOnResume(state)
    }

    // 0b. Snapshot resume payload to closure-local + clear session-
    //     level fields so this prompt is the ONLY one that gets the
    //     retry prefix injected.
    const resumeAnswer = state.cachedDeferredAnswer
    const resumeToolName = state.deferredToolName
    const resumeToolUseId = state.deferredToolUseId
    if (resumeAnswer !== undefined) {
      state.cachedDeferredAnswer = undefined
      state.deferredToolName = undefined
      state.deferredToolUseId = undefined
    }

    // 0c. One-shot model advertisement.
    if (state.modelAdvertised !== true && state.codexModel !== undefined) {
      state.modelAdvertised = true
      emit.send({
        sessionId,
        type: 'model_advertisement',
        model: state.codexModel,
      })
    }

    // 1. Allocate per-turn abort controller; cancel() flips it.
    const abortController = new AbortController()
    state.abortController = abortController

    // 2. Translate canonical content blocks to codex UserInput[].
    //    Pattern B: when resuming with a cached answer, prepend a retry
    //    prefix so the model re-issues the deferred tool call.
    // Codex's UserInput schema (codex-rs/v2/UserInput.ts):
    //   { type: 'text', text, text_elements }
    //   { type: 'image', url }            <- remote URL
    //   { type: 'localImage', path }      <- local filesystem
    //   { type: 'skill', name, path }
    //   { type: 'mention', name, path }
    // text_elements is non-optional; we ship empty.
    const inputs: Array<Record<string, unknown>> = []
    if (resumeAnswer !== undefined && resumeToolUseId !== undefined && resumeToolName !== undefined) {
      inputs.push({
        type: 'text',
        text: this.injectDeferredResumePrefix(resumeAnswer, resumeToolUseId, resumeToolName),
        text_elements: [],
      })
    }
    for (const block of params.prompt) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as { type?: string; text?: string; uri?: string; path?: string; url?: string }
      if (b.type === 'text' && typeof b.text === 'string') {
        inputs.push({ type: 'text', text: b.text, text_elements: [] })
        continue
      }
      if (b.type === 'image') {
        // Canonical: { type: 'image', uri } accepts file://, http(s)://,
        // or a bare local path. Map to codex's localImage / image.
        const uri = b.uri ?? b.url ?? b.path
        if (typeof uri !== 'string') continue
        if (uri.startsWith('file://')) {
          inputs.push({ type: 'localImage', path: uri.slice('file://'.length) })
        } else if (uri.startsWith('http://') || uri.startsWith('https://')) {
          inputs.push({ type: 'image', url: uri })
        } else if (uri.startsWith('/')) {
          inputs.push({ type: 'localImage', path: uri })
        }
      }
    }

    // 3. Phase 1.7 lifecycle timers.
    const promptStartedAt = Date.now()
    let lastEventAt = promptStartedAt
    let stopReason: PromptResult['stopReason'] = 'end_turn' as PromptResult['stopReason']
    let failureReason: PromptResult['failureReason']
    let failureDetail: PromptResult['failureDetail']
    let inactivityFired = false

    let heartbeat: HeartbeatTimer | undefined
    if (state.heartbeatIntervalMs !== undefined) {
      heartbeat = new HeartbeatTimer({
        sessionId,
        intervalMs: state.heartbeatIntervalMs,
        emit,
        getLastSdkMs: () => lastEventAt,
      })
      heartbeat.start(promptStartedAt)
    }

    let inactivityProbe: ReturnType<typeof setInterval> | undefined
    const inactivityThresholdMs = state.inactivityThresholdMs
    if (inactivityThresholdMs !== undefined) {
      const probeIntervalMs = Math.max(10, Math.min(Math.floor(inactivityThresholdMs / 2), 10_000))
      inactivityProbe = setInterval(() => {
        const gap = Date.now() - lastEventAt
        if (gap > inactivityThresholdMs && !inactivityFired) {
          inactivityFired = true
          const detail = `no codex event for ${gap}ms (threshold=${inactivityThresholdMs}ms)`
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

    // 4. Wire codex notification listener; resolve on turn/completed.
    let resolveTurn!: () => void
    let rejectTurn!: (err: Error) => void
    let turnSettled = false
    const turnDone = new Promise<void>((resolve, reject) => {
      resolveTurn = () => {
        turnSettled = true
        resolve()
      }
      rejectTurn = (err) => {
        if (turnSettled) return
        turnSettled = true
        reject(err)
      }
    })
    // Defensive no-op handler: if the turn/start RPC itself throws
    // before anyone awaits turnDone (Phase 2 T13 error path), the
    // subsequent subprocess kill would otherwise produce an
    // unhandled-rejection. Attaching .catch() makes the promise's
    // rejection observable even when the outer race is bypassed.
    turnDone.catch(() => undefined)

    // Subprocess crash watcher: a SIGKILL or codex internal crash mid-
    // turn would otherwise leave turnDone hanging because no
    // turn/completed notification ever arrives. Bail with a structured
    // throw the catch block below classifies as session_failed.
    // Idempotent: if the turn already settled (normal completion or
    // upstream error), the rejecter no-ops.
    state.process.onExit((exitCode) => {
      const err = new Error(`codex subprocess exited mid-turn (code ${exitCode ?? 'null'})`)
      Object.assign(err, { code: 'CODEX_PROCESS_EXITED' })
      rejectTurn(err)
    })

    // Wire event-mapper: codex notifications -> canonical sessionUpdate.
    const eventMapper = new CodexEventMapper({
      sessionId,
      emit: (event) => emit.send(event),
    })

    state.process.onNotification((method, notifParams) => {
      lastEventAt = Date.now()
      eventMapper.handle(method, notifParams)
      if (method === 'turn/started') {
        return
      }
      if (method === 'turn/completed') {
        if (stopReason !== 'session_failed' && stopReason !== 'cancelled') {
          stopReason = 'end_turn'
        }
        resolveTurn()
        return
      }
    })

    // Wire 3 codex approval RPCs to canonical permission_request flow.
    // Phase 2 T10 + T11 (Pattern B). Requires deps.server.
    let cachedAnswerSlot = resumeAnswer
    if (this.deps.server !== undefined) {
      const server = this.deps.server
      state.process.onServerRequest(async (rawMethod, rawParams) => {
        // Legacy alias: pre-v2 codex emits `applyPatchApproval` /
        // `execCommandApproval` with conversationId+callId shape.
        // Rewrite to v2 method + params shape so the single approval
        // pipeline handles both.
        let method = rawMethod
        let params = rawParams
        if (rawMethod === 'applyPatchApproval') {
          method = 'item/fileChange/requestApproval'
          const p = rawParams as {
            conversationId?: string
            callId?: string
            fileChanges?: Record<string, unknown>
            reason?: string | null
          }
          params = {
            threadId: p.conversationId,
            itemId: p.callId,
            files: p.fileChanges === undefined ? [] : Object.keys(p.fileChanges),
            reason: p.reason ?? undefined,
          }
        } else if (rawMethod === 'execCommandApproval') {
          method = 'item/commandExecution/requestApproval'
          const p = rawParams as {
            conversationId?: string
            callId?: string
            approvalId?: string | null
            command?: ReadonlyArray<string>
            cwd?: string
            reason?: string | null
          }
          params = {
            threadId: p.conversationId,
            itemId: p.callId,
            approvalId: p.approvalId ?? null,
            command: p.command === undefined ? '' : p.command.join(' '),
            cwd: p.cwd,
            reason: p.reason ?? undefined,
          }
        }
        if (
          method === 'item/commandExecution/requestApproval' ||
          method === 'item/fileChange/requestApproval' ||
          method === 'item/permissions/requestApproval'
        ) {
          const approvalParams = params as Parameters<typeof handleCodexApproval>[0]['params']
          const approvalName = this.approvalMethodToName(method)

          // Pattern B Process B: short-circuit cached answer for the
          // matching tool name. Single-shot consumption; subsequent
          // approvals fall through to normal canonical flow.
          if (cachedAnswerSlot !== undefined && approvalName === resumeToolName) {
            const decision = cachedAnswerSlot
            cachedAnswerSlot = undefined
            emit.send({
              sessionId,
              type: 'permission_resumed',
              toolUseId: approvalParams.itemId,
              decision,
            })
            if (this.deps.deferredStore !== undefined) {
              await this.deps.deferredStore.delete(sessionId)
            }
            return this.materializeCachedAnswer(method, decision)
          }

          // Build onDefer hook (Process A path) when defer threshold
          // is configured.
          const deferHookArgs =
            state.permissionDeferTimeoutMs === undefined
              ? {}
              : {
                  deferTimeoutMs: state.permissionDeferTimeoutMs,
                  onDefer: this.buildOnDeferHandler(state, sessionId, emit),
                }

          return handleCodexApproval({
            method,
            params: approvalParams,
            server,
            sessionId,
            emit,
            signal: abortController.signal,
            ...deferHookArgs,
          })
        }
        if (method === 'item/tool/requestUserInput') {
          const userInputParams = params as Parameters<typeof handleCodexRequestUserInput>[0]['params']
          return handleCodexRequestUserInput({
            params: userInputParams,
            server,
            sessionId,
            emit,
            signal: abortController.signal,
          })
        }
        if (method === 'mcpServer/elicitation/request') {
          // Codex bubbles MCP server elicit (form / url) to the client.
          // Collapse to canonical question_request with a single
          // Accept/Decline/Cancel question; codex's action enum maps
          // 1:1 with the option ids.
          const elicit = params as {
            threadId?: string
            turnId?: string | null
            serverName?: string
            mode?: 'form' | 'url'
            message?: string
            url?: string
            elicitationId?: string
          }
          const toolUseId = elicit.elicitationId ?? `mcp-elicit-${elicit.serverName ?? 'unknown'}-${Date.now()}`
          const headerLabel = (elicit.serverName ?? 'mcp').slice(0, 12)
          emit.send({
            sessionId,
            type: 'question_request',
            toolUseId,
            questions: [
              {
                question: elicit.message ?? `${elicit.serverName ?? 'MCP'} requested input`,
                header: headerLabel,
                multiSelect: false,
                options: [
                  {
                    label: 'Accept',
                    description:
                      elicit.mode === 'url' ? `Allow URL: ${elicit.url ?? ''}` : 'Provide the requested form input.',
                  },
                  { label: 'Decline', description: 'Refuse this elicitation.' },
                  { label: 'Cancel', description: 'Cancel this elicitation; continue without an answer.' },
                ],
              },
            ],
          })
          try {
            const response = await server.request<{ answers?: Record<string, string> }>('session/ask_user_question', {
              sessionId,
              toolUseId,
              questions: [
                {
                  question: elicit.message ?? `${elicit.serverName ?? 'MCP'} requested input`,
                  header: headerLabel,
                  multiSelect: false,
                  options: [
                    { label: 'Accept', description: 'Provide the requested form input.' },
                    { label: 'Decline', description: 'Refuse this elicitation.' },
                    { label: 'Cancel', description: 'Cancel this elicitation; continue without an answer.' },
                  ],
                },
              ],
            })
            const answer = Object.values(response?.answers ?? {})[0] ?? 'Decline'
            const action = answer === 'Accept' ? 'accept' : answer === 'Cancel' ? 'cancel' : 'decline'
            return { action, content: null, _meta: null }
          } catch {
            return { action: 'decline', content: null, _meta: null }
          }
        }
        if (method === 'item/tool/call') {
          // Codex orchestrator-hosted dynamic tool. Forward to canonical
          // session/dynamic_tool_call so the orchestrator can route to
          // its tool registry. Driver returns the orchestrator's answer
          // verbatim. If the orchestrator can't handle, return a
          // structured failure so codex unwinds.
          const dyn = params as {
            threadId?: string
            turnId?: string
            callId: string
            namespace?: string | null
            tool: string
            arguments: unknown
          }
          try {
            const response = await server.request<{
              contentItems?: ReadonlyArray<unknown>
              success?: boolean
            }>('session/dynamic_tool_call', {
              sessionId,
              callId: dyn.callId,
              namespace: dyn.namespace ?? null,
              tool: dyn.tool,
              arguments: dyn.arguments,
            })
            return {
              contentItems: response?.contentItems ?? [],
              success: response?.success ?? false,
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : 'orchestrator did not handle dynamic tool'
            return {
              contentItems: [{ type: 'text', text: `[kodizm-acp] ${message}` }],
              success: false,
            }
          }
        }
        if (method === 'account/chatgptAuthTokens/refresh') {
          // Codex notices the chatgpt access token is stale. Forward
          // to orchestrator (Laravel side rotates the token from its
          // record). When the orchestrator declines or has no
          // implementation, codex falls back to its built-in OAuth
          // flow (which would prompt on stderr; not a crash path).
          const refresh = params as { reason?: string; previousAccountId?: string | null }
          try {
            const response = await server.request<{
              accessToken?: string
              chatgptAccountId?: string
              chatgptPlanType?: string | null
            }>('session/codex_chatgpt_token_refresh', {
              sessionId,
              reason: refresh.reason,
              previousAccountId: refresh.previousAccountId ?? null,
            })
            if (response?.accessToken !== undefined && response.chatgptAccountId !== undefined) {
              return {
                accessToken: response.accessToken,
                chatgptAccountId: response.chatgptAccountId,
                chatgptPlanType: response.chatgptPlanType ?? null,
              }
            }
          } catch {
            // fall through to codex's fallback
          }
          // Returning null tells codex to fall back to its own refresh.
          return null
        }
        return undefined
      })
    }

    // 5. Send turn/start with serialized inputs.
    try {
      const turnStartResult = await state.process.request<{ turn: { id: string } }>('turn/start', {
        threadId: state.codexThreadId,
        input: inputs,
      })
      state.activeTurnId = turnStartResult.turn.id

      // 6. Race the turn-completion against the abort signal.
      await Promise.race([
        turnDone,
        new Promise<void>((_resolve, reject) => {
          abortController.signal.addEventListener('abort', () => reject(new Error('cancel')), { once: true })
        }),
      ]).catch(async (err) => {
        if (err instanceof Error && err.message === 'cancel') {
          // Send turn/interrupt; await turn/completed (status: cancelled).
          if (state.process !== undefined && state.codexThreadId !== undefined && state.activeTurnId !== undefined) {
            await state.process
              .request('turn/interrupt', {
                threadId: state.codexThreadId,
                turnId: state.activeTurnId,
              })
              .catch(() => undefined)
            // Wait for the synthesized turn/completed (with 1s budget).
            await Promise.race([turnDone, new Promise<void>((resolve) => setTimeout(resolve, 1_000))])
          }
          if (!inactivityFired) {
            stopReason = 'cancelled'
            emit.send({ sessionId, type: 'cancelled', reason: 'user_cancel' })
          }
          return
        }
        // Non-cancel rejection: subprocess crash, RPC error, codex
        // panic. Re-throw so the outer catch classifies it.
        throw err
      })
    } catch (error) {
      // Phase 2 T13: classify codex throw + emit canonical session_failed.
      if (inactivityFired) {
        // Stall already classified; skip re-classification.
      } else if (abortController.signal.aborted) {
        if (stopReason !== 'cancelled') {
          stopReason = 'cancelled'
          emit.send({ sessionId, type: 'cancelled', reason: 'user_cancel' })
        }
      } else {
        const classified = classifyCodexError(error)
        if (classified === null) {
          // Tool-use-aborted on non-defer path: re-throw legacy.
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
      state.activeTurnId = undefined
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

  /**
   * Map a codex approval RPC method to the canonical name used in
   * permission_request events + state.deferredToolName.
   */
  private approvalMethodToName(
    method:
      | 'item/commandExecution/requestApproval'
      | 'item/fileChange/requestApproval'
      | 'item/permissions/requestApproval',
  ): string {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return 'codex_exec'
      case 'item/fileChange/requestApproval':
        return 'codex_apply_patch'
      case 'item/permissions/requestApproval':
        return 'codex_permission_grant'
    }
  }

  /**
   * Build the codex CodexApprovalResult for a cached Pattern B answer.
   * Mirrors handleCodexApproval's mapOutcomeToCodex logic for the
   * 'allow' / 'deny' duo.
   */
  private materializeCachedAnswer(
    method:
      | 'item/commandExecution/requestApproval'
      | 'item/fileChange/requestApproval'
      | 'item/permissions/requestApproval',
    decision: 'allow' | 'deny',
  ): { decision?: string; permissions?: unknown; scope?: string } {
    if (method === 'item/permissions/requestApproval') {
      if (decision === 'allow') {
        return { permissions: { type: 'managed' }, scope: 'Turn' }
      }
      return { permissions: { type: 'disabled' }, scope: 'Turn' }
    }
    return { decision: decision === 'allow' ? 'Accept' : 'Decline' }
  }

  /**
   * Build onDefer handler for Pattern B Process A. Locates the
   * codex JSONL via findCodexJsonlPath, appends the sentinel
   * RolloutItem, persists deferred state, emits permission_deferred
   * event. Returns void; handleCodexApproval responds with Decline
   * after the hook resolves so codex unwinds the turn cleanly.
   */
  private buildOnDeferHandler(
    state: CodexSessionState,
    sessionId: string,
    emit: EventEmitter,
  ): import('./permission-bridge.ts').CodexDeferHandler {
    return async ({ method, params }) => {
      const codexHome = this.deps.codexHome ?? `${process.env.HOME ?? ''}/.codex`
      const jsonlPath =
        state.codexJsonlPath ??
        (state.codexThreadId === undefined ? null : await findCodexJsonlPath(codexHome, state.codexThreadId))

      if (jsonlPath !== null) {
        await writeDeferredRolloutItem(jsonlPath, params.itemId)
        state.codexJsonlPath = jsonlPath
      }

      if (this.deps.deferredStore !== undefined) {
        await this.deps.deferredStore.set(sessionId, {
          toolUseId: params.itemId,
          toolName: this.approvalMethodToName(method),
          rawInput: params as unknown as Record<string, unknown>,
          deferredAt: Date.now(),
        })
      } else if (this.deps.server !== undefined) {
        await this.deps.server
          .request('session/permission_deferred_persist', {
            sessionId,
            toolUseId: params.itemId,
            toolName: this.approvalMethodToName(method),
            rawInput: params,
            deferredAt: Date.now(),
          })
          .catch(() => undefined)
      }

      emit.send({
        sessionId,
        type: 'permission_deferred',
        toolUseId: params.itemId,
        name: this.approvalMethodToName(method),
      })
    }
  }

  /**
   * Process B one-shot resume hook. Pulls deferred state from the
   * local store (preferred) or via outbound RPC. When the state
   * carries a cachedAnswer, populates state.cachedDeferredAnswer +
   * state.deferredToolName so the wrapped onServerRequest fires the
   * cached answer for the matching tool name.
   */
  private async consumeDeferredAnswerOnResume(state: CodexSessionState): Promise<void> {
    let record: import('../../session/deferred-store.ts').DeferredState | null = null

    if (this.deps.deferredStore !== undefined) {
      record = await this.deps.deferredStore.get(state.sessionId)
    } else if (this.deps.server !== undefined) {
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
    state.cachedDeferredAnswer = record.cachedAnswer.behavior
    state.deferredToolName = record.toolName
    state.deferredToolUseId = record.toolUseId
  }

  /**
   * Build the retry prefix injected into the user prompt on Pattern B
   * resume. Codex sees the synthetic RolloutItem in the JSONL
   * transcript + this prefix tells the model to re-issue the deferred
   * tool call so the canonical answer can fire.
   */
  private injectDeferredResumePrefix(decision: 'allow' | 'deny', toolUseId: string, toolName: string): string {
    if (decision === 'allow') {
      return `User has approved the deferred ${toolName} approval (id: ${toolUseId}). Please re-issue the deferred tool call with the same arguments so the transcript records the result.`
    }
    return `User has denied the deferred ${toolName} approval (id: ${toolUseId}). The tool will not run; please acknowledge the denial and continue without retrying it.`
  }

  public async cancel(request: CancelRequest): Promise<void> {
    const state = this.sessions.get(request.sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(request.sessionId)
    }
    if (state.abortController !== undefined) {
      state.abortController.abort()
      return
    }
    // No active prompt; tear down subprocess (used by tests for cleanup).
    if (state.process !== undefined) {
      await state.process.kill()
    }
    this.sessions.delete(request.sessionId)
  }

  /**
   * Phase 2 cross-process Pattern B helper. Spawns a fresh codex
   * subprocess + recreates {@link CodexSessionState} for an existing
   * sessionId so a Process B can pick up where Process A left off.
   *
   * This is the lifecycle the orchestrator drives when the original
   * driver instance has died (container restart, deploy, machine
   * shutdown) and a new driver needs to consume a deferred answer or
   * keep streaming on the same Kodizm sessionId.
   *
   * The orchestrator persists `(codexThreadId, codexJsonlPath)`
   * alongside the deferred record; on resume it calls this method
   * with the same sessionId. We initialize a new subprocess, send
   * `thread/resume` with the captured threadId, and seat the session
   * in `this.sessions` so subsequent `prompt()` / `loadSession()` /
   * `cancel()` calls succeed without `SessionNotFoundError`.
   *
   * @returns the same sessionId echoed back (matches NewSessionResult
   *   for caller convenience)
   */
  public async hydrateSession(params: {
    sessionId: string
    codexThreadId: string
    codexJsonlPath?: string
    cwd: string
    mcpServers: NewSessionRequest['mcpServers']
    additionalDirectories?: NewSessionRequest['additionalDirectories']
    toolPolicy?: NewSessionRequest['toolPolicy']
    permissionDeferTimeoutMs?: number
    heartbeatIntervalMs?: number
    inactivityThresholdMs?: number
  }): Promise<NewSessionResult> {
    if (this.sessions.has(params.sessionId)) {
      throw new Error(`hydrateSession: session ${params.sessionId} already seated`)
    }

    // 1. Build temp config + spawn fresh subprocess (mirrors newSession).
    const configPath = await buildCodexConfigToml({
      sessionId: params.sessionId,
      dir: this.configDir,
      mcpServers: params.mcpServers,
    })
    const proc = await this.spawnFactory({ configPath })
    await proc.initialize({ protocolVersion: 1 })

    // 2. Resume the codex thread from disk via thread/resume + threadId.
    const response = await proc.request<{ thread: { id: string; path?: string }; model?: string }>('thread/resume', {
      threadId: params.codexThreadId,
    })

    // 3. Seat the session record so prompt() / cancel() / loadSession()
    //    all behave as if newSession had run on this driver.
    this.sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      codexThreadId: response.thread.id,
      ...(response.thread.path === undefined
        ? params.codexJsonlPath === undefined
          ? {}
          : { codexJsonlPath: params.codexJsonlPath }
        : { codexJsonlPath: response.thread.path }),
      process: proc,
      configPath,
      ...(params.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: params.heartbeatIntervalMs }),
      ...(params.inactivityThresholdMs === undefined ? {} : { inactivityThresholdMs: params.inactivityThresholdMs }),
      ...(response.model === undefined ? {} : { codexModel: response.model }),
      ...(params.permissionDeferTimeoutMs === undefined
        ? {}
        : { permissionDeferTimeoutMs: params.permissionDeferTimeoutMs }),
    })

    return { sessionId: params.sessionId }
  }

  public async loadSession(params: LoadSessionRequest): Promise<NewSessionResult> {
    const state = this.sessions.get(params.sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(params.sessionId)
    }
    if (state.process === undefined) {
      throw new SessionNotFoundError(`${params.sessionId} (no codex subprocess)`)
    }

    // Codex `ThreadResumeParams` requires `threadId` (camelCase, non-
    // optional). Path-based resume is not exposed in the public v2
    // schema. Phase 2 T11's Pattern B JSONL handoff is captured in
    // codexJsonlPath but the resume call uses threadId alone; codex
    // glob-resolves the rollout file from the threadId on its side.
    if (state.codexThreadId === undefined) {
      throw new SessionNotFoundError(`${params.sessionId} (no codex thread id)`)
    }

    const response = await state.process.request<{ thread: { id: string; path?: string } }>('thread/resume', {
      threadId: state.codexThreadId,
    })

    // Refresh state in case codex returned an updated path.
    state.codexThreadId = response.thread.id
    if (response.thread.path !== undefined) {
      state.codexJsonlPath = response.thread.path
    }
    return { sessionId: params.sessionId }
  }

  public async forkSession(params: ForkSessionRequest): Promise<NewSessionResult> {
    const sourceState = this.sessions.get(params.sourceSessionId)
    if (sourceState === undefined) {
      throw new SessionNotFoundError(params.sourceSessionId)
    }
    if (sourceState.process === undefined || sourceState.codexThreadId === undefined) {
      throw new SessionNotFoundError(`${params.sourceSessionId} (no codex thread)`)
    }

    // Reuse the source subprocess: codex app-server hosts both threads.
    // Fresh ACP sessionId allocated; mapping back to the new
    // codexThreadId from the fork response.
    const response = await sourceState.process.request<{ thread: { id: string; path?: string } }>('thread/fork', {
      threadId: sourceState.codexThreadId,
      ephemeral: false,
    })

    const newSessionId = randomUUID()
    this.sessions.set(newSessionId, {
      sessionId: newSessionId,
      codexThreadId: response.thread.id,
      ...(response.thread.path === undefined ? {} : { codexJsonlPath: response.thread.path }),
      process: sourceState.process,
      configPath: sourceState.configPath,
    })
    return { sessionId: newSessionId }
  }
}
