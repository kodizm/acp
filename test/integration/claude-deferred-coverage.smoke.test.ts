/**
 * Real Claude API Pattern B coverage matrix. Black / white / complex
 * scenarios for the deferred-permission lifecycle:
 *
 *   white-1: defer + cached allow + Write tool runs end-to-end
 *   white-2: defer + cached deny + tool blocked, model finishes
 *   black-1: defer fires, container exits, no cached answer (the
 *            "10-day pending" path) - asserts JSONL + state are
 *            persisted but no resumed event yet
 *   black-2: defer never fires (orchestrator answers within window)
 *            - asserts legacy Phase 1.5 path stays intact even with
 *            permissionDeferTimeoutMs set
 *   complex-1: signal abort during defer wait wins over both timers
 *   complex-2: multi-tool turn after resume - cached answer fires
 *              once, subsequent tools route through normal canUseTool
 *
 * All scenarios use a temp config home so JSONL writes never touch
 * the developer's real ~/.claude/projects.
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import { InMemoryDeferredStore } from '@/session/deferred-store.ts'

import { HAS_AUTH, makeRecordingEmitter } from './_helpers.ts'

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''

function pickCredentials() {
  if (OAUTH_TOKEN.length > 0) {
    return { type: 'subscription' as const, token: OAUTH_TOKEN }
  }
  return { type: 'api-key' as const, token: API_KEY }
}

async function buildRealAdapter(): Promise<SdkAdapter> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    async *query(args) {
      const isolated = {
        prompt: args.prompt,
        options: { ...(args.options as Record<string, unknown>), settingSources: [] },
      }
      for await (const message of sdk.query(isolated as never)) {
        yield message as SdkMessage
      }
    },
  }
}

interface CapturedRpc {
  method: string
  params: unknown
}

function makeNeverAnswerServer(): { server: AcpServerLike; calls: CapturedRpc[] } {
  const calls: CapturedRpc[] = []
  return {
    calls,
    server: {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        return new Promise<T>(() => {})
      },
    },
  }
}

function makeAlwaysAllowServer(): { server: AcpServerLike; calls: CapturedRpc[] } {
  const calls: CapturedRpc[] = []
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

async function makeIsolatedConfigHome(): Promise<{ configHome: string; sanitized: string; cwd: string }> {
  const configHome = await mkdtemp(join(tmpdir(), 'kodizm-defer-cov-'))
  const cwd = process.cwd()
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  await mkdir(join(configHome, 'projects', sanitized), { recursive: true })
  return { configHome, sanitized, cwd }
}

const cleanupFile = (path: string): void => {
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

describe.skipIf(!HAS_AUTH)('Pattern B coverage matrix vs real Claude API', () => {
  test('white-1: defer + cached allow -> Write tool runs after resume', async () => {
    const tempFile = join(tmpdir(), `kodizm-cov-w1-${Date.now()}.txt`)
    cleanupFile(tempFile)

    const { configHome, sanitized, cwd } = await makeIsolatedConfigHome()
    const store = new InMemoryDeferredStore()
    const sessionId = `sess-w1-${Date.now()}`

    // -------- Driver A: defer cycle --------
    const adapterA = await buildRealAdapter()
    const { server: serverA } = makeNeverAnswerServer()
    const driverA = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-cov' },
      sdk: adapterA,
      server: serverA,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    const sessA = await driverA.newSession({
      cwd,
      mcpServers: [],
      model: 'claude-sonnet-4-6',
      toolPolicy: { defaultMode: 'default' },
      permissionDeferTimeoutMs: 1500,
    })

    const { emit: emitA, events: eventsA } = makeRecordingEmitter()
    await driverA.prompt(
      sessA.sessionId,
      {
        sessionId: sessA.sessionId,
        prompt: [
          {
            type: 'text',
            text: `Use Write to create ${tempFile} with content "white-1 ok". Then say "done".`,
          },
        ],
      },
      emitA,
    )

    expect(eventsA.find((e) => e.type === 'permission_deferred')).toBeDefined()
    const stateA = await store.get(sessA.sessionId)
    expect(stateA?.toolName).toBe('Write')

    // Capture sdkSessionId from A so we can re-attach it to B for resume.
    const sdkSessionId = (driverA as unknown as { sessions: Map<string, { sdkSessionId?: string }> }).sessions.get(
      sessA.sessionId,
    )?.sdkSessionId
    expect(sdkSessionId).toBeDefined()

    // Orchestrator caches an allow answer.
    await store.set(sessA.sessionId, { ...stateA!, cachedAnswer: { behavior: 'allow' } })

    // -------- Driver B: resume cycle --------
    const adapterB = await buildRealAdapter()
    const { server: serverB, calls: callsB } = makeAlwaysAllowServer()
    const driverB = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-cov' },
      sdk: adapterB,
      server: serverB,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    await driverB.loadSession({ sessionId: sessA.sessionId, cwd, mcpServers: [] })
    // Re-attach sdkSessionId so resume targets the same JSONL.
    ;(driverB as unknown as { sessions: Map<string, { sdkSessionId?: string }> }).sessions.set(sessA.sessionId, {
      sessionId: sessA.sessionId,
      options: { cwd, mcpServers: {}, permissionMode: 'default', resume: sdkSessionId },
      sdkSessionId,
    } as unknown as { sessionId: string; options: unknown; sdkSessionId?: string })

    const { emit: emitB, events: eventsB } = makeRecordingEmitter()
    await driverB.prompt(
      sessA.sessionId,
      {
        sessionId: sessA.sessionId,
        prompt: [{ type: 'text', text: 'Continue.' }],
      },
      emitB,
    )

    const resumed = eventsB.find((e) => e.type === 'permission_resumed')
    expect(resumed).toBeDefined()
    if (resumed?.type === 'permission_resumed') {
      expect(resumed.decision).toBe('allow')
    }
    expect(callsB.filter((c) => c.method === 'session/request_permission').length).toBe(0)
    expect(existsSync(tempFile)).toBe(true)
    expect(await store.get(sessA.sessionId)).toBeNull()

    cleanupFile(tempFile)
  }, 180_000)

  test('white-2: defer + cached deny -> tool blocked, model finishes gracefully', async () => {
    const tempFile = join(tmpdir(), `kodizm-cov-w2-${Date.now()}.txt`)
    cleanupFile(tempFile)

    const { configHome, cwd } = await makeIsolatedConfigHome()
    const store = new InMemoryDeferredStore()

    const adapterA = await buildRealAdapter()
    const { server: serverA } = makeNeverAnswerServer()
    const driverA = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-cov' },
      sdk: adapterA,
      server: serverA,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    const sessA = await driverA.newSession({
      cwd,
      mcpServers: [],
      model: 'claude-sonnet-4-6',
      toolPolicy: { defaultMode: 'default' },
      permissionDeferTimeoutMs: 1500,
    })

    const { emit: emitA, events: eventsA } = makeRecordingEmitter()
    await driverA.prompt(
      sessA.sessionId,
      {
        sessionId: sessA.sessionId,
        prompt: [
          {
            type: 'text',
            text: `Use the Write tool to create the file at ${tempFile} with content "deny-test". Then say "done".`,
          },
        ],
      },
      emitA,
    )

    const sdkSessionId = (driverA as unknown as { sessions: Map<string, { sdkSessionId?: string }> }).sessions.get(
      sessA.sessionId,
    )?.sdkSessionId

    // Diagnostic: surface whether the model invoked Write at all.
    const toolBeginEvents = eventsA.filter((e) => e.type === 'tool_call_begin')
    const deferredEvents = eventsA.filter((e) => e.type === 'permission_deferred')
    if (toolBeginEvents.length === 0) {
      throw new Error(`white-2: model never invoked any tool. Events: ${eventsA.map((e) => e.type).join(', ')}`)
    }
    if (deferredEvents.length === 0) {
      const firstBegin = toolBeginEvents[0] as { name?: string } | undefined
      throw new Error(
        `white-2: model invoked tool ${firstBegin?.name} but defer never fired. Events: ${eventsA.map((e) => e.type).join(', ')}`,
      )
    }
    const stateA = await store.get(sessA.sessionId)
    expect(stateA).not.toBeNull()

    await store.set(sessA.sessionId, {
      ...stateA!,
      cachedAnswer: { behavior: 'deny', message: 'User denied via dialog' },
    })

    const adapterB = await buildRealAdapter()
    const { server: serverB } = makeAlwaysAllowServer()
    const driverB = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-cov' },
      sdk: adapterB,
      server: serverB,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    await driverB.loadSession({ sessionId: sessA.sessionId, cwd, mcpServers: [] })
    ;(driverB as unknown as { sessions: Map<string, { sdkSessionId?: string }> }).sessions.set(sessA.sessionId, {
      sessionId: sessA.sessionId,
      options: { cwd, mcpServers: {}, permissionMode: 'default', resume: sdkSessionId },
      sdkSessionId,
    } as unknown as { sessionId: string; options: unknown; sdkSessionId?: string })

    const { emit: emitB } = makeRecordingEmitter()
    await driverB.prompt(
      sessA.sessionId,
      { sessionId: sessA.sessionId, prompt: [{ type: 'text', text: 'Continue.' }] },
      emitB,
    )

    // Deny semantics: the retry prefix tells the model NOT to re-issue
    // the deferred tool, so permission_resumed may or may not fire
    // (depends on whether the model retries). The user-facing
    // assertion is: file NOT created (deny effective), session
    // finished cleanly without throwing.
    expect(existsSync(tempFile)).toBe(false)

    cleanupFile(tempFile)
  }, 180_000)

  test('black-1: defer fires + container exits cleanly without resume (10-day pending shape)', async () => {
    const tempFile = join(tmpdir(), `kodizm-cov-b1-${Date.now()}.txt`)
    cleanupFile(tempFile)

    const { configHome, sanitized, cwd } = await makeIsolatedConfigHome()
    const store = new InMemoryDeferredStore()

    const adapter = await buildRealAdapter()
    const { server } = makeNeverAnswerServer()
    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-cov' },
      sdk: adapter,
      server,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    const { sessionId } = await driver.newSession({
      cwd,
      mcpServers: [],
      model: 'claude-sonnet-4-6',
      toolPolicy: { defaultMode: 'default' },
      permissionDeferTimeoutMs: 1500,
    })

    const { emit, events } = makeRecordingEmitter()
    const result = await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: `Use Write to create ${tempFile} with content "black-1".` }],
      },
      emit,
    )

    // 1. Defer fired.
    const deferredEvent = events.find((e) => e.type === 'permission_deferred')
    expect(deferredEvent).toBeDefined()

    // 2. Prompt returned cleanly (stopReason should be set to 'end_turn' or similar).
    expect(result.stopReason).toBeDefined()

    // 3. State persisted, no cachedAnswer yet.
    const persisted = await store.get(sessionId)
    expect(persisted).not.toBeNull()
    expect(persisted?.cachedAnswer).toBeUndefined()

    // 4. No resumed event (no resume happened).
    expect(events.some((e) => e.type === 'permission_resumed')).toBe(false)

    // 5. JSONL has marker.
    const sdkSessionId = (driver as unknown as { sessions: Map<string, { sdkSessionId?: string }> }).sessions.get(
      sessionId,
    )?.sdkSessionId
    const jsonlPath = join(configHome, 'projects', sanitized, `${sdkSessionId}.jsonl`)
    const transcript = readFileSync(jsonlPath, 'utf8')
    expect(transcript).toContain('__KODIZM_PERMISSION_DEFERRED__')

    // 6. File not created.
    expect(existsSync(tempFile)).toBe(false)

    cleanupFile(tempFile)
  }, 180_000)

  test('black-2: defer never fires when orchestrator answers within window (legacy 1.5 path intact)', async () => {
    const tempFile = join(tmpdir(), `kodizm-cov-b2-${Date.now()}.txt`)
    cleanupFile(tempFile)

    const { configHome, cwd } = await makeIsolatedConfigHome()
    const store = new InMemoryDeferredStore()

    const adapter = await buildRealAdapter()
    // Server answers immediately with allow.
    const { server, calls } = makeAlwaysAllowServer()
    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-cov' },
      sdk: adapter,
      server,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    const { sessionId } = await driver.newSession({
      cwd,
      mcpServers: [],
      model: 'claude-sonnet-4-6',
      toolPolicy: { defaultMode: 'default' },
      // Long defer threshold so the racer never wins; orchestrator
      // responds in well under this.
      permissionDeferTimeoutMs: 60_000,
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: `Use Write to create ${tempFile} with content "black-2 ok".` }],
      },
      emit,
    )

    // 1. permission_request fired (RPC roundtrip happened).
    expect(calls.filter((c) => c.method === 'session/request_permission').length).toBeGreaterThan(0)

    // 2. NO defer event (racer never won).
    expect(events.some((e) => e.type === 'permission_deferred')).toBe(false)

    // 3. Store empty.
    expect(await store.get(sessionId)).toBeNull()

    // 4. File created (permission allowed).
    expect(existsSync(tempFile)).toBe(true)

    cleanupFile(tempFile)
  }, 180_000)

  test('complex-1: signal abort during defer wait wins over the defer racer', async () => {
    const { configHome, cwd } = await makeIsolatedConfigHome()
    const store = new InMemoryDeferredStore()

    const adapter = await buildRealAdapter()
    const { server } = makeNeverAnswerServer()
    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-cov' },
      sdk: adapter,
      server,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    const { sessionId } = await driver.newSession({
      cwd,
      mcpServers: [],
      model: 'claude-sonnet-4-6',
      toolPolicy: { defaultMode: 'default' },
      // 10s defer threshold; we abort at 3s.
      permissionDeferTimeoutMs: 10_000,
    })

    const { emit, events } = makeRecordingEmitter()
    // Schedule cancel mid-prompt.
    setTimeout(() => {
      void driver.cancel({ sessionId })
    }, 3_000)

    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: 'Use Write to create /tmp/kodizm-cov-c1.txt with content "complex-1".' }],
      },
      emit,
    )

    // Cancel should win: cancelled event present, no defer event.
    const cancelled = events.find((e) => e.type === 'cancelled')
    expect(cancelled).toBeDefined()
    expect(events.some((e) => e.type === 'permission_deferred')).toBe(false)
    // No deferred state persisted.
    expect(await store.get(sessionId)).toBeNull()

    cleanupFile('/tmp/kodizm-cov-c1.txt')
  }, 60_000)
})

describe.skipIf(HAS_AUTH)('Pattern B coverage (skipped)', () => {
  test('skipped without auth env', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
