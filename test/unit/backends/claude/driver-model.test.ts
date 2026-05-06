import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

interface RecordedCall {
  model: string | undefined
}

function makeAdapter(calls: RecordedCall[]): SdkAdapter {
  return {
    async *query(args) {
      const observedModel = args.options.model
      calls.push({ model: observedModel })
      // Echo back a system init carrying the same model so the
      // event-mapper's model_advertisement path fires.
      if (observedModel !== undefined) {
        yield {
          type: 'system',
          subtype: 'init',
          model: observedModel,
        } satisfies SdkMessage
      }
      yield { type: 'result', subtype: 'success' } satisfies SdkMessage
    },
  }
}

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

function makeDriver(adapter: SdkAdapter): ClaudeDriver {
  return new ClaudeDriver({
    credentials: { type: 'api-key', token: 'sk-ant-fake' },
    agentInfo: { version: '0.0.1-test' },
    sdk: adapter,
  })
}

describe('ClaudeDriver model selection, default', () => {
  test('uses the session model when no per-turn override is set', async () => {
    const calls: RecordedCall[] = []
    const driver = makeDriver(makeAdapter(calls))

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      model: 'claude-sonnet-4-6',
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(calls[0]?.model).toBe('claude-sonnet-4-6')

    const advertisement = events.find((e) => e.type === 'model_advertisement')
    if (advertisement?.type === 'model_advertisement') {
      expect(advertisement.model).toBe('claude-sonnet-4-6')
    }
  })
})

describe('ClaudeDriver model selection, per-turn override', () => {
  test('overrides the session model for one turn only', async () => {
    const calls: RecordedCall[] = []
    const driver = makeDriver(makeAdapter(calls))

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      model: 'claude-sonnet-4-6',
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(sessionId, { sessionId, prompt: [], model: 'claude-haiku-4-5-20251001' }, emit)

    expect(calls[0]?.model).toBe('claude-haiku-4-5-20251001')

    const advertisement = events.find((e) => e.type === 'model_advertisement')
    if (advertisement?.type === 'model_advertisement') {
      expect(advertisement.model).toBe('claude-haiku-4-5-20251001')
    }
  })
})

describe('ClaudeDriver model selection, override does not leak', () => {
  test('turn N+1 falls back to the stored session model after an override turn', async () => {
    const calls: RecordedCall[] = []
    const driver = makeDriver(makeAdapter(calls))

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      model: 'claude-sonnet-4-6',
    })

    const { emit } = makeRecordingEmitter()
    await driver.prompt(sessionId, { sessionId, prompt: [], model: 'claude-haiku-4-5-20251001' }, emit)
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.model).toBe('claude-haiku-4-5-20251001')
    expect(calls[1]?.model).toBe('claude-sonnet-4-6')
  })
})
