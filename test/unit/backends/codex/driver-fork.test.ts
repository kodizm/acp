import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import { CodexDriver } from '@/backends/codex/driver.ts'

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
    ${extra}
  }
}
`

async function buildFakeBin(extra: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-fork-'))
  const path = join(dir, 'fake-codex.ts')
  await writeFile(path, FAKE_BIN_TEMPLATE(extra))
  return path
}

describe('CodexDriver.forkSession (Phase 2 T6)', () => {
  test('dispatches thread/fork from sourceSession; fresh ACP sessionId allocated', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'thread/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id,
          result: {
            thread: { id: 'thread-source-uuid', path: '/tmp/r-src.jsonl' },
            model: 'gpt-5-codex'
          }
        }) + '\\n')
      }
      if (frame.method === 'thread/fork') {
        process.stdout.write(JSON.stringify({
          id: frame.id,
          result: {
            thread: { id: 'thread-fork-uuid', path: '/tmp/r-fork.jsonl' },
            model: 'gpt-5-codex'
          }
        }) + '\\n')
      }
    `)

    const tempDir = await mkdtemp(join(tmpdir(), 'codex-fork-'))
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

    const original = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: { defaultMode: 'bypassPermissions' },
    })
    const fork = await driver.forkSession({
      sourceSessionId: original.sessionId,
      cwd: '/workspace',
      mcpServers: [],
    })

    expect(fork.sessionId).not.toBe(original.sessionId)
    expect(fork.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    await driver.cancel({ sessionId: original.sessionId }).catch(() => {})
    await driver.cancel({ sessionId: fork.sessionId }).catch(() => {})
  }, 10_000)

  test('throws SessionNotFoundError when sourceSessionId is unknown', async () => {
    const fakeBin = await buildFakeBin('')
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-fork-'))
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

    await expect(
      driver.forkSession({ sourceSessionId: 'no-such-session', cwd: '/x', mcpServers: [] }),
    ).rejects.toThrow()
  })
})
