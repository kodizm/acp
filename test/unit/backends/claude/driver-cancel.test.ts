import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

function makeDriver(adapter: SdkAdapter): ClaudeDriver {
  return new ClaudeDriver({
    credentials: { type: 'api-key', token: 'sk-ant-fake' },
    agentInfo: { version: '0.0.1-test' },
    sdk: adapter,
  })
}

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

describe('ClaudeDriver.cancel, mid-prompt abort', () => {
  test('emits a cancelled event with reason=user_cancel and short-circuits the loop', async () => {
    const adapter: SdkAdapter = {
      async *query({ options }) {
        // Wait until the abort fires, then surface as an AbortError.
        await new Promise<void>((_resolve, reject) => {
          options.abortController?.signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            ;(err as { name: string }).name = 'AbortError'
            reject(err)
          })
        })
      },
    }

    const driver = makeDriver(adapter)
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = makeRecordingEmitter()

    const promise = driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    await new Promise((r) => setTimeout(r, 5))
    await driver.cancel({ sessionId })

    const result = await promise
    expect(result.stopReason).toBe('cancelled')

    const cancelled = events.find((e) => e.type === 'cancelled')
    expect(cancelled).toBeDefined()
    if (cancelled?.type === 'cancelled') {
      expect(cancelled.sessionId).toBe(sessionId)
      expect(cancelled.reason).toBe('user_cancel')
    }
  })

  test('cancel emits cancelled within the 2s grace window', async () => {
    const adapter: SdkAdapter = {
      async *query({ options }) {
        await new Promise<void>((_resolve, reject) => {
          options.abortController?.signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            ;(err as { name: string }).name = 'AbortError'
            reject(err)
          })
        })
      },
    }

    const driver = makeDriver(adapter)
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = makeRecordingEmitter()

    const startedAt = Date.now()
    const promise = driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    await new Promise((r) => setTimeout(r, 5))
    await driver.cancel({ sessionId })
    await promise
    const elapsed = Date.now() - startedAt

    expect(elapsed).toBeLessThan(2000)
    expect(events.some((e) => e.type === 'cancelled')).toBe(true)
  })

  test('completed turn (no cancel) does NOT emit a cancelled event', async () => {
    const messages: SdkMessage[] = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
      { type: 'result', subtype: 'success' },
    ]
    const adapter: SdkAdapter = {
      async *query() {
        for (const message of messages) {
          yield message
        }
      },
    }

    const driver = makeDriver(adapter)
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = makeRecordingEmitter()

    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    expect(result.stopReason).toBe('end_turn')
    expect(events.some((e) => e.type === 'cancelled')).toBe(false)
  })

  test('cancel before any prompt is a no-op (only flips the controller, no emit)', async () => {
    const adapter: SdkAdapter = {
      async *query() {
        // never enters here
        yield { type: 'result', subtype: 'success' } satisfies SdkMessage
      },
    }
    const driver = makeDriver(adapter)
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    await driver.cancel({ sessionId })
    // No prompt() ran -> nothing to assert against an emit. Reaching
    // this line without throwing is the assertion.
    expect(true).toBe(true)
  })
})
