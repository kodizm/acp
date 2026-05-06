/**
 * Real Claude API resume smoke. The SDK persists session transcripts
 * to ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl after each
 * turn; loadSession({ sessionId }) sets the SDK's `resume` option
 * which replays that transcript on the next prompt.
 */

import { describe, expect, test } from 'bun:test'

import { HAS_AUTH, TEST_MODEL, buildRealDriver, joinOutputText, makeRecordingEmitter } from './_helpers.ts'

describe.skipIf(!HAS_AUTH)('real Claude API resume smoke', () => {
  test('newSession + prompt -> loadSession + new prompt continues the conversation', async () => {
    const driver = await buildRealDriver()

    // 1. Fresh session with a memorable fact.
    const fresh = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: TEST_MODEL,
    })
    const r1 = makeRecordingEmitter()
    await driver.prompt(
      fresh.sessionId,
      {
        sessionId: fresh.sessionId,
        prompt: [{ type: 'text', text: 'Remember: my favorite color is teal. Reply with just "got it".' }],
      },
      r1.emit,
    )
    const r1Output = r1.events.filter((e) => e.type === 'output_chunk')
    expect(r1Output.length).toBeGreaterThan(0)

    // 2. Load + ask for the recall.
    const loaded = await driver.loadSession({
      sessionId: fresh.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })
    expect(loaded.sessionId).toBe(fresh.sessionId)

    const r2 = makeRecordingEmitter()
    await driver.prompt(
      loaded.sessionId,
      {
        sessionId: loaded.sessionId,
        prompt: [{ type: 'text', text: 'What is my favorite color? Just the color name.' }],
      },
      r2.emit,
    )

    const r2Text = joinOutputText(r2.events).toLowerCase()
    expect(r2Text).toContain('teal')
  }, 60_000)
})

describe.skipIf(HAS_AUTH)('real Claude API resume smoke (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
