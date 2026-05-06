import { describe, expect, test } from 'bun:test'

import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import { handleCodexApproval } from '@/backends/codex/permission-bridge.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const collector = (): { events: SessionUpdateEvent[]; emit: { send: (e: SessionUpdateEvent) => void } } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

function makeServer(decision: 'allow' | 'allow_always' | 'reject'): AcpServerLike {
  return {
    async request<T>(method: string, _params: unknown): Promise<T> {
      if (method === 'session/request_permission') {
        return { outcome: { outcome: 'selected', optionId: decision } } as T
      }
      return {} as T
    },
  }
}

describe('handleCodexApproval (Phase 2 T10)', () => {
  test('exec approval allow -> codex Accept decision', async () => {
    const { emit, events } = collector()
    const result = await handleCodexApproval({
      method: 'item/commandExecution/requestApproval',
      params: { thread_id: 't1', turn_id: 'tu1', item_id: 'item_1', command: 'pwd' },
      server: makeServer('allow'),
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ decision: 'Accept' })
    expect(events.some((e) => e.type === 'permission_request' && e.name === 'codex_exec')).toBe(true)
  })

  test('exec approval allow_always -> codex AcceptForSession decision', async () => {
    const { emit } = collector()
    const result = await handleCodexApproval({
      method: 'item/commandExecution/requestApproval',
      params: { thread_id: 't1', turn_id: 'tu1', item_id: 'item_2' },
      server: makeServer('allow_always'),
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ decision: 'AcceptForSession' })
  })

  test('exec approval reject -> codex Decline decision', async () => {
    const { emit } = collector()
    const result = await handleCodexApproval({
      method: 'item/commandExecution/requestApproval',
      params: { thread_id: 't1', turn_id: 'tu1', item_id: 'item_3' },
      server: makeServer('reject'),
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ decision: 'Decline' })
  })

  test('fileChange approval allow -> codex Accept', async () => {
    const { emit, events } = collector()
    const result = await handleCodexApproval({
      method: 'item/fileChange/requestApproval',
      params: { thread_id: 't1', turn_id: 'tu1', item_id: 'fc_1', reason: 'edit /x.ts' },
      server: makeServer('allow'),
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ decision: 'Accept' })
    expect(events.some((e) => e.type === 'permission_request' && e.name === 'codex_apply_patch')).toBe(true)
  })

  test('fileChange approval allow_always -> codex AcceptForSession', async () => {
    const { emit } = collector()
    const result = await handleCodexApproval({
      method: 'item/fileChange/requestApproval',
      params: { thread_id: 't1', turn_id: 'tu1', item_id: 'fc_2' },
      server: makeServer('allow_always'),
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ decision: 'AcceptForSession' })
  })

  test('fileChange approval reject -> codex Decline', async () => {
    const { emit } = collector()
    const result = await handleCodexApproval({
      method: 'item/fileChange/requestApproval',
      params: { thread_id: 't1', turn_id: 'tu1', item_id: 'fc_3' },
      server: makeServer('reject'),
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ decision: 'Decline' })
  })

  test('permissions approval allow -> codex Turn scope', async () => {
    const { emit, events } = collector()
    const result = await handleCodexApproval({
      method: 'item/permissions/requestApproval',
      params: { thread_id: 't1', turn_id: 'tu1', item_id: 'p_1', cwd: '/x', permissions: { type: 'managed' } },
      server: makeServer('allow'),
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ permissions: { type: 'managed' }, scope: 'Turn' })
    expect(events.some((e) => e.type === 'permission_request' && e.name === 'codex_permission_grant')).toBe(true)
  })

  test('permissions approval allow_always -> codex Session scope', async () => {
    const { emit } = collector()
    const result = await handleCodexApproval({
      method: 'item/permissions/requestApproval',
      params: { thread_id: 't1', turn_id: 'tu1', item_id: 'p_2', permissions: { type: 'managed' } },
      server: makeServer('allow_always'),
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ permissions: { type: 'managed' }, scope: 'Session' })
  })

  test('permissions approval reject -> Disabled permission profile (default deny shape)', async () => {
    const { emit } = collector()
    const result = await handleCodexApproval({
      method: 'item/permissions/requestApproval',
      params: { thread_id: 't1', turn_id: 'tu1', item_id: 'p_3', permissions: { type: 'managed' } },
      server: makeServer('reject'),
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ permissions: { type: 'disabled' }, scope: 'Turn' })
  })
})
