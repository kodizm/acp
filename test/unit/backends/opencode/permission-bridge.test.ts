import { describe, expect, mock, test } from 'bun:test'

import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import { type OpencodePermissionRequest, handleOpencodePermission } from '@/backends/opencode/permission-bridge.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

function recorder(): { events: SessionUpdateEvent[]; emit: { send: (e: SessionUpdateEvent) => void } } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

function fakeSdk(): { permission: { reply: ReturnType<typeof mock> } } {
  return {
    permission: {
      reply: mock(async () => ({})),
    },
  }
}

function fakeServer(outcome: {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
}): AcpServerLike {
  return { request: mock(async () => outcome) } as unknown as AcpServerLike
}

const baseParams: OpencodePermissionRequest = {
  id: 'perm-1',
  sessionID: 'opencode-1',
  permission: 'bash',
  patterns: ['*'],
  always: ['bash'],
  metadata: {},
}

describe('handleOpencodePermission', () => {
  test('orchestrator selects allow -> sdk.permission.reply with reply=once', async () => {
    const { emit, events } = recorder()
    const server = fakeServer({ outcome: { outcome: 'selected', optionId: 'allow' } })
    const sdk = fakeSdk()

    await handleOpencodePermission({
      params: baseParams,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as { permission: { reply: (...a: unknown[]) => unknown } },
      emit,
      signal: new AbortController().signal,
      mcpReverseMap: new Map(),
    })

    expect(events.find((e) => e.type === 'permission_request')).toBeDefined()
    expect(sdk.permission.reply).toHaveBeenCalled()
    const call = (sdk.permission.reply.mock.calls[0] ?? []) as unknown[]
    const payload = call[0] as { requestID: string; reply: string }
    expect(payload.requestID).toBe('perm-1')
    expect(payload.reply).toBe('once')
  })

  test('orchestrator selects allow_always -> reply=always', async () => {
    const { emit } = recorder()
    const server = fakeServer({ outcome: { outcome: 'selected', optionId: 'allow_always' } })
    const sdk = fakeSdk()

    await handleOpencodePermission({
      params: baseParams,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as { permission: { reply: (...a: unknown[]) => unknown } },
      emit,
      signal: new AbortController().signal,
      mcpReverseMap: new Map(),
    })

    const call = (sdk.permission.reply.mock.calls[0] ?? []) as unknown[]
    expect((call[0] as { reply: string }).reply).toBe('always')
  })

  test('orchestrator selects reject -> reply=reject + feedback message from _meta', async () => {
    const { emit } = recorder()
    const server: AcpServerLike = {
      request: mock(async () => ({
        outcome: { outcome: 'selected', optionId: 'reject' },
        _meta: { feedback: 'too dangerous' },
      })),
    } as unknown as AcpServerLike
    const sdk = fakeSdk()

    await handleOpencodePermission({
      params: baseParams,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as { permission: { reply: (...a: unknown[]) => unknown } },
      emit,
      signal: new AbortController().signal,
      mcpReverseMap: new Map(),
    })

    const call = (sdk.permission.reply.mock.calls[0] ?? []) as unknown[]
    const payload = call[0] as { reply: string; message?: string }
    expect(payload.reply).toBe('reject')
    expect(payload.message).toBe('too dangerous')
  })

  test('defer threshold fires onDefer hook + does NOT call sdk.permission.reply', async () => {
    const { emit } = recorder()
    const server: AcpServerLike = {
      // Hangs the orchestrator forever; defer wins the race.
      request: mock(async () => new Promise(() => undefined)),
    } as unknown as AcpServerLike
    const sdk = fakeSdk()
    const onDefer = mock(async () => undefined)

    await handleOpencodePermission({
      params: baseParams,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as { permission: { reply: (...a: unknown[]) => unknown } },
      emit,
      signal: new AbortController().signal,
      mcpReverseMap: new Map(),
      deferTimeoutMs: 50,
      onDefer,
    })

    expect(onDefer).toHaveBeenCalled()
    expect(sdk.permission.reply).not.toHaveBeenCalled()
  })

  test('signal abort -> reply not called, no event for selection', async () => {
    const { emit } = recorder()
    const server: AcpServerLike = {
      request: mock(async () => new Promise(() => undefined)),
    } as unknown as AcpServerLike
    const sdk = fakeSdk()

    const controller = new AbortController()
    const promise = handleOpencodePermission({
      params: baseParams,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as { permission: { reply: (...a: unknown[]) => unknown } },
      emit,
      signal: controller.signal,
      mcpReverseMap: new Map(),
    })
    controller.abort()
    await promise

    expect(sdk.permission.reply).not.toHaveBeenCalled()
  })

  test('mcp permission key reverse-maps to canonical mcp__server__tool name', async () => {
    const { events, emit } = recorder()
    const server = fakeServer({ outcome: { outcome: 'selected', optionId: 'allow' } })
    const sdk = fakeSdk()

    await handleOpencodePermission({
      params: { ...baseParams, permission: 'kodizm_search-docs' },
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as { permission: { reply: (...a: unknown[]) => unknown } },
      emit,
      signal: new AbortController().signal,
      mcpReverseMap: new Map([['kodizm', 'kodizm']]),
    })

    const evt = events.find((e) => e.type === 'permission_request')
    expect(evt?.name).toBe('mcp__kodizm__search-docs')
  })
})
