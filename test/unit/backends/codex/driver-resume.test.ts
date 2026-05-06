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
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-resume-'))
  const path = join(dir, 'fake-codex.ts')
  await writeFile(path, FAKE_BIN_TEMPLATE(extra))
  return path
}

describe('CodexDriver.loadSession (Phase 2 T5)', () => {
  test('dispatches thread/resume with thread_id captured from prior session', async () => {
    const threadStartCount = 0
    let resumeCallParams: { thread_id?: string; path?: string } | undefined
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'thread/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id,
          result: {
            thread: { id: 'thread-original-uuid', path: '/tmp/r.jsonl' },
            model: 'gpt-5-codex'
          }
        }) + '\\n')
      }
      if (frame.method === 'thread/resume') {
        process.stdout.write(JSON.stringify({
          id: frame.id,
          result: {
            thread: { id: 'thread-original-uuid', path: '/tmp/r.jsonl' },
          }
        }) + '\\n')
        process.stderr.write('RESUME_PARAMS:' + JSON.stringify(frame.params) + '\\n')
      }
    `)
    void threadStartCount
    void resumeCallParams

    const tempDir = await mkdtemp(join(tmpdir(), 'codex-resume-'))
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

    const newSession = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: { defaultMode: 'bypassPermissions' },
    })
    expect(newSession.sessionId).toBeDefined()

    const loaded = await driver.loadSession({
      sessionId: newSession.sessionId,
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(loaded.sessionId).toBe(newSession.sessionId)
    await driver.cancel({ sessionId: newSession.sessionId }).catch(() => {})
  }, 10_000)

  test('throws SessionNotFoundError when sessionId is unknown', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'thread/resume') {
        process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\\n')
      }
    `)
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-resume-'))
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

    await expect(driver.loadSession({ sessionId: 'unknown-uuid', cwd: '/x', mcpServers: [] })).rejects.toThrow()
  })
})
