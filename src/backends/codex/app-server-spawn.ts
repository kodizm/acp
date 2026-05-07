/**
 * codex app-server subprocess driver.
 *
 * Spawns `codex app-server --listen stdio://`, frames JSON-RPC 2.0
 * messages over NDJSON, and exposes:
 *   - request<T>(method, params): outbound request, awaits matching id
 *   - notify(method, params): outbound notification
 *   - onNotification(handler): subscribe to ServerNotification stream
 *   - onServerRequest(handler): handle codex-initiated requests (the
 *     3 approval RPCs land here)
 *   - kill(): SIGTERM with 3s grace, then SIGKILL fallback
 *
 * Phase 2 T2. Driver-internal seam; CodexDriver constructs one per
 * session. debugSink integration: every inbound frame -> rpc.in,
 * every outbound frame -> rpc.out.
 */

import type { Subprocess } from 'bun'

import type { DebugLogLevel, DebugStage } from '../../wire/events.ts'

/**
 * Minimal sink contract the subprocess tees frames into. Matches the
 * shape of {@link import('../../util/debug-recorder.ts').DebugRecorder.record}
 * so the bin can pass the real recorder.
 */
export interface CodexDebugSink {
  record(stage: DebugStage, payload: unknown, level?: DebugLogLevel): void
}

/**
 * Construction options.
 */
export interface CodexAppServerSpawnOptions {
  /**
   * Path to the codex binary. Defaults to `codex` (PATH lookup) when
   * the bin is installed; tests pass `bun` + a fake codex script via
   * {@link binaryArgs}.
   */
  binaryPath?: string
  /**
   * Extra args before the `app-server --listen stdio://` portion.
   * Tests pass `['run', fakeBinPath]` to launch a fake codex; when
   * empty, the args default to `['app-server', '--listen', 'stdio://']`.
   * When non-empty, the caller takes full control of the arg vector
   * (used by tests to inject the fake script).
   */
  binaryArgs?: ReadonlyArray<string>
  /**
   * Optional `--config <path>` argument; threads through after
   * `binaryArgs` (or before `app-server` when binaryArgs is empty).
   */
  configPath?: string
  /**
   * Override `CODEX_HOME` for the spawned subprocess.
   */
  codexHome?: string
  /**
   * Extra env vars layered onto `process.env` for the subprocess.
   */
  env?: Record<string, string>
  /**
   * Optional debug sink: every JSON-RPC frame in / out is teed into
   * `record('rpc.in' | 'rpc.out', frame)` for forensic capture.
   */
  debugSink?: CodexDebugSink
}

/**
 * Outbound JSON-RPC envelope (request).
 */
interface JsonRpcRequest {
  id: number
  method: string
  params?: unknown
}

/**
 * Outbound JSON-RPC envelope (notification).
 */
interface JsonRpcNotification {
  method: string
  params?: unknown
}

/**
 * Inbound JSON-RPC envelope (response).
 */
interface JsonRpcResponse {
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const DEFAULT_KILL_GRACE_MS = 3_000

/**
 * Long-lived `codex app-server` subprocess wrapper. One instance per
 * AcpSession; killed on session close / container shutdown.
 */
export class CodexAppServerProcess {
  private subprocess: Subprocess<'pipe', 'pipe', 'pipe'> | undefined
  private readonly pendingRequests: Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  > = new Map()
  private readonly notificationHandlers: Array<(method: string, params: unknown) => void> = []
  private serverRequestHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined
  private nextId = 1
  private readBuffer = ''
  private readonly decoder: TextDecoder = new TextDecoder()
  private readonly exitHandlers: Array<(exitCode: number | null) => void> = []
  private exitedFlag = false

  public constructor(private readonly options: CodexAppServerSpawnOptions) {}

  /**
   * Launch the subprocess and start pumping its stdout into the
   * frame dispatcher. Resolves once the process is up.
   *
   * @throws Error when the binary fails to spawn
   */
  public async spawn(): Promise<void> {
    const binaryPath = this.options.binaryPath ?? 'codex'
    const args =
      this.options.binaryArgs !== undefined ? [...this.options.binaryArgs] : ['app-server', '--listen', 'stdio://']

    if (this.options.configPath !== undefined && this.options.binaryArgs === undefined) {
      args.unshift('--config', this.options.configPath)
    }

    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    if (this.options.codexHome !== undefined) {
      env.CODEX_HOME = this.options.codexHome
    }
    if (this.options.env !== undefined) {
      Object.assign(env, this.options.env)
    }

    this.subprocess = Bun.spawn([binaryPath, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })

    this.startReadLoop()
    this.startExitWatcher()
  }

  /**
   * Watch the subprocess exit; when it dies, reject every pending
   * request with a ProcessExited error AND fire any registered exit
   * handlers. Without this, killing codex mid-turn leaves the awaiting
   * `request<T>()` promise (or the `turn/completed` waiter inside the
   * driver) forever.
   */
  private startExitWatcher(): void {
    if (this.subprocess === undefined) {
      return
    }
    const proc = this.subprocess
    void (async () => {
      const exitCode = await proc.exited
      this.exitedFlag = true
      const error = new Error(`codex subprocess exited (code ${exitCode ?? 'null'})`)
      Object.assign(error, { code: 'CODEX_PROCESS_EXITED' })
      for (const [id, pending] of this.pendingRequests) {
        this.pendingRequests.delete(id)
        pending.reject(error)
      }
      for (const handler of this.exitHandlers) {
        try {
          handler(exitCode ?? null)
        } catch {
          // handler swallowed; subprocess exit is terminal
        }
      }
    })()
  }

