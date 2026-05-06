import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const recorder = (): { emit: EventEmitter; events: SessionUpdateEvent[] } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

function adapterThatThrows(message: string): SdkAdapter {
  return {
    async *query() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-throw' } satisfies SdkMessage
      throw new Error(message)
    },
  }
}

function adapterThatThrowsValue(value: unknown): SdkAdapter {
  return {
    async *query() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-throw' } satisfies SdkMessage
      throw value
    },
  }
}

describe('ClaudeDriver structured throw -> session_failed (Phase 1.7 T12)', () => {
  test('auth_error -> emits session_failed event + PromptResult.failureReason', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: adapterThatThrows('Unauthorized: 401 invalid api key'),
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(result.stopReason).toBe('session_failed')
    expect(result.failureReason).toBe('auth_error')
    const failedEvent = events.find((e) => e.type === 'session_failed')
    expect(failedEvent).toBeDefined()
    if (failedEvent?.type === 'session_failed') {
      expect(failedEvent.reason).toBe('auth_error')
      expect(failedEvent.detail).toContain('Unauthorized')
      expect(failedEvent.cause?.name).toBe('Error')
    }
  })

  test('rate_limit -> classified + structured event', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: adapterThatThrows('429 rate_limit_exceeded'),
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(result.failureReason).toBe('rate_limit')
  })

  test('transport_error -> classified', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: adapterThatThrows('write EPIPE'),
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(result.failureReason).toBe('transport_error')
  })

  test('unknown error -> sdk_throw fallback', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: adapterThatThrows('something completely random'),
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(result.failureReason).toBe('sdk_throw')
    expect(result.failureDetail).toContain('something')
  })

  test('non-Error thrown values still classify (sdk_throw)', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: adapterThatThrowsValue('plain string thrown'),
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(result.failureReason).toBe('sdk_throw')
  })

  test('Tool-use-aborted on non-defer path re-throws (preserves legacy)', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: adapterThatThrows('Tool use aborted'),
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit } = recorder()

    await expect(driver.prompt(sessionId, { sessionId, prompt: [] }, emit)).rejects.toThrow(/Tool use aborted/)
  })
})
