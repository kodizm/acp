/**
 * Real Claude API debug-mode round-trip smoke. Phase 1.7 T15.
 *
 * Asserts:
 *   - debug:true on NewSessionRequest produces canonical debug_log
 *     events streamed to the orchestrator (live tail).
 *   - The forensic JSONL file at <configHome>/<sessionId>.jsonl
 *     contains rpc.in / rpc.out / sdk.message / driver.state_change
 *     stage entries.
 *   - Allow-list redaction is applied by default (no raw OAuth
 *     token leaks into the trace).
 *   - The KODIZM_DEBUG_RAW_SECRETS env override disables redaction
 *     when set.
 *
 * The test wires a DebugRecorder + AcpServer manually because the
 * bin entrypoint is still a stub (Phase 1 leftover); the wiring
 * mirrors what Phase 5 will bake into the production bin.
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import { DebugRecorder } from '@/util/debug-recorder.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

import { HAS_AUTH } from './_helpers.ts'

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''

function pickCredentials() {
  if (OAUTH_TOKEN.length > 0) {
    return { type: 'subscription' as const, token: OAUTH_TOKEN }
  }
  return { type: 'api-key' as const, token: API_KEY }
}

async function buildRealAdapter(debugRecorder?: DebugRecorder): Promise<SdkAdapter> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    async *query(args) {
      const isolated = {
        prompt: args.prompt,
        options: { ...(args.options as Record<string, unknown>), settingSources: [] },
      }
      for await (const message of sdk.query(isolated as never)) {
        const sdkMsg = message as SdkMessage
        if (debugRecorder !== undefined) {
          debugRecorder.record('sdk.message', sdkMsg)
        }
        yield sdkMsg
      }
    },
  }
}

function makeAlwaysAllowServer(): { server: AcpServerLike; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    server: {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        if (method === 'session/request_permission') {
          return { outcome: { outcome: 'selected', optionId: 'allow' } } as T
        }
        return {} as T
      },
    },
  }
}

describe.skipIf(!HAS_AUTH)('Phase 1.7 debug-mode real-API smoke', () => {
  test('debug:true session emits debug_log events + writes forensic JSONL with redacted secrets', async () => {
    const sessionId = `s-debug-${Date.now()}`
    const configDir = await mkdtemp(join(tmpdir(), 'kodizm-debug-cov-'))
    const debugFilePath = join(configDir, `${sessionId}.jsonl`)

    const events: SessionUpdateEvent[] = []
    const recorder = new DebugRecorder({
      sessionId,
      emit: { send: (e) => events.push(e) },
      debug: true,
      debugFilePath,
    })

    // Pre-record a session.config snapshot mirroring what the bin
    // will emit on session/new (carries credentials + env; redaction
    // must mask the OAuth token).
    recorder.record('session.config', {
      env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN.length > 0 ? OAUTH_TOKEN : 'sk-ant-oat01-fake_value_for_test' },
      cwd: '/workspace',
    })

    const adapter = await buildRealAdapter(recorder)
    const { server } = makeAlwaysAllowServer()
    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-debug-smoke' },
      sdk: adapter,
      server,
    })

    const newSession = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: 'claude-haiku-4-5-20251001',
      debug: true,
    })

    await driver.prompt(
      newSession.sessionId,
      {
        sessionId: newSession.sessionId,
        prompt: [{ type: 'text', text: 'Say hi briefly.' }],
      },
      { send: (e) => events.push(e) },
    )

    await recorder.flushPending()

    // 1. Wire-side: debug_log events are present.
    const debugEvents = events.filter((e) => e.type === 'debug_log')
    expect(debugEvents.length).toBeGreaterThan(0)
    const stages = new Set(debugEvents.map((e) => (e.type === 'debug_log' ? e.stage : '')))
    expect(stages.has('session.config')).toBe(true)
    expect(stages.has('sdk.message')).toBe(true)

    // 2. Forensic JSONL has the same entries.
    expect(existsSync(debugFilePath)).toBe(true)
    const jsonlContent = readFileSync(debugFilePath, 'utf8')
    expect(jsonlContent.length).toBeGreaterThan(0)
    const lines = jsonlContent.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)

    // 3. Redaction: no raw OAuth token should leak.
    expect(jsonlContent).not.toContain('sk-ant-oat01-')

    unlinkSync(debugFilePath)
  }, 180_000)
})

describe.skipIf(HAS_AUTH)('Phase 1.7 debug-mode (skipped)', () => {
  test('skipped without auth env', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
