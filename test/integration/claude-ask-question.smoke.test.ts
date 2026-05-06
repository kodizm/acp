/**
 * Real Claude API AskUserQuestion smoke. Validates the dedicated
 * session/ask_user_question outbound RPC + answer roundtrip.
 *
 * The SDK normally allows the model to invoke AskUserQuestion as a
 * tool. We make sure our canUseTool branch intercepts that call, the
 * orchestrator answers, and the model receives the answer through
 * tool_result so its final reply cites the chosen option.
 */

import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

import { HAS_AUTH, TEST_MODEL } from './_helpers.ts'

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''

function pickCredentials() {
  if (OAUTH_TOKEN.length > 0) {
    return { type: 'subscription' as const, token: OAUTH_TOKEN }
  }
  return { type: 'api-key' as const, token: API_KEY }
}

async function buildRealAdapter(): Promise<SdkAdapter> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    async *query(args) {
      for await (const message of sdk.query(args as never)) {
        yield message as SdkMessage
      }
    },
  }
}

interface CapturedRpc {
  method: string
  params: unknown
}

function makeFakeServer(answer: (method: string, params: unknown) => unknown): {
  server: AcpServerLike
  calls: CapturedRpc[]
} {
  const calls: CapturedRpc[] = []
  return {
    calls,
    server: {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        return answer(method, params) as T
      },
    },
  }
}

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

describe.skipIf(!HAS_AUTH)('real Claude API AskUserQuestion smoke', () => {
  test('model invokes AskUserQuestion -> orchestrator answers -> model echoes the choice', async () => {
    const adapter = await buildRealAdapter()
    const { server, calls } = makeFakeServer((method) => {
      if (method === 'session/ask_user_question') {
        return { answers: { 'Pick one color: red or blue?': 'blue' } }
      }
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    })

    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapter,
      server,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: TEST_MODEL,
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the AskUserQuestion tool to ask the user this single question with EXACTLY this text: "Pick one color: red or blue?". Provide two options labelled "red" and "blue". Once they answer, reply with their choice in lowercase.',
          },
        ],
      },
      emit,
    )

    const askCalls = calls.filter((c) => c.method === 'session/ask_user_question')
    expect(askCalls.length).toBeGreaterThan(0)

    const text = events
      .filter((e) => e.type === 'output_chunk')
      .map((e) => (e.type === 'output_chunk' ? e.text : ''))
      .join('')
      .toLowerCase()
    expect(text).toContain('blue')

    const questionEvents = events.filter((e) => e.type === 'question_request')
    expect(questionEvents.length).toBeGreaterThan(0)
  }, 60_000)
})

describe.skipIf(HAS_AUTH)('real Claude API AskUserQuestion smoke (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
