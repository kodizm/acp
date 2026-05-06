/**
 * Real Claude API smoke test. Skipped automatically when
 * ANTHROPIC_API_KEY is not set so the default `bun test` run
 * stays free of network calls.
 *
 * Run: ANTHROPIC_API_KEY=sk-ant-... bun test test/integration/claude-real.smoke.test.ts
 *
 * Cost expectation: a single "say hi" turn against the default
 * Claude Sonnet model is on the order of a fraction of a US cent.
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
      // Cast: the SDK's SDKMessage is a wider union than our local
      // SdkMessage subset; the event-mapper handles unknown variants
      // by dropping them, so the cast is safe.
      for await (const message of query(args)) {
        yield message as SdkMessage
      }
    },
  }
}

describe.skipIf(!HAS_API_KEY)('real Claude API smoke', () => {
  test('say hi -> output_chunk + usage with positive tokens + costUsd > 0', async () => {
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
    const result = await driver.prompt(
      sessionId,
      { sessionId, prompt: [{ type: 'text', text: 'Say "hi" and nothing else.' }] },
      emit,
    )

    expect(result.stopReason).toBe('end_turn')

    const outputChunks = events.filter((e) => e.type === 'output_chunk')
    expect(outputChunks.length).toBeGreaterThan(0)

    const usage = events.find((e) => e.type === 'usage')
    expect(usage).toBeDefined()
    if (usage?.type === 'usage') {
      expect(usage.inputTokens).toBeGreaterThan(0)
      expect(usage.outputTokens).toBeGreaterThan(0)
      expect(usage.costUsd).toBeGreaterThan(0)
    }
  }, 30_000)
})

describe.skipIf(HAS_API_KEY)('real Claude API smoke (skipped)', () => {
  test('skipped when ANTHROPIC_API_KEY is not set', () => {
    expect(HAS_API_KEY).toBe(false)
  })
})
