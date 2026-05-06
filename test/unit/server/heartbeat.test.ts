import { describe, expect, test } from 'bun:test'

import { HeartbeatTimer } from '@/server/heartbeat.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const recorder = (): { events: SessionUpdateEvent[]; emit: { send: (e: SessionUpdateEvent) => void } } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('HeartbeatTimer', () => {
  test('emits heartbeat events at the configured cadence', async () => {
    const { emit, events } = recorder()
    const lastSdkAt = Date.now()
    const timer = new HeartbeatTimer({
      sessionId: 's1',
      intervalMs: 30,
      emit,
      getLastSdkMs: () => lastSdkAt,
    })

    timer.start(Date.now())
    await sleep(110)
    timer.stop()

    // Expect 3 ticks within 110ms at 30ms cadence.
    const heartbeats = events.filter((e) => e.type === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThanOrEqual(2)
    expect(heartbeats.length).toBeLessThanOrEqual(4)
    if (heartbeats[0]?.type === 'heartbeat') {
      expect(heartbeats[0].sessionId).toBe('s1')
      expect(heartbeats[0].uptimeMs).toBeGreaterThanOrEqual(0)
      expect(heartbeats[0].lastSdkMs).toBeGreaterThanOrEqual(0)
    }
    void lastSdkAt
  })

  test('stop() halts further emissions', async () => {
    const { emit, events } = recorder()
    const timer = new HeartbeatTimer({
      sessionId: 's1',
      intervalMs: 20,
      emit,
      getLastSdkMs: () => Date.now(),
    })

    timer.start(Date.now())
    await sleep(50)
    timer.stop()
    const countAfterStop = events.filter((e) => e.type === 'heartbeat').length

    await sleep(50)
    expect(events.filter((e) => e.type === 'heartbeat').length).toBe(countAfterStop)
  })

  test('stop() is idempotent', () => {
    const { emit } = recorder()
    const timer = new HeartbeatTimer({
      sessionId: 's1',
      intervalMs: 100,
      emit,
      getLastSdkMs: () => Date.now(),
    })

    timer.start(Date.now())
    timer.stop()
    expect(() => timer.stop()).not.toThrow()
  })

  test('lastSdkMs reflects the elapsed time since the last SDK message', async () => {
    const { emit, events } = recorder()
    const sdkAt = Date.now() - 500 // simulate 500ms gap
    const timer = new HeartbeatTimer({
      sessionId: 's1',
      intervalMs: 30,
      emit,
      getLastSdkMs: () => sdkAt,
    })

    timer.start(Date.now())
    await sleep(45)
    timer.stop()

    const beat = events.find((e) => e.type === 'heartbeat')
    if (beat?.type === 'heartbeat') {
      expect(beat.lastSdkMs).toBeGreaterThanOrEqual(500)
    }
  })
})
