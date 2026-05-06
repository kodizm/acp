/**
 * Real Claude API in-process Pattern B (deferred-permission) smoke.
 *
 * Topology: two ClaudeDriver instances share a single
 * `InMemoryDeferredStore`. Driver A runs the first turn with
 * `permissionDeferTimeoutMs: 1000` and a fake orchestrator that NEVER
 * answers the `session/request_permission` RPC. The defer racer wins,
 * the driver writes the synthetic JSONL row, persists the deferred
 * record, emits `permission_deferred`, then unwinds the SDK turn.
 *
 * Between A and B, the test plays orchestrator and writes a cached
 * answer (`allow`) into the same store entry. Driver B then loadSession
 * + prompt. The driver's one-shot deferred-state check populates the
 * resume fields, the wrapped canUseTool short-circuits the matching
 * tool_use_id, the model retries, and the tool runs end-to-end.
 *
 * Black / white / complex cases:
 *   - white: defer fires, JSONL has marker, store has state.
 *   - white: resume populates cached answer, wrap fires, tool runs.
 *   - complex: synthetic JSONL row coexists with the SDK's natural
 *     transcript, no SDK index errors when resuming.
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
        // Never resolve: forces the defer racer to win.
        return new Promise<T>(() => {})
      },
    },
  }
}

const TEMP_FILE = join(tmpdir(), `kodizm-defer-real-${Date.now()}.txt`)

function cleanupTempFile(): void {
  if (existsSync(TEMP_FILE)) {
    unlinkSync(TEMP_FILE)
  }
}

describe.skipIf(!HAS_AUTH)('real Claude API Pattern B in-process smoke', () => {
  test('driver A defers, orchestrator caches answer, driver B resumes + tool runs', async () => {
    cleanupTempFile()

    // Isolate JSONL writes to a temp config home so the test never
    // touches the developer's real ~/.claude/projects.
    const configHome = await mkdtemp(join(tmpdir(), 'kodizm-defer-config-'))
    const cwd = process.cwd()
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    await mkdir(join(configHome, 'projects', sanitized), { recursive: true })

    const store = new InMemoryDeferredStore()

    // -------- Driver A: defer cycle --------
    const adapterA = await buildRealAdapter()
    const { server: serverA, calls: callsA } = makeNeverAnswerServer()
    const driverA = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapterA,
      server: serverA,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    const sessionA = await driverA.newSession({
      cwd,
      mcpServers: [],
      model: 'claude-sonnet-4-6',
      toolPolicy: { defaultMode: 'default' },
      permissionDeferTimeoutMs: 1500,
    })

    const { emit: emitA, events: eventsA } = makeRecordingEmitter()
    await driverA.prompt(
      sessionA.sessionId,
      {
        sessionId: sessionA.sessionId,
        prompt: [
          {
            type: 'text',
            text: `Use the Write tool to create the file at ${TEMP_FILE} with content "kodizm-defer-resume". Then confirm "done".`,
          },
        ],
      },
      emitA,
    )

    // 1. Permission RPC was attempted by Driver A.
    expect(callsA.some((c) => c.method === 'session/request_permission')).toBe(true)

    // 2. permission_deferred event surfaced (defer racer won).
    const deferredEvent = eventsA.find((e) => e.type === 'permission_deferred')
    expect(deferredEvent).toBeDefined()

    // 3. Store has the deferred record.
    const persistedAfterA = await store.get(sessionA.sessionId)
    expect(persistedAfterA).not.toBeNull()
    expect(persistedAfterA?.toolName).toBe('Write')

    // 4. JSONL has the synthetic deferred row.
    // The driver writes under `<configHome>/projects/<sanitized-cwd>/<sdkSessionId>.jsonl`.
    const sdkSessionId = (driverA as unknown as { sessions: Map<string, { sdkSessionId?: string }> }).sessions.get(
      sessionA.sessionId,
    )?.sdkSessionId
    expect(sdkSessionId).toBeDefined()
    const jsonlPath = join(configHome, 'projects', sanitized, `${sdkSessionId}.jsonl`)
    expect(existsSync(jsonlPath)).toBe(true)
    const transcript = readFileSync(jsonlPath, 'utf8')
    expect(transcript).toContain('__KODIZM_PERMISSION_DEFERRED__')
    expect(transcript).toContain((persistedAfterA?.toolUseId ?? '').slice(0, 10))

    // 5. File NOT created (permission never granted on Driver A).
    expect(existsSync(TEMP_FILE)).toBe(false)

    // -------- Orchestrator side: cache the user's answer --------
    // The store-set merges the cachedAnswer onto the existing record.
    const before = await store.get(sessionA.sessionId)
    if (before === null) {
      throw new Error('expected deferred record before resume')
    }
    await store.set(sessionA.sessionId, {
      ...before,
      cachedAnswer: { behavior: 'allow' },
    })

    // -------- Driver B: resume cycle --------
    const adapterB = await buildRealAdapter()
    // Driver B's server can answer normally; the cached answer should
    // short-circuit before this server is consulted.
    const callsB: CapturedRpc[] = []
    const serverB: AcpServerLike = {
      async request<T>(method: string, params: unknown): Promise<T> {
        callsB.push({ method, params })
        if (method === 'session/request_permission') {
          return { outcome: { outcome: 'selected', optionId: 'reject' } } as T
        }
        return {} as T
      },
    }

    const driverB = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapterB,
      server: serverB,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    // Reuse the same sessionId so the resume path triggers.
    // loadSession registers the session with the orchestrator id.
    // The driver's sdkSessionId is captured during loadSession's
    // first prompt; the resume key falls back to the orchestrator
    // id if the SDK has not yet produced one.
    // Pre-populate sdkSessionId so resume hits the same JSONL.
    await driverB.loadSession({ sessionId: sessionA.sessionId, cwd, mcpServers: [] })
    ;(driverB as unknown as { sessions: Map<string, { sdkSessionId?: string }> }).sessions.set(sessionA.sessionId, {
      sessionId: sessionA.sessionId,
      options: {
        cwd,
        mcpServers: {},
        permissionMode: 'default',
        resume: sdkSessionId,
      },
      sdkSessionId,
    } as unknown as { sessionId: string; options: unknown; sdkSessionId?: string })

    const { emit: emitB, events: eventsB } = makeRecordingEmitter()
    await driverB.prompt(
      sessionA.sessionId,
      {
        sessionId: sessionA.sessionId,
        prompt: [{ type: 'text', text: 'Continue where you left off.' }],
      },
      emitB,
    )

    // 6. permission_resumed event emitted on Driver B.
    const resumedEvent = eventsB.find((e) => e.type === 'permission_resumed')
    expect(resumedEvent).toBeDefined()
    if (resumedEvent?.type === 'permission_resumed') {
      expect(resumedEvent.decision).toBe('allow')
    }

    // 7. Cached answer was consumed (store cleared).
    const afterB = await store.get(sessionA.sessionId)
    expect(afterB).toBeNull()

    // 8. The wrapped canUseTool short-circuited; Driver B's server
    //    did NOT see another permission RPC for the same toolUseId.
    //    Note: the model may issue more tool calls; we only require
    //    it didn't redundantly ask for the cached one.
    expect(callsB.filter((c) => c.method === 'session/request_permission').length).toBeLessThanOrEqual(0)

    // 9. File created via the resumed Write call (the model retries
    //    with the same arguments per the injected prefix).
    expect(existsSync(TEMP_FILE)).toBe(true)

    cleanupTempFile()
  }, 180_000)
})

describe.skipIf(HAS_AUTH)('real Claude API Pattern B smoke (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
