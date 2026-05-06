/**
 * Typed Error subclasses for the ACP server.
 *
 * Two families:
 *   1. {@link JsonRpcError} subclasses: errors that flow over the wire
 *      as JSON-RPC error responses. Each carries a numeric `code` from
 *      {@link JsonRpcErrorCode} and optional structured `data`.
 *   2. Startup-only errors: thrown before the wire is up (env validation,
 *      backend resolution). Plain `Error` subclasses; never serialized.
 *
 * The `toJsonRpcResponse` helper builds a wire-shape response from any
 * thrown error. Non-JsonRpcError throws fall back to InternalError so
 * the dispatch layer never has to branch on type at the call site.
 */

/**
 * JSON-RPC error codes the server emits.
 *
 * Spec codes (-32700 .. -32600) come from the JSON-RPC 2.0 spec. The
 * Kodizm-custom codes use the implementation-defined range
 * (-32099 .. -32000) for ACP-specific failure modes.
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ProcessDied: -32001,
  Cancelled: -32002,
  BackendDriverError: -32003,
  AcpTimeout: -32004,
  AcpProtocol: -32005,
} as const

export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode]

/**
 * Wire-shape JSON-RPC error response. Returned by {@link toJsonRpcResponse}.
 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: string | number
  error: {
    code: number
    message: string
    data?: unknown
  }
}

/**
 * Options shared by every {@link JsonRpcError} constructor.
 */
export interface JsonRpcErrorOptions {
  data?: unknown
  cause?: unknown
}

/**
 * Base class for any error that can become a JSON-RPC error response.
 *
 * Subclasses pin the `code` field; structured `data` is optional and
 * surfaced on the wire response when present.
 */
export class JsonRpcError extends Error {
  public override readonly name: string = 'JsonRpcError'

  public readonly code: number

  public readonly data: unknown

  public constructor(message: string, code: number, options?: JsonRpcErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.data = options?.data
  }
}

/**
 * -32601 Method Not Found. Emitted when no handler is registered for
 * the incoming request's method.
 */
export class MethodNotFoundError extends JsonRpcError {
  public override readonly name = 'MethodNotFoundError'

  public constructor(method: string, options?: JsonRpcErrorOptions) {
    super(`method not found: ${method}`, JsonRpcErrorCode.MethodNotFound, options)
  }
}

/**
 * -32602 Invalid Params. Thrown by handlers when the request payload
 * fails validation (zod schema rejection, missing required field).
 */
export class InvalidParamsError extends JsonRpcError {
  public override readonly name = 'InvalidParamsError'

  public constructor(message: string, data?: unknown) {
    super(message, JsonRpcErrorCode.InvalidParams, { data })
  }
}

/**
 * -32603 Internal Error. Catch-all for unexpected handler throws.
 */
export class InternalError extends JsonRpcError {
  public override readonly name = 'InternalError'

  public constructor(message: string, options?: JsonRpcErrorOptions) {
    super(message, JsonRpcErrorCode.InternalError, options)
  }
}

/**
 * -32602 Invalid Params, specialized for "you referenced a session id
 * that does not exist". Carries the offending sessionId in data.
 */
export class SessionNotFoundError extends JsonRpcError {
  public override readonly name = 'SessionNotFoundError'

  public constructor(sessionId: string) {
    super(`session not found: ${sessionId}`, JsonRpcErrorCode.InvalidParams, {
      data: { sessionId },
    })
  }
}

/**
 * -32001 Process Died. The spawned backend process exited unexpectedly.
 * Carries the exit code in data so the orchestrator can surface OOM
 * (137) versus crash (other codes) in audit.
 */
export class ProcessDiedError extends JsonRpcError {
  public override readonly name = 'ProcessDiedError'

  public constructor(exitCode: number, detail?: string) {
    const message = detail === undefined ? `backend process died (exit ${exitCode})` : detail
    super(message, JsonRpcErrorCode.ProcessDied, { data: { exitCode } })
  }
}

/**
 * -32002 Cancelled. The session was cancelled by the orchestrator
 * before the in-flight prompt could finish.
 */
