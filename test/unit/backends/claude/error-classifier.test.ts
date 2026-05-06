import { describe, expect, test } from 'bun:test'

import { classifyClaudeError } from '@/backends/claude/error-classifier.ts'

describe('classifyClaudeError', () => {
  test('401 / Unauthorized -> auth_error', () => {
    const result = classifyClaudeError(new Error('Unauthorized: 401 invalid api key'))
    expect(result?.reason).toBe('auth_error')
  })

  test('Could not resolve authentication -> auth_error', () => {
    const result = classifyClaudeError(new Error('Could not resolve authentication: missing token'))
    expect(result?.reason).toBe('auth_error')
  })

  test('429 rate_limit -> rate_limit', () => {
    const result = classifyClaudeError(new Error('429 rate_limit_exceeded: please retry'))
    expect(result?.reason).toBe('rate_limit')
  })

  test('Overloaded (529) -> rate_limit', () => {
    const result = classifyClaudeError(new Error('Overloaded: 529 retry later'))
    expect(result?.reason).toBe('rate_limit')
  })

  test('EPIPE / ECONNRESET -> transport_error', () => {
    expect(classifyClaudeError(new Error('write EPIPE')).reason).toBe('transport_error')
    expect(classifyClaudeError(new Error('socket ECONNRESET')).reason).toBe('transport_error')
    expect(classifyClaudeError(new Error('stdio closed unexpectedly')).reason).toBe('transport_error')
  })

  test('Tool use aborted -> null (not a real failure; defer-fired path)', () => {
    expect(classifyClaudeError(new Error('Tool use aborted'))).toBeNull()
  })

  test('ede_diagnostic / Claude Code returned an error result -> sdk_throw', () => {
    expect(classifyClaudeError(new Error('Claude Code returned an error result: [ede_diagnostic]')).reason).toBe(
      'sdk_throw',
    )
    expect(classifyClaudeError(new Error('ede_diagnostic stop_reason=tool_use')).reason).toBe('sdk_throw')
  })

  test('unknown error -> sdk_throw with the message in detail', () => {
    const result = classifyClaudeError(new Error('something completely random'))
    expect(result?.reason).toBe('sdk_throw')
    expect(result?.detail).toContain('something completely random')
  })

  test('non-Error thrown values map to sdk_throw with stringified detail', () => {
    expect(classifyClaudeError('plain string')?.reason).toBe('sdk_throw')
    expect(classifyClaudeError({ unstructured: true })?.reason).toBe('sdk_throw')
    expect(classifyClaudeError(undefined)?.reason).toBe('sdk_throw')
  })
})
