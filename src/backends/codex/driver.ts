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
import { CodexAppServerProcess, type CodexDebugSink } from './app-server-spawn.ts'
import { buildCodexConfigToml } from './config-mapper.ts'
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
}

const FULL_CAPABILITIES: DriverCapabilities = {
  resume: true,
  fork: true,
  fileUpload: true,
  thinking: true,
  subagent: true,
  skillEvents: false,
  debug: true,
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

    const threadResponse = await proc.request<{
      thread: { id: string; path?: string }
      model?: string
    }>('thread/start', {
      cwd: params.cwd,
      approval_policy: approvalPolicy,
      sandbox_policy: sandboxPolicy,
      ...(params.model === undefined ? {} : { model: params.model }),
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

    // 1. Allocate per-turn abort controller; cancel() flips it.
    const abortController = new AbortController()
    state.abortController = abortController

    // 2. Translate canonical content blocks to codex UserInput[].
    const inputs: Array<{ type: string; text?: string }> = []
    for (const block of params.prompt) {
      if (typeof block === 'object' && block !== null) {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') {
          inputs.push({ type: 'text', text: b.text })
        }
      }
    }

    // 3. Phase 1.7 lifecycle timers.
    const promptStartedAt = Date.now()
    let lastEventAt = promptStartedAt
    let stopReason: PromptResult['stopReason'] = 'end_turn'
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
    const turnDone = new Promise<void>((resolve) => {
      resolveTurn = resolve
    })

    const off = state.process.onNotification((method, _notifParams) => {
      lastEventAt = Date.now()
      if (method === 'turn/started') {
        return
      }
      if (method === 'turn/completed') {
        // T7 will read params.turn.status to set stopReason; for now,
        // assume end_turn unless cancel was already in flight.
        if (stopReason !== 'session_failed' && stopReason !== 'cancelled') {
          stopReason = 'end_turn'
        }
        resolveTurn()
        return
      }
      // T7 wires the full event-mapper. For T4 we don't emit any
      // canonical events for output_chunk / tool_call_*; that lands
      // in T7. Tests for T4 only assert lifecycle (heartbeat, cancel,
      // stall, end_turn).
    })
    void off // returned by onNotification when we extend it; T2 didn't return one yet

    // 5. Send turn/start with serialized inputs.
    try {
      const turnStartResult = await state.process.request<{ turn: { id: string } }>('turn/start', {
        thread_id: state.codexThreadId,
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
                thread_id: state.codexThreadId,
                turn_id: state.activeTurnId,
              })
              .catch(() => undefined)
            // Wait for the synthesized turn/completed (with 1s budget).
            await Promise.race([turnDone, new Promise<void>((resolve) => setTimeout(resolve, 1_000))])
          }
          if (!inactivityFired) {
            stopReason = 'cancelled'
            emit.send({ sessionId, type: 'cancelled', reason: 'user_cancel' })
          }
        }
      })
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

  public async loadSession(params: LoadSessionRequest): Promise<NewSessionResult> {
    const state = this.sessions.get(params.sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(params.sessionId)
    }
    if (state.process === undefined) {
      throw new SessionNotFoundError(`${params.sessionId} (no codex subprocess)`)
    }

    // 1. Resume by JSONL path when available (Pattern B handoff sets it
    //    in T11). Otherwise resume by thread_id (default codex behaviour:
    //    glob the rollout-*-<thread_id>.jsonl path on its side).
    const resumeParams: { thread_id?: string; path?: string } = {}
    if (state.codexJsonlPath !== undefined) {
      resumeParams.path = state.codexJsonlPath
    } else if (state.codexThreadId !== undefined) {
      resumeParams.thread_id = state.codexThreadId
    } else {
      throw new SessionNotFoundError(`${params.sessionId} (no codex thread id or path)`)
    }

    const response = await state.process.request<{ thread: { id: string; path?: string } }>(
      'thread/resume',
      resumeParams,
    )

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
      thread_id: sourceState.codexThreadId,
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
