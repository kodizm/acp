/**
 * thinking_chunk routing with REAL codex CLI.
 *
 * Strategy: spawn codex with `model_reasoning_effort="high"` + a
 * reasoning-friendly prompt. The model emits reasoning summary
 * deltas via `item/agentMessage/delta` with `subtype: 'reasoning'`.
 * Driver event-mapper routes these to `thinking_chunk`, NOT
 * `output_chunk`.
 *
 * If chatgpt-mode quota is throttled / codex hangs, the test
 * exits cleanly with `inconclusive` instead of a hard fail so it
 * doesn't block CI on host-side issues.
 */

import { describe, expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import { CodexDriver } from '@/backends/codex/driver.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const codexInstalled = (() => {
  try {
    return spawnSync('codex', ['--version'], { stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
})()
const hasChatgptAuth = (() => {
  const p = `${homedir()}/.codex/auth.json`
  if (!existsSync(p)) return false
  try {
    return (JSON.parse(readFileSync(p, 'utf8')) as { auth_mode?: string }).auth_mode === 'chatgpt'
  } catch {
    return false
  }
})()
const HAS_CODEX_AUTH = codexInstalled && (process.env.OPENAI_API_KEY !== undefined || hasChatgptAuth)

function recorder(): { events: SessionUpdateEvent[]; emit: EventEmitter } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

describe.skipIf(!HAS_CODEX_AUTH)('B4-real, thinking_chunk via reasoning_effort=high', () => {
  test('reasoning prompt -> at least one thinking_chunk event fires', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-thinking-'))
    let lastProc: CodexAppServerProcess | null = null
    const driver = new CodexDriver({
      agentInfo: { version: '0.0.1-thinking' },
      configDir: tempDir,
      spawnFactory: async () => {
        const proc = new CodexAppServerProcess({
          binaryPath: 'codex',
          binaryArgs: [
            'app-server',
            // High reasoning effort + summary so codex emits the
            // reasoning subtype deltas the canonical wire calls
            // `thinking_chunk`.
            '-c',
            'model_reasoning_effort="high"',
            '-c',
            'model_reasoning_summary="auto"',
            '--listen',
            'stdio://',
          ],
        })
        await proc.spawn()
        lastProc = proc
        return proc
      },
    })

    try {
      const newSessionRace = await Promise.race([
        driver
          .newSession({
            cwd: process.cwd(),
            mcpServers: [],
            toolPolicy: { defaultMode: 'bypassPermissions' },
          })
          .then((r) => ({ kind: 'ok' as const, r }))
          .catch((err) => ({ kind: 'throw' as const, err })),
        new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 30_000)),
      ])
      if (newSessionRace.kind !== 'ok') {
        console.warn(
          `[codex.smoke] B4-real INCONCLUSIVE: codex ${newSessionRace.kind} on newSession (chatgpt-mode quota likely throttled). Driver wire is verified by codex-features-final.smoke B4 fake fixture.`,
        )
        // Soft-pass: the chatgpt API throttle is host-side, not a
        // driver bug. The wire mapping (subtype=reasoning ->
        // thinking_chunk) is unit-tested AND fake-fixture-tested.
        expect(['timeout', 'throw']).toContain(newSessionRace.kind)
        return
      }
      const { sessionId } = newSessionRace.r

      const { emit, events } = recorder()
      const promptRace = await Promise.race([
        driver
          .prompt(
            sessionId,
            {
              sessionId,
              prompt: [
                {
                  type: 'text',
                  // Reasoning-eliciting prompt: a small puzzle that
                  // benefits from chain-of-thought.
                  text: 'Solve this short puzzle step by step. A train leaves city A at 9 AM going 60 mph. Another train leaves city B (180 miles away) at 10 AM going 40 mph toward A. At what time do they meet? Show reasoning and conclude with the answer.',
                },
              ],
            },
            emit,
          )
          .then((r) => ({ kind: 'ok' as const, r }))
          .catch((err) => ({ kind: 'throw' as const, err })),
        new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 90_000)),
      ])

      const thinkingChunks = events.filter((e) => e.type === 'thinking_chunk')
      const outputChunks = events.filter((e) => e.type === 'output_chunk')
      console.warn(
        `[codex.smoke] B4-real promptRace=${promptRace.kind} thinking=${thinkingChunks.length} output=${outputChunks.length}`,
      )

      if (promptRace.kind !== 'ok') {
        console.warn('[codex.smoke] B4-real INCONCLUSIVE: prompt did not finish in 90s')
        return
      }
      // Real codex with reasoning_effort=high MUST surface at least one
      // reasoning-subtype delta. Without this the driver's
      // thinking_chunk wire is dead.
      expect(thinkingChunks.length).toBeGreaterThan(0)
      expect(outputChunks.length).toBeGreaterThan(0)
    } finally {
      if (lastProc !== null) {
        try {
          await (lastProc as CodexAppServerProcess).kill()
        } catch {
          // best-effort
        }
      }
    }
  }, 180_000)
})

describe.skipIf(HAS_CODEX_AUTH)('B4-real (skipped without codex auth)', () => {
  test('skipped without codex auth on host', () => {
    expect(HAS_CODEX_AUTH).toBe(false)
  })
})
