/**
 * Per-reason container exit policy for Phase 1.7 session_failed.
 *
 * Decision matrix locked in `phase-01d-debug-and-lifecycle.md` (locked
 * decision 9):
 *
 *   - Exit container on:
 *       sdk_stall          (hung SDK; can't recover in same process)
 *       transport_error    (stdio dead)
 *       internal_panic     (bridge-side bug)
 *       protocol_violation (wire corrupted)
 *   - Stay alive on:
 *       sdk_throw          (transient; orchestrator may retry)
 *       auth_error         (orchestrator can refresh creds)
 *       rate_limit         (transient; orchestrator backs off)
 *
 * The bin entrypoint (T14) consults this policy after the driver
 * emits session_failed; when true, it triggers graceful shutdown.
 * When false, the dispatcher continues serving subsequent requests
 * on the same session id.
 */

import type { SessionFailedReason } from '../wire/events.ts'

const EXIT_REASONS: ReadonlySet<SessionFailedReason> = new Set([
  'sdk_stall',
  'transport_error',
  'internal_panic',
  'protocol_violation',
])

/**
 * Whether the container should exit gracefully after the given
 * `session_failed` reason fires.
 *
 * @param reason - the canonical {@link SessionFailedReason}
 * @returns true when the container should exit; false when it
 *          should stay alive and accept further requests
 */
export function shouldExitOnReason(reason: SessionFailedReason): boolean {
  return EXIT_REASONS.has(reason)
}
