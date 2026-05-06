import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { CanUseToolOptions, PermissionResult } from '@/backends/claude/permission-bridge.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import { type DeferredState, InMemoryDeferredStore } from '@/session/deferred-store.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

interface CapturedCall {
  method: string
  params: unknown
}

/**
 * Adapter that records the canUseTool result + the prompt string the
 * SDK was given. Used to verify Process B's prompt-injection + cached
 * answer wiring.
 */
function makeRecordingAdapter(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  sdkSessionId: string,
  state: { capturedResults: PermissionResult[]; capturedPrompt: string | null },
): SdkAdapter {
  return {
    async *query(args) {
      state.capturedPrompt = args.prompt
      yield { type: 'system', subtype: 'init', session_id: sdkSessionId } satisfies SdkMessage
      const canUseTool = (args.options as { canUseTool?: unknown }).canUseTool as
        | ((t: string, i: Record<string, unknown>, o: CanUseToolOptions) => Promise<PermissionResult>)
        | undefined
      if (canUseTool !== undefined) {
        const result = await canUseTool(toolName, toolInput, {
          signal: new AbortController().signal,
          toolUseID: toolUseId,
        })
        state.capturedResults.push(result)
      }
      yield { type: 'result', subtype: 'success' } satisfies SdkMessage
    },
  }
}

const recorder = (): { emit: EventEmitter; events: SessionUpdateEvent[] } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e: SessionUpdateEvent) => events.push(e) } }
}

const cachedDeferredState = (): DeferredState => ({
  toolUseId: 'tu_def_1',
  toolName: 'Bash',
  rawInput: { command: 'pwd' },
  deferredAt: 1_700_000_000_000,
  cachedAnswer: { behavior: 'allow', updatedInput: { command: 'pwd' } },
})

describe('ClaudeDriver Process B auto-detect on first prompt (T8)', () => {
  test('checks deferredStore.get(sessionId) on first prompt and consumes the cached answer (T8+T9)', async () => {
    const harness = { capturedResults: [] as PermissionResult[], capturedPrompt: null as string | null }
    const store = new InMemoryDeferredStore()
    await store.set('sess_under_test', cachedDeferredState())

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeRecordingAdapter('Bash', { command: 'pwd' }, 'tu_def_1', 'sdk_resume_1', harness),
      server: undefined,
      deferredStore: store,
    })

    // loadSession with the orchestrator-supplied id. Deferred-state
    // detection must NOT depend on a permissionDeferTimeoutMs; the resume
    // container does not need to opt in for the second time.
    await driver.loadSession({ sessionId: 'sess_under_test', cwd: '/tmp/kodizm-test', mcpServers: [] })

    const { emit } = recorder()
    await driver.prompt('sess_under_test', { sessionId: 'sess_under_test', prompt: [] }, emit)

    // canUseTool returned the cached answer (T9 short-circuit).
    expect(harness.capturedResults[0]).toEqual({ behavior: 'allow', updatedInput: { command: 'pwd' } })
    // Store cleared after consumption (one-shot semantics).
    const after = await store.get('sess_under_test')
    expect(after).toBeNull()
  })

  test('no-op when the store has no record for the sessionId', async () => {
    const harness = { capturedResults: [] as PermissionResult[], capturedPrompt: null as string | null }
    const calls: CapturedCall[] = []
    const server = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        if (method === 'session/request_permission') {
          return { outcome: { outcome: 'selected', optionId: 'allow' } } as T
        }
        return { state: null } as T
      },
    }
    const store = new InMemoryDeferredStore()

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeRecordingAdapter('Bash', {}, 'tu_x', 'sdk_x', harness),
      server,
      deferredStore: store,
    })

    await driver.loadSession({ sessionId: 'sess_empty', cwd: '/tmp/kodizm-test', mcpServers: [] })
    const { emit, events } = recorder()
    await driver.prompt('sess_empty', { sessionId: 'sess_empty', prompt: [] }, emit)

    // No permission_resumed event should fire when there was nothing to resume.
    expect(events.some((e) => e.type === 'permission_resumed')).toBe(false)
  })

  test('falls back to session/permission_deferred_state RPC when no deferredStore is in deps', async () => {
    const harness = { capturedResults: [] as PermissionResult[], capturedPrompt: null as string | null }
    const calls: CapturedCall[] = []
    const server = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        if (method === 'session/permission_deferred_state') {
          return { state: cachedDeferredState() } as T
        }
        return { outcome: { outcome: 'selected', optionId: 'allow' } } as T
      },
    }

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeRecordingAdapter('Bash', { command: 'pwd' }, 'tu_def_1', 'sdk_resume_2', harness),
      server,
      // NOTE: no deferredStore -> driver must call the RPC.
    })

    await driver.loadSession({ sessionId: 'sess_rpc', cwd: '/tmp/kodizm-test', mcpServers: [] })
    const { emit } = recorder()
    await driver.prompt('sess_rpc', { sessionId: 'sess_rpc', prompt: [] }, emit)

    expect(calls.some((c) => c.method === 'session/permission_deferred_state')).toBe(true)
  })

  test('only checks once per session (second prompt does NOT re-check)', async () => {
    const harness = { capturedResults: [] as PermissionResult[], capturedPrompt: null as string | null }
    const calls: CapturedCall[] = []
    const server = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        if (method === 'session/permission_deferred_state') {
          return { state: null } as T
        }
        return { outcome: { outcome: 'selected', optionId: 'allow' } } as T
      },
    }

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeRecordingAdapter('Bash', {}, 'tu_x', 'sdk_x', harness),
      server,
    })

    await driver.loadSession({ sessionId: 'sess_oneshot', cwd: '/tmp/kodizm-test', mcpServers: [] })
    const { emit } = recorder()
    await driver.prompt('sess_oneshot', { sessionId: 'sess_oneshot', prompt: [] }, emit)
    await driver.prompt('sess_oneshot', { sessionId: 'sess_oneshot', prompt: [] }, emit)

    const stateChecks = calls.filter((c) => c.method === 'session/permission_deferred_state')
    expect(stateChecks.length).toBe(1)
  })
})

