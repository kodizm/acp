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

// CodexDriver.newSession spawns a subprocess + sends initialize +
// thread/start (Phase 2 T3). The full lifecycle is covered in
// `driver-newsession.test.ts` via spawnFactory injection; T1 stays
// scoped to capabilities + initialize so the scaffold concern is
// preserved separately.
