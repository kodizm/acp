#!/usr/bin/env bun
/**
 * kodizm-acp bin entrypoint.
 *
 * Reads `KODIZM_BACKEND` from process.env, constructs the matching
 * backend driver, wires the AcpServer over stdio, and serves until
 * the transport closes. The bin is the only public surface; everything
 * else is internal to the package.
 *
 * Phase 1.7 (T14): graceful SIGTERM / SIGINT handler installs at boot.
 * The handler runs `runShutdown` with a 3s grace window and tears down
 * the registered DebugRecorders + transport before exiting. Active
 * recorders register via {@link registerActiveRecorder}; the bin's
 * server-boot code attaches the transport flush helper via
 * {@link registerShutdownFlusher}.
 *
 * Phase 5 (kodizm-acp v0.5 wire): bin no longer a stub. main() now:
 *   - constructs the driver matching KODIZM_BACKEND
 *   - builds an NdjsonTransport bound to Bun.stdin.stream() + a
 *     Uint8Array sink wrapping process.stdout
 *   - calls createAcpServer({ transport, backend }) and attaches the
 *     server back into the driver for outbound RPCs
 *   - registers a transportFlusher so SIGTERM drains pending writes
 *   - awaits server.serve() until the transport's read stream ends
 */

import type { AcpServerLike } from './backends/claude/permission-bridge.ts'
import { createAcpServer } from './server/acp-server.ts'
import { BackendNotConfiguredError, UnknownBackendError } from './server/errors.ts'
import { runShutdown } from './server/shutdown.ts'
import { createNdjsonTransport, type NdjsonTransport } from './server/transport.ts'
import type { DebugRecorder } from './util/debug-recorder.ts'

/**
 * Backend identifier accepted at runtime. Phase 1 ships `claude`,
 * Phase 2 adds `codex`, Phase 3 adds `opencode`. New backends extend
 * the union here and append to {@link KNOWN_BACKENDS}; the registry
 * construction happens externally so this module stays import-light.
 */
export type SupportedBackend = 'claude' | 'codex' | 'opencode'

const KNOWN_BACKENDS: ReadonlyArray<SupportedBackend> = ['claude', 'codex', 'opencode']

export { BackendNotConfiguredError, UnknownBackendError }

/**
 * Default budget the SIGTERM / SIGINT handler races against. Locked
 * by Phase 1.7 decision 7.
 */
export const SHUTDOWN_GRACE_MS = 3_000

/**
 * Module-scope registry of active recorders. The bin tracks every
 * DebugRecorder it constructs so the shutdown handler can call
 * `flushPending()` on each in parallel.
 */
const activeRecorders = new Set<DebugRecorder>()

/**
 * Optional transport-flush callback. The server boot path registers
 * a flusher pointing to the AcpServer's transport.
 */
let transportFlusher: (() => Promise<void>) | undefined

/**
 * Register a recorder so the shutdown handler can flush it.
 *
 * @param recorder - the recorder to track
 * @returns a deregister callback the recorder's owner calls when the
 *          session ends (so closed recorders do not pin memory)
 */
export function registerActiveRecorder(recorder: DebugRecorder): () => void {
  activeRecorders.add(recorder)
  return () => activeRecorders.delete(recorder)
}

/**
 * Register the transport flush callback the shutdown handler invokes
 * after recorders have flushed.
 */
export function registerShutdownFlusher(flusher: () => Promise<void>): void {
  transportFlusher = flusher
}

/**
 * Internal helper: orchestrate the shutdown side-effects with the
 * supplied grace budget. Exposed for the SIGTERM / SIGINT handler
 * + tests.
 */
export async function performShutdown(graceMs: number = SHUTDOWN_GRACE_MS): Promise<void> {
  await runShutdown({
    graceMs,
    flushRecorders: async () => {
      const recorders = [...activeRecorders]
      await Promise.all(recorders.map((r) => r.flushPending()))
      for (const recorder of recorders) {
        recorder.close()
      }
    },
    flushTransport: async () => {
      if (transportFlusher !== undefined) {
        await transportFlusher()
      }
    },
  })
}

/**
 * Install SIGTERM + SIGINT handlers that run the graceful shutdown
 * cycle then exit. Idempotent: re-installing replaces prior handlers.
 */
