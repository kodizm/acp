import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import { CodexDriver } from '@/backends/codex/driver.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const FAKE_BIN_TEMPLATE = (extra: string): string => `
const decoder = new TextDecoder()
let buf = ''
const reader = Bun.stdin.stream().getReader()
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  buf += decoder.decode(value)
  const lines = buf.split('\\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line) continue
    const frame = JSON.parse(line)
    if (frame.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        id: frame.id, result: { codexHome: '/tmp/.codex', platformFamily: 'mac' }
      }) + '\\n')
      continue
    }
    if (frame.method === 'thread/start') {
      process.stdout.write(JSON.stringify({
        id: frame.id,
        result: {
          thread: { id: 't1', path: '/tmp/r.jsonl' },
          model: 'gpt-5-codex'
        }
      }) + '\\n')
      continue
    }
    ${extra}
  }
}
`

async function buildFakeBin(extra: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-model-'))
  const path = join(dir, 'fake-codex.ts')
  await writeFile(path, FAKE_BIN_TEMPLATE(extra))
  return path
}

const recorder = (): { events: SessionUpdateEvent[]; emit: EventEmitter } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

describe('CodexDriver model_advertisement (Phase 2 T9)', () => {
  test('emits model_advertisement at the start of the first prompt() call', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'turn/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id, result: { turn: { id: 'tu1' } }
        }) + '\\n')
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { thread_id: 't1', turn: { id: 'tu1', status: 'completed' } }
          }) + '\\n')
        }, 20)
      }
    `)
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-model-'))
    const driver = new CodexDriver({
      agentInfo: { version: '0.0.1-test' },
      configDir: tempDir,
      spawnFactory: async (options) => {
        const proc = new CodexAppServerProcess({
          binaryPath: 'bun',
          binaryArgs: ['run', fakeBin],
          configPath: options.configPath,
        })
        await proc.spawn()
        return proc
      },
    })

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: { defaultMode: 'bypassPermissions' },
    })
    const { emit, events } = recorder()
    await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'hi' }] }, emit)

    const advertisement = events.find((e) => e.type === 'model_advertisement')
    expect(advertisement).toBeDefined()
    if (advertisement?.type === 'model_advertisement') {
      expect(advertisement.model).toBe('gpt-5-codex')
    }
    await driver.cancel({ sessionId }).catch(() => {})
  }, 10_000)

  test('does NOT emit skill_activation events (codex has no skill loader)', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'turn/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id, result: { turn: { id: 'tu1' } }
        }) + '\\n')
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { thread_id: 't1', turn: { id: 'tu1', status: 'completed' } }
          }) + '\\n')
        }, 20)
      }
    `)
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-noskill-'))
    const driver = new CodexDriver({
      agentInfo: { version: '0.0.1-test' },
      configDir: tempDir,
      spawnFactory: async (options) => {
        const proc = new CodexAppServerProcess({
          binaryPath: 'bun',
          binaryArgs: ['run', fakeBin],
          configPath: options.configPath,
        })
        await proc.spawn()
        return proc
      },
    })
    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: { defaultMode: 'bypassPermissions' },
    })
    const { emit, events } = recorder()
    await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'hi' }] }, emit)

    expect(events.some((e) => e.type === 'skill_activation')).toBe(false)
    await driver.cancel({ sessionId }).catch(() => {})
  }, 10_000)
})
