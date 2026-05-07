import { describe, expect, test } from 'bun:test'

import { classifyOpencodeError } from '@/backends/opencode/error-classifier.ts'

/**
 * Phase 3 Task 11: opencode error -> canonical SessionFailedReason.
 *
 * One assertion per branch. opencode surfaces errors as discriminated
 * AssistantError objects + plain HttpError throws; the classifier
 * accepts both.
 */
describe('classifyOpencodeError', () => {
  test('ProviderAuthError -> auth_error', () => {
    const err = { name: 'ProviderAuthError', message: 'invalid api key for opencode-go' }
    expect(classifyOpencodeError(err)?.reason).toBe('auth_error')
  })

  test('APIError 429 -> rate_limit', () => {
    const err = { name: 'APIError', data: { statusCode: 429, message: 'Too many requests' } }
    expect(classifyOpencodeError(err)?.reason).toBe('rate_limit')
  })

  test('APIError 503 -> rate_limit', () => {
    const err = { name: 'APIError', data: { statusCode: 503, message: 'Service unavailable' } }
    expect(classifyOpencodeError(err)?.reason).toBe('rate_limit')
  })

  test('APIError 500 -> transport_error', () => {
    const err = { name: 'APIError', data: { statusCode: 500, message: 'Internal server error' } }
    expect(classifyOpencodeError(err)?.reason).toBe('transport_error')
  })

  test('ContextOverflowError -> transport_error', () => {
    const err = { name: 'ContextOverflowError', message: 'context window exceeded' }
    expect(classifyOpencodeError(err)?.reason).toBe('transport_error')
  })

  test('MessageOutputLengthError -> sdk_throw', () => {
    const err = { name: 'MessageOutputLengthError', message: 'output exceeded max tokens' }
    expect(classifyOpencodeError(err)?.reason).toBe('sdk_throw')
  })

  test('MessageAbortedError -> null (cancel sentinel)', () => {
    const err = { name: 'MessageAbortedError', message: 'aborted' }
    expect(classifyOpencodeError(err)).toBeNull()
  })

  test('plain HttpError 401 -> auth_error', () => {
    const err = new Error('opencode server GET /session/x → 401 Unauthorized')
    expect(classifyOpencodeError(err)?.reason).toBe('auth_error')
  })

  test('plain HttpError 403 -> auth_error', () => {
    const err = new Error('opencode server POST /session/y → 403 Forbidden')
    expect(classifyOpencodeError(err)?.reason).toBe('auth_error')
  })

  test('unknown error -> sdk_throw fallback', () => {
    const err = new Error('something weird went wrong')
    expect(classifyOpencodeError(err)?.reason).toBe('sdk_throw')
  })

  test('UnknownError -> sdk_throw', () => {
    const err = { name: 'UnknownError', message: 'unhandled' }
    expect(classifyOpencodeError(err)?.reason).toBe('sdk_throw')
  })
})
