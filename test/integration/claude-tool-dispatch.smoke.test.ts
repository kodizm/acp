/**
 * Real Claude API tool dispatch smoke. Asserts the SDK's built-in
 * `Bash` tool fires when prompted to run a command, surfaces as a
 * `tool_call_begin` -> `tool_call_end` pair through the event-mapper,
 * and the assistant's final answer cites the command output.
 *
 * The smoke flips permissionMode to 'bypassPermissions' to keep the
 * run non-interactive; in production the orchestrator gates this
 * through the ACP `session/request_permission` round-trip.
 */

import { describe, expect, test } from 'bun:test'

import { HAS_AUTH, TEST_MODEL, buildRealDriver, joinOutputText, makeRecordingEmitter } from './_helpers.ts'

describe.skipIf(!HAS_AUTH)('real Claude API tool dispatch smoke', () => {
  test('asking Claude to run a shell command surfaces tool_call_begin + tool_call_end', async () => {
    const driver = await buildRealDriver((args) => ({
      ...args,
      options: {
        ...(args.options as Record<string, unknown>),
        permissionMode: 'bypassPermissions',
      },
    }))

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
            text: 'Run `echo kodizm-smoke-output` using the Bash tool and tell me the exact output.',
          },
        ],
      },
      emit,
    )

    const beginEvents = events.filter((e) => e.type === 'tool_call_begin')
    const endEvents = events.filter((e) => e.type === 'tool_call_end')

    expect(beginEvents.length).toBeGreaterThan(0)
    expect(endEvents.length).toBeGreaterThan(0)

    const finalText = joinOutputText(events).toLowerCase()
    expect(finalText).toContain('kodizm-smoke-output')
  }, 60_000)
})

describe.skipIf(HAS_AUTH)('real Claude API tool dispatch smoke (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
