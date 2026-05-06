import { describe, expect, test } from 'bun:test'

import type { BackendDriver, DriverCapabilities, EventEmitter } from '@/backends/driver.ts'
import { createAcpServer } from '@/server/acp-server.ts'
import type { NdjsonTransport } from '@/server/transport.ts'

/**
 * Bidirectional in-memory transport. Reused pattern from
 * acp-server.test.ts; inlined here to keep the file standalone.
 */
function createTestTransport(): {
  transport: NdjsonTransport
  injectFrame: (frame: unknown) => void
  injectClose: () => void
  outbound: unknown[]
} {
  let inboundResolve: ((result: IteratorResult<unknown>) => void) | undefined
  const inboundQueue: IteratorResult<unknown>[] = []
  const outbound: unknown[] = []

  const transport: NdjsonTransport = {
    readFrames(): AsyncIterable<unknown> {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (inboundQueue.length > 0) {
                return inboundQueue.shift() as IteratorResult<unknown>
              }
              return new Promise<IteratorResult<unknown>>((resolve) => {
                inboundResolve = resolve
              })
            },
          }
        },
      }
    },
    async writeFrame(frame: unknown): Promise<void> {
      outbound.push(frame)
    },
    async close(): Promise<void> {
      // no-op
    },
  }

  const injectFrame = (frame: unknown): void => {
    const item: IteratorResult<unknown> = { value: frame, done: false }
    if (inboundResolve) {
      inboundResolve(item)
      inboundResolve = undefined
    } else {
      inboundQueue.push(item)
    }
  }

  const injectClose = (): void => {
    const item: IteratorResult<unknown> = { value: undefined, done: true }
    if (inboundResolve) {
      inboundResolve(item)
      inboundResolve = undefined
    } else {
      inboundQueue.push(item)
    }
  }

  return { transport, injectFrame, injectClose, outbound }
}

