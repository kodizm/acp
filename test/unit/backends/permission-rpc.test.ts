import { describe, expect, test } from 'bun:test'

import { DEFERRED_SENTINEL, awaitPermissionResponse } from '@/backends/permission-rpc.ts'
import { AcpTimeoutError } from '@/server/errors.ts'

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

describe('awaitPermissionResponse, deadline', () => {
  test('throws AcpTimeoutError when timeoutMs elapses before the RPC resolves', async () => {
    const server = makeFakeServer(
      () => new Promise(() => {}), // never resolves
    )

    await expect(awaitPermissionResponse(server, 'session/request_permission', {}, { timeoutMs: 50 })).rejects.toThrow(
      AcpTimeoutError,
    )
  })

  test('returns the RPC response when it resolves before the deadline', async () => {
    const server = makeFakeServer(async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }))

    const result = await awaitPermissionResponse(server, 'session/request_permission', {}, { timeoutMs: 1000 })

    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  })
})

describe('awaitPermissionResponse, signal cancellation', () => {
  test('rejects when the abort signal fires mid-await', async () => {
    const server = makeFakeServer(() => new Promise(() => {}))
    const controller = new AbortController()

    const promise = awaitPermissionResponse(server, 'session/request_permission', {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)

    await expect(promise).rejects.toThrow()
  })
})

describe('awaitPermissionResponse, deferTimeoutMs racer', () => {
  test('returns DEFERRED_SENTINEL when deferTimeoutMs fires before the RPC resolves', async () => {
    const server = makeFakeServer(() => new Promise(() => {})) // never resolves

    const result = await awaitPermissionResponse(server, 'session/request_permission', {}, { deferTimeoutMs: 30 })

    expect(result).toBe(DEFERRED_SENTINEL)
  })

  test('hard timeout fires before defer when timeoutMs is shorter', async () => {
    const server = makeFakeServer(() => new Promise(() => {}))

    await expect(
      awaitPermissionResponse(server, 'session/request_permission', {}, { timeoutMs: 20, deferTimeoutMs: 200 }),
    ).rejects.toThrow(AcpTimeoutError)
  })

  test('signal abort wins over both timers', async () => {
    const server = makeFakeServer(() => new Promise(() => {}))
    const controller = new AbortController()
    const promise = awaitPermissionResponse(
      server,
      'session/request_permission',
      {},
      { signal: controller.signal, timeoutMs: 200, deferTimeoutMs: 200 },
    )
    setTimeout(() => controller.abort(), 5)

    await expect(promise).rejects.toThrow(/aborted/)
  })

  test('returns the RPC response when it resolves before the defer timer', async () => {
    const server = makeFakeServer(async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }))

    const result = await awaitPermissionResponse(server, 'session/request_permission', {}, { deferTimeoutMs: 1000 })
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  })
})
