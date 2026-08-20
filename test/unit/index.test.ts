import { describe, expect, test } from 'bun:test'

import { resolveBackendFromEnv } from '@/index'

describe('resolveBackendFromEnv', () => {
  test('throws BackendNotConfiguredError when KODIZM_BACKEND is missing', () => {
    expect(() => resolveBackendFromEnv({})).toThrow(/KODIZM_BACKEND is not set/)
  })

  test('throws BackendNotConfiguredError when KODIZM_BACKEND is empty', () => {
    expect(() => resolveBackendFromEnv({ KODIZM_BACKEND: '' })).toThrow(/KODIZM_BACKEND is not set/)
  })

  test('accepts claude as a valid backend value', () => {
    const result = resolveBackendFromEnv({ KODIZM_BACKEND: 'claude' })
    expect(result).toBe('claude')
  })

  test('accepts opencode as a valid backend value', () => {
    const result = resolveBackendFromEnv({ KODIZM_BACKEND: 'opencode' })
    expect(result).toBe('opencode')
  })

  test('rejects unknown backend values', () => {
    expect(() => resolveBackendFromEnv({ KODIZM_BACKEND: 'gemini' })).toThrow(/unknown backend/i)
  })
})
