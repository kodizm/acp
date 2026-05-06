/**
 * Real Claude API tool dispatch smoke. Skipped when ANTHROPIC_API_KEY
 * is not set so the default `bun test` run stays free of network calls.
 *
 * Run: ANTHROPIC_API_KEY=sk-ant-... bun test test/integration/claude-tool-dispatch.smoke.test.ts
 *
 * Asserts that the SDK's built-in `Bash` tool fires when prompted to
 * run a command, surfaces as a tool_call_begin -> tool_call_end pair
 * through the event-mapper, and the assistant's final answer cites
 * the command output. The SDK auto-permits Bash via permissionMode
 * 'bypassPermissions' to keep the smoke non-interactive; in
 * production the orchestrator gates this through the ACP
 * `session/request_permission` round-trip instead.
 */

import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const HAS_API_KEY = API_KEY.length > 0

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

async function buildBypassAdapter(): Promise<SdkAdapter> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    async *query(args) {
      // Force bypassPermissions so the Bash tool runs without an
      // interactive prompt (would otherwise hang the smoke).
      const enriched = {
        ...args,
        options: {
          ...args.options,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
        },
      }
      for await (const message of sdk.query(enriched as never)) {
        yield message as SdkMessage
      }
    },
  }
}

describe.skipIf(!HAS_API_KEY)('real Claude API tool dispatch smoke', () => {
  test('asking Claude to run a shell command surfaces tool_call_begin + tool_call_end', async () => {
    const adapter = await buildBypassAdapter()

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: API_KEY },
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapter,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Run `echo kodizm-smoke` and tell me the output verbatim.',
          },
        ],
      },
      emit,
    )

    const beginEvents = events.filter((e) => e.type === 'tool_call_begin')
    const endEvents = events.filter((e) => e.type === 'tool_call_end')

    expect(beginEvents.length).toBeGreaterThan(0)
    expect(endEvents.length).toBeGreaterThan(0)

    const finalText = events
      .filter((e) => e.type === 'output_chunk')
      .map((e) => (e.type === 'output_chunk' ? e.text : ''))
      .join(' ')
      .toLowerCase()
    expect(finalText).toContain('kodizm-smoke')
  }, 60_000)
})

describe.skipIf(HAS_API_KEY)('real Claude API tool dispatch smoke (skipped)', () => {
  test('skipped when ANTHROPIC_API_KEY is not set', () => {
    expect(HAS_API_KEY).toBe(false)
  })
})
