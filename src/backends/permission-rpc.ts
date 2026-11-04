/**
 * Outbound permission-style RPC helpers shared by every backend driver
 * (claude, opencode) and the ACP entrypoint.
 */

import { AcpTimeoutError } from '../server/errors.ts'
import type { SessionUpdateEvent } from '../wire/events.ts'

/**
 * Minimal AcpServer surface we need for the outbound RPC. Defined
 * structurally so unit tests can inject a fake server without
 * pulling the real implementation.
 */
export interface AcpServerLike {
  request<T>(method: string, params: unknown): Promise<T>
}

/**
 * Minimal emitter contract; mirrors `EventEmitter` from
 * `src/backends/driver.ts` but inlined to avoid a circular import.
 */
export interface EmitLike {
  send(event: SessionUpdateEvent): void
}

/**
 * Sentinel returned by {@link awaitPermissionResponse} when the
 * `deferTimeoutMs` racer wins. Caller MUST distinguish this from the
 * normal RPC payload: defer is a soft outcome (state persistence +
 * synthetic JSONL row), NOT a hard timeout (which throws
 * {@link AcpTimeoutError}).
 */
export const DEFERRED_SENTINEL: unique symbol = Symbol.for('kodizm.permission.deferred')

/**
 * Resource-bounded await for an outbound permission-style RPC.
 *
 * Race semantics:
 *   - The RPC promise.
 *   - Optional abort signal -> rejects with `Error('aborted')`.
 *   - Optional `timeoutMs` -> rejects with {@link AcpTimeoutError}.
 *   - Optional `deferTimeoutMs` -> resolves to {@link DEFERRED_SENTINEL}
 *     (soft defer; caller writes synthetic tool_result + persists).
 *
 * Pure helper so AskUserQuestion (T8) can reuse it for its own
 * outbound RPC without re-implementing the race.
 */
export async function awaitPermissionResponse<T>(
  server: AcpServerLike,
  method: string,
  params: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number; deferTimeoutMs?: number } = {},
): Promise<T | typeof DEFERRED_SENTINEL> {
  const racers: Array<Promise<T | typeof DEFERRED_SENTINEL>> = [server.request<T>(method, params)]
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let deferHandle: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined

  if (options.signal !== undefined) {
    const signal = options.signal
    racers.push(
      new Promise<T>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        abortListener = () => reject(new Error('aborted'))
        signal.addEventListener('abort', abortListener)
      }),
    )
  }

  if (options.timeoutMs !== undefined) {
    const timeoutMs = options.timeoutMs
    racers.push(
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new AcpTimeoutError(`permission RPC ${method} timed out`, {
              data: { method, elapsedMs: timeoutMs },
            }),
          )
        }, timeoutMs)
      }),
    )
  }

  if (options.deferTimeoutMs !== undefined) {
    const deferTimeoutMs = options.deferTimeoutMs
    racers.push(
      new Promise<typeof DEFERRED_SENTINEL>((resolve) => {
        deferHandle = setTimeout(() => resolve(DEFERRED_SENTINEL), deferTimeoutMs)
      }),
    )
  }

  try {
    return await Promise.race(racers)
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    if (deferHandle !== undefined) {
      clearTimeout(deferHandle)
    }
    if (abortListener !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener('abort', abortListener)
    }
  }
}
