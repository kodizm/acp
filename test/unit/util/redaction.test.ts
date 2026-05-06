import { describe, expect, test } from 'bun:test'

import { isRawSecretsMode, redact } from '@/util/redaction.ts'

describe('redact, string inputs', () => {
  test('redacts an OAuth access token in plain string', () => {
    const input = 'Bearer sk-ant-oat01-KdHtbqfyNUx3yAyMkoS_ba0UR7T5WvlERkuyvawoFPfyiodsPtL'
    const result = redact(input)
    expect(result).not.toContain('sk-ant-oat01')
    expect(result).toContain('<REDACTED>')
  })

  test('redacts an api-key style secret in JSON-ish string', () => {
    const input = '{"apiKey":"abcdef0123456789ZZZZZ"}'
    const result = redact(input)
    expect(result).not.toContain('abcdef0123456789ZZZZZ')
    expect(result).toContain('<REDACTED>')
  })

  test('leaves random text without secret patterns alone', () => {
    const input = 'The quick brown fox jumps over the lazy dog 123 times.'
    expect(redact(input)).toBe(input)
  })

  test('redacts kdz-prefixed Kodizm tokens', () => {
    const input = 'token=kdz-int-abcdef.payload.signature'
    const result = redact(input)
    expect(result).not.toContain('kdz-int-abcdef')
  })
})

describe('redact, structured inputs', () => {
  test('redacts a token nested inside an object', () => {
    const input = {
      session: 's1',
      headers: { Authorization: 'Bearer sk-ant-api04-secrettoken123456789' },
    }
    const result = redact(input) as { session: string; headers: { Authorization: string } }
    expect(result.session).toBe('s1')
    expect(result.headers.Authorization).not.toContain('sk-ant-api04')
    expect(result.headers.Authorization).toContain('<REDACTED>')
  })

  test('redacts a token nested inside an array element', () => {
    const input = ['safe text', 'sk-ant-ort01-refresher_payload_value_AbC']
    const result = redact(input) as string[]
    expect(result[0]).toBe('safe text')
    expect(result[1]).not.toContain('sk-ant-ort01')
  })

  test('passes through non-string primitives unchanged', () => {
    const input = { count: 42, ratio: 0.5, enabled: true, missing: null }
    expect(redact(input)).toEqual(input)
  })
})

describe('redact, raw-secrets-mode override', () => {
  test('returns input untouched when rawSecretsMode is true', () => {
    const input = 'Bearer sk-ant-oat01-OPEN_SESAME_TOKEN'
    expect(redact(input, { rawSecretsMode: true })).toBe(input)
  })
})

describe('isRawSecretsMode', () => {
  test('returns true when KODIZM_DEBUG_RAW_SECRETS is "1"', () => {
    expect(isRawSecretsMode({ KODIZM_DEBUG_RAW_SECRETS: '1' })).toBe(true)
  })

  test('returns false when KODIZM_DEBUG_RAW_SECRETS is unset', () => {
    expect(isRawSecretsMode({})).toBe(false)
  })

  test('returns false when set to any other value', () => {
    expect(isRawSecretsMode({ KODIZM_DEBUG_RAW_SECRETS: 'true' })).toBe(false)
    expect(isRawSecretsMode({ KODIZM_DEBUG_RAW_SECRETS: '0' })).toBe(false)
  })
})
