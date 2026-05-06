import { describe, expect, test } from 'bun:test'

import { classifyCodexError } from '@/backends/codex/error-classifier.ts'

describe('classifyCodexError', () => {
  test('401 / Unauthorized -> auth_error', () => {
    expect(classifyCodexError(new Error('401 Unauthorized: invalid api key')).reason).toBe('auth_error')
    expect(classifyCodexError(new Error('codex auth: invalid CODEX_API_KEY')).reason).toBe('auth_error')
  })

  test('429 / 503 / overloaded -> rate_limit', () => {
    expect(classifyCodexError(new Error('429 Too Many Requests')).reason).toBe('rate_limit')
    expect(classifyCodexError(new Error('503 Service Unavailable: Overloaded')).reason).toBe('rate_limit')
  })

  test('EPIPE / ECONNRESET / subprocess exited -> transport_error', () => {
    expect(classifyCodexError(new Error('write EPIPE')).reason).toBe('transport_error')
    expect(classifyCodexError(new Error('socket ECONNRESET')).reason).toBe('transport_error')
    expect(classifyCodexError(new Error('subprocess exited with code 1')).reason).toBe('transport_error')
    expect(classifyCodexError(new Error('codex stdio closed')).reason).toBe('transport_error')
  })

  test('JSON-RPC parse / Invalid Params -> protocol_violation', () => {
    expect(classifyCodexError(new Error('JSON-RPC parse error: invalid frame')).reason).toBe('protocol_violation')
    expect(classifyCodexError(new Error('Invalid Params: thread_id missing')).reason).toBe('protocol_violation')
    expect(classifyCodexError(new Error('Method not found: thread/foo')).reason).toBe('protocol_violation')
  })

  test('panic / assertion -> internal_panic', () => {
    expect(classifyCodexError(new Error('panic at codex-rs/core/lib.rs')).reason).toBe('internal_panic')
    expect(classifyCodexError(new Error('assertion failed: state invariant')).reason).toBe('internal_panic')
    expect(classifyCodexError(new Error('Tool error: unwrap on None')).reason).toBe('internal_panic')
  })

  test('Tool use aborted -> null (defer-fired sentinel; not a real failure)', () => {
    expect(classifyCodexError(new Error('Tool use aborted'))).toBeNull()
  })

  test('unknown error -> sdk_throw with verbatim detail', () => {
    const result = classifyCodexError(new Error('something completely random'))
    expect(result?.reason).toBe('sdk_throw')
    expect(result?.detail).toContain('something')
  })

  test('non-Error thrown values map to sdk_throw with stringified detail', () => {
    expect(classifyCodexError('plain string').reason).toBe('sdk_throw')
    expect(classifyCodexError({ unstructured: true }).reason).toBe('sdk_throw')
    expect(classifyCodexError(undefined).reason).toBe('sdk_throw')
    expect(classifyCodexError(null).reason).toBe('sdk_throw')
  })
})
