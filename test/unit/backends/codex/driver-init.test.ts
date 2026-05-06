import { describe, expect, test } from 'bun:test'

import { CodexDriver } from '@/backends/codex/driver.ts'
import type { DriverCapabilities } from '@/backends/driver.ts'

describe('CodexDriver capabilities', () => {
  test('advertises full feature set with skillEvents=false (codex has no skill loader)', () => {
    const driver = new CodexDriver({ agentInfo: { version: '0.0.1-test' } })
    const caps = driver.capabilities()
    const expected: DriverCapabilities = {
      resume: true,
      fork: true,
      fileUpload: true,
      thinking: true,
      subagent: true,
      skillEvents: false,
      debug: true,
    }
    expect(caps).toEqual(expected)
  })
})

describe('CodexDriver.initialize', () => {
  test('returns protocolVersion + agentInfo + capabilities', async () => {
    const driver = new CodexDriver({ agentInfo: { version: '0.0.1-test' } })
    const result = await driver.initialize({ protocolVersion: 1 })
    expect(result.protocolVersion).toBe(1)
    expect(result.agentInfo).toEqual({ version: '0.0.1-test' })
    expect(result.capabilities.debug).toBe(true)
  })
})

describe('CodexDriver.newSession', () => {
  test('returns a UUID-shaped sessionId without spawning subprocess yet (T2 wires spawn)', async () => {
    const driver = new CodexDriver({ agentInfo: { version: '0.0.1-test' } })
    const result = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
