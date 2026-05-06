import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CODEX_DEFERRED_PERMISSION_MARKER,
  findCodexJsonlPath,
  writeDeferredRolloutItem,
} from '@/backends/codex/deferred-permission.ts'

describe('findCodexJsonlPath', () => {
  test('returns the path for a rollout-*-<threadId>.jsonl that exists', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    const sessionsDir = join(codexHome, 'sessions')
    await mkdir(sessionsDir)
    const threadId = 'b9c50a55-0000-0000-0000-000000000001'
    const filePath = join(sessionsDir, `rollout-2026-05-07T20-39-13-${threadId}.jsonl`)
    await writeFile(filePath, '{"type":"session_meta"}\n')

    const found = await findCodexJsonlPath(codexHome, threadId)
    expect(found).toBe(filePath)
  })

  test('returns null when no matching jsonl exists', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    const sessionsDir = join(codexHome, 'sessions')
    await mkdir(sessionsDir)

    const found = await findCodexJsonlPath(codexHome, 'no-such-thread')
    expect(found).toBeNull()
  })

  test('returns null when sessions dir does not exist', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    const found = await findCodexJsonlPath(codexHome, 'thread')
    expect(found).toBeNull()
  })
})

describe('writeDeferredRolloutItem', () => {
  test('appends a RolloutItem line carrying the deferred marker', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    const sessionsDir = join(codexHome, 'sessions')
    await mkdir(sessionsDir)
    const filePath = join(sessionsDir, 'rollout-test.jsonl')
    await writeFile(filePath, '{"type":"session_meta","id":"meta_1"}\n')

    await writeDeferredRolloutItem(filePath, 'item_x')

    const content = await readFile(filePath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)
    const last = JSON.parse(lines[1] ?? '')
    expect(last.type).toBe('event_msg')
    expect(last.payload.type).toBe('tool_call_completed')
    expect(last.payload.call_id).toBe('item_x')
    expect(last.payload.result).toBe(CODEX_DEFERRED_PERMISSION_MARKER)
  })

  test('marker constant is __KODIZM_PERMISSION_DEFERRED__ (canonical sentinel)', () => {
    expect(CODEX_DEFERRED_PERMISSION_MARKER).toBe('__KODIZM_PERMISSION_DEFERRED__')
  })
})
