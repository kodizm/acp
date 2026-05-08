import { describe, expect, test } from 'bun:test'

import type {
  BackendDriver,
  DriverCapabilities,
  EventEmitter,
  InitializeResult,
  NewSessionResult,
  PromptResult,
} from '@/backends/driver.ts'
import { createBackendRegistry } from '@/backends/registry.ts'
import { BackendNotConfiguredError, UnknownBackendError } from '@/server/errors.ts'

/**
 * Minimal driver fixture. Phase 1's real Claude driver lands in T18;
 * the registry is tested against the contract, not a specific impl.
 */
function makeFakeDriver(label: string): BackendDriver {
  const caps: DriverCapabilities = {
    resume: false,
    fork: false,
    fileUpload: false,
    thinking: false,
    subagent: false,
    skillEvents: false,
    debug: false,
    askQuestion: false,
  }

  return {
    capabilities: () => caps,
    initialize: async () =>
      ({
        protocolVersion: 1,
        agentInfo: { version: label },
        capabilities: caps,
      }) as InitializeResult,
    newSession: async () => ({ sessionId: `${label}-session` }) as NewSessionResult,
    prompt: async (_sessionId, _params, _emit: EventEmitter) => ({ stopReason: 'end_turn' }) as PromptResult,
    cancel: async () => undefined,
    loadSession: async () => ({ sessionId: `${label}-session` }) as NewSessionResult,
    forkSession: async () => ({ sessionId: `${label}-fork` }) as NewSessionResult,
    compact: async () => undefined,
  }
}

describe('createBackendRegistry', () => {
  test('register + resolve returns the registered driver instance', () => {
    const registry = createBackendRegistry()
    const driver = makeFakeDriver('claude')

    registry.register('claude', driver)

    expect(registry.resolve('claude')).toBe(driver)
  })

  test('resolveFromEnv reads KODIZM_BACKEND and returns the bound driver', () => {
    const registry = createBackendRegistry()
    const driver = makeFakeDriver('claude')
    registry.register('claude', driver)

    const resolved = registry.resolveFromEnv({ KODIZM_BACKEND: 'claude' })
    expect(resolved).toBe(driver)
  })

  test('resolveFromEnv throws BackendNotConfiguredError when KODIZM_BACKEND is missing', () => {
    const registry = createBackendRegistry()
    expect(() => registry.resolveFromEnv({})).toThrow(BackendNotConfiguredError)
  })

  test('resolveFromEnv throws BackendNotConfiguredError when KODIZM_BACKEND is empty', () => {
    const registry = createBackendRegistry()
    expect(() => registry.resolveFromEnv({ KODIZM_BACKEND: '' })).toThrow(BackendNotConfiguredError)
  })

  test('resolveFromEnv throws UnknownBackendError when value is not registered', () => {
    const registry = createBackendRegistry()
    registry.register('claude', makeFakeDriver('claude'))

    expect(() => registry.resolveFromEnv({ KODIZM_BACKEND: 'gemini' })).toThrow(UnknownBackendError)
  })

  test('UnknownBackendError lists registered backends in its message', () => {
    const registry = createBackendRegistry()
    registry.register('claude', makeFakeDriver('claude'))

    try {
      registry.resolveFromEnv({ KODIZM_BACKEND: 'codex' })
      throw new Error('expected throw, got pass')
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownBackendError)
      expect((error as UnknownBackendError).message).toContain('codex')
      expect((error as UnknownBackendError).message).toContain('claude')
    }
  })

  test('resolve throws UnknownBackendError for an unknown name (no env path)', () => {
    const registry = createBackendRegistry()
    expect(() => registry.resolve('opencode')).toThrow(UnknownBackendError)
  })

  test('registered() returns the list of bound backend names', () => {
    const registry = createBackendRegistry()
    expect(registry.registered()).toEqual([])

    registry.register('claude', makeFakeDriver('claude'))
    expect(registry.registered()).toEqual(['claude'])
  })

  test('register overwrites a prior binding under the same name', () => {
    const registry = createBackendRegistry()
    const first = makeFakeDriver('first')
    const second = makeFakeDriver('second')

    registry.register('claude', first)
    registry.register('claude', second)

    expect(registry.resolve('claude')).toBe(second)
  })
})
