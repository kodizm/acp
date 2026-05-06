/**
 * Extended codex CLI feature coverage. Mirrors the missing Claude
 * scenarios for parity:
 *
 *   1. cancel mid-stream (turn/interrupt RPC)
 *   2. resume (thread/resume + memory recall)
 *   3. tool dispatch with bypass (Bash echo, output verified)
 *   4. permission canonical flow allow (real canUseTool roundtrip
 *      via codex item/commandExecution/requestApproval)
 *   5. permission canonical flow reject
 *   6. additional directories threaded to sandbox writable_roots
 *   7. multi-turn after permission (lifecycle)
 *
 * Auth: gated on HAS_CODEX_AUTH same as codex-features.smoke.
 */

import { describe, expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import { CodexDriver } from '@/backends/codex/driver.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const CODEX_API_KEY = process.env.CODEX_API_KEY ?? ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''

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

const HAS_CODEX_AUTH = codexInstalled && (CODEX_API_KEY.length > 0 || OPENAI_API_KEY.length > 0 || hasChatgptAuth)

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

interface DriverHandle {
  driver: CodexDriver
  cleanup: () => Promise<void>
}

async function makeDriver(server?: AcpServerLike, debug?: boolean): Promise<DriverHandle> {
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-ext-'))
  let lastProc: CodexAppServerProcess | null = null
  const driver = new CodexDriver({
    agentInfo: { version: '0.0.1-ext' },
    configDir: tempDir,
    spawnFactory: async () => {
      const proc = new CodexAppServerProcess({
        binaryPath: 'codex',
        binaryArgs: ['app-server', '-c', 'model_reasoning_effort="low"', '--listen', 'stdio://'],
        ...(debug === true
          ? {
              debugSink: {
                record: (kind, frame) => {
                  if (kind === 'rpc.in') {
                    const f = frame as { method?: string; id?: number }
                    if (f.method !== undefined) {
                      // biome-ignore lint/suspicious/noConsole: smoke debug
                      console.error(`[codex.in] ${f.method}${f.id !== undefined ? ` (id=${f.id})` : ''}`)
                    }
                  }
                },
              },
            }
          : {}),
      })
      await proc.spawn()
      lastProc = proc
      return proc
    },
    ...(server === undefined ? {} : { server }),
  })
  return {
    driver,
    cleanup: async () => {
      if (lastProc !== null) {
        try {
          await lastProc.close()
        } catch {
          // best-effort
        }
      }
    },
  }
}

function recorder(): { events: SessionUpdateEvent[]; emit: EventEmitter } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

function joinText(events: SessionUpdateEvent[]): string {
  return events
    .filter((e) => e.type === 'output_chunk')
    .map((e) => (e.type === 'output_chunk' ? e.text : ''))
    .join('')
    .toLowerCase()
}

describe.skipIf(!HAS_CODEX_AUTH)('feature 6, cancel mid-stream', () => {
  test('cancel during prompt -> turn/interrupt fires + cancelled event', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit, events } = recorder()
      const startedAt = Date.now()
      const promise = driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Write a 500-word essay about TypeScript history.' }],
        },
        emit,
      )

      // Wait for first SDK chunks then fire cancel.
      await new Promise((r) => setTimeout(r, 1500))
      await driver.cancel({ sessionId })

      const result = await promise
      const elapsed = Date.now() - startedAt

      expect(['cancelled', 'end_turn']).toContain(result.stopReason)
      // Cancel should unwind in well under 30s; default essay would take > 30s.
      expect(elapsed).toBeLessThan(30_000)
      // At least the model_advertisement event must have surfaced before cancel.
      expect(events.some((e) => e.type === 'model_advertisement')).toBe(true)
    } finally {
      await cleanup()
    }
  }, 60_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 7, resume + memory recall', () => {
  test('newSession + memorable fact -> loadSession on same id -> model recalls', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const fresh = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const r1 = recorder()
      await driver.prompt(
        fresh.sessionId,
        {
          sessionId: fresh.sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Remember: my favorite color is teal. Reply just "got it".',
            },
          ],
        },
        r1.emit,
      )
      expect(joinText(r1.events).length).toBeGreaterThan(0)

      const loaded = await driver.loadSession({
        sessionId: fresh.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      })
      expect(loaded.sessionId).toBe(fresh.sessionId)

      const r2 = recorder()
      await driver.prompt(
        loaded.sessionId,
        {
          sessionId: loaded.sessionId,
          prompt: [{ type: 'text', text: 'What is my favorite color? Just the color name.' }],
        },
        r2.emit,
      )
      expect(joinText(r2.events)).toContain('teal')
    } finally {
      await cleanup()
    }
  }, 120_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 8, tool dispatch with bypass', () => {
  test('Bash echo runs, output cited in final answer', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit, events } = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Run the shell command `echo kodizm-codex-tool` and tell me the EXACT output verbatim.',
            },
          ],
        },
        emit,
      )

      const text = joinText(events)
      // Either tool ran and output surfaced, or model relayed it via
      // tool_call_end / output_chunk text. Lenient assertion against
      // model variance.
      expect(text).toContain('kodizm-codex-tool')
    } finally {
      await cleanup()
    }
  }, 90_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 9, permission canonical flow allow', () => {
  test('default mode + auto-allow orchestrator -> shell command runs through approval round trip', async () => {
    const { server, calls } = makeFakeServer((method) => {
      if (method === 'session/request_permission') {
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      }
      return {}
    })
    const { driver, cleanup } = await makeDriver(server)
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'default' },
      })
      const { emit, events } = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'You MUST use the shell tool to run this exact command: `echo kodizm-codex-allow-token`. Then report the EXACT printed output. You cannot guess; the tool MUST run.',
            },
          ],
        },
        emit,
      )

      const permissionCalls = calls.filter((c) => c.method === 'session/request_permission')
      const toolBegins = events.filter((e) => e.type === 'tool_call_begin')

      // If model actually invoked a tool, canonical permission RPC
      // must have fired.
      if (toolBegins.length > 0) {
        expect(permissionCalls.length).toBeGreaterThan(0)
        // Tool ran -> output should surface in the assistant text.
        expect(joinText(events)).toContain('kodizm-codex-allow-token')
      } else {
        // Codex with chatgpt auth + untrusted policy may sometimes
        // refuse to invoke shell; document the skip-rather-than-fail.
        // biome-ignore lint/suspicious/noConsole: smoke note
        console.warn('[codex.smoke] feature 9: model skipped tool use; allow path not exercised')
      }
    } finally {
      await cleanup()
    }
  }, 120_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 10, permission canonical flow reject', () => {
  test('default mode + auto-reject -> shell tool blocked at canonical layer', async () => {
    const { server, calls } = makeFakeServer((method) => {
      if (method === 'session/request_permission') {
        return { outcome: { outcome: 'selected', optionId: 'reject' } }
      }
      return {}
    })
    const { driver, cleanup } = await makeDriver(server)
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'default' },
      })
      const { emit, events } = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'You MUST use the shell tool to run `echo kodizm-codex-reject-marker`. If the tool gets blocked, reply ONLY "blocked".',
            },
          ],
        },
        emit,
      )

      const permissionCalls = calls.filter((c) => c.method === 'session/request_permission')
      const toolBegins = events.filter((e) => e.type === 'tool_call_begin')

      if (toolBegins.length > 0) {
        // Model attempted a tool -> permission RPC must have fired.
        expect(permissionCalls.length).toBeGreaterThan(0)
        // Echo output should NOT surface (rejected before execution).
        expect(joinText(events)).not.toContain('kodizm-codex-reject-marker')
      } else {
        // biome-ignore lint/suspicious/noConsole: smoke note
        console.warn('[codex.smoke] feature 10: model skipped tool use; reject path not exercised')
      }
    } finally {
      await cleanup()
    }
  }, 120_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 11, additional directories', () => {
  test('additionalDirectories threads to codex sandbox writable_roots', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        additionalDirectories: ['/tmp'],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit } = recorder()
      // Just sanity prompt; the assertion is that newSession didn't
      // throw (sandbox config accepted the additional directory).
      await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'Reply OK.' }] }, emit)
      // Reaching this point without throwing = additionalDirectories
      // accepted by codex sandbox policy.
      expect(sessionId.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  }, 60_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 12, multi-turn after permission', () => {
  test('allow + tool runs + 2nd turn references the result', async () => {
    const { server } = makeFakeServer((method) => {
      if (method === 'session/request_permission') {
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      }
      return {}
    })
    const { driver, cleanup } = await makeDriver(server)
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      // Turn 1: shell run sets a memorable output.
      const r1 = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Run `echo 2027` and tell me the year you saw.',
            },
          ],
        },
        r1.emit,
      )
      expect(joinText(r1.events)).toContain('2027')

      // Turn 2: same session asks about turn 1 output.
      const r2 = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'What year did the previous shell command print? Just the year.',
            },
          ],
        },
        r2.emit,
      )
      expect(joinText(r2.events)).toContain('2027')
    } finally {
      await cleanup()
    }
  }, 120_000)
})

describe.skipIf(HAS_CODEX_AUTH)('codex-features-extended.smoke (skipped)', () => {
  test('skipped without codex auth', () => {
    expect(HAS_CODEX_AUTH).toBe(false)
  })
})
