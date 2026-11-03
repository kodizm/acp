import { describe, expect, test } from 'bun:test'

import { LoadSessionRequestSchema, NewSessionRequestSchema } from '@/wire/schemas.ts'

const base = { cwd: '/workspace', mcpServers: [] }

describe('plugins on the session wire', () => {
  test('session/new accepts a plugin directory under /opt/kodizm/plugins/', () => {
    const result = NewSessionRequestSchema.safeParse({ ...base, plugins: ['/opt/kodizm/plugins/ac-lsp'] })

    expect(result.success).toBe(true)
    expect(result.data?.plugins).toEqual(['/opt/kodizm/plugins/ac-lsp'])
  })

  test('session/load carries the same field', () => {
    const result = LoadSessionRequestSchema.safeParse({
      ...base,
      sessionId: 'prior',
      plugins: ['/opt/kodizm/plugins/ac-lsp'],
    })

    expect(result.success).toBe(true)
    expect(result.data?.plugins).toEqual(['/opt/kodizm/plugins/ac-lsp'])
  })

  test('the field is optional', () => {
    expect(NewSessionRequestSchema.safeParse(base).success).toBe(true)
  })

  test.each([
    ['a path outside the plugin root', '/etc/x'],
    ['a relative path', 'opt/kodizm/plugins/ac-lsp'],
    ['a parent segment that climbs out of the root', '/opt/kodizm/plugins/../../etc'],
    ['a parent segment in the middle', '/opt/kodizm/plugins/ac-lsp/../../x'],
    ['the root itself', '/opt/kodizm/plugins/'],
    ['a sibling that merely shares the prefix', '/opt/kodizm/plugins-evil/x'],
  ])('rejects %s', (_label, path) => {
    expect(NewSessionRequestSchema.safeParse({ ...base, plugins: [path] }).success).toBe(false)
    expect(LoadSessionRequestSchema.safeParse({ ...base, sessionId: 'prior', plugins: [path] }).success).toBe(false)
  })

  test('rejects plugins smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      ...base,
      _meta: { plugins: ['/opt/kodizm/plugins/ac-lsp'] },
    })

    expect(result.success).toBe(false)
  })
})