export class CancelledError extends JsonRpcError {
  public override readonly name = 'CancelledError'

  public constructor(sessionId: string) {
    super(`session cancelled: ${sessionId}`, JsonRpcErrorCode.Cancelled, {
      data: { sessionId },
    })
  }
}

/**
 * -32003 Backend Driver Error. Generic wrapper for failures inside a
 * backend driver (Claude SDK call rejection, codex app-server protocol
 * mismatch, opencode HTTP error). The original cause is preserved
 * via the standard `Error.cause` chain.
 */
export class BackendDriverError extends JsonRpcError {
  public override readonly name = 'BackendDriverError'

  public constructor(message: string, options?: JsonRpcErrorOptions) {
    super(message, JsonRpcErrorCode.BackendDriverError, options)
  }
}

/**
 * -32004 ACP Timeout. The read loop's deadline expired before a frame
 * arrived. Surfaces as the third lifecycle terminator after process
 * death and cancel. Default deadline lives on the AcpServer per
 * request (60s for session/prompt; configurable).
 */
export class AcpTimeoutError extends JsonRpcError {
  public override readonly name = 'AcpTimeoutError'

  public constructor(message = 'ACP read deadline exceeded', options?: JsonRpcErrorOptions) {
    super(message, JsonRpcErrorCode.AcpTimeout, options)
  }
}

/**
 * -32005 ACP Protocol Violation. A frame arrived that is not a valid
 * JSON-RPC v2 envelope (missing jsonrpc field, malformed shape) or a
 * JSON-RPC envelope that breaks ACP-specific invariants. Distinct
 * from -32600 InvalidRequest because protocol-level violations may
 * indicate adapter-version drift, not just bad client behavior.
 */
export class AcpProtocolError extends JsonRpcError {
  public override readonly name = 'AcpProtocolError'

  public constructor(message: string, options?: JsonRpcErrorOptions) {
    super(message, JsonRpcErrorCode.AcpProtocol, options)
  }
}

/**
 * Startup error: `KODIZM_BACKEND` env is missing or empty. Thrown by
 * the bin's resolver before any wire is up; never serialized to a
 * JSON-RPC response. Logged to stderr; the process exits non-zero.
 */
export class BackendNotConfiguredError extends Error {
  public override readonly name = 'BackendNotConfiguredError'

  public constructor(detail: string) {
    super(`KODIZM_BACKEND is not set or empty (${detail})`)
  }
}

/**
 * Startup error: `KODIZM_BACKEND` carries a value not in the allowlist.
 * Same lifecycle as {@link BackendNotConfiguredError}; never serialized.
 */
export class UnknownBackendError extends Error {
  public override readonly name = 'UnknownBackendError'

  public constructor(value: string, knownBackends: ReadonlyArray<string>) {
    super(`unknown backend: ${value} (known: ${knownBackends.join(', ')})`)
  }
}

/**
 * Build a wire-shape JSON-RPC error response from any thrown error.
 *
 * - {@link JsonRpcError} subclasses: code + message come from the
 *   instance; data is included when present.
 * - Plain {@link Error}: falls back to InternalError code; message is
 *   preserved verbatim.
 * - Anything else: stringified into the message; InternalError code.
 *
 * @param id - the JSON-RPC request id to correlate the response with
 * @param error - the thrown value
 * @returns a wire-shape error response ready for the transport
 */
export function toJsonRpcResponse(id: string | number, error: unknown): JsonRpcErrorResponse {
  // 1. JsonRpcError instances carry their own code + optional data.
  if (error instanceof JsonRpcError) {
    const errorPayload: JsonRpcErrorResponse['error'] =
      error.data === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, data: error.data }

    return {
      jsonrpc: '2.0',
      id,
      error: errorPayload,
    }
  }

  // 2. Plain Error throws map to InternalError; preserve the message.
  if (error instanceof Error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: JsonRpcErrorCode.InternalError,
        message: error.message,
      },
    }
  }

  // 3. Anything else (string throws, undefined, weirdness): stringify.
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: JsonRpcErrorCode.InternalError,
      message: String(error),
    },
  }
}
