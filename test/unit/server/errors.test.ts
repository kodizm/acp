import { describe, expect, test } from 'bun:test'

import {
  BackendDriverError,
  BackendNotConfiguredError,
  CancelledError,
  InternalError,
  InvalidParamsError,
  JsonRpcError,
  JsonRpcErrorCode,
  MethodNotFoundError,
  ProcessDiedError,
  SessionNotFoundError,
  UnknownBackendError,
  toJsonRpcResponse,
} from '@/server/errors.ts'

describe('JsonRpcError subclasses', () => {
  test('MethodNotFoundError carries code -32601', () => {
    const error = new MethodNotFoundError('session/foo')
    expect(error).toBeInstanceOf(JsonRpcError)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(JsonRpcErrorCode.MethodNotFound)
    expect(error.message).toContain('session/foo')
  })

  test('InvalidParamsError carries code -32602 with optional data', () => {
    const error = new InvalidParamsError('cwd must be absolute', { field: 'cwd' })
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams)
    expect(error.data).toEqual({ field: 'cwd' })
  })

  test('InternalError carries code -32603 with optional data', () => {
    const error = new InternalError('boom')
    expect(error.code).toBe(JsonRpcErrorCode.InternalError)
    expect(error.data).toBeUndefined()
  })

  test('SessionNotFoundError maps to -32602 with sessionId in data', () => {
    const error = new SessionNotFoundError('s1')
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams)
    expect(error.data).toEqual({ sessionId: 's1' })
  })

  test('ProcessDiedError carries Kodizm-custom code with exitCode in data', () => {
    const error = new ProcessDiedError(137, 'killed by oom')
    expect(error.code).toBe(JsonRpcErrorCode.ProcessDied)
    expect(error.data).toMatchObject({ exitCode: 137 })
    expect(error.message).toContain('killed by oom')
  })

  test('CancelledError carries Kodizm-custom code', () => {
    const error = new CancelledError('s1')
    expect(error.code).toBe(JsonRpcErrorCode.Cancelled)
    expect(error.data).toEqual({ sessionId: 's1' })
  })

  test('BackendDriverError wraps a backend cause', () => {
    const cause = new Error('SDK contract drift')
    const error = new BackendDriverError('claude SDK call failed', { cause })
    expect(error.code).toBe(JsonRpcErrorCode.BackendDriverError)
    expect(error.cause).toBe(cause)
  })
})

describe('Startup-only errors (do not go on the wire)', () => {
  test('BackendNotConfiguredError is a plain Error subclass', () => {
    const error = new BackendNotConfiguredError('expected one of: claude')
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(JsonRpcError)
    expect(error.name).toBe('BackendNotConfiguredError')
    expect(error.message).toContain('KODIZM_BACKEND is not set')
  })

  test('UnknownBackendError is a plain Error subclass', () => {
    const error = new UnknownBackendError('gemini', ['claude'])
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(JsonRpcError)
    expect(error.name).toBe('UnknownBackendError')
    expect(error.message).toContain('gemini')
    expect(error.message).toContain('claude')
  })
})

describe('toJsonRpcResponse', () => {
  test('builds a JSON-RPC error response with the error code + message', () => {
    const response = toJsonRpcResponse(7, new MethodNotFoundError('nope'))
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: JsonRpcErrorCode.MethodNotFound,
        message: response.error?.message,
      },
    })
    expect(response.error?.message).toContain('nope')
  })

  test('includes data field when the error carries it', () => {
    const response = toJsonRpcResponse('abc', new InvalidParamsError('bad cwd', { field: 'cwd' }))
    expect(response.error?.data).toEqual({ field: 'cwd' })
  })

  test('omits data when the error does not carry it', () => {
    const response = toJsonRpcResponse(1, new InternalError('boom'))
    expect(response.error).not.toHaveProperty('data')
  })

  test('roundtrips every JsonRpcError subclass', () => {
    const cases = [
      new MethodNotFoundError('m1'),
      new InvalidParamsError('p1'),
      new InternalError('i1'),
      new SessionNotFoundError('s1'),
      new ProcessDiedError(1, 'x'),
      new CancelledError('s2'),
      new BackendDriverError('b1'),
    ]

    for (const error of cases) {
      const response = toJsonRpcResponse(1, error)
      expect(response.jsonrpc).toBe('2.0')
      expect(response.id).toBe(1)
      expect(response.error?.code).toBe(error.code)
      expect(response.error?.message).toBe(error.message)
    }
  })

  test('falls back to InternalError code for non-JsonRpcError throws', () => {
    const response = toJsonRpcResponse(1, new Error('mystery'))
    expect(response.error?.code).toBe(JsonRpcErrorCode.InternalError)
    expect(response.error?.message).toBe('mystery')
  })
})
