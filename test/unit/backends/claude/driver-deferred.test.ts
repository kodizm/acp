import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { CanUseToolOptions, PermissionResult } from '@/backends/claude/permission-bridge.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import { InMemoryDeferredStore } from '@/session/deferred-store.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

interface CapturedCall {
  method: string
  params: unknown
}

/**
 * SDK adapter that fires canUseTool with a known tool_use_id then
 * yields a result frame. The deferred path returns a deny PermissionResult,
 * so capturedResults reflects what the driver sent the SDK.
 */
function makeAdapterThatInvokesCanUseTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  sdkSessionId: string,
  capturedResults: PermissionResult[],
): SdkAdapter {
  return {
    async *query(args) {
      // 1. Mimic the SDK's first system init so the driver captures sdkSessionId.
      yield { type: 'system', subtype: 'init', session_id: sdkSessionId } satisfies SdkMessage
      // 2. Invoke canUseTool just like the real SDK would.
      const canUseTool = (args.options as { canUseTool?: unknown }).canUseTool as
        | ((t: string, i: Record<string, unknown>, o: CanUseToolOptions) => Promise<PermissionResult>)
        | undefined
      if (canUseTool !== undefined) {
        const result = await canUseTool(toolName, toolInput, {
          signal: new AbortController().signal,
          toolUseID: toolUseId,
        })
        capturedResults.push(result)
      }
      yield { type: 'result', subtype: 'success' } satisfies SdkMessage
    },
  }
}

const recorder = (): { emit: EventEmitter; events: SessionUpdateEvent[] } => {
  const events: SessionUpdateEvent[] = []
  return {
    events,
    emit: { send: (e: SessionUpdateEvent) => events.push(e) },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('ClaudeDriver Process A defer wiring', () => {
  test('defer threshold fires JSONL append + store.set + permission_deferred event', async () => {
    const captured: PermissionResult[] = []
    // Pre-create the JSONL parent dir + use a config home override so the
    // driver writes into the temp dir instead of the real ~/.claude.
    const configHome = await mkdtemp(join(tmpdir(), 'kodizm-claude-config-'))
    const cwd = '/tmp/kodizm-test-cwd'
    const sdkSessionId = 'sdk_sess_abc'
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = join(configHome, 'projects', sanitized)
    await mkdtemp(projectDir).catch(async () => {
      // mkdtemp adds a suffix, we want the exact dir; create it ourselves.
      const { mkdir } = await import('node:fs/promises')
      await mkdir(projectDir, { recursive: true })
    })

    // Server that never answers session/request_permission so the defer racer wins.
    const calls: CapturedCall[] = []
    const server = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        return new Promise(() => {}) as Promise<T>
      },
    }

    const store = new InMemoryDeferredStore()

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapterThatInvokesCanUseTool('Bash', { command: 'ls' }, 'tu_abc', sdkSessionId, captured),
      server,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    const { sessionId } = await driver.newSession({
      cwd,
      mcpServers: [],
      permissionDeferTimeoutMs: 30,
    })
    const { emit, events } = recorder()
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    // Settle defer side-effects: JSONL append + store.set both run on the
    // same async tick the racer resolves on.
    await sleep(20)

    // 1. PermissionResult sent back to the SDK is deny+interrupt.
    expect(captured[0]?.behavior).toBe('deny')
    if (captured[0]?.behavior === 'deny') {
      expect(captured[0].interrupt).toBe(true)
    }

    // 2. JSONL has the synthetic deferred row.
    const jsonlPath = join(configHome, 'projects', sanitized, `${sdkSessionId}.jsonl`)
    const written = await readFile(jsonlPath, 'utf8')
    expect(written).toContain('__KODIZM_PERMISSION_DEFERRED__')
    expect(written).toContain('tu_abc')

    // 3. Deferred store has the state record.
    const stored = await store.get(sessionId)
    expect(stored?.toolUseId).toBe('tu_abc')
    expect(stored?.toolName).toBe('Bash')
    expect(stored?.rawInput).toEqual({ command: 'ls' })

    // 4. permission_deferred event was emitted.
    const deferEvent = events.find((e) => e.type === 'permission_deferred')
    expect(deferEvent).toBeDefined()
    if (deferEvent?.type === 'permission_deferred') {
      expect(deferEvent.toolUseId).toBe('tu_abc')
      expect(deferEvent.name).toBe('Bash')
    }
  })

  test('no defer when permissionDeferTimeoutMs is undefined (legacy flow stays unchanged)', async () => {
    const captured: PermissionResult[] = []
    const calls: CapturedCall[] = []
    const server = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        if (method === 'session/request_permission') {
          return { outcome: { outcome: 'selected', optionId: 'allow' } } as T
        }
        return { outcome: { outcome: 'selected', optionId: 'reject' } } as T
      },
    }

    const store = new InMemoryDeferredStore()
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapterThatInvokesCanUseTool('Bash', {}, 'tu_xyz', 'sdk_sess_def', captured),
      server,
      deferredStore: store,
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = recorder()
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(captured[0]?.behavior).toBe('allow')
    expect(events.some((e) => e.type === 'permission_deferred')).toBe(false)
    expect(await store.get(sessionId)).toBeNull()
  })
})

