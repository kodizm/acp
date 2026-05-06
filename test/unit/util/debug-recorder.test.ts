import { describe, expect, test } from 'bun:test'

import { DebugRecorder } from '@/util/debug-recorder.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const recorder = (): { events: SessionUpdateEvent[]; emit: { send: (e: SessionUpdateEvent) => void } } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

describe('DebugRecorder, debug=true', () => {
  test('emits a debug_log event on record() with full envelope', () => {
    const { emit, events } = recorder()
    const rec = new DebugRecorder({ sessionId: 's1', emit, debug: true })
    rec.record('sdk.message', { type: 'assistant', text: 'hi' })

    expect(events.length).toBe(1)
    const event = events[0]
    if (event?.type !== 'debug_log') {
      throw new Error(`expected debug_log event, got ${event?.type}`)
    }
    expect(event.sessionId).toBe('s1')
    expect(event.stage).toBe('sdk.message')
    expect(event.level).toBe('debug')
    expect(event.payload).toEqual({ type: 'assistant', text: 'hi' })
    expect(event.capturedAt).toBeGreaterThan(0)
  })

  test('redacts secret-shaped strings in payload by default', () => {
    const { emit, events } = recorder()
    const rec = new DebugRecorder({ sessionId: 's1', emit, debug: true })
    rec.record('rpc.in', {
      headers: { Authorization: 'Bearer sk-ant-oat01-leaked_token_value_long_enough_to_match' },
    })

    const event = events[0]
    if (event?.type !== 'debug_log') {
      throw new Error('expected debug_log')
    }
    const payload = event.payload as { headers: { Authorization: string } }
    expect(payload.headers.Authorization).not.toContain('sk-ant-oat01')
    expect(payload.headers.Authorization).toContain('<REDACTED>')
    expect(event.redacted).toBe(true)
  })

  test('rawSecretsMode disables redaction; redacted flag is false', () => {
    const { emit, events } = recorder()
    const rec = new DebugRecorder({ sessionId: 's1', emit, debug: true, rawSecretsMode: true })
    rec.record('rpc.in', { token: 'sk-ant-oat01-untouched_secret_value_needed_long_text' })

    const event = events[0]
    if (event?.type !== 'debug_log') {
      throw new Error('expected debug_log')
    }
    const payload = event.payload as { token: string }
    expect(payload.token).toContain('sk-ant-oat01')
    expect(event.redacted).toBe(false)
  })

  test('record() with explicit level is honored', () => {
    const { emit, events } = recorder()
    const rec = new DebugRecorder({ sessionId: 's1', emit, debug: true })
    rec.record('sdk.error', { error: 'boom' }, 'error')

    const event = events[0]
    if (event?.type !== 'debug_log') {
      throw new Error('expected debug_log')
    }
    expect(event.level).toBe('error')
  })

  test('snapshot() returns the in-memory ring buffer', () => {
    const { emit } = recorder()
    const rec = new DebugRecorder({ sessionId: 's1', emit, debug: true })
    rec.record('sdk.message', { i: 1 })
    rec.record('sdk.message', { i: 2 })

    const snap = rec.snapshot()
    expect(snap.length).toBe(2)
    expect(snap[0]?.payload).toEqual({ i: 1 })
    expect(snap[1]?.payload).toEqual({ i: 2 })
  })
})

describe('DebugRecorder, debug=false', () => {
  test('record() is a no-op when debug=false', () => {
    const { emit, events } = recorder()
    const rec = new DebugRecorder({ sessionId: 's1', emit, debug: false })
    rec.record('sdk.message', { type: 'assistant' })

    expect(events.length).toBe(0)
    expect(rec.snapshot().length).toBe(0)
  })
})

describe('DebugRecorder, capture-narrowing flags', () => {
  test('debugCaptureRawSdk=false suppresses sdk.message + sdk.error', () => {
    const { emit, events } = recorder()
    const rec = new DebugRecorder({ sessionId: 's1', emit, debug: true, debugCaptureRawSdk: false })
    rec.record('sdk.message', { i: 1 })
    rec.record('sdk.error', { i: 2 })
    rec.record('rpc.in', { i: 3 })

    expect(events.length).toBe(1)
    if (events[0]?.type !== 'debug_log') {
      throw new Error('expected debug_log')
    }
    expect(events[0].stage).toBe('rpc.in')
  })

  test('debugCaptureRpc=false suppresses rpc.in + rpc.out', () => {
    const { emit, events } = recorder()
    const rec = new DebugRecorder({ sessionId: 's1', emit, debug: true, debugCaptureRpc: false })
    rec.record('rpc.in', { i: 1 })
    rec.record('rpc.out', { i: 2 })
    rec.record('sdk.message', { i: 3 })

    expect(events.length).toBe(1)
    if (events[0]?.type !== 'debug_log') {
      throw new Error('expected debug_log')
    }
    expect(events[0].stage).toBe('sdk.message')
  })
})

describe('DebugRecorder, ring buffer cap', () => {
  test('snapshot() caps at 1000 entries (FIFO)', () => {
    const { emit } = recorder()
    const rec = new DebugRecorder({ sessionId: 's1', emit, debug: true })
    for (let i = 0; i < 1100; i++) {
      rec.record('sdk.message', { i })
    }

    const snap = rec.snapshot()
    expect(snap.length).toBe(1000)
    // First 100 entries dropped; the buffer starts at i=100.
    expect((snap[0]?.payload as { i: number }).i).toBe(100)
    expect((snap[999]?.payload as { i: number }).i).toBe(1099)
  })
})
