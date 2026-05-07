#!/usr/bin/env bun
/**
 * kodizm-acp bin entrypoint.
 *
 * Reads `KODIZM_BACKEND` from process.env, resolves the backend driver,
 * and boots the ACP server over stdio. The bin is the only public
 * surface; everything else is internal to the package.
 *
 * Phase 1.7 (T14): graceful SIGTERM / SIGINT handler installs at boot.
 * The handler runs `runShutdown` with a 3s grace window and tears down
 * the registered DebugRecorders + transport before exiting. Active
 * recorders register via {@link registerActiveRecorder}; the bin's
 * future server-boot code attaches the transport flush helper via
 * {@link registerShutdownFlusher}.
 *
 * Subsequent tasks layer the ACP server (T5+), the Kodizm canonical
 * wire shape (T10+), the backend driver registry (T13+), and the
 * Claude SDK driver (T16+) on top of this entrypoint.
 */

import { BackendNotConfiguredError, UnknownBackendError } from './server/errors.ts'
import { runShutdown } from './server/shutdown.ts'
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
 * Optional transport-flush callback. The future server boot path
 * registers a flusher pointing to the AcpServer's transport.
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
 * Bin entrypoint side-effect runner. Resolves the backend at startup;
 * later tasks extend this to construct the AcpServer + register the
 * resolved backend driver + attach stdin/stdout streams.
 */
export async function main(): Promise<void> {
  installShutdownHook()
  const backend = resolveBackendFromEnv(process.env as Record<string, string | undefined>)

  // 1. Phase 1 placeholder: real boot path lands in T15 (wire AcpServer
  //    to BackendDriver). Until then the bin only validates env and
  //    exits cleanly so the orchestrator's spawn smoke does not hang.
  process.stderr.write(`${JSON.stringify({ level: 'info', message: 'kodizm-acp resolved backend', backend })}\n`)
}

// 1. Top-level execution guard: only run main when invoked as the bin,
//    not when imported by tests.
if (import.meta.main) {
  await main()
}
