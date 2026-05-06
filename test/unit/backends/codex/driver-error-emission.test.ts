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
        result: { thread: { id: 't1', path: '/tmp/r.jsonl' }, model: 'gpt-5-codex' }
      }) + '\\n')
      continue
    }
    ${extra}
  }
}
`

async function buildFakeBin(extra: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-err-'))
  const path = join(dir, 'fake-codex.ts')
  await writeFile(path, FAKE_BIN_TEMPLATE(extra))
  return path
}

const recorder = (): { events: SessionUpdateEvent[]; emit: EventEmitter } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

describe('CodexDriver structured throw -> session_failed (Phase 2 T13)', () => {
  test('auth_error from turn/start error response -> session_failed event + PromptResult', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'turn/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id,
          error: { code: -32603, message: '401 Unauthorized: invalid CODEX_API_KEY' }
        }) + '\\n')
      }
    `)
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-err-'))
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
    const result = await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'hi' }] }, emit)

    expect(result.stopReason).toBe('session_failed')
    expect(result.failureReason).toBe('auth_error')
    expect(events.some((e) => e.type === 'session_failed' && e.reason === 'auth_error')).toBe(true)
    await driver.cancel({ sessionId }).catch(() => {})
  }, 10_000)

  test('rate_limit from turn/start error response -> session_failed', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'turn/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id,
          error: { code: -32603, message: '429 rate_limit_exceeded' }
        }) + '\\n')
      }
    `)
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-err-'))
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
    const { emit } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'hi' }] }, emit)
    expect(result.failureReason).toBe('rate_limit')
    await driver.cancel({ sessionId }).catch(() => {})
  }, 10_000)

  test('unknown error -> sdk_throw fallback', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'turn/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id,
          error: { code: -32603, message: 'something completely random' }
        }) + '\\n')
      }
    `)
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-err-'))
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
    const { emit } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'hi' }] }, emit)
    expect(result.failureReason).toBe('sdk_throw')
    expect(result.failureDetail).toContain('something')
    await driver.cancel({ sessionId }).catch(() => {})
  }, 10_000)
})
