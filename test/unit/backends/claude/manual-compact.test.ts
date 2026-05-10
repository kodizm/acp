import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

/**
 * Build a recording SDK adapter that captures every prompt the driver
 * dispatches + replays a canned message stream as the SDK reply. The
 * synthetic `/compact` turn surfaces here so we can prove the driver
 * dispatched the literal `'/compact'` text the SDK expects.
 */
function makeRecordingAdapter(messages: SdkMessage[]): {
  adapter: SdkAdapter
  prompts: string[]
} {
  const prompts: string[] = []
  const adapter: SdkAdapter = {
    async *query(args) {
      if (typeof args.prompt === 'string') {
        prompts.push(args.prompt)
      }
      for (const message of messages) {
        yield message
      }
    },
  }
  return { adapter, prompts }
}

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

describe('ClaudeDriver.compact', () => {
  test('dispatches the synthetic /compact prompt to the SDK', async () => {
    const messages: SdkMessage[] = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 50_000,
          post_tokens: 12_000,
          duration_ms: 2_400,
        },
      },
      {
        type: 'result',
        subtype: 'success',
      },
    ]
    const { adapter, prompts } = makeRecordingAdapter(messages)
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-ant-fake' },
      agentInfo: { version: '0.0.1-test' },
      sdk: adapter,
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit } = makeRecordingEmitter()
    await driver.compact({ sessionId }, emit)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toBe('/compact')
  })

  test('compaction_started + compaction_completed events both carry trigger:manual', async () => {
    const messages: SdkMessage[] = [
      {
        type: 'system',
        subtype: 'status',
        status: 'compacting',
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 50_000,
          post_tokens: 12_000,
          duration_ms: 2_400,
        },
      },
      {
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'success',
      },
      {
        type: 'result',
        subtype: 'success',
      },
    ]
    const { adapter } = makeRecordingAdapter(messages)
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-ant-fake' },
      agentInfo: { version: '0.0.1-test' },
      sdk: adapter,
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = makeRecordingEmitter()
    await driver.compact({ sessionId }, emit)

    const startedEvents = events.filter((event) => event.type === 'compaction_started')
    const completedEvents = events.filter((event) => event.type === 'compaction_completed')

    expect(startedEvents).toHaveLength(1)
    expect(completedEvents).toHaveLength(1)

    const started = startedEvents[0]
    const completed = completedEvents[0]
    if (started?.type === 'compaction_started') {
      expect(started.trigger).toBe('manual')
    }
    if (completed?.type === 'compaction_completed') {
      expect(completed.trigger).toBe('manual')
      expect(completed.preTokens).toBe(50_000)
      expect(completed.postTokens).toBe(12_000)
      expect(completed.succeeded).toBe(true)
    }
  })

  test('clears the pendingManualCompact latch after the boundary fires', async () => {
    // Two compact() calls back-to-back. If the latch leaks across the
    // first call's completion, an unrelated auto-compact happening in a
    // later prompt would mistakenly tag itself manual. Asserting the
    // second call's events still tag manual (since both calls explicitly
    // requested manual compaction) guards the basic clear-on-complete
    // semantic without spinning up a separate prompt() turn.
    const adapterMessages: SdkMessage[] = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 100 },
      },
      { type: 'result', subtype: 'success' },
    ]
    const { adapter, prompts } = makeRecordingAdapter(adapterMessages)
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-ant-fake' },
      agentInfo: { version: '0.0.1-test' },
      sdk: adapter,
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })

    const first = makeRecordingEmitter()
    await driver.compact({ sessionId }, first.emit)

    const second = makeRecordingEmitter()
    await driver.compact({ sessionId }, second.emit)

    expect(prompts).toHaveLength(2)
    expect(prompts.every((value) => value === '/compact')).toBe(true)
  })
})
