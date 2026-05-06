/**
 * Graceful shutdown helper for the kodizm-acp bin.
 *
 * Phase 1.7 (T14) locked decision 7: SIGTERM / SIGINT handler flushes
 * pending debug log + emits a final `session_failed` event when a
 * last error was captured + flushes the transport, all within a 3s
 * grace window. SIGKILL bypasses this hook by definition.
 *
 * The runShutdown helper is reusable + framework-free so the bin's
 * signal handler stays a thin glue layer. Tests inject fakes for
 * each side-effect; production hooks pass real flushers.
 */

import type { SessionFailedReason, SessionUpdateEvent } from '../wire/events.ts'

/**
 * Inputs for {@link runShutdown}.
 */
export interface ShutdownOptions {
  /**
   * Total budget in ms. Once exceeded, runShutdown returns
   * `{ timedOut: true }` even if flushers have not yet settled.
   * Caller is expected to call `process.exit()` with the appropriate
   * code regardless.
   */
  graceMs: number
  /**
   * Flush every active DebugRecorder. The bin tracks active recorders
   * in module scope and provides a fan-out that calls
   * `recorder.flushPending()` on each.
   */
  flushRecorders: () => Promise<void>
  /**
   * Flush the AcpServer's transport (drain any queued frames). The
   * bin's NdjsonTransport exposes `close()` / `flush()` that the
   * shutdown helper invokes here.
   */
  flushTransport: () => Promise<void>
  /**
   * Optional final event emitter. When supplied with non-empty
   * {@link finalSessionIds} + a {@link finalReason}, runShutdown
   * emits a `session_failed` event for each session id BEFORE
   * flushing so the orchestrator's stream-event store records the
   * cause of the shutdown.
   */
  emitFinal?: (event: SessionUpdateEvent) => void
  finalReason?: SessionFailedReason
  finalDetail?: string
  finalSessionIds?: ReadonlyArray<string>
}

/**
 * Result of a shutdown cycle.
 */
export interface ShutdownResult {
  /**
   * True when the grace window expired before flushers settled.
   * Caller still proceeds to process.exit() — in autonomous mode
   * the file system may carry partial state, but the wire frames
   * already flushed (transport.flush() resolves separately).
   */
  timedOut: boolean
  /**
   * Errors caught from the flushers. Surfaced to the caller for
   * stderr logging; runShutdown never throws.
   */
  errors: Array<Error>
}

/**
 * Drive the graceful-shutdown cycle within a fixed budget.
 *
 * Phase 1.7 T14. The bin's SIGTERM / SIGINT handler is a thin shim
 * that calls runShutdown then exits with code 0 (clean) or 1
 * (timed out / errors).
 */
export async function runShutdown(options: ShutdownOptions): Promise<ShutdownResult> {
  const errors: Array<Error> = []

  // 1. Emit final session_failed events FIRST so the orchestrator
  //    records the cause before transport drains.
  if (options.emitFinal !== undefined && options.finalReason !== undefined && options.finalSessionIds !== undefined) {
    const detail = options.finalDetail ?? 'shutdown'
    const capturedAt = Date.now()
    for (const sessionId of options.finalSessionIds) {
      try {
        options.emitFinal({
          sessionId,
          type: 'session_failed',
          reason: options.finalReason,
          detail,
          capturedAt,
        })
      } catch (err) {
        errors.push(toError(err))
      }
    }
  }

  // 2. Race the flushers against the grace window.
  const flushers = (async () => {
    try {
      await options.flushRecorders()
    } catch (err) {
      errors.push(toError(err))
    }
    try {
      await options.flushTransport()
    } catch (err) {
      errors.push(toError(err))
    }
  })()

  let timedOut = false
  await Promise.race([
    flushers,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true
        resolve()
      }, options.graceMs)
    }),
  ])

  return { timedOut, errors }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
