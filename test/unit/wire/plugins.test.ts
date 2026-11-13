import { describe, expect, test } from 'bun:test'

import { LoadSessionRequestSchema, NewSessionRequestSchema, PLUGIN_ROOT, PluginPathSchema } from '@/wire/schemas.ts'

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

  test('the exported schema the tmuxd start shares accepts a directory under the exported root', () => {
    expect(PLUGIN_ROOT).toBe('/opt/kodizm/plugins/')
    expect(PluginPathSchema.safeParse('/opt/kodizm/plugins/live-1').success).toBe(true)
  })

  test.each([
    ['a parent segment that climbs out of the root', '/opt/kodizm/plugins/../etc'],
    ['a sibling whose name extends the root', '/opt/kodizm/pluginsx/a'],
    ['a relative path', 'plugins/live-1'],
    ['the root itself', '/opt/kodizm/plugins/'],
    ['a dot segment that names the root', '/opt/kodizm/plugins/.'],
    ['a dot segment inside the path', '/opt/kodizm/plugins/./live-1'],
    ['an empty segment', '/opt/kodizm/plugins//live-1'],
    ['a trailing slash', '/opt/kodizm/plugins/live-1/'],
  ])('the exported schema rejects %s', (_label, path) => {
    expect(PluginPathSchema.safeParse(path).success).toBe(false)
  })

  test('rejects plugins smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      ...base,
      _meta: { plugins: ['/opt/kodizm/plugins/ac-lsp'] },
    })

    expect(result.success).toBe(false)
  })
})
