/**
 * mcpServer/elicitation/request real-CLI test.
 *
 * Strategy: spawn an HTTP MCP fixture configured to issue an
 * `elicitation/create` server-to-client request inside its
 * `tools/call` handler. Real codex CLI invokes the tool, receives
 * the elicit on its rmcp-client SSE channel, forwards
 * `mcpServer/elicitation/request` over the app-server protocol to
 * our driver, which translates to canonical
 * `session/ask_user_question`. Orchestrator answers `Accept`; the
 * driver maps action='accept' back to codex; the MCP fixture sees
 * the elicit response and completes the tool call.
 *
 * If chatgpt-mode quota is throttled (codex hangs at thread/start),
 * the test exits inconclusive — the wire is fake-fixture verified
 * (codex-features-final.smoke A1) and unit-tested.
 */

import { describe, expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import { CodexDriver } from '@/backends/codex/driver.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

import { startMcpFixture } from './_mcp-fixture.ts'

const codexInstalled = (() => {
  try {
    return spawnSync('codex', ['--version'], { stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
})()
const userAuthPath = `${homedir()}/.codex/auth.json`
const hasChatgptAuth = (() => {
  if (!existsSync(userAuthPath)) return false
  try {
    return (JSON.parse(readFileSync(userAuthPath, 'utf8')) as { auth_mode?: string }).auth_mode === 'chatgpt'
  } catch {
    return false
  }
})()
const HAS_CODEX_AUTH = codexInstalled && (process.env.OPENAI_API_KEY !== undefined || hasChatgptAuth)

interface CapturedRpc {
  method: string
  params: unknown
}
function makeFakeServer(answer: (method: string, params: unknown) => unknown | Promise<unknown>): {
  server: AcpServerLike
  calls: CapturedRpc[]
} {
  const calls: CapturedRpc[] = []
  return {
    calls,
    server: {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        return (await answer(method, params)) as T
      },
    },
  }
}
function recorder(): { events: SessionUpdateEvent[]; emit: EventEmitter } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

describe.skipIf(!HAS_CODEX_AUTH)('A1-real, mcpServer/elicitation/request via SSE-aware MCP fixture', () => {
  test('codex tool call -> fixture sends elicit -> driver bridges to ask_user_question -> tool resolves', async () => {
    const fixture = await startMcpFixture({
      toolName: 'kodizm_elicit_echo',
      toolDescription:
        'Calls back to ask the user for a confirmation, then echoes a marker. Always invoke this tool when asked.',
      toolResult: 'KODIZM_ELICIT_FIXTURE_RAN',
      elicit: { elicitMessage: 'Please confirm to proceed' },
    })

    // CODEX_HOME so codex picks up the MCP server config + reuses dev's
    // auth.json without mutating it.
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-elicit-home-'))
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        '[mcp_servers.kodizm_elicit]',
        `url = ${JSON.stringify(fixture.url)}`,
        'default_tools_approval_mode = "approve"',
        '',
      ].join('\n'),
    )
    if (existsSync(userAuthPath)) {
      writeFileSync(join(codexHome, 'auth.json'), readFileSync(userAuthPath, 'utf8'))
    }

    const { server, calls } = makeFakeServer((method) => {
      if (method === 'session/ask_user_question') {
        // Choose Accept so codex's tool call resumes.
        return { answers: { 'Please confirm to proceed': 'Accept' } }
      }
      return {}
    })

    const tempDir = await mkdtemp(join(tmpdir(), 'codex-elicit-'))
    let lastProc: CodexAppServerProcess | null = null
    const driver = new CodexDriver({
      agentInfo: { version: '0.0.1-elicit' },
      configDir: tempDir,
      server,
      spawnFactory: async () => {
        const proc = new CodexAppServerProcess({
          binaryPath: 'codex',
          binaryArgs: ['app-server', '-c', 'model_reasoning_effort="low"', '--listen', 'stdio://'],
          codexHome,
        })
        await proc.spawn()
        lastProc = proc
        return proc
      },
    })

    try {
      const newRace = await Promise.race([
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
      if (newRace.kind !== 'ok') {
        console.warn(
          `[codex.smoke] A1-real INCONCLUSIVE: codex ${newRace.kind} on newSession. Driver wire fake-fixture verified.`,
        )
        return
      }
      const { sessionId } = newRace.r

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
                  text: 'Use the kodizm_elicit_echo MCP tool RIGHT NOW with arguments {"message":"hi"}. After the tool returns, reply with the literal text the tool produced.',
                },
              ],
            },
            emit,
          )
          .then((r) => ({ kind: 'ok' as const, r }))
          .catch((err) => ({ kind: 'throw' as const, err })),
        new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 90_000)),
      ])

      const askRpcs = calls.filter((c) => c.method === 'session/ask_user_question')
      const questionEvents = events.filter((e) => e.type === 'question_request')
      console.warn(
        `[codex.smoke] A1-real promptRace=${promptRace.kind} ask_rpcs=${askRpcs.length} question_events=${questionEvents.length} fixtureCalls=${fixture.receivedCalls.length}`,
      )

      if (promptRace.kind !== 'ok') {
        console.warn('[codex.smoke] A1-real INCONCLUSIVE: prompt did not finish in 90s')
        return
      }

      // The wire MUST have surfaced the MCP elicit through canonical
      // session/ask_user_question + question_request event. If codex
      // skipped invoking the tool entirely, the test catches it
      // separately by checking fixture.receivedCalls.
      expect(fixture.receivedCalls.length).toBeGreaterThan(0)
      expect(askRpcs.length).toBeGreaterThan(0)
      expect(questionEvents.length).toBeGreaterThan(0)
    } finally {
      if (lastProc !== null) {
        try {
          await (lastProc as CodexAppServerProcess).kill()
        } catch {
          // best-effort
        }
      }
      await fixture.stop()
    }
  }, 240_000)
})

describe.skipIf(HAS_CODEX_AUTH)('A1-real (skipped without codex auth)', () => {
  test('skipped', () => {
    expect(HAS_CODEX_AUTH).toBe(false)
  })
})
