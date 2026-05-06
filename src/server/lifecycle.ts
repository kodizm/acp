/**
 * Lifecycle terminator probes for the ACP read loop.
 *
 * Mirrors the four-probe ladder the Laravel-side `AcpClient::request()`
 * polls each 0.5s read slice. The loop must surface the first
 * terminating condition as a typed JSON-RPC error so the dispatch
 * layer can unwind cleanly:
 *
 *   1. Transport liveness (subprocess still up)        -> ProcessDiedError
 *   2. Cancel signal (with 2s grace window)            -> CancelledError
 *   3. Read deadline reached                           -> AcpTimeoutError
 *   4. Inbound frame fails protocol validation         -> AcpProtocolError
 *
 * Probes 1-3 fire from the polling tick; probe 4 fires per-frame on
 * read. They are split so the read loop can short-circuit when a
 * terminator wins without parsing the next frame, while the per-frame
 * check still rejects malformed input.
 */

import { AcpProtocolError, AcpTimeoutError, CancelledError, type JsonRpcError, ProcessDiedError } from './errors.ts'

/**
 * Default grace window after a cancel signal during which the loop
 * still drains in-flight frames before raising. Matches the Laravel
 * side's CANCEL_GRACE_SECONDS.
 */
export const CANCEL_GRACE_SECONDS_DEFAULT = 2

/**
 * State the read loop maintains and the polling probes consume.
 *
 * - {@link isAlive} returns whether the underlying transport (subprocess
 *   stdio) is still healthy. The probe never blocks.
 * - {@link cancelledAt} is null while no cancel has been issued; once
 *   the orchestrator calls `session/cancel` the value is the
 *   `Date.now()` at which the cancel arrived. The grace window is
 *   measured from that instant.
 * - {@link sessionId} is required for the {@link CancelledError}'s
 *   data payload; without it the cancelled-session attribution would
 *   be ambiguous to downstream audit.
 * - {@link graceSeconds} overrides {@link CANCEL_GRACE_SECONDS_DEFAULT}
 *   for tests or aggressive cancel modes.
 * - {@link deadlineMs} is an absolute `Date.now()` value past which
 *   the loop must raise {@link AcpTimeoutError}. Optional (the
 *   default request has a 60s deadline; long-running tool calls may
 *   set a longer deadline).
 */
export interface LifecycleState {
  isAlive: () => boolean
  cancelledAt: number | null
  sessionId: string
  graceSeconds?: number
  deadlineMs?: number
}

/**
 * Run the four polling terminators in priority order. Returns the
 * first matching error or `null` when the loop should keep reading.
 *
 * Priority: process death > cancel-past-grace > deadline. Probes are
 * pure functions of the input state; no global clocks are read except
 * via `Date.now()` so tests can mutate the state directly without
 * mocking time.
 *
 * @param state - the read loop's lifecycle snapshot
 * @returns a {@link JsonRpcError} when a terminator fires; `null`
 *          when no terminator matched
 */
export function pollTerminators(state: LifecycleState): JsonRpcError | null {
  // 1. Process death wins over everything; once the transport is dead
  //    the other probes' results are meaningless.
  if (!state.isAlive()) {
    return new ProcessDiedError(0, 'transport reported not-alive')
  }

  // 2. Cancel: respect the grace window so in-flight frames have a
  //    chance to drain before the error fires. Within the grace,
  //    return null so the loop keeps reading.
  if (state.cancelledAt !== null) {
    const graceSeconds = state.graceSeconds ?? CANCEL_GRACE_SECONDS_DEFAULT
    const elapsedMs = Date.now() - state.cancelledAt
    if (elapsedMs >= graceSeconds * 1000) {
      return new CancelledError(state.sessionId)
    }
  }

  // 3. Deadline: the absolute timestamp past which the loop is no
  //    longer allowed to wait for a frame.
  if (state.deadlineMs !== undefined && Date.now() >= state.deadlineMs) {
    return new AcpTimeoutError()
  }

  return null
}

/**
 * Validate that a parsed wire object is a valid JSON-RPC v2 envelope.
 *
 * Used per-frame on read to short-circuit malformed input before the
 * dispatcher branches on shape. Returns null for valid envelopes,
 * {@link AcpProtocolError} otherwise.
 *
 * Distinguished from -32600 InvalidRequest: that one fires when an
 * envelope is structurally valid but breaks JSON-RPC's request shape
 * (id present but no method, etc.). This one fires when the bytes
 * themselves do not constitute a JSON-RPC v2 message at all.
 *
 * @param raw - the parsed JSON value off the transport
 * @returns null if valid; {@link AcpProtocolError} if malformed
 */
export function validateProtocolFrame(raw: unknown): AcpProtocolError | null {
  // 1. Reject anything that is not a plain object.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return new AcpProtocolError(`expected JSON-RPC v2 envelope, got ${typeof raw}`)
  }

  const obj = raw as Record<string, unknown>

  // 2. The jsonrpc field must be exactly the literal "2.0".
  if (obj.jsonrpc !== '2.0') {
    return new AcpProtocolError(`missing or invalid jsonrpc field (expected "2.0", got ${JSON.stringify(obj.jsonrpc)})`)
  }

  // 3. Distinguish requests/notifications (carry method) from responses
  //    (carry result or error). Requests + notifications must have
  //    method as a string; responses must NOT carry method.
  const hasMethod = typeof obj.method === 'string'
  const hasResult = obj.result !== undefined
  const hasError = obj.error !== undefined

  if (!hasMethod && !hasResult && !hasError) {
    return new AcpProtocolError('frame is neither a request, notification, nor response')
  }

  return null
}