  /**
   * Subscribe to the subprocess `exited` event. Driver wires this to
   * abort the per-turn controller so an unexpected codex crash unwinds
   * the awaiting prompt instead of hanging on the unfinished
   * `turn/completed` notification.
   */
  public onExit(handler: (exitCode: number | null) => void): void {
    this.exitHandlers.push(handler)
    if (this.exitedFlag) {
      // Already exited; fire synchronously.
      try {
        handler(null)
      } catch {
        // swallow
      }
    }
  }

  /**
   * Send the JSON-RPC `initialize` request, await the response, then
   * send the `initialized` notification.
   *
   * @param params - the codex InitializeParams. `clientInfo` is
   *   required by codex app-server (`Invalid request: missing field
   *   clientInfo` otherwise); we inject a sane default when caller
   *   omits.
   */
  public async initialize<T = Record<string, unknown>>(params: {
    protocolVersion?: number
    clientInfo?: { name: string; version: string; title?: string }
  }): Promise<T> {
    const enriched: Record<string, unknown> = {
      clientInfo: params.clientInfo ?? { name: 'kodizm-acp', version: '0.0.1' },
    }
    if (params.protocolVersion !== undefined) {
      enriched.protocolVersion = params.protocolVersion
    }
    const result = await this.request<T>('initialize', enriched)
    this.notify('initialized', {})
    return result
  }

  /**
   * Outbound JSON-RPC request. Allocates a fresh id, writes the frame,
   * and resolves on the matching response (or rejects on error).
   */
  public request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++
    const frame: JsonRpcRequest = { id, method, params }
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.writeFrame(frame)
    })
  }

  /**
   * Outbound notification. Fire-and-forget; no correlation.
   */
  public notify(method: string, params: unknown): void {
    const frame: JsonRpcNotification = { method, params }
    this.writeFrame(frame)
  }

  /**
   * Subscribe to inbound ServerNotifications (no id; codex pushes
   * during a turn).
   */
  public onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler)
  }

  /**
   * Register the handler for codex-initiated requests (the 3 approval
   * RPCs). The handler's resolved value becomes the response result.
   */
  public onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.serverRequestHandler = handler
  }

  /**
   * Send SIGTERM, give the subprocess up to {@link graceMs} to exit
   * cleanly, then send SIGKILL. Idempotent; safe in finally blocks.
   *
   * @param graceMs - budget before SIGKILL fallback (default 3000ms)
   */
  public async kill(graceMs: number = DEFAULT_KILL_GRACE_MS): Promise<void> {
    if (this.subprocess === undefined) {
      return
    }
    const proc = this.subprocess
    proc.kill('SIGTERM')
    const exited = await Promise.race([
      proc.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), graceMs)),
    ])
    if (exited === 'timeout') {
      proc.kill('SIGKILL')
      await proc.exited
    }
    this.subprocess = undefined
  }

  private writeFrame(frame: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (this.subprocess === undefined) {
      throw new Error('CodexAppServerProcess: subprocess not spawned')
    }
    this.options.debugSink?.record('rpc.out', frame)
    const line = `${JSON.stringify(frame)}\n`
    this.subprocess.stdin.write(line)
  }

  private startReadLoop(): void {
    if (this.subprocess === undefined) {
      return
    }
    void (async () => {
      const reader = this.subprocess?.stdout.getReader()
      if (reader === undefined) {
        return
      }
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          this.readBuffer += this.decoder.decode(value, { stream: true })
          const lines = this.readBuffer.split('\n')
          this.readBuffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line === '') continue
            this.handleFrame(line)
          }
        }
      } catch {
        // subprocess died; pending requests will reject via .exited handler
      }
    })()
  }

  private handleFrame(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // malformed line; surface via debug sink
      this.options.debugSink?.record('rpc.in', { malformed: line }, 'warn')
      return
    }

    this.options.debugSink?.record('rpc.in', parsed)
    const frame = parsed as Partial<JsonRpcResponse> & Partial<JsonRpcRequest> & Partial<JsonRpcNotification>

    // 1. Response (has id + result/error).
    if (typeof frame.id === 'number' && (frame.result !== undefined || frame.error !== undefined)) {
      const pending = this.pendingRequests.get(frame.id)
      if (pending !== undefined) {
        this.pendingRequests.delete(frame.id)
        if (frame.error !== undefined) {
          const err = new Error(frame.error.message)
          Object.assign(err, { code: frame.error.code, data: frame.error.data })
          pending.reject(err)
        } else {
          pending.resolve(frame.result)
        }
      }
      return
    }

    // 2. Server-initiated request (has id + method).
    if (typeof frame.id === 'number' && typeof frame.method === 'string') {
      const handler = this.serverRequestHandler
      const requestId = frame.id
      const method = frame.method
      const params = frame.params
      void (async () => {
        try {
          const result = handler === undefined ? null : await handler(method, params)
          const response: JsonRpcResponse = { id: requestId, result }
          this.writeFrame(response)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'internal error'
          const response: JsonRpcResponse = {
            id: requestId,
            error: { code: -32603, message },
          }
          this.writeFrame(response)
        }
      })()
      return
    }

    // 3. Notification (method, no id).
    if (typeof frame.method === 'string') {
      for (const handler of this.notificationHandlers) {
        try {
          handler(frame.method, frame.params)
        } catch {
          // swallow handler errors; logger picks up the trail
        }
      }
    }
  }
}
