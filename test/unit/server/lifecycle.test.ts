import { describe, expect, test } from 'bun:test'

import {
  AcpProtocolError,
  AcpTimeoutError,
  CancelledError,
  type JsonRpcError,
  ProcessDiedError,
} from '@/server/errors.ts'
import { CANCEL_GRACE_SECONDS_DEFAULT, pollTerminators, validateProtocolFrame } from '@/server/lifecycle.ts'

describe('pollTerminators', () => {
  test('returns null when transport is alive, no cancel, no deadline', () => {
    const result = pollTerminators({
      isAlive: () => true,
      cancelledAt: null,
      sessionId: 's1',
    })
    expect(result).toBeNull()
  })

  test('detects process death (highest priority)', () => {
    const result = pollTerminators({
      isAlive: () => false,
      cancelledAt: Date.now() - 5000,
      sessionId: 's1',
      deadlineMs: Date.now() - 1000,
    })
    expect(result).toBeInstanceOf(ProcessDiedError)
  })

  test('returns null during the cancel grace window', () => {
    const cancelledAt = Date.now() - 500 // 0.5s ago, within 2s default grace
    const result = pollTerminators({
      isAlive: () => true,
      cancelledAt,
      sessionId: 's1',
    })
    expect(result).toBeNull()
  })

  test('emits CancelledError once the grace window expires', () => {
    const cancelledAt = Date.now() - 3000 // 3s ago, past 2s default grace
    const result = pollTerminators({
      isAlive: () => true,
      cancelledAt,
      sessionId: 's2',
    })
    expect(result).toBeInstanceOf(CancelledError)
    expect((result as CancelledError).data).toEqual({ sessionId: 's2' })
  })

  test('respects a custom grace window', () => {
    const cancelledAt = Date.now() - 1000 // 1s ago
    const inGrace = pollTerminators({
      isAlive: () => true,
      cancelledAt,
      sessionId: 's1',
      graceSeconds: 5,
    })
    expect(inGrace).toBeNull()

    const expired = pollTerminators({
      isAlive: () => true,
      cancelledAt: Date.now() - 6000,
      sessionId: 's1',
      graceSeconds: 5,
    })
    expect(expired).toBeInstanceOf(CancelledError)
  })

  test('emits AcpTimeoutError when the deadline is reached', () => {
    const result = pollTerminators({
      isAlive: () => true,
      cancelledAt: null,
      sessionId: 's1',
      deadlineMs: Date.now() - 100,
    })
    expect(result).toBeInstanceOf(AcpTimeoutError)
  })

  test('returns null when the deadline is still in the future', () => {
    const result = pollTerminators({
      isAlive: () => true,
      cancelledAt: null,
      sessionId: 's1',
      deadlineMs: Date.now() + 60_000,
    })
    expect(result).toBeNull()
  })

  test('priority order: process death wins over cancel + deadline', () => {
    const result = pollTerminators({
      isAlive: () => false,
      cancelledAt: Date.now() - 10_000,
      sessionId: 's1',
      deadlineMs: Date.now() - 1000,
    })
    expect(result).toBeInstanceOf(ProcessDiedError)
  })

  test('priority order: cancel wins over deadline when both fire', () => {
    const result = pollTerminators({
      isAlive: () => true,
      cancelledAt: Date.now() - 5000,
      sessionId: 's3',
      deadlineMs: Date.now() - 100,
    })
    expect(result).toBeInstanceOf(CancelledError)
  })

  test('exposes the documented default grace window constant', () => {
    expect(CANCEL_GRACE_SECONDS_DEFAULT).toBe(2)
  })
})

describe('validateProtocolFrame', () => {
  test('returns null for a well-formed JSON-RPC v2 envelope', () => {
    const result = validateProtocolFrame({ jsonrpc: '2.0', id: 1, method: 'foo', params: {} })
    expect(result).toBeNull()
  })

  test('returns null for a JSON-RPC v2 notification', () => {
    const result = validateProtocolFrame({ jsonrpc: '2.0', method: 'notify', params: {} })
    expect(result).toBeNull()
  })

  test('emits AcpProtocolError when jsonrpc field is missing', () => {
    const result = validateProtocolFrame({ id: 1, method: 'foo' })
    expect(result).toBeInstanceOf(AcpProtocolError)
    expect((result as JsonRpcError).message).toContain('jsonrpc')
  })

  test('emits AcpProtocolError when jsonrpc field is not "2.0"', () => {
    const result = validateProtocolFrame({ jsonrpc: '1.0', id: 1, method: 'foo' })
    expect(result).toBeInstanceOf(AcpProtocolError)
  })

  test('emits AcpProtocolError for non-object frames', () => {
    expect(validateProtocolFrame('string-frame')).toBeInstanceOf(AcpProtocolError)
    expect(validateProtocolFrame(null)).toBeInstanceOf(AcpProtocolError)
    expect(validateProtocolFrame(42)).toBeInstanceOf(AcpProtocolError)
  })

  test('emits AcpProtocolError for a request without a method', () => {
    const result = validateProtocolFrame({ jsonrpc: '2.0', id: 1 })
    expect(result).toBeInstanceOf(AcpProtocolError)
  })
})
