import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import { SessionNotFoundError } from '@/server/errors.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

function makeAdapter(messages: SdkMessage[]): SdkAdapter {
  return {
    async *query() {
      for (const message of messages) {
        yield message
      }
    },
  }
}

function makeRecordingEmitter(): {
  emit: EventEmitter
  events: SessionUpdateEvent[]
} {
  const events: SessionUpdateEvent[] = []
  return {
    events,
    emit: { send: (event) => events.push(event) },
  }
}

function makeDriver(adapter: SdkAdapter) {
  return new ClaudeDriver({
    credentials: { type: 'api-key', token: 'sk-ant-fake' },
    agentInfo: { version: '0.0.1-test' },
    sdk: adapter,
  })
}

describe('ClaudeDriver.prompt', () => {
  test('throws SessionNotFoundError when the session id is unknown', async () => {
    const driver = makeDriver(makeAdapter([]))
    const { emit } = makeRecordingEmitter()

    await expect(driver.prompt('unknown-session', { sessionId: 'unknown-session', prompt: [] }, emit)).rejects.toThrow(
      SessionNotFoundError,
    )
  })

  test('streams a five-message SDK sequence to matching emit calls', async () => {
    const messages: SdkMessage[] = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'mcp__kodizm__kodizm_create_task',
              input: { title: 'x' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [{ type: 'text', text: 'ok' }],
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.0152,
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 100,
        },
      },
    ]

    const driver = makeDriver(makeAdapter(messages))
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })

    const { emit, events } = makeRecordingEmitter()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(result.stopReason).toBe('end_turn')

    // model_advertisement + output_chunk + tool_call_begin +
    // tool_call_end + usage = 5 events.
    expect(events).toHaveLength(5)
    expect(events[0]?.type).toBe('model_advertisement')
    expect(events[1]?.type).toBe('output_chunk')
    expect(events[2]?.type).toBe('tool_call_begin')
    expect(events[3]?.type).toBe('tool_call_end')
    expect(events[4]?.type).toBe('usage')

    if (events[4]?.type === 'usage') {
      expect(events[4].inputTokens).toBe(1234)
      expect(events[4].outputTokens).toBe(567)
      expect(events[4].cacheReadTokens).toBe(8000)
      expect(events[4].cacheCreationTokens).toBe(100)
      expect(events[4].costUsd).toBe(0.0152)
    }
  })

  test('returns the SDK stop reason when the result message carries one', async () => {
    const messages: SdkMessage[] = [
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'max_tokens',
      },
    ]

    const driver = makeDriver(makeAdapter(messages))
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })

    const { emit } = makeRecordingEmitter()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    expect(result.stopReason).toBe('max_tokens')
  })

  test('cancel() flips the abort controller; the next prompt sees stopReason cancelled', async () => {
    let aborted = false
    const adapter: SdkAdapter = {
      async *query({ options }) {
        // Wait for abort to fire; surface it as a thrown AbortError-ish.
        await new Promise<void>((resolve, reject) => {
          options.abortController?.signal.addEventListener('abort', () => {
            aborted = true
            const err = new Error('aborted')
            ;(err as { name: string }).name = 'AbortError'
            reject(err)
          })
          setTimeout(resolve, 50)
        })
      },
    }

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk' },
      agentInfo: { version: 'x' },
      sdk: adapter,
    })
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })

    const { emit } = makeRecordingEmitter()
    const promise = driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    // Tick + cancel.
    await new Promise((r) => setTimeout(r, 5))
    await driver.cancel({ sessionId })

    const result = await promise
    expect(aborted).toBe(true)
    expect(result.stopReason).toBe('cancelled')
  })

  test('cancel() throws SessionNotFoundError on unknown session id', async () => {
    const driver = makeDriver(makeAdapter([]))
    await expect(driver.cancel({ sessionId: 'nope' })).rejects.toThrow(SessionNotFoundError)
  })

  test('per-turn model override does not mutate the stored session options', async () => {
    let observedModel: string | undefined
    const adapter: SdkAdapter = {
      async *query({ options }) {
        observedModel = options.model
        yield { type: 'result', subtype: 'success' } satisfies SdkMessage
      },
    }

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk' },
      agentInfo: { version: 'x' },
      sdk: adapter,
    })
    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      model: 'claude-sonnet-4-6',
    })

    const { emit } = makeRecordingEmitter()
    await driver.prompt(sessionId, { sessionId, prompt: [], model: 'claude-haiku-4-5-20251001' }, emit)

    expect(observedModel).toBe('claude-haiku-4-5-20251001')

    // Second prompt without override should use the stored model.
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    expect(observedModel).toBe('claude-sonnet-4-6')
  })
})
