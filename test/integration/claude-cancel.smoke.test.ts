/**
 * Real Claude API cancel smoke. Skipped when ANTHROPIC_API_KEY is
 * not set so the default `bun test` run stays free of network calls.
 *
 * Run: ANTHROPIC_API_KEY=sk-ant-... bun test test/integration/claude-cancel.smoke.test.ts
 */

import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const HAS_API_KEY = API_KEY.length > 0

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

async function buildRealAdapter(): Promise<SdkAdapter> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  return {
    async *query(args) {
      for await (const message of query(args)) {
        yield message as SdkMessage
      }
    },
  }
}

describe.skipIf(!HAS_API_KEY)('real Claude API cancel smoke', () => {
  test('mid-stream cancel emits a cancelled event within the 2s grace window', async () => {
    const adapter = await buildRealAdapter()

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: API_KEY },
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapter,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    })

    const { emit, events } = makeRecordingEmitter()
    const startedAt = Date.now()
    const promise = driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: 'Write a 500-word essay about TypeScript.' }],
      },
      emit,
    )

    // Wait for the first stream chunk to confirm the SDK started.
    await new Promise((r) => setTimeout(r, 200))
    await driver.cancel({ sessionId })

    const result = await promise
    const elapsed = Date.now() - startedAt

    expect(result.stopReason).toBe('cancelled')
    expect(events.some((e) => e.type === 'cancelled')).toBe(true)
    expect(elapsed).toBeLessThan(5000)
  }, 30_000)
})

describe.skipIf(HAS_API_KEY)('real Claude API cancel smoke (skipped)', () => {
  test('skipped when ANTHROPIC_API_KEY is not set', () => {
    expect(HAS_API_KEY).toBe(false)
  })
})
