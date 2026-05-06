import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

function makeAdapter(messages: SdkMessage[], onCall?: (opts: { options: { resume?: string } }) => void): SdkAdapter {
  return {
    async *query(args) {
      onCall?.(args)
      for (const message of messages) {
        yield message
      }
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

describe('ClaudeDriver.loadSession, no history', () => {
  test('returns the requested sessionId and stores options with resume=sessionId', async () => {
    let observedResume: string | undefined
    const driver = makeDriver(
      makeAdapter([{ type: 'result', subtype: 'success' }], (call) => {
        observedResume = call.options.resume
      }),
    )

    const result = await driver.loadSession({
      sessionId: 'prior-session-1',
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(result.sessionId).toBe('prior-session-1')

    const { emit } = makeRecordingEmitter()
    await driver.prompt('prior-session-1', { sessionId: 'prior-session-1', prompt: [] }, emit)
    expect(observedResume).toBe('prior-session-1')
  })
})

describe('ClaudeDriver.loadSession, 5-turn replay', () => {
  test('next prompt streams the replayed messages through the event pipeline', async () => {
    const replay: SdkMessage[] = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'turn 1 response' }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'turn 2 response' }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'turn 3 response' }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'turn 4 response' }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'turn 5 response' }] },
      },
      { type: 'result', subtype: 'success' },
    ]

    const driver = makeDriver(makeAdapter(replay))
    await driver.loadSession({
      sessionId: 'prior-session-2',
      cwd: '/workspace',
      mcpServers: [],
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt('prior-session-2', { sessionId: 'prior-session-2', prompt: [] }, emit)

    const outputChunks = events.filter((e) => e.type === 'output_chunk')
    expect(outputChunks).toHaveLength(5)
    if (outputChunks[0]?.type === 'output_chunk') {
      expect(outputChunks[0].text).toBe('turn 1 response')
    }
    if (outputChunks[4]?.type === 'output_chunk') {
      expect(outputChunks[4].text).toBe('turn 5 response')
    }
  })
})

describe('ClaudeDriver.loadSession, continue conversation', () => {
  test('a fresh prompt after load reuses the stored options + still flags resume', async () => {
    const calls: Array<{ resume?: string; prompt: string }> = []
    const adapter: SdkAdapter = {
      async *query(args) {
        calls.push({ resume: args.options.resume, prompt: args.prompt })
        yield { type: 'result', subtype: 'success' } satisfies SdkMessage
      },
    }
    const driver = makeDriver(adapter)
    await driver.loadSession({
      sessionId: 'prior-session-3',
      cwd: '/workspace',
      mcpServers: [],
    })

    const { emit } = makeRecordingEmitter()
    await driver.prompt(
      'prior-session-3',
      { sessionId: 'prior-session-3', prompt: [{ type: 'text', text: 'continue from here' }] },
      emit,
    )
    await driver.prompt(
      'prior-session-3',
      { sessionId: 'prior-session-3', prompt: [{ type: 'text', text: 'and one more thing' }] },
      emit,
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.resume).toBe('prior-session-3')
    expect(calls[1]?.resume).toBe('prior-session-3')
    expect(calls[0]?.prompt).toBe('continue from here')
    expect(calls[1]?.prompt).toBe('and one more thing')
  })
})
