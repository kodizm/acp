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
   * Per-turn abort controller; flipped by cancel(). T4 wires this.
   */
  abortController?: AbortController
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
    })

    return { sessionId }
  }

  public async prompt(_sessionId: string, _params: PromptRequest, _emit: EventEmitter): Promise<PromptResult> {
    throw new MethodNotSupportedError('session/prompt', ['initialize', 'session/new'])
  }

  public async cancel(request: CancelRequest): Promise<void> {
    const state = this.sessions.get(request.sessionId)
    if (state === undefined) {
      throw new SessionNotFoundError(request.sessionId)
    }
    // Phase 2 T4 wires turn/interrupt; for T3 we just kill the subprocess
    // so tests can clean up after assertion.
    if (state.process !== undefined) {
      await state.process.kill()
    }
    this.sessions.delete(request.sessionId)
  }

  public async loadSession(_params: LoadSessionRequest): Promise<NewSessionResult> {
    throw new MethodNotSupportedError('session/load', ['initialize', 'session/new', 'session/cancel'])
  }

  public async forkSession(_params: ForkSessionRequest): Promise<NewSessionResult> {
    throw new MethodNotSupportedError('session/fork', ['initialize', 'session/new', 'session/cancel'])
  }
}
