/**
 * Real Claude API tool policy smoke. Validates the read-only preset:
 * dontAsk mode + an explicit allow-list. Anything not in the list
 * gets rejected by the SDK without ever reaching our canUseTool
 * callback (the SDK denies via the allowed/disallowed translation).
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

const dummyServer: AcpServerLike = {
  async request<T>(): Promise<T> {
    return { outcome: { outcome: 'selected', optionId: 'reject' } } as unknown as T
  },
}

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

describe.skipIf(!HAS_AUTH)('real Claude API tool policy smoke', () => {
  test('read_only preset (dontAsk + Read/Glob/Grep allow) blocks Write', async () => {
    const adapter = await buildRealAdapter()
    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapter,
      server: dummyServer,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: TEST_MODEL,
      toolPolicy: {
        allow: ['Read', 'Glob', 'Grep'],
        defaultMode: 'dontAsk',
      },
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Try to write the text "kodizm-policy-test" to /tmp/kodizm-policy-test.txt. Do NOT run any shell command. If you cannot write, reply "blocked".',
          },
        ],
      },
      emit,
    )

    const text = events
      .filter((e) => e.type === 'output_chunk')
      .map((e) => (e.type === 'output_chunk' ? e.text : ''))
      .join('')
      .toLowerCase()

    // Either the model declares blocked, OR it fails to write (no
    // tool_call_end with non-error for Write/Edit). Lenient assertion
    // because model phrasing varies.
    const writeAttempted = events.some((e) => e.type === 'tool_call_begin' && (e.name === 'Write' || e.name === 'Edit'))
    const writeSucceeded = events.some((e) => e.type === 'tool_call_end' && e.isError === false)

    if (writeAttempted) {
      // SDK's dontAsk mode should have denied the Write call before
      // it executed; the tool_call_end for Write should NOT report
      // success.
      expect(writeSucceeded).toBe(false)
    } else {
      // Model decided not to attempt; final text should mention
      // blocking or refusal.
      expect(text).toMatch(/block|refuse|cannot|unable/i)
    }
  }, 60_000)
})

describe.skipIf(HAS_AUTH)('real Claude API tool policy smoke (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
