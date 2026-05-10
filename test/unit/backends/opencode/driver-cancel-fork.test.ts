import { describe, expect, mock, test } from 'bun:test'

import { spawnSync } from 'node:child_process'

import { OpencodeDriver } from '@/backends/opencode/driver.ts'
import type { OpencodeHttpBridge } from '@/backends/opencode/http-bridge.ts'

const HAS_OPENCODE = (() => {
  try {
    return spawnSync('opencode', ['--version'], { stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
})()

/**
 * Phase 3 Tasks 12 + 14: cancel() tears down the per-session bridge
 * and forkSession() reuses the parent's listener while spawning a
 * fresh opencode session.
 */
describe.skipIf(!HAS_OPENCODE)('OpencodeDriver.cancel', () => {
  test('cancel removes the session and stops the bridge', async () => {
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-cancel' } })
    try {
      const created = await driver.newSession({ cwd: process.cwd(), mcpServers: [] })
      expect(driver.debugSessionIds().has(created.sessionId)).toBe(true)

      await driver.cancel({ sessionId: created.sessionId })
      expect(driver.debugSessionIds().has(created.sessionId)).toBe(false)
    } finally {
      await driver.disposeAll()
    }
  }, 30_000)

  test('cancel on unknown sessionId is a no-op', async () => {
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-cancel' } })
    try {
      await expect(driver.cancel({ sessionId: 'never-existed' })).resolves.toBeUndefined()
    } finally {
      await driver.disposeAll()
    }
  })
})

describe('OpencodeDriver.cancel (with fake bridge)', () => {
  test('cancel calls bridge.stop and removes the session', async () => {
    const fakeStop = mock(async () => undefined)
    const fakeStart = mock(async () => ({
      url: 'http://127.0.0.1:0',
      port: 0,
      sdk: {
        session: {
          create: mock(async () => ({ data: { id: 'fake-opencode-id' } })),
          abort: mock(async () => ({})),
        },
      },
    }))

    const fakeBridgeFactory = (): OpencodeHttpBridge => {
      const bridge = {
        start: fakeStart,
        stop: fakeStop,
        isRunning: () => true,
      } as unknown as OpencodeHttpBridge
      return bridge
    }

    const driver = new OpencodeDriver({
      agentInfo: { version: '0.0.1-fake' },
      bridgeFactory: fakeBridgeFactory,
    })

    const created = await driver.newSession({ cwd: '/tmp', mcpServers: [] })
    await driver.cancel({ sessionId: created.sessionId })

    expect(fakeStop).toHaveBeenCalled()
    expect(driver.debugSessionIds().has(created.sessionId)).toBe(false)
  })
})

describe('OpencodeDriver cwd passthrough (with fake bridge)', () => {
  test('newSession passes params.cwd as directory to sdk.session.create', async () => {
    const createCalls: Array<Record<string, unknown>> = []
    const fakeStart = mock(async () => ({
      url: 'http://127.0.0.1:0',
      port: 0,
      sdk: {
        session: {
          create: mock(async (parameters: Record<string, unknown>) => {
            createCalls.push(parameters)
            return { data: { id: 'fake-opencode-id' } }
          }),
          abort: mock(async () => ({})),
        },
      },
    }))

    const driver = new OpencodeDriver({
      agentInfo: { version: '0.0.1-cwd' },
      bridgeFactory: (): OpencodeHttpBridge =>
        ({
          start: fakeStart,
          stop: mock(async () => undefined),
          isRunning: () => true,
        }) as unknown as OpencodeHttpBridge,
    })

    await driver.newSession({ cwd: '/tmp/probe-cwd-create', mcpServers: [] })

    expect(createCalls.length).toBe(1)
    expect(createCalls[0]?.directory).toBe('/tmp/probe-cwd-create')
  })

  test('forkSession passes params.cwd as directory to sdk.session.fork', async () => {
    const forkCalls: Array<Record<string, unknown>> = []
    const fakeStart = mock(async () => ({
      url: 'http://127.0.0.1:0',
      port: 0,
      sdk: {
        session: {
          create: mock(async () => ({ data: { id: 'parent-opencode-id' } })),
          fork: mock(async (parameters: Record<string, unknown>) => {
            forkCalls.push(parameters)
            return { data: { id: 'fork-opencode-id' } }
          }),
          abort: mock(async () => ({})),
        },
      },
    }))

    const driver = new OpencodeDriver({
      agentInfo: { version: '0.0.1-cwd-fork' },
      bridgeFactory: (): OpencodeHttpBridge =>
        ({
          start: fakeStart,
          stop: mock(async () => undefined),
          isRunning: () => true,
        }) as unknown as OpencodeHttpBridge,
    })

    const parent = await driver.newSession({ cwd: '/tmp/probe-cwd-parent', mcpServers: [] })
    await driver.forkSession({
      sourceSessionId: parent.sessionId,
      cwd: '/tmp/probe-cwd-fork',
      mcpServers: [],
    })

    expect(forkCalls.length).toBe(1)
    expect(forkCalls[0]?.directory).toBe('/tmp/probe-cwd-fork')
    expect(forkCalls[0]?.sessionID).toBe('parent-opencode-id')
  })

  test('loadSession passes params.cwd as directory to sdk.session.get', async () => {
    const getCalls: Array<Record<string, unknown>> = []
    const fakeStart = mock(async () => ({
      url: 'http://127.0.0.1:0',
      port: 0,
      sdk: {
        session: {
          create: mock(async () => ({ data: { id: 'unused' } })),
          get: mock(async (parameters: Record<string, unknown>) => {
            getCalls.push(parameters)
            return { data: { id: parameters.sessionID } }
          }),
          abort: mock(async () => ({})),
        },
      },
    }))

    const driver = new OpencodeDriver({
      agentInfo: { version: '0.0.1-cwd-load' },
      bridgeFactory: (): OpencodeHttpBridge =>
        ({
          start: fakeStart,
          stop: mock(async () => undefined),
          isRunning: () => true,
        }) as unknown as OpencodeHttpBridge,
    })

    await driver.loadSession({
      sessionId: 'kodizm-session-id',
      cwd: '/tmp/probe-cwd-load',
      mcpServers: [],
      _meta: { opencodeSessionId: 'opencode-load-id' },
    })

    expect(getCalls.length).toBe(1)
    expect(getCalls[0]?.directory).toBe('/tmp/probe-cwd-load')
    expect(getCalls[0]?.sessionID).toBe('opencode-load-id')
  })
})

describe.skipIf(!HAS_OPENCODE)('OpencodeDriver.forkSession', () => {
  test('fork returns a fresh Kodizm sessionId pointing at a new opencode session', async () => {
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-fork' } })
    try {
      const parent = await driver.newSession({ cwd: process.cwd(), mcpServers: [] })
      const fork = await driver.forkSession({
        sourceSessionId: parent.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      })
      expect(fork.sessionId).not.toBe(parent.sessionId)

      const ids = driver.debugSessionIds()
      const parentOpencodeId = ids.get(parent.sessionId)
      const forkOpencodeId = ids.get(fork.sessionId)
      expect(parentOpencodeId).toBeDefined()
      expect(forkOpencodeId).toBeDefined()
      expect(parentOpencodeId).not.toBe(forkOpencodeId)
    } finally {
      await driver.disposeAll()
    }
  }, 60_000)
})