describe('ClaudeDriver Process A defer: outbound RPC fallback (T7)', () => {
  test('falls back to session/permission_deferred_persist RPC when no deferredStore is in deps', async () => {
    const captured: PermissionResult[] = []
    const configHome = await mkdtemp(join(tmpdir(), 'kodizm-claude-config-'))
    const cwd = '/tmp/kodizm-test-cwd-rpc-fallback'
    const sdkSessionId = 'sdk_sess_rpc'
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(configHome, 'projects', sanitized), { recursive: true })

    // Server: never answers session/request_permission, captures persist RPC.
    const calls: CapturedCall[] = []
    const server = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        if (method === 'session/permission_deferred_persist') {
          return { ok: true } as T
        }
        return new Promise(() => {}) as Promise<T>
      },
    }

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapterThatInvokesCanUseTool('Bash', { command: 'ls' }, 'tu_rpc', sdkSessionId, captured),
      server,
      claudeConfigHome: configHome,
      // NOTE: no deferredStore in deps -> driver must use RPC fallback.
    })

    const { sessionId } = await driver.newSession({
      cwd,
      mcpServers: [],
      permissionDeferTimeoutMs: 30,
    })
    const { emit, events } = recorder()
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    await sleep(20)

    // 1. PermissionResult is deny+interrupt.
    expect(captured[0]?.behavior).toBe('deny')

    // 2. RPC fallback fired with the right shape.
    const persistCall = calls.find((c) => c.method === 'session/permission_deferred_persist')
    expect(persistCall).toBeDefined()
    if (persistCall !== undefined) {
      const params = persistCall.params as {
        sessionId: string
        toolUseId: string
        toolName: string
        rawInput: Record<string, unknown>
      }
      expect(params.sessionId).toBe(sessionId)
      expect(params.toolUseId).toBe('tu_rpc')
      expect(params.toolName).toBe('Bash')
      expect(params.rawInput).toEqual({ command: 'ls' })
    }

    // 3. permission_deferred event still emitted.
    expect(events.some((e) => e.type === 'permission_deferred')).toBe(true)
  })

  test('local store takes precedence when both store + RPC are available', async () => {
    const captured: PermissionResult[] = []
    const configHome = await mkdtemp(join(tmpdir(), 'kodizm-claude-config-'))
    const cwd = '/tmp/kodizm-test-cwd-store-precedence'
    const sdkSessionId = 'sdk_sess_pref'
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(configHome, 'projects', sanitized), { recursive: true })

    const calls: CapturedCall[] = []
    const server = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        return new Promise(() => {}) as Promise<T>
      },
    }

    const store = new InMemoryDeferredStore()
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapterThatInvokesCanUseTool('Bash', {}, 'tu_pref', sdkSessionId, captured),
      server,
      deferredStore: store,
      claudeConfigHome: configHome,
    })

    const { sessionId } = await driver.newSession({
      cwd,
      mcpServers: [],
      permissionDeferTimeoutMs: 30,
    })
    const { emit } = recorder()
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    await sleep(20)

    // Local store has the record.
    expect(await store.get(sessionId)).not.toBeNull()
    // RPC fallback NOT fired.
    expect(calls.some((c) => c.method === 'session/permission_deferred_persist')).toBe(false)
  })
})
