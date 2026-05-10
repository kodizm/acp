/**
 * Real Claude API smoke test. Runs under either auth path:
 *   - `ANTHROPIC_API_KEY` (api-key)
 *   - `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CODE_REMOTE=1` (subscription)
 *
 * Skipped automatically when neither is set.
 *
 * Cost expectation: a single "say hi" turn against Haiku is on the
 * order of a fraction of a US cent.
 */

import { describe, expect, test } from 'bun:test'

import { HAS_AUTH, TEST_MODEL, buildRealDriver, findEvent, makeRecordingEmitter } from './_helpers.ts'

describe.skipIf(!HAS_AUTH)('real Claude API smoke', () => {
  test('say hi -> output_chunk + usage with positive tokens + costUsd > 0', async () => {
    const driver = await buildRealDriver()

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: TEST_MODEL,
    })

    const { emit, events } = makeRecordingEmitter()
    const result = await driver.prompt(
      sessionId,
      { sessionId, prompt: [{ type: 'text', text: 'Say "hi" and nothing else.' }] },
      emit,
    )

    expect(result.stopReason).toBe('end_turn')

    const outputChunks = events.filter((e) => e.type === 'output_chunk')
    expect(outputChunks.length).toBeGreaterThan(0)

    const usage = findEvent(events, 'usage')
    expect(usage).toBeDefined()
    if (usage !== undefined) {
      expect(usage.inputTokens).toBeGreaterThan(0)
      expect(usage.outputTokens).toBeGreaterThan(0)
      expect(usage.costUsd).toBeGreaterThanOrEqual(0)
    }
  }, 30_000)

  test('PNG image-block round-trip: assistant identifies the colour', async () => {
    const driver = await buildRealDriver()

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: TEST_MODEL,
    })

    // 64x64 solid red PNG, base64-encoded. Decoded size ~160 bytes;
    // well under the 5 MB cap. Inline so the smoke does not depend on
    // sharp / fixtures on disk. Larger than 8x8 because the Anthropic
    // image endpoint rejects very tiny PNGs with HTTP 400.
    const RED_PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZklEQVR42u3QMREAAAgEIJN8/1B20RyeDBSgOpnPSoAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECLhvAexncfCuqA9bAAAAAElFTkSuQmCC'

    const { emit, events } = makeRecordingEmitter()
    const result = await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          { type: 'text', text: 'What colour is this image? Reply with one word.' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: RED_PNG_BASE64 } },
        ],
      },
      emit,
    )

    expect(result.stopReason).toBe('end_turn')

    const text = events
      .filter((e) => e.type === 'output_chunk')
      .map((e) => (e.type === 'output_chunk' ? e.text : ''))
      .join('')
    expect(text.toLowerCase()).toContain('red')
  }, 30_000)
})

describe.skipIf(HAS_AUTH)('real Claude API smoke (skipped)', () => {
  test('skipped when neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
