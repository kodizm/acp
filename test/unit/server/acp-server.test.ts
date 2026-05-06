import { describe, expect, test } from 'bun:test'

import { JsonRpcErrorCode, createAcpServer } from '@/server/acp-server.ts'
import type { NdjsonTransport } from '@/server/transport.ts'

/**
 * Bidirectional in-memory transport for tests. The "client" side feeds
 * frames into the server (via injectFrame) and observes the server's
 * outbound traffic (via outbound).
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

/**
 * Helper: wait until at least N frames have been written outbound.
 */
async function waitForOutbound(outbound: unknown[], count: number, deadlineMs = 200): Promise<void> {
  const start = Date.now()
  while (outbound.length < count) {
    if (Date.now() - start > deadlineMs) {
      throw new Error(`expected ${count} outbound frames, got ${outbound.length}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('createAcpServer.serve', () => {
  test('dispatches a request to the registered handler', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })
    server.on('initialize', (params: unknown) => ({
      protocolVersion: 1,
      echoed: params,
    }))

    const serving = server.serve()

    injectFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { client: 'test' } })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(outbound).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: 1, echoed: { client: 'test' } },
      },
    ])
  })

  test('returns -32601 method-not-found for an unregistered method', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })
    const serving = server.serve()

    injectFrame({ jsonrpc: '2.0', id: 7, method: 'nope/whatever', params: {} })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: JsonRpcErrorCode.MethodNotFound,
      },
    })
  })

  test('handler throw maps to -32603 internal-error response', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })
    server.on('boom', () => {
      throw new Error('handler exploded')
    })

    const serving = server.serve()

    injectFrame({ jsonrpc: '2.0', id: 2, method: 'boom', params: {} })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: { code: JsonRpcErrorCode.InternalError },
    })
  })

  test('notification: handler runs but no response frame is emitted', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })

    let observed: unknown
    server.on('session/cancel', (params: unknown) => {
      observed = params
    })

    const serving = server.serve()

    injectFrame({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'abc' } })
    // Settle the microtask queue so the handler runs.
    await new Promise((resolve) => setTimeout(resolve, 5))
    injectClose()
    await serving

    expect(observed).toEqual({ sessionId: 'abc' })
    expect(outbound).toEqual([])
  })

  test('rejects a frame missing the jsonrpc:"2.0" envelope (id present)', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })
    const serving = server.serve()

    // Missing jsonrpc field. With an id, we still emit an error response.
    injectFrame({ id: 9, method: 'initialize', params: {} })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 9,
      error: { code: JsonRpcErrorCode.InvalidRequest },
    })
  })

  test('drops a malformed frame with no id silently', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })
    const serving = server.serve()

    // Not a valid JSON-RPC envelope and no id -> nowhere to respond.
    injectFrame('not an object')
    injectFrame(null)
    injectFrame({ random: true })
    // Give the dispatcher a tick.
    await new Promise((resolve) => setTimeout(resolve, 5))
    injectClose()
    await serving

    expect(outbound).toEqual([])
  })
})

describe('createAcpServer.request', () => {
  test('emits an outbound request with an incrementing id and resolves on matching response', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })
    const serving = server.serve()

    const promise = server.request('session/request_permission', { sessionId: 's1' })
    await waitForOutbound(outbound, 1)

    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'session/request_permission',
      params: { sessionId: 's1' },
    })
    const sentId = (outbound[0] as { id: number }).id
    expect(typeof sentId).toBe('number')

    // Reply on the inbound channel.
    injectFrame({ jsonrpc: '2.0', id: sentId, result: { outcome: { outcome: 'selected', optionId: 'allow' } } })

    const resolved = await promise
    expect(resolved).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })

    injectClose()
    await serving
  })

  test('outbound ids increment monotonically across calls', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })
    const serving = server.serve()

    const a = server.request('m/a', {})
    const b = server.request('m/b', {})
    await waitForOutbound(outbound, 2)

    const idA = (outbound[0] as { id: number }).id
    const idB = (outbound[1] as { id: number }).id
    expect(idB).toBe(idA + 1)

    injectFrame({ jsonrpc: '2.0', id: idA, result: 'a-ok' })
    injectFrame({ jsonrpc: '2.0', id: idB, result: 'b-ok' })

    expect(await a).toBe('a-ok')
    expect(await b).toBe('b-ok')

    injectClose()
    await serving
  })

  test('outbound request rejects when the response carries an error', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })
    const serving = server.serve()

    const promise = server.request('session/request_permission', { sessionId: 's1' })
    await waitForOutbound(outbound, 1)
    const sentId = (outbound[0] as { id: number }).id

    injectFrame({ jsonrpc: '2.0', id: sentId, error: { code: -32602, message: 'bad shape' } })

    await expect(promise).rejects.toThrow(/bad shape/)
    injectClose()
    await serving
  })
})

describe('createAcpServer.notify', () => {
  test('emits an outbound notification (no id)', async () => {
    const { transport, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })
    const serving = server.serve()

    server.notify('sessionUpdate', { sessionId: 's1', payload: 'hi' })
    await waitForOutbound(outbound, 1)

    expect(outbound[0]).toEqual({
      jsonrpc: '2.0',
      method: 'sessionUpdate',
      params: { sessionId: 's1', payload: 'hi' },
    })

    injectClose()
    await serving
  })
})