async function waitForOutbound(outbound: unknown[], count: number, deadlineMs = 200): Promise<void> {
  const start = Date.now()
  while (outbound.length < count) {
    if (Date.now() - start > deadlineMs) {
      throw new Error(`expected ${count} outbound frames, got ${outbound.length}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Recording mock driver. Each method tracks the call args + the
 * (lazy) result it returns. Tests assert: schema-validated params
 * arrived, driver was called, return value flowed back to the wire.
 */
function makeMockDriver(caps: Partial<DriverCapabilities> = {}): {
  driver: BackendDriver
  calls: Record<string, unknown[]>
} {
  const calls: Record<string, unknown[]> = {
    initialize: [],
    newSession: [],
    prompt: [],
    cancel: [],
    loadSession: [],
    forkSession: [],
  }

  const fullCaps: DriverCapabilities = {
    resume: true,
    fork: true,
    fileUpload: true,
    thinking: true,
    subagent: true,
    skillEvents: true,
    ...caps,
  }

  const driver: BackendDriver = {
    capabilities: () => fullCaps,
    initialize: async (params) => {
      calls.initialize?.push(params)
      return {
        protocolVersion: 1,
        agentInfo: { version: '0.0.1-mock' },
        capabilities: fullCaps,
      }
    },
    newSession: async (params) => {
      calls.newSession?.push(params)
      return { sessionId: 'mock-session' }
    },
    prompt: async (sessionId, params, emit: EventEmitter) => {
      calls.prompt?.push({ sessionId, params })
      emit.send({ sessionId, type: 'output_chunk', text: 'pong' })
      return { stopReason: 'end_turn' }
    },
    cancel: async (request) => {
      calls.cancel?.push(request)
    },
    loadSession: async (params) => {
      calls.loadSession?.push(params)
      return { sessionId: 'loaded-session' }
    },
    forkSession: async (params) => {
      calls.forkSession?.push(params)
      return { sessionId: 'forked-session' }
    },
  }

  return { driver, calls }
}

describe('createAcpServer with backend wiring', () => {
  test('initialize dispatches to backend.initialize and returns the result', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const { driver, calls } = makeMockDriver()
    const server = createAcpServer({ transport, backend: driver })
    const serving = server.serve()

    injectFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(calls.initialize).toHaveLength(1)
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { version: '0.0.1-mock' },
      },
    })
  })

  test('session/new dispatches to backend.newSession with validated params', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const { driver, calls } = makeMockDriver()
    const server = createAcpServer({ transport, backend: driver })
    const serving = server.serve()

    injectFrame({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/workspace', mcpServers: [] },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(calls.newSession).toHaveLength(1)
    expect(calls.newSession?.[0]).toMatchObject({ cwd: '/workspace', mcpServers: [] })
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { sessionId: 'mock-session' },
    })
  })

  test('session/prompt dispatches to backend.prompt and forwards emitted events as sessionUpdate', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const { driver, calls } = makeMockDriver()
    const server = createAcpServer({ transport, backend: driver })
    const serving = server.serve()

    injectFrame({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 's1', prompt: [] },
    })
    // Expect 2 outbound: one sessionUpdate notification, one prompt result.
    await waitForOutbound(outbound, 2)
    injectClose()
    await serving

    expect(calls.prompt).toHaveLength(1)

    const sessionUpdate = outbound.find((frame) => (frame as { method?: string }).method === 'sessionUpdate')
    expect(sessionUpdate).toMatchObject({
      jsonrpc: '2.0',
      method: 'sessionUpdate',
      params: { sessionId: 's1', type: 'output_chunk', text: 'pong' },
    })

    const result = outbound.find((frame) => (frame as { id?: number }).id === 3)
    expect(result).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      result: { stopReason: 'end_turn' },
    })
  })

  test('session/cancel dispatches to backend.cancel', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const { driver, calls } = makeMockDriver()
    const server = createAcpServer({ transport, backend: driver })
    const serving = server.serve()

    injectFrame({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/cancel',
      params: { sessionId: 's1' },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(calls.cancel).toHaveLength(1)
    expect(calls.cancel?.[0]).toMatchObject({ sessionId: 's1' })
  })

  test('session/load dispatches to backend.loadSession', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const { driver, calls } = makeMockDriver()
    const server = createAcpServer({ transport, backend: driver })
    const serving = server.serve()

    injectFrame({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/load',
      params: { sessionId: 's1', cwd: '/workspace', mcpServers: [] },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(calls.loadSession).toHaveLength(1)
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 5,
      result: { sessionId: 'loaded-session' },
    })
  })

  test('session/fork dispatches to backend.forkSession', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const { driver, calls } = makeMockDriver()
    const server = createAcpServer({ transport, backend: driver })
    const serving = server.serve()

    injectFrame({
      jsonrpc: '2.0',
      id: 6,
      method: 'session/fork',
      params: { sourceSessionId: 's1', cwd: '/workspace', mcpServers: [] },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(calls.forkSession).toHaveLength(1)
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 6,
      result: { sessionId: 'forked-session' },
    })
  })

  test('session/load is rejected with -32601 when backend lacks resume capability', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const { driver, calls } = makeMockDriver({ resume: false })
    const server = createAcpServer({ transport, backend: driver })
    const serving = server.serve()

    injectFrame({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/load',
      params: { sessionId: 's1', cwd: '/workspace', mcpServers: [] },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(calls.loadSession).toHaveLength(0)
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601 },
    })
  })

  test('session/fork is rejected when backend lacks fork capability', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const { driver, calls } = makeMockDriver({ fork: false })
    const server = createAcpServer({ transport, backend: driver })
    const serving = server.serve()

    injectFrame({
      jsonrpc: '2.0',
      id: 8,
      method: 'session/fork',
      params: { sourceSessionId: 's1', cwd: '/workspace', mcpServers: [] },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(calls.forkSession).toHaveLength(0)
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 8,
      error: { code: -32601 },
    })
  })

  test('schema validation failure maps to -32602 InvalidParams', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const { driver, calls } = makeMockDriver()
    const server = createAcpServer({ transport, backend: driver })
    const serving = server.serve()

    // cwd must be absolute; relative path triggers refinement failure.
    injectFrame({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/new',
      params: { cwd: 'relative/path', mcpServers: [] },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(calls.newSession).toHaveLength(0)
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32602 },
    })
  })
})
