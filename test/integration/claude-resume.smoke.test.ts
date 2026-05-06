/**
 * Real Claude API resume smoke. Skipped when ANTHROPIC_API_KEY is
 * not set so the default `bun test` run stays free of network calls.
 *
 * Run: ANTHROPIC_API_KEY=sk-ant-... bun test test/integration/claude-resume.smoke.test.ts
 *
 * Resume semantics: the SDK persists the session transcript to a
 * JSONL file under ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl
 * after each turn. loadSession({ sessionId }) sets the SDK's `resume`
 * option which replays that transcript on the next prompt.
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

describe.skipIf(!HAS_API_KEY)('real Claude API resume smoke', () => {
  test('newSession + prompt -> loadSession + new prompt continues the conversation', async () => {
    const adapter = await buildRealAdapter()

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: API_KEY },
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapter,
    })

    // 1. Fresh session with a memorable fact.
    const fresh = await driver.newSession({ cwd: process.cwd(), mcpServers: [] })
    const r1 = makeRecordingEmitter()
    await driver.prompt(
      fresh.sessionId,
      {
        sessionId: fresh.sessionId,
        prompt: [{ type: 'text', text: 'Remember: my favorite color is teal. Say "got it".' }],
      },
      r1.emit,
    )
    const r1Output = r1.events.filter((e) => e.type === 'output_chunk')
    expect(r1Output.length).toBeGreaterThan(0)

    // 2. Load + ask for the recall.
    const loaded = await driver.loadSession({
      sessionId: fresh.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })
    expect(loaded.sessionId).toBe(fresh.sessionId)

    const r2 = makeRecordingEmitter()
    await driver.prompt(
      loaded.sessionId,
      {
        sessionId: loaded.sessionId,
        prompt: [{ type: 'text', text: 'What is my favorite color?' }],
      },
      r2.emit,
    )

    const r2Text = r2.events
      .filter((e) => e.type === 'output_chunk')
      .map((e) => (e.type === 'output_chunk' ? e.text : ''))
      .join(' ')
      .toLowerCase()

    expect(r2Text).toContain('teal')
  }, 60_000)
})

describe.skipIf(HAS_API_KEY)('real Claude API resume smoke (skipped)', () => {
  test('skipped when ANTHROPIC_API_KEY is not set', () => {
    expect(HAS_API_KEY).toBe(false)
  })
})
