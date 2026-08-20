import { describe, expect, test } from 'bun:test'

import { runShutdown } from '@/server/shutdown.ts'

describe('runShutdown', () => {
  test('flushes recorders + transport, then resolves', async () => {
    const callOrder: string[] = []
    const result = await runShutdown({
      graceMs: 1_000,
      flushRecorders: async () => {
        callOrder.push('recorders')
      },
      flushTransport: async () => {
        callOrder.push('transport')
      },
    })

    expect(callOrder).toEqual(['recorders', 'transport'])
    expect(result.timedOut).toBe(false)
  })

  test('disposes the backend driver after the flushers', async () => {
    // Load bearing for opencode: it boots one `opencode serve`
    // subprocess per session and those children do not die with the
    // bin. Before this step existed they accumulated until the
    // container's cgroup was full.
    const callOrder: string[] = []
    await runShutdown({
      graceMs: 1_000,
      flushRecorders: async () => {
        callOrder.push('recorders')
      },
      flushTransport: async () => {
        callOrder.push('transport')
      },
      disposeDriver: async () => {
        callOrder.push('driver')
      },
    })

    expect(callOrder).toEqual(['recorders', 'transport', 'driver'])
  })

  test('a driver disposal failure does not abort the shutdown', async () => {
    const result = await runShutdown({
      graceMs: 1_000,
      flushRecorders: async () => undefined,
      flushTransport: async () => undefined,
      disposeDriver: async () => {
        throw new Error('subprocess already gone')
      },
    })

    expect(result.timedOut).toBe(false)
  })

  test('returns timedOut=true when flushers exceed graceMs', async () => {
    const result = await runShutdown({
      graceMs: 30,
      flushRecorders: () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
      flushTransport: async () => undefined,
    })

    expect(result.timedOut).toBe(true)
  })

  test('emits final session_failed event when an emitter + last error are supplied', async () => {
    const events: Array<{ type: string }> = []
    const result = await runShutdown({
      graceMs: 1_000,
      flushRecorders: async () => undefined,
      flushTransport: async () => undefined,
      emitFinal: (event) => events.push(event),
      finalReason: 'transport_error',
      finalDetail: 'SIGTERM received',
      finalSessionIds: ['s1', 's2'],
    })

    expect(events.length).toBe(2)
    expect(events[0]).toMatchObject({ type: 'session_failed' })
    expect(result.timedOut).toBe(false)
  })

  test('survives flusher throws (logs but does NOT propagate)', async () => {
    const result = await runShutdown({
      graceMs: 1_000,
      flushRecorders: async () => {
        throw new Error('recorder fail')
      },
      flushTransport: async () => {
        throw new Error('transport fail')
      },
    })

    expect(result.timedOut).toBe(false)
    expect(result.errors.length).toBe(2)
  })
})
