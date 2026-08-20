/**
 * Opencode SSE event dispatcher + turn-completion predicate.
 *
 * Phase 3 T9. The driver opens a long-lived SSE subscription via
 * `sdk.event.subscribe()` (under the hood: `GET /event` text/event-stream)
 * and feeds each frame to `dispatchOpencodeEvent`. The dispatch layer is
 * a pure routing table:
 *
 *   message.part.delta / message.part.updated / message.updated /
 *   session.updated / session.compacted          -> onMessageBus
 *   permission.asked                              -> onPermissionAsked
 *   question.asked                                -> onQuestionAsked
 *   session.error                                 -> onSessionError
 *   else                                          -> drop
 *
 * Turn completion: `message.updated` with `info.role='assistant'` AND
 * `info.time.completed` set is the canonical end-of-turn signal. The
 * driver resolves `prompt()` once that fires.
 */

/**
 * One parsed SSE event from the opencode `/event` stream. Mirrors the
 * shape the SDK's `event.subscribe()` consumer hands out: `{type, properties}`.
 */
export interface OpencodeBusEvent {
  type: string
  properties: unknown
}

/**
 * Dispatch handlers the driver wires to bridge layers (event-mapper,
 * permission-bridge, ask-user-question, error-classifier). Each
 * handler receives the raw `properties` payload; structural decoding
 * happens inside the bridge.
 */
export interface DispatchHandlers {
  onMessageBus: (method: string, properties: unknown) => void
  onPermissionAsked: (properties: unknown) => void
  onQuestionAsked: (properties: unknown) => void
  onSessionError: (properties: unknown) => void
}

const MESSAGE_BUS_TYPES: ReadonlySet<string> = new Set([
  'message.part.delta',
  'message.part.updated',
  'message.part.removed',
  'message.updated',
  'message.removed',
  'session.updated',
  'session.compacted',
])

/**
 * Route one parsed bus event to the right handler. Pure function; no
 * side effects beyond the handler invocations.
 */
export function dispatchOpencodeEvent(event: OpencodeBusEvent, handlers: DispatchHandlers): void {
  if (MESSAGE_BUS_TYPES.has(event.type)) {
    handlers.onMessageBus(event.type, event.properties)
    return
  }
  if (event.type === 'permission.asked') {
    handlers.onPermissionAsked(event.properties)
    return
  }
  if (event.type === 'question.asked') {
    handlers.onQuestionAsked(event.properties)
    return
  }
  if (event.type === 'session.error') {
    handlers.onSessionError(event.properties)
    return
  }
  // Unknown type: silent passthrough so future opencode events do not
  // crash the driver.
}

/**
 * Predicate: does this event signal the end of the whole turn?
 * The driver loops until this returns true, then resolves `prompt()`.
 */
export function isTurnComplete(event: OpencodeBusEvent): boolean {
  // `session.idle` is the only signal that the whole turn is over.
  //
  // This used to key on the first `message.updated` carrying a
  // completed assistant message, which is wrong as soon as the turn
  // calls a tool: the tool-call message completes first, the loop broke
  // on it, and the assistant's follow-up text never reached the
  // orchestrator. A production opencode session emitted
  // tool_call_begin + tool_call_end + usage and no output_chunk at all,
  // while a tool-free prompt looked perfectly fine because it has only
  // one assistant message.
  return event.type === 'session.idle'
}
