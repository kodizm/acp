import { describe, expect, test } from 'bun:test'

import type { DriverCapabilities } from '@/backends/driver.ts'
import { OpencodeDriver } from '@/backends/opencode/driver.ts'
import { createBackendRegistry } from '@/backends/registry.ts'

/**
 * Phase 3 Task 1: scaffold OpencodeDriver. Tests the capability shape +
 * initialize handshake + registry resolution. The deeper lifecycle
 * (newSession, prompt, etc.) lands in subsequent tasks; this test
 * pins the contract so later tasks can layer behavior without
 * accidentally redefining capabilities.
 */
describe('OpencodeDriver capabilities', () => {
  test('advertises full feature set with skillEvents=false + askQuestion=true', () => {
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-test' } })
    const caps = driver.capabilities()
    const expected: DriverCapabilities = {
      resume: true,
      fork: true,
      fileUpload: true,
      thinking: true,
      subagent: true,
      skillEvents: false,
      debug: true,
      askQuestion: true,
    }
    expect(caps).toEqual(expected)
  })
})

describe('OpencodeDriver.initialize', () => {
  test('returns protocolVersion + agentInfo + capabilities', async () => {
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-test' } })
    const result = await driver.initialize({ protocolVersion: 1 })

    expect(result.protocolVersion).toBe(1)
    expect(result.agentInfo).toEqual({ version: '0.0.1-test' })
    expect(result.capabilities.askQuestion).toBe(true)
    expect(result.capabilities.debug).toBe(true)
  })
})

describe('Backend registry binding', () => {
  test('register + resolve returns the OpencodeDriver instance', () => {
    const registry = createBackendRegistry()
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-test' } })

    registry.register('opencode', driver)

    expect(registry.resolve('opencode')).toBe(driver)
  })

  test('resolveFromEnv reads KODIZM_BACKEND=opencode and returns the driver', () => {
    const registry = createBackendRegistry()
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-test' } })
    registry.register('opencode', driver)

    expect(registry.resolveFromEnv({ KODIZM_BACKEND: 'opencode' })).toBe(driver)
  })
})