export function installShutdownHook(): void {
  const handler = async (signal: string): Promise<void> => {
    process.stderr.write(`${JSON.stringify({ level: 'info', message: 'kodizm-acp shutdown', signal })}\n`)
    await performShutdown()
    process.exit(0)
  }
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
  process.on('SIGTERM', () => void handler('SIGTERM'))
  process.on('SIGINT', () => void handler('SIGINT'))
}

/**
 * Resolve the backend identifier from a captured environment.
 *
 * @param env - mapping of environment variables; pass `process.env` in
 *              production, an inline record in tests
 *
 * @returns the recognized backend identifier
 *
 * @throws {BackendNotConfiguredError} when `KODIZM_BACKEND` is missing
 *                                     or empty
 * @throws {UnknownBackendError}        when `KODIZM_BACKEND` carries an
 *                                      unrecognized value
 */
export function resolveBackendFromEnv(env: Record<string, string | undefined>): SupportedBackend {
  // 1. Reject missing or empty configuration up front.
  const raw = env.KODIZM_BACKEND

  if (raw === undefined || raw === '') {
    throw new BackendNotConfiguredError(`expected one of: ${KNOWN_BACKENDS.join(', ')}`)
  }

  // 2. Reject unknown values; phases 2 and 3 will extend the allowlist.
  if (!KNOWN_BACKENDS.includes(raw as SupportedBackend)) {
    throw new UnknownBackendError(raw, KNOWN_BACKENDS)
  }

  return raw as SupportedBackend
}

/**
 * Construct an NDJSON transport bound to Bun.stdin.stream() +
 * process.stdout. Stdout sink wraps the Node Writable as a
 * WritableStream<Uint8Array> the transport's writer can drive.
 */
