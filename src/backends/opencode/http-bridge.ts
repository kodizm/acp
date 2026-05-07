/**
 * opencode HTTP server lifecycle wrapper.
 *
 * Phase 3 D1 + D2 lock the boot mode: programmatic per-session boot
 * via opencode's official SDK helper (`createOpencodeServer`), which
 * spawns `opencode serve --port 0 --hostname 127.0.0.1` under the
 * hood, waits for the `opencode server listening on …` stdout marker,
 * and resolves with the resulting URL. One bridge per Kodizm session;
 * `stop()` is the canonical session termination signal (mirrors the
 * codex backend's one-subprocess-per-session invariant).
 *
 * The SDK helper layers the cross-spawn subprocess; we add `start()`
 * idempotence + a typed sdk client + cleanup so the driver code can
 * treat it like an in-process resource.
 */

import { createOpencodeServer } from '@opencode-ai/sdk'
import { type OpencodeClient, createOpencodeClient } from '@opencode-ai/sdk/v2'

/**
 * Options the driver passes to {@link OpencodeHttpBridge.start}. The
 * environment override sets `OPENCODE_AUTH_CONTENT` and other
 * provider keys before the SDK spawns the subprocess (Phase 3 D9).
 * `signal` is passed through so the orchestrator can abort an
 * in-flight start.
 */
export interface OpencodeHttpBridgeStartOptions {
  /**
   * Extra environment variables layered onto `process.env` before the
   * opencode subprocess spawns. Most-common keys: `OPENCODE_AUTH_CONTENT`
   * (per-provider auth blob), `OPENCODE_DATA` (alt data dir), provider
   * API keys.
   */
  env?: Record<string, string>
  /**
   * Optional abort signal; surfaces as the SDK helper's `signal`
   * option, killing the start sequence on abort.
   */
  signal?: AbortSignal
  /**
   * Boot timeout in ms; defaults to the SDK's 5_000ms.
   */
  timeoutMs?: number
}

/**
 * Result of a successful {@link OpencodeHttpBridge.start} call.
 * `port` is parsed from `url`; the driver caches both because the
 * port is convenient for log lines and for future cross-process
 * resume probes.
 */
export interface OpencodeHttpBridgeHandle {
  url: string
  port: number
  sdk: OpencodeClient
}

interface ActiveServer {
  url: string
  port: number
  sdk: OpencodeClient
  close: () => void
}

/**
 * Wraps a single opencode HTTP server lifecycle. Construct one per
 * Kodizm session; call `start()` to boot, `stop()` to terminate.
 * Subsequent `start()` calls are idempotent (return the cached
 * handle). The bridge is single-tenant by design; the driver's
 * sessions Map holds one bridge per Kodizm sessionId.
 */
export class OpencodeHttpBridge {
  private active: ActiveServer | undefined

  /**
   * Boot the opencode server. Idempotent: re-invocations on a started
   * bridge return the cached handle without spawning a new
   * subprocess.
   *
   * @param options - boot-time options (env, signal, timeout)
   * @returns the running server's URL + port + SDK client
   *
   * @throws when the SDK helper rejects (timeout, port conflict,
   *         opencode binary missing, etc.); the caller classifies via
   *         {@link import('./error-classifier.ts').classifyOpencodeError}.
   */
  public async start(options: OpencodeHttpBridgeStartOptions = {}): Promise<OpencodeHttpBridgeHandle> {
    if (this.active !== undefined) {
      return {
        url: this.active.url,
        port: this.active.port,
        sdk: this.active.sdk,
      }
    }

    // 1. Layer the per-session env onto process.env. The SDK helper
    //    spawns via cross-spawn which inherits process.env directly,
    //    so we apply the overrides at process scope, then restore
    //    after the subprocess captures them. opencode reads its env
    //    in the first 50ms of boot; restoring env right after start
    //    is safe.
    const envSnapshot = this.captureEnvKeys(options.env ?? {})
    this.applyEnv(options.env ?? {})

    let server: { url: string; close: () => void } | undefined
    try {
      const serverOpts: Parameters<typeof createOpencodeServer>[0] = {
        hostname: '127.0.0.1',
        port: 0,
        timeout: options.timeoutMs ?? 5_000,
      }
      if (options.signal !== undefined) {
        serverOpts.signal = options.signal
      }
      server = await createOpencodeServer(serverOpts)
    } finally {
      // 2. Restore the env so concurrent bridges (different sessions,
      //    different auth) do not leak each other's keys.
      this.restoreEnv(envSnapshot)
    }

    // 3. Build the v2 SDK client pointed at the server URL.
    const sdk = createOpencodeClient({ baseUrl: server.url })

    // 4. Parse the port from the URL for easy logging + reuse.
    const parsedUrl = new URL(server.url)
    const port = Number(parsedUrl.port) || 0

    this.active = {
      url: server.url,
      port,
      sdk,
      close: server.close,
    }

    return {
      url: this.active.url,
      port: this.active.port,
      sdk: this.active.sdk,
    }
  }

  /**
   * Terminate the running listener. No-op when not started. After
   * stop() the bridge can be re-`start`ed; tests rely on this for
   * lifecycle assertions, but production drivers construct one
   * bridge per session and discard it on session close.
   */
  public async stop(): Promise<void> {
    if (this.active === undefined) {
      return
    }
    const { close } = this.active
    this.active = undefined
    close()
    // The SDK helper's close is synchronous (sends SIGTERM via
    // cross-spawn). Give the OS a tick to release the port.
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }

  /**
   * Returns true while the listener is running. Useful for assertions
   * and for the driver's cancel() short-circuit.
   */
  public isRunning(): boolean {
    return this.active !== undefined
  }

  /**
   * Snapshot the prior values of every env key we are about to set so
   * `restoreEnv` can put them back exactly. Missing keys are recorded
   * as `undefined` so restoration unsets them.
   */
  private captureEnvKeys(env: Record<string, string>): Record<string, string | undefined> {
    const snapshot: Record<string, string | undefined> = {}
    for (const key of Object.keys(env)) {
      snapshot[key] = process.env[key]
    }
    return snapshot
  }

  private applyEnv(env: Record<string, string>): void {
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value
    }
  }

  private restoreEnv(snapshot: Record<string, string | undefined>): void {
    for (const [key, prior] of Object.entries(snapshot)) {
      if (prior === undefined) {
        delete process.env[key]
        continue
      }
      process.env[key] = prior
    }
  }
}
