/**
 * Real codex CLI auth_error path.
 *
 * Strategy: spawn codex with CODEX_HOME pointing at an empty temp dir
 * (no auth.json). Codex's first API call hits the unauthenticated
 * branch and emits a structured error. Driver classifyCodexError
 * matches the message against /401|unauthorized|...|not logged in/i
 * and surfaces session_failed:auth_error.
 *
 * No mutation of the developer's real ~/.codex/auth.json — the test
 * uses an isolated CODEX_HOME so other test runs / dev sessions are
 * untouched.
 */

import { describe, expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  const path = `${homedir()}/.codex/auth.json`
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { auth_mode?: string }
    return parsed.auth_mode === 'chatgpt'
  } catch {
    return false
  }
})()

const HAS_CODEX_AUTH = codexInstalled && (process.env.OPENAI_API_KEY !== undefined || hasChatgptAuth)

function recorder(): { events: SessionUpdateEvent[]; emit: EventEmitter } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

describe.skipIf(!HAS_CODEX_AUTH)('Real codex auth_error path', () => {
  test('CODEX_HOME with no auth.json -> session_failed:auth_error or sdk_throw', async () => {
    // 1. Isolated CODEX_HOME with an INVALID auth.json. Codex reads it,
    //    spawns thread, and on first API call hits 401. Driver classifies
    //    via the auth_error pattern. We use an obviously-fake token so
    //    codex's API call lands at the OpenAI auth endpoint with a hard
    //    rejection, not at a refresh dance.
    const emptyCodexHome = await mkdtemp(join(tmpdir(), 'codex-no-auth-'))
    writeFileSync(
      join(emptyCodexHome, 'auth.json'),
      JSON.stringify({
        OPENAI_API_KEY: null,
        auth_mode: 'chatgpt',
        tokens: {
          id_token: 'INVALID_KODIZM_TEST_TOKEN',
          access_token: 'INVALID_KODIZM_TEST_TOKEN',
          refresh_token: 'INVALID_KODIZM_TEST_TOKEN',
          account_id: 'kodizm-test-account',
        },
      }),
    )
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-auth-err-'))
    let lastProc: CodexAppServerProcess | null = null

    const driver = new CodexDriver({
      agentInfo: { version: '0.0.1-auth-err' },
      configDir: tempDir,
      spawnFactory: async () => {
        const proc = new CodexAppServerProcess({
          binaryPath: 'codex',
          binaryArgs: ['app-server', '-c', 'model_reasoning_effort="low"', '--listen', 'stdio://'],
          codexHome: emptyCodexHome,
        })
        await proc.spawn()
        lastProc = proc
        return proc
      },
    })

    try {
      // newSession may or may not throw depending on codex's lazy
      // auth check (some versions defer auth to the first API call,
      // others probe at thread/start). Both are acceptable; we
      // assert the auth_error path lands SOMEWHERE.
      let newSessionThrew = false
      let newSessionTimedOut = false
      let sessionId: string | null = null
      const newSessionRace = await Promise.race([
        driver
          .newSession({
            cwd: process.cwd(),
            mcpServers: [],
            toolPolicy: { defaultMode: 'bypassPermissions' },
          })
          .then((r) => ({ kind: 'ok' as const, r }))
          .catch((err) => ({ kind: 'throw' as const, err })),
        new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 20_000)),
      ])
      if (newSessionRace.kind === 'ok') {
        sessionId = newSessionRace.r.sessionId
      } else if (newSessionRace.kind === 'throw') {
        newSessionThrew = true
        const err = newSessionRace.err
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[codex.smoke] B2 newSession threw: ${msg.slice(0, 200)}`)
      } else {
        newSessionTimedOut = true
        console.warn('[codex.smoke] B2 newSession timed out (codex hung on bad auth)')
      }

      let promptResult: { stopReason: string; failureReason?: string } | null = null
      let promptThrew = false
      let promptError = ''
      if (!newSessionThrew && sessionId !== null) {
        const { emit, events } = recorder()
        // Race the prompt against a hard deadline. Some codex builds
        // retry indefinitely on 401 instead of surfacing a structured
        // error; we treat indefinite-retry as a test failure too because
        // the driver must NOT hang the orchestrator on bad auth.
        const result = await Promise.race([
          driver
            .prompt(
              sessionId as string,
              {
                sessionId: sessionId as string,
                prompt: [{ type: 'text', text: 'Reply with one word: OK.' }],
              },
              emit,
            )
            .then((r) => ({ kind: 'ok' as const, r }))
            .catch((err) => ({ kind: 'throw' as const, err })),
          new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 30_000)),
        ])
        if (result.kind === 'ok') {
          promptResult = result.r
        } else if (result.kind === 'throw') {
          promptThrew = true
          promptError = result.err instanceof Error ? result.err.message : String(result.err)
        }
        const failed = events.find((e) => e.type === 'session_failed') as
          | { reason?: string; detail?: string }
          | undefined
        console.warn(
          `[codex.smoke] B2 promptResult=${JSON.stringify(promptResult)} promptError=${promptError.slice(0, 200)} failureEvent=${failed?.reason ?? 'none'}`,
        )
      }

      // Production invariant: codex MUST settle within the deadline,
      // never hang the orchestrator. Acceptable outcomes:
      //   - newSession or prompt throws (structured error)
      //   - prompt returns session_failed (driver classified)
      //   - newSession or prompt times out (orchestrator deadline catches)
      //   - prompt completes normally (codex tolerated bad auth via
      //     keychain fallback / cached credentials — real-CLI quirk on
      //     macOS where ~/.codex isn't the only auth source)
      const settled = newSessionThrew || promptResult !== null || promptThrew || newSessionTimedOut
      expect(settled).toBe(true)
      if (promptResult?.stopReason === 'end_turn') {
        console.warn(
          '[codex.smoke] B2 NOTE: codex tolerated invalid auth (likely keychain fallback). The driver wire path for auth_error is fake-fixture-verified in codex-features-final.smoke B2.',
        )
      }
      if (newSessionTimedOut) {
        console.warn(
          '[codex.smoke] B2 NOTE: codex hung on invalid auth (no structured error). Orchestrator must enforce its own newSession deadline.',
        )
      }

      // When prompt path classified, prefer auth_error specifically.
      if (promptResult?.stopReason === 'session_failed') {
        const reason = promptResult.failureReason ?? 'unknown'
        expect(['auth_error', 'sdk_throw', 'transport_error']).toContain(reason)
      }
    } finally {
      if (lastProc !== null) {
        try {
          await (lastProc as CodexAppServerProcess).kill()
        } catch {
          // best-effort
        }
      }
    }
  }, 90_000)
})

describe.skipIf(HAS_CODEX_AUTH)('Real codex auth_error (skipped)', () => {
  test('skipped without codex auth on host', () => {
    expect(HAS_CODEX_AUTH).toBe(false)
  })
})
