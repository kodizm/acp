import { describe, expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'

import { OpencodeHttpBridge } from '@/backends/opencode/http-bridge.ts'

const HAS_OPENCODE = (() => {
  try {
    return spawnSync('opencode', ['--version'], { stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
})()

/**
 * Phase 3 Task 2: real opencode `Server.listen()` boot. The bridge
 * wraps `createOpencodeServer()` from `@opencode-ai/sdk` (the
 * official programmatic boot helper, which spawns
 * `opencode serve --port 0 --hostname 127.0.0.1` under the hood and
 * resolves the server URL once the subprocess prints
 * `opencode server listening on …`).
 *
 * Test gated on `HAS_OPENCODE`: skips when the binary is not on PATH
 * (CI without opencode installed). On the developer host opencode
 * 1.14.40+ is installed, so the suite hits the real-CLI path.
 */
describe.skipIf(!HAS_OPENCODE)('OpencodeHttpBridge', () => {
  test('start() boots a real listener and returns a working sdk client', async () => {
    const bridge = new OpencodeHttpBridge()
    const result = await bridge.start({})
    try {
      expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/)
      expect(result.port).toBeGreaterThan(0)
      expect(result.sdk).toBeDefined()

      // The SDK client exposes session.list (a benign read endpoint we
      // can hit to prove the server is responding); a fresh server has
      // an empty session list.
      const listResponse = await result.sdk.session.list()
      expect(listResponse).toBeDefined()
    } finally {
      await bridge.stop()
    }
  }, 30_000)

  test('start() is idempotent (second call returns the same handle)', async () => {
    const bridge = new OpencodeHttpBridge()
    try {
      const first = await bridge.start({})
      const second = await bridge.start({})
      expect(second.url).toBe(first.url)
      expect(second.port).toBe(first.port)
    } finally {
      await bridge.stop()
    }
  }, 30_000)

  test('stop() terminates the listener and rejects subsequent fetch', async () => {
    const bridge = new OpencodeHttpBridge()
    const result = await bridge.start({})
    const url = result.url

    await bridge.stop()

    let rejected = false
    try {
      const response = await fetch(`${url}global/event`, {
        signal: AbortSignal.timeout(2_000),
      })
      // Server may respond with 502 or connection-refused; either
      // counts as "not running".
      if (response.status >= 500 || response.status === 0) {
        rejected = true
      }
      try {
        await response.body?.cancel()
      } catch {
        // ignore
      }
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  }, 30_000)
})

describe.skipIf(HAS_OPENCODE)('OpencodeHttpBridge (skipped, no opencode binary)', () => {
  test('skipped without opencode installed', () => {
    expect(HAS_OPENCODE).toBe(false)
  })
})
