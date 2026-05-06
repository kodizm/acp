import { describe, expect, test } from 'bun:test'

import { SessionNotFoundError } from '@/server/errors.ts'
import { SessionManager } from '@/session/manager.ts'
import type { SessionState } from '@/session/state.ts'

function fakeState(overrides: Partial<SessionState> = {}): Omit<SessionState, 'sessionId' | 'createdAt'> {
  return {
    backend: 'claude',
    sdkOptions: { cwd: '/workspace', mcpServers: {} },
    abortController: new AbortController(),
    parentChildMap: new Map(),
    ...overrides,
  }
}

describe('SessionManager.create', () => {
  test('stores a new session under the given id with createdAt populated', () => {
    const manager = new SessionManager()
    const before = Date.now()

    const state = manager.create('s1', fakeState())

    expect(state.sessionId).toBe('s1')
    expect(state.createdAt).toBeGreaterThanOrEqual(before)
    expect(manager.has('s1')).toBe(true)
  })

  test('rejects a duplicate session id', () => {
    const manager = new SessionManager()
    manager.create('s1', fakeState())

    expect(() => manager.create('s1', fakeState())).toThrow(/already exists/)
  })
})

describe('SessionManager.get', () => {
  test('returns the stored state for a known id', () => {
    const manager = new SessionManager()
    manager.create('s1', fakeState({ backend: 'claude' }))

    const state = manager.get('s1')
    expect(state.backend).toBe('claude')
  })

  test('throws SessionNotFoundError on an unknown id', () => {
    const manager = new SessionManager()
    expect(() => manager.get('unknown')).toThrow(SessionNotFoundError)
  })
})

describe('SessionManager.close', () => {
  test('aborts the session AbortController and removes the entry', () => {
    const manager = new SessionManager()
    const controller = new AbortController()
    manager.create('s1', fakeState({ abortController: controller }))

    manager.close('s1')

    expect(controller.signal.aborted).toBe(true)
    expect(manager.has('s1')).toBe(false)
  })

  test('close on an unknown id throws SessionNotFoundError', () => {
    const manager = new SessionManager()
    expect(() => manager.close('nope')).toThrow(SessionNotFoundError)
  })
})

describe('SessionManager.isolation', () => {
  test('closing one session leaves siblings untouched', () => {
    const manager = new SessionManager()
    const a = new AbortController()
    const b = new AbortController()
    manager.create('s1', fakeState({ abortController: a }))
    manager.create('s2', fakeState({ abortController: b }))

    manager.close('s1')

    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    expect(manager.has('s2')).toBe(true)
  })

  test('size reflects current population across create + close', () => {
    const manager = new SessionManager()
    expect(manager.size()).toBe(0)

    manager.create('s1', fakeState())
    manager.create('s2', fakeState())
    expect(manager.size()).toBe(2)

    manager.close('s1')
    expect(manager.size()).toBe(1)
  })
})

describe('SessionManager.list', () => {
  test('returns the session ids in insertion order', () => {
    const manager = new SessionManager()
    manager.create('s1', fakeState())
    manager.create('s2', fakeState())
    manager.create('s3', fakeState())

    expect(manager.list()).toEqual(['s1', 's2', 's3'])
  })
})
