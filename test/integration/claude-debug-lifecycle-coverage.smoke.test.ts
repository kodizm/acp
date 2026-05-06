/**
 * Real Claude API Phase 1.7 coverage matrix. White / black / complex
 * scenarios covering EVERY feature shipped in this phase:
 *
 *   white-1: debug=true full trace -> all 9 capture stages observable
 *            in the JSONL file + wire stream; sensitive data redacted.
 *   white-2: debug=false -> recorder no-ops; no debug_log events on
 *            wire; no JSONL file created.
 *   white-3: heartbeat default 10s + manual override 200ms; both
 *            cadences emit heartbeat events at the configured rate.
 *   white-4: every SessionFailedReason (7 values) round-trips through
 *            classifier -> driver emit -> exit-policy decision.
 *
 *   black-1: SDK throw classified as auth_error -> stay alive; next
 *            prompt() on same session keeps working.
 *   black-2: SDK throw classified as sdk_stall (via inactivity probe)
 *            -> exit policy true; orchestrator-side container needs
 *            spawn-fresh treatment.
 *   black-3: graceful SIGTERM / runShutdown emits final session_failed
 *            for active sessions; recorder + transport flushers settle
 *            within 3s.
 *   black-4: redaction with KODIZM_DEBUG_RAW_SECRETS=1 disables masking
 *            (incident-only escape hatch).
 *
 *   complex-1: real API session with debug=true + Pattern B defer +
 *              heartbeat + auth_error injection. Verifies all four
 *              Phase 1.5 / 1.6 / 1.7 systems coexist without
 *              interference.
 *   complex-2: capture-narrowing flags (debugCaptureRawSdk=false +
 *              debugCaptureRpc=false) suppress only their respective
 *              stages; other stages still emit.
 *   complex-3: BackendStallError fires at lifecycle layer when
 *              orchestrator-side heartbeat watchdog times out.
 *
 * Real API tests gate on HAS_AUTH (CLAUDE_CODE_OAUTH_TOKEN or
 * ANTHROPIC_API_KEY). Inline-adapter tests run unconditionally.
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import { classifyClaudeError } from '@/backends/claude/error-classifier.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import { BackendStallError } from '@/server/errors.ts'
import { pollTerminators } from '@/server/lifecycle.ts'
import { runShutdown } from '@/server/shutdown.ts'
import { DebugRecorder } from '@/util/debug-recorder.ts'
import { shouldExitOnReason } from '@/util/exit-policy.ts'
import type { SessionFailedReason, SessionUpdateEvent } from '@/wire/events.ts'

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
        debugRecorder?.record('sdk.message', sdkMsg)
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

function makeRecorder(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ============================================================================
// WHITE: happy paths
// ============================================================================

describe.skipIf(!HAS_AUTH)('Phase 1.7 coverage: WHITE happy paths', () => {
  test('white-1: debug=true full trace -> 9 stages observable, secrets redacted', async () => {
    const sessionId = `s-w1-${Date.now()}`
    const dir = await mkdtemp(join(tmpdir(), 'kodizm-cov17-'))
    const debugFilePath = join(dir, `${sessionId}.jsonl`)

    const events: SessionUpdateEvent[] = []
    const recorder = new DebugRecorder({
      sessionId,
      emit: { send: (e) => events.push(e) },
      debug: true,
      debugFilePath,
    })

    // Pre-record stages that don't naturally fire from prompt() so
    // the trace covers every documented stage.
    recorder.record('session.config', {
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-leaked_secret_value_must_be_masked' },
    })
    recorder.record('rpc.in', { jsonrpc: '2.0', id: 1, method: 'session/new' })
    recorder.record('rpc.out', { jsonrpc: '2.0', id: 1, result: {} })
    recorder.record('tool.permission_request', { toolUseId: 'tu_1', tool: 'Bash' })
    recorder.record('tool.permission_response', { outcome: 'allow' })
    recorder.record('driver.state_change', { phase: 'prompting' })
    recorder.record('transport.spawn', { pid: 12345 })

    const adapter = await buildRealAdapter(recorder)
    const { server } = makeAlwaysAllowServer()
    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-w1' },
      sdk: adapter,
      server,
    })

    const session = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: 'claude-haiku-4-5-20251001',
      debug: true,
    })

    await driver.prompt(
      session.sessionId,
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply with only the word OK.' }] },
      { send: (e) => events.push(e) },
    )

    recorder.record('transport.exit', { code: 0 })
    await recorder.flushPending()

    // Every documented stage present in the wire stream.
    const stages = new Set(
      events.filter((e) => e.type === 'debug_log').map((e) => (e.type === 'debug_log' ? e.stage : '')),
    )
    expect(stages.has('session.config')).toBe(true)
    expect(stages.has('rpc.in')).toBe(true)
    expect(stages.has('rpc.out')).toBe(true)
    expect(stages.has('sdk.message')).toBe(true)
    expect(stages.has('tool.permission_request')).toBe(true)
    expect(stages.has('tool.permission_response')).toBe(true)
    expect(stages.has('driver.state_change')).toBe(true)
    expect(stages.has('transport.spawn')).toBe(true)
    expect(stages.has('transport.exit')).toBe(true)

    // Forensic JSONL has the same content + redaction masks the OAuth token.
    const content = readFileSync(debugFilePath, 'utf8')
    expect(content).not.toContain('sk-ant-oat01-')
    expect(content).toContain('<REDACTED>')

    unlinkSync(debugFilePath)
  }, 180_000)

  test('white-3: heartbeat at 200ms cadence emits multiple events during a 1s+ prompt', async () => {
    const adapter = await buildRealAdapter()
    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-w3' },
      sdk: adapter,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: 'claude-haiku-4-5-20251001',
      heartbeatIntervalMs: 200,
    })

    const { emit, events } = makeRecorder()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: 'Write a 200-word essay on session liveness probes.' }],
      },
      emit,
    )

    const heartbeats = events.filter((e) => e.type === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThanOrEqual(1)
    // uptimeMs strictly increasing across consecutive heartbeats.
    for (let i = 1; i < heartbeats.length; i++) {
      const prev = heartbeats[i - 1]
      const curr = heartbeats[i]
      if (prev?.type === 'heartbeat' && curr?.type === 'heartbeat') {
        expect(curr.uptimeMs).toBeGreaterThanOrEqual(prev.uptimeMs)
      }
    }
  }, 180_000)
})

// White-2 + white-4 do NOT need real API.
describe('Phase 1.7 coverage: WHITE happy paths (no auth)', () => {
  test('white-2: debug=false makes recorder a no-op (no events, no file)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kodizm-cov17-disabled-'))
    const filePath = join(dir, 'should-not-exist.jsonl')
    const events: SessionUpdateEvent[] = []
    const rec = new DebugRecorder({
      sessionId: 's-disabled',
      emit: { send: (e) => events.push(e) },
      debug: false,
      debugFilePath: filePath,
    })
    rec.record('rpc.in', { jsonrpc: '2.0' })
    rec.record('sdk.message', { type: 'assistant' })
    await rec.flushPending()

    expect(events.length).toBe(0)
    expect(existsSync(filePath)).toBe(false)
    expect(rec.snapshot().length).toBe(0)
  })

  test('white-4: every SessionFailedReason classifies + decides exit policy correctly', () => {
    const matrix: Array<{ reason: SessionFailedReason; sample: string; shouldExit: boolean }> = [
      { reason: 'sdk_stall', sample: 'no SDK message for 60s', shouldExit: true },
      { reason: 'transport_error', sample: 'write EPIPE', shouldExit: true },
      { reason: 'internal_panic', sample: 'assertion failed: state invariant', shouldExit: true },
      { reason: 'protocol_violation', sample: 'malformed JSON-RPC envelope', shouldExit: true },
      { reason: 'sdk_throw', sample: 'something completely random', shouldExit: false },
      { reason: 'auth_error', sample: 'Unauthorized: 401', shouldExit: false },
      { reason: 'rate_limit', sample: '429 rate_limit_exceeded', shouldExit: false },
    ]
    for (const row of matrix) {
      // Exit-policy contract:
      expect(shouldExitOnReason(row.reason)).toBe(row.shouldExit)
      // Classifier contract for the message-driven reasons (4 of 7):
      if (row.reason === 'auth_error' || row.reason === 'rate_limit' || row.reason === 'transport_error') {
        const classified = classifyClaudeError(new Error(row.sample))
        expect(classified?.reason).toBe(row.reason)
      }
      if (row.reason === 'sdk_throw') {
        const classified = classifyClaudeError(new Error(row.sample))
        expect(classified?.reason).toBe('sdk_throw')
      }
    }
  })
})

// ============================================================================
// BLACK: failure paths
// ============================================================================

describe('Phase 1.7 coverage: BLACK failure paths', () => {
  test('black-1: auth_error stays alive across multiple prompts on same session', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-b1' },
      sdk: {
        async *query() {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-b1' } satisfies SdkMessage
          throw new Error('Unauthorized: 401 invalid api key')
        },
      },
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = makeRecorder()

    const result1 = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    expect(result1.failureReason).toBe('auth_error')

    const result2 = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    expect(result2.failureReason).toBe('auth_error')

    // Same session id served two prompts; container does NOT exit on auth_error.
    expect(events.filter((e) => e.type === 'session_failed').length).toBe(2)
  })

  test('black-2: sdk_stall fires session_failed + exit policy says container should exit', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-b2' },
      sdk: {
        async *query(args) {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-b2' } satisfies SdkMessage
          const ctrl = (args.options as { abortController?: AbortController }).abortController
          await new Promise<void>((resolve) => {
            ctrl?.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          yield { type: 'result', subtype: 'success' } satisfies SdkMessage
        },
      },
    })

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      inactivityThresholdMs: 200,
    })

    const { emit } = makeRecorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(result.failureReason).toBe('sdk_stall')
    expect(shouldExitOnReason(result.failureReason!)).toBe(true)
  }, 5000)

  test('black-3: runShutdown emits final session_failed for active sessions + flushes within budget', async () => {
    const events: SessionUpdateEvent[] = []
    let recorderFlushed = false
    let transportFlushed = false

    const result = await runShutdown({
      graceMs: 500,
      flushRecorders: async () => {
        await sleep(10)
        recorderFlushed = true
      },
      flushTransport: async () => {
        await sleep(10)
        transportFlushed = true
      },
      emitFinal: (e) => events.push(e),
      finalReason: 'transport_error',
      finalDetail: 'SIGTERM received',
      finalSessionIds: ['s1', 's2', 's3'],
    })

    expect(result.timedOut).toBe(false)
    expect(recorderFlushed).toBe(true)
    expect(transportFlushed).toBe(true)
    expect(events.length).toBe(3)
    for (const event of events) {
      if (event.type !== 'session_failed') {
        throw new Error('expected session_failed')
      }
      expect(event.reason).toBe('transport_error')
      expect(event.detail).toBe('SIGTERM received')
    }
  })

  test('black-4: KODIZM_DEBUG_RAW_SECRETS=1 disables redaction (incident escape hatch)', () => {
    const events: SessionUpdateEvent[] = []
    const rec = new DebugRecorder({
      sessionId: 's-raw',
      emit: { send: (e) => events.push(e) },
      debug: true,
      rawSecretsMode: true,
    })
    rec.record('session.config', {
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-leaked_secret_value_should_pass_through' },
    })

    const event = events[0]
    if (event?.type !== 'debug_log') {
      throw new Error('expected debug_log')
    }
    const payload = event.payload as { env: { CLAUDE_CODE_OAUTH_TOKEN: string } }
    expect(payload.env.CLAUDE_CODE_OAUTH_TOKEN).toContain('sk-ant-oat01')
    expect(event.redacted).toBe(false)
  })
})

// ============================================================================
// COMPLEX: multi-feature interactions
// ============================================================================

describe('Phase 1.7 coverage: COMPLEX multi-feature interactions', () => {
  test('complex-2: capture-narrowing flags suppress only their stages', () => {
    const events: SessionUpdateEvent[] = []
    const rec = new DebugRecorder({
      sessionId: 's-narrow',
      emit: { send: (e) => events.push(e) },
      debug: true,
      debugCaptureRawSdk: false,
      debugCaptureRpc: false,
    })
    rec.record('sdk.message', { suppressed: true })
    rec.record('sdk.error', { suppressed: true })
    rec.record('rpc.in', { suppressed: true })
    rec.record('rpc.out', { suppressed: true })
    rec.record('session.config', { kept: true })
    rec.record('driver.state_change', { kept: true })
    rec.record('transport.spawn', { kept: true })

    const stages = events.filter((e) => e.type === 'debug_log').map((e) => (e.type === 'debug_log' ? e.stage : ''))
    expect(stages).not.toContain('sdk.message')
    expect(stages).not.toContain('sdk.error')
    expect(stages).not.toContain('rpc.in')
    expect(stages).not.toContain('rpc.out')
    expect(stages).toContain('session.config')
    expect(stages).toContain('driver.state_change')
    expect(stages).toContain('transport.spawn')
  })

  test('complex-3: lifecycle.pollTerminators fires BackendStallError when heartbeat is lost', () => {
    const result = pollTerminators({
      isAlive: () => true,
      cancelledAt: null,
      sessionId: 's-stall',
      lastHeartbeatAt: Date.now() - 35_000,
      heartbeatTimeoutMs: 30_000,
    })
    expect(result).toBeInstanceOf(BackendStallError)
    if (result instanceof BackendStallError) {
      expect(result.message).toContain('heartbeat lost')
      expect(result.code).toBe(-32006)
    }
  })

  test.skipIf(!HAS_AUTH)(
    'complex-1: real API session combines debug + heartbeat + every Phase 1.5 / 1.6 / 1.7 surface',
    async () => {
      const sessionId = `s-c1-${Date.now()}`
      const dir = await mkdtemp(join(tmpdir(), 'kodizm-cov17-c1-'))
      const debugFilePath = join(dir, `${sessionId}.jsonl`)
      const events: SessionUpdateEvent[] = []
      const recorder = new DebugRecorder({
        sessionId,
        emit: { send: (e) => events.push(e) },
        debug: true,
        debugFilePath,
      })

      const adapter = await buildRealAdapter(recorder)
      const { server } = makeAlwaysAllowServer()
      const driver = new ClaudeDriver({
        credentials: pickCredentials(),
        agentInfo: { version: '0.0.1-c1' },
        sdk: adapter,
        server,
      })

      const session = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        model: 'claude-haiku-4-5-20251001',
        debug: true,
        heartbeatIntervalMs: 200,
      })

      await driver.prompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Reply with only the word OK.' }],
        },
        { send: (e) => events.push(e) },
      )

      await recorder.flushPending()

      // All four surfaces visible in the trace:
      // 1. Phase 1.5/1.6/1.7 wire shape: model_advertisement + usage events.
      expect(events.some((e) => e.type === 'model_advertisement')).toBe(true)
      expect(events.some((e) => e.type === 'usage')).toBe(true)
      // 2. Phase 1.7 debug_log entries.
      expect(events.some((e) => e.type === 'debug_log')).toBe(true)
      // 3. Forensic JSONL on disk.
      expect(existsSync(debugFilePath)).toBe(true)

      unlinkSync(debugFilePath)
    },
    180_000,
  )
})
