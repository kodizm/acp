import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

interface ObservedCall {
  forkSessionId?: string
  systemPrompt?: unknown
  model?: string
}

function makeAdapter(onCall: (call: ObservedCall) => void): SdkAdapter {
  return {
    async *query(args) {
      onCall({
        forkSessionId: args.options.forkSessionId,
        systemPrompt: args.options.systemPrompt,
        model: args.options.model,
      })
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

describe('ClaudeDriver.forkSession, inherit branch options', () => {
  test('fork with no systemPrompt keeps the SDK preset and tags forkSessionId', async () => {
    const calls: ObservedCall[] = []
    const driver = makeDriver(makeAdapter((c) => calls.push(c)))

    const { sessionId: forked } = await driver.forkSession({
      sourceSessionId: 'parent-1',
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(forked).not.toBe('parent-1')

    const { emit } = makeRecordingEmitter()
    await driver.prompt(forked, { sessionId: forked, prompt: [] }, emit)

    expect(calls[0]?.forkSessionId).toBe('parent-1')
    expect(calls[0]?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(calls[0]?.model).toBeUndefined()
  })
})

describe('ClaudeDriver.forkSession, override systemPrompt + model', () => {
  test('append systemPrompt + per-branch model take effect on the next turn', async () => {
    const calls: ObservedCall[] = []
    const driver = makeDriver(makeAdapter((c) => calls.push(c)))

    const { sessionId: forked } = await driver.forkSession({
      sourceSessionId: 'parent-2',
      cwd: '/workspace',
      mcpServers: [],
      systemPrompt: { append: 'Speak like a pirate.' },
      model: 'claude-haiku-4-5-20251001',
    })

    const { emit } = makeRecordingEmitter()
    await driver.prompt(forked, { sessionId: forked, prompt: [] }, emit)

    expect(calls[0]?.forkSessionId).toBe('parent-2')
    expect(calls[0]?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Speak like a pirate.',
    })
    expect(calls[0]?.model).toBe('claude-haiku-4-5-20251001')
  })

  test('full-replace systemPrompt string passes through verbatim', async () => {
    const calls: ObservedCall[] = []
    const driver = makeDriver(makeAdapter((c) => calls.push(c)))

    const { sessionId: forked } = await driver.forkSession({
      sourceSessionId: 'parent-3',
      cwd: '/workspace',
      mcpServers: [],
      systemPrompt: 'You are a strict code reviewer.',
    })

    const { emit } = makeRecordingEmitter()
    await driver.prompt(forked, { sessionId: forked, prompt: [] }, emit)

    expect(calls[0]?.systemPrompt).toBe('You are a strict code reviewer.')
  })
})