describe('ClaudeDriver Process B canUseTool wrap + retry prompt injection (T9)', () => {
  test('cached answer fires for matching toolUseId; emits permission_resumed; clears state', async () => {
    const harness = { capturedResults: [] as PermissionResult[], capturedPrompt: null as string | null }
    const store = new InMemoryDeferredStore()
    await store.set('sess_match', cachedDeferredState())

    const calls: CapturedCall[] = []
    const server = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        return { outcome: { outcome: 'selected', optionId: 'allow' } } as T
      },
    }

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeRecordingAdapter('Bash', { command: 'pwd' }, 'tu_def_1', 'sdk_resume', harness),
      server,
      deferredStore: store,
    })

    await driver.loadSession({ sessionId: 'sess_match', cwd: '/tmp/kodizm-test', mcpServers: [] })
    const { emit, events } = recorder()
    await driver.prompt('sess_match', { sessionId: 'sess_match', prompt: [{ type: 'text', text: 'continue' }] }, emit)

    // 1. canUseTool returned the cached answer (no roundtrip to server).
    expect(harness.capturedResults[0]).toEqual({ behavior: 'allow', updatedInput: { command: 'pwd' } })
    expect(calls.some((c) => c.method === 'session/request_permission')).toBe(false)

    // 2. permission_resumed event emitted with the matching toolUseId + decision.
    const resumed = events.find((e) => e.type === 'permission_resumed')
    expect(resumed).toBeDefined()
    if (resumed?.type === 'permission_resumed') {
      expect(resumed.toolUseId).toBe('tu_def_1')
      expect(resumed.decision).toBe('allow')
    }

    // 3. Cached answer cleared after consumption (one-shot).
    const after = await store.get('sess_match')
    expect(after).toBeNull()
  })

  test('different toolUseId falls through to normal canUseTool (cached answer not consumed)', async () => {
    const harness = { capturedResults: [] as PermissionResult[], capturedPrompt: null as string | null }
    const store = new InMemoryDeferredStore()
    await store.set('sess_mismatch', cachedDeferredState())

    const calls: CapturedCall[] = []
    const server = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        return { outcome: { outcome: 'selected', optionId: 'allow' } } as T
      },
    }

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      // Different toolUseId than the cached one (tu_def_1 in fixture).
      sdk: makeRecordingAdapter('Bash', { command: 'ls' }, 'tu_other', 'sdk_resume_2', harness),
      server,
      deferredStore: store,
    })

    await driver.loadSession({ sessionId: 'sess_mismatch', cwd: '/tmp/kodizm-test', mcpServers: [] })
    const { emit, events } = recorder()
    await driver.prompt('sess_mismatch', { sessionId: 'sess_mismatch', prompt: [] }, emit)

    // Normal canUseTool flow ran (server saw the permission request).
    expect(calls.some((c) => c.method === 'session/request_permission')).toBe(true)
    // No permission_resumed event since we never matched.
    expect(events.some((e) => e.type === 'permission_resumed')).toBe(false)
  })

  test('retry prefix injected into the user prompt on the first prompt after resume', async () => {
    const harness = { capturedResults: [] as PermissionResult[], capturedPrompt: null as string | null }
    const store = new InMemoryDeferredStore()
    await store.set('sess_inject', cachedDeferredState())

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeRecordingAdapter('Bash', { command: 'pwd' }, 'tu_def_1', 'sdk_inject', harness),
      server: undefined,
      deferredStore: store,
    })

    await driver.loadSession({ sessionId: 'sess_inject', cwd: '/tmp/kodizm-test', mcpServers: [] })
    const { emit } = recorder()
    await driver.prompt(
      'sess_inject',
      { sessionId: 'sess_inject', prompt: [{ type: 'text', text: 'list files please' }] },
      emit,
    )

    expect(harness.capturedPrompt).toContain('User has answered the deferred permission')
    expect(harness.capturedPrompt).toContain('allow')
    expect(harness.capturedPrompt).toContain('tu_def_1')
    expect(harness.capturedPrompt).toContain('list files please')
  })

  test('second prompt after resume does NOT re-inject the retry prefix', async () => {
    const harness1 = { capturedResults: [] as PermissionResult[], capturedPrompt: null as string | null }
    const harness2 = { capturedResults: [] as PermissionResult[], capturedPrompt: null as string | null }
    const store = new InMemoryDeferredStore()
    await store.set('sess_second', cachedDeferredState())

    // Adapter that switches between harness records on each query call.
    let callIdx = 0
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: {
        async *query(args) {
          const target = callIdx++ === 0 ? harness1 : harness2
          target.capturedPrompt = args.prompt
          yield { type: 'system', subtype: 'init', session_id: 'sdk_second' } satisfies SdkMessage
          const canUseTool = (args.options as { canUseTool?: unknown }).canUseTool as
            | ((t: string, i: Record<string, unknown>, o: CanUseToolOptions) => Promise<PermissionResult>)
            | undefined
          if (canUseTool !== undefined) {
            const result = await canUseTool(
              'Bash',
              { command: 'pwd' },
              { signal: new AbortController().signal, toolUseID: callIdx === 1 ? 'tu_def_1' : 'tu_other' },
            )
            target.capturedResults.push(result)
          }
          yield { type: 'result', subtype: 'success' } satisfies SdkMessage
        },
      },
      server: undefined,
      deferredStore: store,
    })

    await driver.loadSession({ sessionId: 'sess_second', cwd: '/tmp/kodizm-test', mcpServers: [] })
    const { emit } = recorder()
    await driver.prompt('sess_second', { sessionId: 'sess_second', prompt: [{ type: 'text', text: 'first' }] }, emit)
    await driver.prompt('sess_second', { sessionId: 'sess_second', prompt: [{ type: 'text', text: 'second' }] }, emit)

    expect(harness1.capturedPrompt).toContain('User has answered the deferred permission')
    expect(harness2.capturedPrompt).not.toContain('User has answered the deferred permission')
    expect(harness2.capturedPrompt).toContain('second')
  })
})
