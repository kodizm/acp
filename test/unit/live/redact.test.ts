import { describe, expect, test } from 'bun:test'

import { REDACTED, redact } from '@/live/redact.ts'

// Planted FAKE values only. Each stays under the repository secret scan's length floor.
const FAKE_GATEWAY_KEY = 'kgw-FAKE0001abcd'
const FAKE_ANTHROPIC_KEY = 'sk-ant-FAKE0001'
const FAKE_AGENT_JWT = 'kdz-int-jwt.eyJGQUtFIjoxfQ.0f0f'

describe('redact, known values', () => {
  test('replaces every occurrence of an injected value', () => {
    expect(redact('a=plainsecret b=plainsecret', ['plainsecret'])).toBe(`a=${REDACTED} b=${REDACTED}`)
  })

  test('replaces the longer of two overlapping values whole', () => {
    expect(redact('token: abcdef123', ['abc', 'abcdef123'])).toBe(`token: ${REDACTED}`)
  })

  test('treats a value as a literal, not a pattern', () => {
    expect(redact('x a.b+c y aXbbc', ['a.b+c'])).toBe(`x ${REDACTED} y aXbbc`)
  })

  test('ignores an empty known value', () => {
    expect(redact('nothing secret', [''])).toBe('nothing secret')
  })
})

describe('redact, credential patterns', () => {
  const cases: ReadonlyArray<[string, string, string, string]> = [
    ['gateway key', `Authorization: Bearer ${FAKE_GATEWAY_KEY} done`, 'Authorization: Bearer ', FAKE_GATEWAY_KEY],
    ['anthropic key', `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}\n`, 'ANTHROPIC_API_KEY=', FAKE_ANTHROPIC_KEY],
    ['anthropic oauth token shape', 'tok sk-ant-oat01-FAKE_x-y end', 'tok ', 'sk-ant-oat01-FAKE_x-y'],
    ['internal agent jwt', `{"auth":"${FAKE_AGENT_JWT}"}`, '{"auth":"', FAKE_AGENT_JWT],
  ]

  for (const [label, input, keptPrefix, secret] of cases) {
    test(label, () => {
      const result = redact(input, [])
      expect(result).not.toContain(secret)
      expect(result).toContain(`${keptPrefix}${REDACTED}`)
    })
  }

  test('git url credential keeps the host', () => {
    const result = redact('remote https://x-access-token:ghs_FAKE0001@github.com/org/repo.git', [])
    expect(result).toBe(`remote https://x-access-token:${REDACTED}@github.com/org/repo.git`)
  })

  test('private key block is replaced whole', () => {
    const block = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'RkFLRQ==',
      'RkFLRQ==',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n')
    expect(redact(`before\n${block}\nafter`, [])).toBe(`before\n${REDACTED}\nafter`)
  })

  test('truncated private key block is replaced to the end of the text', () => {
    expect(redact('before\n-----BEGIN RSA PRIVATE KEY-----\nRkFLRQ==', [])).toBe(`before\n${REDACTED}`)
  })

  test('two key blocks are replaced separately', () => {
    const block = '-----BEGIN PRIVATE KEY-----\nRkFLRQ==\n-----END PRIVATE KEY-----'
    expect(redact(`${block} mid ${block}`, [])).toBe(`${REDACTED} mid ${REDACTED}`)
  })

  test('leaves ordinary text alone', () => {
    const text = 'kgw is a word, sk-ant is a prefix, kdz-int-jwt is a name; x-access-token: is a header'
    expect(redact(text, [])).toBe(text)
  })

  test('redacts known values and patterns in one pass', () => {
    const result = redact(`k=${FAKE_GATEWAY_KEY} v=injected-value-1`, ['injected-value-1'])
    expect(result).toBe(`k=${REDACTED} v=${REDACTED}`)
  })
})
