import { describe, expect, test } from 'bun:test'

import { buildCanUseTool } from '@/backends/claude/permission-bridge.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

interface FakeServer {
  request<T>(method: string, params: unknown): Promise<T>
  lastCall?: { method: string; params: unknown }
}

function makeFakeServer(handler: (method: string, params: unknown) => Promise<unknown>): FakeServer {
  const server: FakeServer = {
    async request<T>(method: string, params: unknown): Promise<T> {
      server.lastCall = { method, params }
      return (await handler(method, params)) as T
    },
  }
  return server
}

function recorder(): { emit: { send: (e: SessionUpdateEvent) => void }; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

describe('buildCanUseTool, allow path', () => {
  test('selected.allow returns { behavior: allow, updatedInput: input }', async () => {
    const server = makeFakeServer(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow' },
    }))
    const { emit, events } = recorder()
    const canUseTool = buildCanUseTool({
      server,
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })

    const result = await canUseTool(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tu_1',
      },
    )
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })

    expect(events.some((e) => e.type === 'permission_request')).toBe(true)
  })
})

describe('buildCanUseTool, allow_always path', () => {
  test('returns updatedPermissions with session destination', async () => {
    const server = makeFakeServer(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    }))
    const { emit } = recorder()
    const canUseTool = buildCanUseTool({
      server,
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })

    const result = await canUseTool(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tu_1',
      },
    )

    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') {
      expect(result.updatedPermissions?.[0]?.destination).toBe('session')
    }
  })
})

describe('buildCanUseTool, deny path', () => {
  test('selected.reject returns { behavior: deny, message }', async () => {
    const server = makeFakeServer(async () => ({
      outcome: { outcome: 'selected', optionId: 'reject' },
    }))
    const { emit } = recorder()
    const canUseTool = buildCanUseTool({
      server,
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })

    const result = await canUseTool(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tu_1',
      },
    )

    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('refused')
    }
  })
})

describe('buildCanUseTool, cancelled outcome', () => {
  test('throws Tool use aborted', async () => {
    const server = makeFakeServer(async () => ({ outcome: { outcome: 'cancelled' } }))
    const { emit } = recorder()
    const canUseTool = buildCanUseTool({
      server,
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })

    await expect(
      canUseTool(
        'Bash',
        {},
        {
          signal: new AbortController().signal,
          toolUseID: 'tu_1',
        },
      ),
    ).rejects.toThrow(/aborted/)
  })
})

describe('buildCanUseTool, agentId tagging', () => {
  test('passes agentId from canUseTool args into the RPC payload + event', async () => {
    const server = makeFakeServer(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow' },
    }))
    const { emit, events } = recorder()
    const canUseTool = buildCanUseTool({
      server,
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })

    await canUseTool(
      'Bash',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'tu_1',
        agentID: 'sub_outer',
      },
    )

    expect((server.lastCall?.params as { agentId?: string })?.agentId).toBe('sub_outer')
    const event = events.find((e) => e.type === 'permission_request')
    if (event?.type === 'permission_request') {
      expect(event.agentId).toBe('sub_outer')
    }
  })
})

describe('buildCanUseTool, timeout falls back to deny', () => {
  test('AcpTimeoutError caught + mapped to { behavior: deny, message }', async () => {
    const server = makeFakeServer(() => new Promise(() => {})) // never resolves
    const { emit } = recorder()
    const canUseTool = buildCanUseTool({
      server,
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
      permissionTimeoutMs: 30,
    })

    const result = await canUseTool(
      'Bash',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'tu_1',
      },
    )

    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('timed out')
    }
  })
})
