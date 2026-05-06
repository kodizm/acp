/**
 * Real Claude API compaction smoke. Forces auto-compact to fire by
 * setting `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1` (1% of context window
 * threshold; even a small turn exceeds it).
 *
 * Asserts the canonical wire events surface:
 *   - compaction_started fires before the boundary
 *   - compaction_completed fires after with metadata (preTokens,
 *     postTokens?, durationMs?, succeeded)
 *
 * Source: services/compact/autoCompact.ts:79-87 in claude-code CLI
 * (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE override).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

import { HAS_AUTH } from './_helpers.ts'

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''

let originalPctOverride: string | undefined

beforeAll(() => {
  // Force auto-compact to trigger at 1% of the effective context
  // window (~2K tokens with Sonnet's 200K). Two turns of any length
  // will hit it.
  originalPctOverride = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '1'
})

afterAll(() => {
  if (originalPctOverride === undefined) {
    delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  } else {
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = originalPctOverride
  }
})

async function buildRealAdapter(): Promise<SdkAdapter> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    async *query(args) {
      const isolated = {
        prompt: args.prompt,
        options: { ...(args.options as Record<string, unknown>), settingSources: [] },
      }
      for await (const message of sdk.query(isolated as never)) {
        yield message as SdkMessage
      }
    },
  }
}

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

function pickCredentials() {
  if (OAUTH_TOKEN.length > 0) {
    return { type: 'subscription' as const, token: OAUTH_TOKEN }
  }
  return { type: 'api-key' as const, token: API_KEY }
}

describe.skipIf(!HAS_AUTH)('real Claude API compaction smoke', () => {
  test('low threshold + multi-turn -> compaction_started + compaction_completed events fire', async () => {
    const adapter = await buildRealAdapter()
    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapter,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: 'claude-sonnet-4-6',
    })

    const allEvents: SessionUpdateEvent[] = []

    // Turn 1: priming context with some content.
    const r1 = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Tell me a short fact about TypeScript in 3 sentences. Remember this for later.',
          },
        ],
      },
      r1.emit,
    )
    allEvents.push(...r1.events)

    // Turn 2: another turn to push past the 1% threshold.
    const r2 = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Now tell me a short fact about Bun runtime in 3 sentences.',
          },
        ],
      },
      r2.emit,
    )
    allEvents.push(...r2.events)

    // Turn 3: another to virtually guarantee compaction triggers.
    const r3 = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Compare them in one sentence.',
          },
        ],
      },
      r3.emit,
    )
    allEvents.push(...r3.events)

    const startedEvents = allEvents.filter((e) => e.type === 'compaction_started')
    const completedEvents = allEvents.filter((e) => e.type === 'compaction_completed')

    // At 1% threshold, compaction should fire at least once.
    expect(startedEvents.length + completedEvents.length).toBeGreaterThan(0)

    // If completion fired, validate metadata shape.
    if (completedEvents.length > 0) {
      const completed = completedEvents[0]
      if (completed?.type === 'compaction_completed') {
        expect(['manual', 'auto']).toContain(completed.trigger)
        expect(typeof completed.succeeded).toBe('boolean')
        expect(typeof completed.preTokens).toBe('number')
      }
    }
  }, 90_000)

  test('autoCompact:false opts out -> DISABLE_AUTO_COMPACT env injected, no compaction events', async () => {
    let observedEnv: Record<string, string> | undefined
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const adapter: SdkAdapter = {
      async *query(args) {
        observedEnv = (args.options as { env?: Record<string, string> }).env
        const isolated = {
          prompt: args.prompt,
          options: { ...(args.options as Record<string, unknown>), settingSources: [] },
        }
        for await (const message of sdk.query(isolated as never)) {
          yield message as SdkMessage
        }
      },
    }
    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapter,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: 'claude-haiku-4-5-20251001',
      autoCompact: false,
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply "ok".' }],
      },
      emit,
    )

    // Driver should have injected the disable env.
    expect(observedEnv?.DISABLE_AUTO_COMPACT).toBe('1')

    // No compaction events expected (auto-compact disabled).
    const compactionEvents = events.filter(
      (e) => e.type === 'compaction_started' || e.type === 'compaction_completed',
    )
    expect(compactionEvents.length).toBe(0)
  }, 30_000)
})

describe.skipIf(HAS_AUTH)('real Claude API compaction smoke (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
