import { describe, expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { OpencodeDriver } from '@/backends/opencode/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

/**
 * Pin the SSE subscription's directory scope.
 *
 * The v2 opencode client builds the `/event` request with `directory`
 * and `workspace` as query params, so `event.subscribe({})` scopes the
 * stream to whatever the bin's own process cwd resolves to. Every
 * production session runs in `/workspace/<repo>` while the bin is
 * spawned elsewhere, so an unscoped subscription listened to the wrong
 * directory: the turn ran and was billed, but the driver saw only
 * `server.connected` / `server.heartbeat` and emitted nothing beyond
 * `model_advertisement`. No error surfaced, because the event loop
 * exits silently on every unexpected condition.
 *
 * The regression is only visible when the session cwd DIFFERS from the
 * process cwd, which is why every earlier local test passed: they all
 * used `process.cwd()` for both.
 */
const opencodeInstalled = (() => {
  try {
    return spawnSync('opencode', ['--version'], { stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
})()

const hasOpencodeGoAuth = (() => {
  const path = `${homedir()}/.local/share/opencode/auth.json`
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { type?: string; key?: string }>
    return parsed['opencode-go']?.key !== undefined && parsed['opencode-go']?.key.length > 0
  } catch {
    return false
  }
})()

const HAS_OPENCODE_AUTH: boolean =
  opencodeInstalled && (hasOpencodeGoAuth || process.env.OPENCODE_AUTH_CONTENT !== undefined)

const MODEL: string = process.env.KODIZM_TEST_OPENCODE_MODEL ?? 'opencode-go/deepseek-v4-flash'

describe.skipIf(!HAS_OPENCODE_AUTH)('OpencodeDriver event-stream scope', () => {
  test('a session whose cwd differs from process.cwd() still streams content', async () => {
    // A directory the bin was not started in. This single difference
    // is what the bug turned on.
    const sessionCwd = mkdtempSync(join(tmpdir(), 'kdz-scope-'))
    expect(sessionCwd).not.toBe(process.cwd())

    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-scope' } })

    try {
      const { sessionId } = await driver.newSession({
        cwd: sessionCwd,
        mcpServers: [],
        model: MODEL,
      })

      const events: SessionUpdateEvent[] = []
      const emit = { send: (e: SessionUpdateEvent) => events.push(e) }

      await driver.prompt(
        sessionId,
        { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: SCOPE-OK' }] },
        emit,
      )

      const types = events.map((e) => e.type)

      // model_advertisement alone is the failure signature: it is
      // emitted synchronously by prompt() and never proves the SSE
      // stream reached the right scope.
      expect(types).toContain('output_chunk')
      expect(types.filter((t) => t !== 'model_advertisement').length).toBeGreaterThan(0)
    } finally {
      await driver.disposeAll()
    }
  }, 120_000)

  test('a tool-using turn still streams the reply that follows the tool', async () => {
    // The turn's first assistant message is the one carrying the tool
    // call, and it completes before the reply exists. Ending the event
    // loop there truncated every tool-using turn: tool_call_begin,
    // tool_call_end and usage reached the orchestrator while the answer
    // did not. `session.idle` is the signal that the whole turn is done.
    const sessionCwd = mkdtempSync(join(tmpdir(), 'kdz-tool-'))
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-tool' } })

    try {
      const { sessionId } = await driver.newSession({
        cwd: sessionCwd,
        mcpServers: [],
        model: MODEL,
      })

      const events: SessionUpdateEvent[] = []
      const emit = { send: (e: SessionUpdateEvent) => events.push(e) }

      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Use your bash tool to run `echo TOOLTEXT-42`, then reply with only what it printed.',
            },
          ],
        },
        emit,
      )

      const types = events.map((e) => e.type)

      expect(types).toContain('tool_call_begin')
      expect(types).toContain('output_chunk')
    } finally {
      await driver.disposeAll()
    }
  }, 180_000)
})
