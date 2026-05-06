/**
 * Real Claude API cancel smoke. Runs under either auth path; skipped
 * when neither is set.
 */

import { describe, expect, test } from 'bun:test'

import { HAS_AUTH, TEST_MODEL, buildRealDriver, makeRecordingEmitter } from './_helpers.ts'

describe.skipIf(!HAS_AUTH)('real Claude API cancel smoke', () => {
  test('mid-stream cancel emits a cancelled event within the 5s grace window', async () => {
    const driver = await buildRealDriver()

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: TEST_MODEL,
    })

    const { emit, events } = makeRecordingEmitter()
    const startedAt = Date.now()
    const promise = driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: 'Write a 500-word essay about TypeScript.' }],
      },
      emit,
    )

    // Wait for the SDK to start streaming.
    await new Promise((r) => setTimeout(r, 500))
    await driver.cancel({ sessionId })

    const result = await promise
    const elapsed = Date.now() - startedAt

    expect(result.stopReason).toBe('cancelled')
    expect(events.some((e) => e.type === 'cancelled')).toBe(true)
    expect(elapsed).toBeLessThan(10_000)
  }, 30_000)
})

describe.skipIf(HAS_AUTH)('real Claude API cancel smoke (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
