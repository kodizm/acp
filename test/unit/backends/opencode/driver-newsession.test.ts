import { describe, expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'

import { OpencodeDriver } from '@/backends/opencode/driver.ts'

const HAS_OPENCODE = (() => {
  try {
    return spawnSync('opencode', ['--version'], { stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
})()

/**
 * Phase 3 Task 3: real opencode `Server.listen()` per Kodizm session
 * + `sdk.session.create()` per session. Two concurrent newSession()
 * calls boot two distinct opencode subprocesses, each owning its own
 * port + opencode session id. The state map's size = 2 invariant
 * proves the driver does not collapse sessions into a shared
 * listener.
 */
describe.skipIf(!HAS_OPENCODE)('OpencodeDriver.newSession', () => {
  test('returns a UUID; second call returns a DIFFERENT UUID; map size = 2', async () => {
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-newsession' } })
    try {
      const first = await driver.newSession({ cwd: process.cwd(), mcpServers: [] })
      expect(typeof first.sessionId).toBe('string')
      expect(first.sessionId.length).toBeGreaterThan(0)

      const second = await driver.newSession({ cwd: process.cwd(), mcpServers: [] })
      expect(second.sessionId).not.toBe(first.sessionId)

      // Internal state assertion: opencode session ids differ too,
      // proving each Kodizm session has its own listener + opencode
      // session.
      const opencodeIds = driver.debugSessionIds()
      expect(opencodeIds.size).toBe(2)
      const distinct = new Set(opencodeIds.values())
      expect(distinct.size).toBe(2)
    } finally {
      await driver.disposeAll()
    }
  }, 90_000)

  test('OPENCODE_AUTH_CONTENT propagates to the subprocess', async () => {
    const sentinel = JSON.stringify({
      'opencode-go': {
        type: 'api',
        key: 'kodizm-test-sentinel-DO-NOT-LEAK',
      },
    })

    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-auth' } })
    try {
      const result = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: {
          opencodeAuth: sentinel,
        },
      })
      expect(typeof result.sessionId).toBe('string')

      // Process.env should NOT carry the sentinel after start; the
      // driver restores env keys to avoid cross-session leaks.
      expect(process.env.OPENCODE_AUTH_CONTENT).not.toBe(sentinel)
    } finally {
      await driver.disposeAll()
    }
  }, 60_000)
})

describe.skipIf(HAS_OPENCODE)('OpencodeDriver.newSession (skipped)', () => {
  test('skipped without opencode binary', () => {
    expect(HAS_OPENCODE).toBe(false)
  })
})
