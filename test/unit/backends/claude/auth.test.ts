import { describe, expect, test } from 'bun:test'

import { AuthMissingError, type ClaudeCredentials, resolveClaudeCredentials } from '@/backends/claude/auth.ts'

describe('resolveClaudeCredentials', () => {
  test('returns subscription credentials when CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_CODE_REMOTE=1 are set', () => {
    const creds = resolveClaudeCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fake-subscription-token',
      CLAUDE_CODE_REMOTE: '1',
    })

    expect(creds.type).toBe('subscription')
    expect(creds.token).toBe('sk-ant-oat-fake-subscription-token')
  })

  test('returns api-key credentials when only ANTHROPIC_API_KEY is set', () => {
    const creds = resolveClaudeCredentials({
      ANTHROPIC_API_KEY: 'sk-ant-api03-fake',
    })

    expect(creds.type).toBe('api-key')
    expect(creds.token).toBe('sk-ant-api03-fake')
  })

  test('subscription wins when both are set', () => {
    const creds = resolveClaudeCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fake',
      CLAUDE_CODE_REMOTE: '1',
      ANTHROPIC_API_KEY: 'sk-ant-api03-fake',
    })

    expect(creds.type).toBe('subscription')
  })

  test('falls back to api-key when subscription token is set but CLAUDE_CODE_REMOTE != 1', () => {
    const creds = resolveClaudeCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fake',
      ANTHROPIC_API_KEY: 'sk-ant-api03-fake',
      // CLAUDE_CODE_REMOTE not set or != "1"
    })

    expect(creds.type).toBe('api-key')
  })

  test('throws AuthMissingError when neither credential is present', () => {
    expect(() => resolveClaudeCredentials({})).toThrow(AuthMissingError)
  })

  test('throws AuthMissingError when ANTHROPIC_API_KEY is empty string', () => {
    expect(() => resolveClaudeCredentials({ ANTHROPIC_API_KEY: '' })).toThrow(AuthMissingError)
  })

  test('throws AuthMissingError when CLAUDE_CODE_OAUTH_TOKEN is empty', () => {
    expect(() =>
      resolveClaudeCredentials({
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_REMOTE: '1',
      }),
    ).toThrow(AuthMissingError)
  })

  test('returned credentials object is the discriminated ClaudeCredentials type', () => {
    const subscription: ClaudeCredentials = resolveClaudeCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: 'a',
      CLAUDE_CODE_REMOTE: '1',
    })
    const apiKey: ClaudeCredentials = resolveClaudeCredentials({
      ANTHROPIC_API_KEY: 'a',
    })

    expect(['subscription', 'api-key']).toContain(subscription.type)
    expect(['subscription', 'api-key']).toContain(apiKey.type)
  })
})