function buildStdioTransport(): NdjsonTransport {
  // 1. Bun gives us a ReadableStream<Uint8Array> over stdin natively.
  const readable = Bun.stdin.stream()

  // 2. process.stdout is Node's Writable; wrap it as a WritableStream
  //    so the transport's writer.write/close map cleanly.
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        const ok = process.stdout.write(chunk, (error) => {
          if (error !== undefined && error !== null) {
            reject(error)
            return
          }
          resolve()
        })
        if (!ok) {
          process.stdout.once('drain', () => resolve())
        }
      })
    },
    close() {
      // process.stdout cannot be programmatically closed; leave it
      // alone so the runtime exit path handles the final flush.
    },
  })

  return createNdjsonTransport({
    readable,
    writable,
    onInvalidFrame: (rawLine, error) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          message: 'kodizm-acp invalid frame dropped',
          rawLine: rawLine.slice(0, 200),
          error: message,
        })}\n`,
      )
    },
  })
}

/**
 * Resolve the Claude credential shape from process.env. Subscription
 * mode (CLAUDE_CODE_OAUTH_TOKEN) wins when present; falls back to
 * api-key (ANTHROPIC_API_KEY). The SDK reads env directly; this value
 * is metadata for audit.
 */
function pickClaudeCredentials(env: Record<string, string | undefined>): {
  type: 'subscription' | 'api-key'
  token: string
} {
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN ?? ''
  if (oauth.length > 0) {
    return { type: 'subscription', token: oauth }
  }
  const apiKey = env.ANTHROPIC_API_KEY ?? ''
  return { type: 'api-key', token: apiKey }
}

/**
 * Build the Claude backend driver wired to the real
 * `@anthropic-ai/claude-agent-sdk` query function. Lazy import so the
 * SDK module is only loaded when KODIZM_BACKEND=claude.
 */
async function buildClaudeBackend(): Promise<{
  driver: import('./backends/claude/driver.ts').ClaudeDriver
}> {
  const { ClaudeDriver } = await import('./backends/claude/driver.ts')
  const sdk = await import('@anthropic-ai/claude-agent-sdk')

  // Resolve the claude CLI path explicitly. After bun build, the
  // bundled bin's import.meta.url no longer resolves to the SDK's
  // module dir; the SDK's auto-detection (which uses import.meta.url
  // relative paths to find its bundled-alongside cli.js) silently
  // points at /usr/local/bin/cli.js (a path that does not exist).
  // The SDK then spawns claude as `cli.js` on $PATH, gets ENOENT,
  // and exits with code 1 surfaced as "Claude Code process exited
  // with code 1". Set CLAUDE_CODE_PATH to override or fall back to
  // the canonical install location baked into kodizm-ai-docker.
  const claudePath = process.env.CLAUDE_CODE_PATH ?? '/usr/local/bin/claude'

  const driver = new ClaudeDriver({
    credentials: pickClaudeCredentials(process.env as Record<string, string | undefined>),
    agentInfo: { version: '0.5.4' },
    sdk: {
      // Real-SDK adapter: forwards prompt + options to the SDK's
      // query() iterator. Force `settingSources: []` so the SDK does
      // not read the container-baked /home/agent/.claude/settings.json
      // (which carries Kodizm's curated CC defaults: hooks, model,
      // enabledPlugins, etc.) — those defaults are meant for when a
      // human runs Claude Code interactively. The orchestrator owns
      // the session config it ships through `session/new`; layering
      // a stale settings.json on top creates surprising hangs (the
      // SDK can wait on hooks the container has not provisioned).
      // biome-ignore lint/suspicious/useAwait: AsyncGenerator wrapper requires async signature
      async *query(args) {
        const optsIn = (args as { options?: unknown }).options as Record<string, unknown> | undefined
        const isolated = {
          prompt: (args as { prompt: unknown }).prompt,
          options: {
            ...(optsIn ?? {}),
            settingSources: [],
            // Force the SDK to spawn the system-installed claude CLI
            // instead of trying to resolve cli.js via import.meta.url
            // (which the bundle breaks).
            pathToClaudeCodeExecutable: claudePath,
          },
        }
        for await (const message of sdk.query(isolated as never)) {
          yield message as never
        }
      },
    },
  })

  return { driver }
}

/**
 * Bin entrypoint side-effect runner. Resolves the backend, builds the
 * matching driver + the NDJSON transport, wires the AcpServer, and
 * awaits its serve loop until the transport's read stream ends.
 */
export async function main(): Promise<void> {
  installShutdownHook()
  const backend = resolveBackendFromEnv(process.env as Record<string, string | undefined>)

  process.stderr.write(`${JSON.stringify({ level: 'info', message: 'kodizm-acp resolved backend', backend })}\n`)

  // 1. Build the driver. Codex / opencode wires land in their own
  //    follow-up plans; for now they are recognised by env but throw
  //    a clear "not yet wired" error so the orchestrator surfaces
  //    SessionFailureReason::AuthError rather than a stub-bin EOF.
  let driver: import('./backends/driver.ts').BackendDriver
  if (backend === 'claude') {
    const built = await buildClaudeBackend()
    driver = built.driver
  } else {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        message: 'kodizm-acp backend not yet wired in bin',
        backend,
        hint: `KODIZM_BACKEND=${backend} requires the bin's ${backend}-backend wire (deferred follow-up). Use KODIZM_BACKEND=claude for now.`,
      })}\n`,
    )
    process.exit(2)
  }

  // 2. Build the NDJSON transport over stdin/stdout.
  const transport = buildStdioTransport()

  // 3. Construct the AcpServer with the driver wired as backend.
  const server = createAcpServer({ transport, backend: driver })

  // 4. Wire the server back into the driver for outbound RPCs
  //    (session/request_permission, session/ask_user_question). The
  //    driver was constructed before the server, so this is the
  //    chicken-and-egg break.
  if ('attachServer' in driver && typeof (driver as { attachServer?: unknown }).attachServer === 'function') {
    ;(driver as unknown as { attachServer(s: AcpServerLike): void }).attachServer(server)
  }

  // 5. Register the transport flusher so the SIGTERM hook drains
  //    pending writes before the process exits.
  registerShutdownFlusher(async () => {
    await transport.close()
  })

  // 6. Drive the dispatch loop until the read stream ends. The server
  //    resolves cleanly on EOF; the SIGTERM hook calls process.exit
  //    if the orchestrator drops us mid-prompt.
  await server.serve()
}

// 1. Top-level execution guard: only run main when invoked as the bin,
//    not when imported by tests.
if (import.meta.main) {
  await main()
}
