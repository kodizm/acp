import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFERRED_PERMISSION_MARKER,
  findSessionJsonlPath,
  writeDeferredToolResult,
} from '@/backends/claude/deferred-permission.ts'

describe('findSessionJsonlPath', () => {
  test('encodes an absolute cwd by replacing non-alphanumerics with dashes', () => {
    const path = findSessionJsonlPath('/Users/anilcan/Code/kodizm-acp', 'sess_abc123', '/home/.claude')
    expect(path).toBe('/home/.claude/projects/-Users-anilcan-Code-kodizm-acp/sess_abc123.jsonl')
  })

  test('handles cwd with dots and underscores', () => {
    const path = findSessionJsonlPath('/Users/anilcan/Code/foo.bar/baz_qux', 'sess_1', '/home/.claude')
    expect(path).toBe('/home/.claude/projects/-Users-anilcan-Code-foo-bar-baz-qux/sess_1.jsonl')
  })
})

describe('writeDeferredToolResult', () => {
  test('appends a synthetic tool_result row carrying the marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kodizm-deferred-'))
    const jsonlPath = join(dir, 'session.jsonl')
    await writeDeferredToolResult(jsonlPath, 'tu_abc')

    const written = await readFile(jsonlPath, 'utf8')
    const lines = written.trim().split('\n')
    expect(lines.length).toBe(1)

    const [firstLine] = lines
    expect(firstLine).toBeDefined()
    const row = JSON.parse(firstLine ?? '')
    expect(row.type).toBe('user')
    expect(row.message.role).toBe('user')
    expect(row.message.content[0].type).toBe('tool_result')
    expect(row.message.content[0].tool_use_id).toBe('tu_abc')
    expect(row.message.content[0].content).toBe(DEFERRED_PERMISSION_MARKER)
    expect(row.message.content[0].is_error).toBe(false)
  })

  test('preserves prior JSONL content (append-only)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kodizm-deferred-'))
    const jsonlPath = join(dir, 'session.jsonl')
    await writeFile(jsonlPath, '{"type":"assistant","message":{"id":"msg_1"}}\n')

    await writeDeferredToolResult(jsonlPath, 'tu_abc')

    const written = await readFile(jsonlPath, 'utf8')
    const lines = written.trim().split('\n')
    expect(lines.length).toBe(2)
    const [first, second] = lines
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(JSON.parse(first ?? '').type).toBe('assistant')
    expect(JSON.parse(second ?? '').message.content[0].tool_use_id).toBe('tu_abc')
  })

  test('marker constant matches the documented sentinel', () => {
    expect(DEFERRED_PERMISSION_MARKER).toBe('__KODIZM_PERMISSION_DEFERRED__')
  })
})
