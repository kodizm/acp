import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import { CodexDriver } from '@/backends/codex/driver.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const FAKE_CODEX_TEMPLATE = (extra: string): string => `
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
        result: { thread: { id: 't_uuid', path: '/tmp/r.jsonl' }, model: 'gpt-5-codex' }
      }) + '\\n')
      continue
    }
    ${extra}
  }
}
`

async function buildFakeBin(extra: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-prompt-'))
  const path = join(dir, 'fake-codex.ts')
  await writeFile(path, FAKE_CODEX_TEMPLATE(extra))
  return path
}

const recorder = (): { events: SessionUpdateEvent[]; emit: EventEmitter } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

async function makeDriver(fakeBin: string) {
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-prompt-'))
  return new CodexDriver({
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
}

describe('CodexDriver.prompt (Phase 2 T4)', () => {
  test('dispatches turn/start with serialized text content + resolves on turn/completed', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'turn/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id,
          result: { turn: { id: 'turn_1', status: 'running' } }
        }) + '\\n')
        // Emit turn/started + minimal output then turn/completed.
        process.stdout.write(JSON.stringify({
          method: 'turn/started',
          params: { thread_id: 't_uuid', turn: { id: 'turn_1' } }
        }) + '\\n')
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { thread_id: 't_uuid', turn: { id: 'turn_1', status: 'completed' } }
          }) + '\\n')
        }, 20)
      }
    `)

    const driver = await makeDriver(fakeBin)
    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: { defaultMode: 'bypassPermissions' },
    })

    const { emit } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'Say hi.' }] }, emit)

    expect(result.stopReason).toBe('end_turn')
    await driver.cancel({ sessionId }).catch(() => {})
  }, 10_000)

  test('turn/interrupt fires on cancel + PromptResult.stopReason=cancelled', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'turn/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id, result: { turn: { id: 'turn_x' } }
        }) + '\\n')
        // Never send turn/completed; force cancel.
      }
      if (frame.method === 'turn/interrupt') {
        process.stdout.write(JSON.stringify({
          id: frame.id, result: {}
        }) + '\\n')
        // Then synthesize turn/completed with cancelled status.
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { thread_id: 't_uuid', turn: { id: 'turn_x', status: 'cancelled' } }
          }) + '\\n')
        }, 10)
      }
    `)

    const driver = await makeDriver(fakeBin)
    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: { defaultMode: 'bypassPermissions' },
    })

    const { emit } = recorder()
    setTimeout(() => {
      void driver.cancel({ sessionId })
    }, 50)

    const result = await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'Hang.' }] }, emit)

    expect(result.stopReason).toBe('cancelled')
  }, 10_000)

  test('inactivity probe fires session_failed:sdk_stall when SDK gap exceeds threshold', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'turn/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id, result: { turn: { id: 'turn_stall' } }
        }) + '\\n')
        // Never send any subsequent events; codex appears hung.
      }
      if (frame.method === 'turn/interrupt') {
        process.stdout.write(JSON.stringify({
          id: frame.id, result: {}
        }) + '\\n')
      }
    `)

    const driver = await makeDriver(fakeBin)
    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: { defaultMode: 'bypassPermissions' },
      inactivityThresholdMs: 200,
    })

    const { emit, events } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'Hang.' }] }, emit)

    expect(result.stopReason).toBe('session_failed')
    expect(result.failureReason).toBe('sdk_stall')
    expect(events.some((e) => e.type === 'session_failed' && e.reason === 'sdk_stall')).toBe(true)
  }, 10_000)

  test('heartbeat events fire during a long turn', async () => {
    const fakeBin = await buildFakeBin(`
      if (frame.method === 'turn/start') {
        process.stdout.write(JSON.stringify({
          id: frame.id, result: { turn: { id: 'turn_hb' } }
        }) + '\\n')
        // Emit periodic deltas every 50ms then complete after ~300ms.
        let count = 0
        const t = setInterval(() => {
          count++
          process.stdout.write(JSON.stringify({
            method: 'item/agentMessage/delta',
            params: { thread_id: 't_uuid', turn_id: 'turn_hb', delta: 'tick' }
          }) + '\\n')
          if (count >= 5) {
            clearInterval(t)
            process.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { thread_id: 't_uuid', turn: { id: 'turn_hb', status: 'completed' } }
            }) + '\\n')
          }
        }, 50)
      }
    `)

    const driver = await makeDriver(fakeBin)
    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      heartbeatIntervalMs: 80,
      toolPolicy: { defaultMode: 'bypassPermissions' },
    })

    const { emit, events } = recorder()
    await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'Stream' }] }, emit)

    const heartbeats = events.filter((e) => e.type === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThanOrEqual(1)
  }, 10_000)
})
