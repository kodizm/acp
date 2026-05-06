/**
 * ACP server: JSON-RPC 2.0 dispatch over the {@link NdjsonTransport}.
 *
 * Owns the protocol semantics one layer above the byte stream:
 *   - parses each incoming frame as a JSON-RPC envelope
 *   - distinguishes requests (have `id`) from notifications (no `id`)
 *   - dispatches to a method->handler map registered via {@link AcpServer.on}
 *   - tracks outbound requests in a pending-id map so async responses
 *     correlate back to the right awaiter (used by the agent->client
 *     `session/request_permission` round-trip)
 *   - emits responses over the transport with matching `id`
 *
 * Error shapes follow JSON-RPC 2.0:
 *   -32600 Invalid Request    (missing jsonrpc envelope or fields)
 *   -32601 Method Not Found   (no handler registered)
 *   -32602 Invalid Params     (handler-thrown InvalidParamsError; T7)
 *   -32603 Internal Error     (handler-thrown anything else)
 */

import type { NdjsonTransport } from './transport.ts'

/**
 * Standard JSON-RPC 2.0 error codes used at this layer. Custom codes
 * for backend-specific errors live in the per-backend driver layer.
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const

export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode]

/**
 * Wire-side request envelope.
 */
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

/**
 * Wire-side notification envelope (no `id`).
 */
interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/**
 * Wire-side response envelope.
 */
interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Handler signature for incoming requests + notifications. Notification
 * handlers' return values are ignored; request handlers' returns
 * become the `result` field of the response.
 */
export type MethodHandler = (params: unknown) => unknown | Promise<unknown>

/**
 * Construction options.
 */
export interface AcpServerOptions {
  transport: NdjsonTransport
}

/**
 * Public surface of the server. Tests + driver code interact through
 * this contract; the read loop is internal.
 */
export interface AcpServer {
  /**
   * Register a handler for an incoming method. Overwrites any prior
   * registration silently; the AcpServer is single-tenant on method
   * names by design.
   */
  on(method: string, handler: MethodHandler): void

  /**
   * Send an outbound request and await the matching response. The id
   * is allocated internally; correlation is automatic.
   *
   * @throws on error-shaped responses (rejects with a JS Error carrying
   *         the wire `message` and `data`)
   */
  request<T = unknown>(method: string, params: unknown): Promise<T>

  /**
   * Send an outbound notification. Fire-and-forget; no response.
   */
  notify(method: string, params: unknown): void

  /**
   * Start the dispatch loop. Resolves when the transport's readable
   * stream signals end-of-stream.
   */
  serve(): Promise<void>
}

/**
 * Determine whether a parsed wire object is a JSON-RPC v2 envelope.
 * Used as the gatekeeper before any dispatch decision.
 */
function isJsonRpcEnvelope(value: unknown): value is { jsonrpc: '2.0'; method?: string; id?: string | number } {
  return typeof value === 'object' && value !== null && (value as { jsonrpc?: unknown }).jsonrpc === '2.0'
}

/**
 * Build an {@link AcpServer} bound to the given transport.
 */
export function createAcpServer(options: AcpServerOptions): AcpServer {
  const { transport } = options

  const handlers = new Map<string, MethodHandler>()
  const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>()
  let nextId = 1

  const writeResponse = async (id: string | number, result: unknown): Promise<void> => {
    const response: JsonRpcResponse = { jsonrpc: '2.0', id, result }
    await transport.writeFrame(response)
  }

  const writeError = async (id: string | number, code: number, message: string, data?: unknown): Promise<void> => {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    }
    await transport.writeFrame(response)
  }

  /**
   * Dispatch an incoming request. Catches handler throws and maps them
   * to -32603 Internal Error responses; -32601 fires when no handler
   * is registered.
   */
  const handleRequest = async (frame: JsonRpcRequest): Promise<void> => {
    const handler = handlers.get(frame.method)

    if (handler === undefined) {
      await writeError(frame.id, JsonRpcErrorCode.MethodNotFound, `method not found: ${frame.method}`)
      return
    }

    try {
      const result = await handler(frame.params)
      await writeResponse(frame.id, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal error'
      await writeError(frame.id, JsonRpcErrorCode.InternalError, message)
    }
  }

  /**
   * Dispatch an incoming notification. Handler return values are
   * discarded; throws are swallowed (no response surface to report
   * them on, the server-side logger should pick up the trail).
   */
  const handleNotification = async (frame: JsonRpcNotification): Promise<void> => {
    const handler = handlers.get(frame.method)
    if (handler === undefined) {
      return
    }
    try {
      await handler(frame.params)
    } catch {
      // swallow; notifications carry no response surface
    }
  }

  /**
   * Settle a pending outbound request when its response lands.
   */
  const handleResponse = (frame: JsonRpcResponse): void => {
    const entry = pending.get(frame.id)
    if (entry === undefined) {
      return
    }
    pending.delete(frame.id)

    if (frame.error !== undefined) {
      const err = new Error(frame.error.message)
      Object.assign(err, { code: frame.error.code, data: frame.error.data })
      entry.reject(err)
      return
    }

    entry.resolve(frame.result)
  }

  return {
    on(method: string, handler: MethodHandler): void {
      handlers.set(method, handler)
    },

    request<T = unknown>(method: string, params: unknown): Promise<T> {
      const id = nextId++
      const frame: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }

      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject })

        // 1. Fire the request frame; if the transport rejects (closed),
        //    drop the pending entry and surface the failure.
        transport.writeFrame(frame).catch((error) => {
          pending.delete(id)
          reject(error)
        })
      })
    },

    notify(method: string, params: unknown): void {
      const frame: JsonRpcNotification = { jsonrpc: '2.0', method, params }
      // Fire-and-forget; errors land in the unhandled-rejection lane,
      // which the bin's bootstrap pipes through the logger.
      void transport.writeFrame(frame)
    },

    async serve(): Promise<void> {
      // 1. Pull frames off the wire and dispatch by shape.
      for await (const raw of transport.readFrames()) {
        // 2. Reject anything that is not a valid JSON-RPC envelope. If
        //    the malformed frame still carries an id, send an
        //    InvalidRequest response back; otherwise drop silently.
        if (!isJsonRpcEnvelope(raw)) {
          if (
            typeof raw === 'object' &&
            raw !== null &&
            (raw as { id?: unknown }).id !== undefined &&
            (typeof (raw as { id?: unknown }).id === 'string' || typeof (raw as { id?: unknown }).id === 'number')
          ) {
            await writeError(
              (raw as { id: string | number }).id,
              JsonRpcErrorCode.InvalidRequest,
              'invalid JSON-RPC envelope',
            )
          }
          continue
        }

        // 3. Branch on shape: response (has result or error), request
        //    (has method + id), or notification (has method, no id).
        if ((raw as { result?: unknown }).result !== undefined || (raw as { error?: unknown }).error !== undefined) {
          handleResponse(raw as JsonRpcResponse)
          continue
        }

        if (typeof (raw as { method?: unknown }).method !== 'string') {
          continue
        }

        if ((raw as { id?: unknown }).id !== undefined) {
          await handleRequest(raw as JsonRpcRequest)
        } else {
          await handleNotification(raw as JsonRpcNotification)
        }
      }
    },
  }
}
