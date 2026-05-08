/**
 * Codex driver manual-compaction smoke. Drives a fake codex
 * subprocess that accepts `thread/compact/start` + emits the
 * matching ContextCompaction item lifecycle. Asserts:
 *
 *   1. `driver.compact()` dispatches the literal
 *      `thread/compact/start` JSON-RPC request with the right
 *      `threadId` (the codex thread id, NOT the orchestrator's
 *      Kodizm session id).
 *   2. The resulting `compaction_started` + `compaction_completed`
 *      sessionUpdate events both carry `trigger: 'manual'` (the
 *      mapper defaults to 'auto' on the bare `ContextCompaction`
 *      item; the `pendingManualCompact` latch overrides it).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import { CodexDriver } from '@/backends/codex/driver.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const FAKE_BIN_TEMPLATE = `
const decoder = new TextDecoder()
let buf = ''
const observed = []
const writeFrame = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')

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
    observed.push(frame)
    if (frame.method === 'initialize') {
      writeFrame({ id: frame.id, result: { codexHome: '/tmp/.codex', platformFamily: 'mac' } })
      continue
    }
    if (frame.method === 'thread/start') {
      writeFrame({
        id: frame.id,
        result: {
          thread: { id: 'thread-codex-uuid', path: '/tmp/r-fake.jsonl' },
          model: 'gpt-5-codex'
        }
      })
      continue
    }
    if (frame.method === 'thread/compact/start') {
      // Echo the threadId back to the test harness via stderr so the
      // assertion can verify exact-match wiring without grepping the
      // raw frame stream.
      process.stderr.write('OBSERVED_COMPACT_THREAD_ID=' + (frame.params && frame.params.threadId) + '\\n')
      // Emit item/started + item/completed for ContextCompaction.
      writeFrame({
        method: 'item/started',
        params: {
          item: { id: 'compact_1', type: 'ContextCompaction' }
        }
      })
      writeFrame({
        method: 'item/completed',
        params: {
          item: { id: 'compact_1', type: 'ContextCompaction', status: 'completed' }
        }
      })
      writeFrame({ id: frame.id, result: {} })
      continue
    }
  }
}
`

async function buildFakeBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-compact-'))
  const path = join(dir, 'fake-codex.ts')
  await writeFile(path, FAKE_BIN_TEMPLATE)
  return path
}

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

describe('CodexDriver.compact (T6 manual compaction)', () => {
  test('dispatches thread/compact/start with the codex threadId + tags events trigger:manual', async () => {
    const fakeBin = await buildFakeBin()
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-compact-'))

    let stderrBuf = ''
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
        // Tee stderr so the test can read the OBSERVED_COMPACT_THREAD_ID
        // marker the fake bin writes.
        const stderr = (proc as unknown as { subprocess?: { stderr?: ReadableStream<Uint8Array> } }).subprocess?.stderr
        if (stderr !== undefined) {
          ;(async () => {
            const reader = stderr.getReader()
            const decoder = new TextDecoder()
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              stderrBuf += decoder.decode(value)
            }
          })()
        }
        return proc
      },
    })

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: { defaultMode: 'bypassPermissions' },
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.compact({ sessionId }, emit)

    expect(stderrBuf).toContain('OBSERVED_COMPACT_THREAD_ID=thread-codex-uuid')

    const startedEvents = events.filter((event) => event.type === 'compaction_started')
    const completedEvents = events.filter((event) => event.type === 'compaction_completed')
    expect(startedEvents).toHaveLength(1)
    expect(completedEvents).toHaveLength(1)
    if (startedEvents[0]?.type === 'compaction_started') {
      expect(startedEvents[0].trigger).toBe('manual')
    }
    if (completedEvents[0]?.type === 'compaction_completed') {
      expect(completedEvents[0].trigger).toBe('manual')
    }

    await driver.cancel({ sessionId }).catch(() => {})
  }, 10_000)
})
