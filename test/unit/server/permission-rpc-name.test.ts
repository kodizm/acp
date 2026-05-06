import { describe, expect, test } from 'bun:test'

import { RPC_METHOD_ALIASES, createAcpServer } from '@/server/acp-server.ts'
import type { NdjsonTransport } from '@/server/transport.ts'

/**
 * Bidirectional in-memory transport reused from acp-server tests but
 * inlined to keep the file standalone (the helper would otherwise need
 * to live in test/unit/server/_helpers.ts; deferred until a third use).
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

describe('RPC alias dispatch (permission request name drift)', () => {
  test('exposes session/request_permission with requestPermission as legacy alias', () => {
    expect(RPC_METHOD_ALIASES['session/request_permission']).toEqual(['requestPermission'])
  })

  test('handler registered under canonical name fires for canonical request', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })

    let received: unknown
    server.on('session/request_permission', (params) => {
      received = params
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    })

    const serving = server.serve()

    injectFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/request_permission',
      params: { sessionId: 's1' },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(received).toEqual({ sessionId: 's1' })
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    })
  })

  test('handler registered under canonical name ALSO fires for legacy alias request', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })

    let received: unknown
    server.on('session/request_permission', (params) => {
      received = params
      return { outcome: { outcome: 'selected', optionId: 'allow_always' } }
    })

    const serving = server.serve()

    // Older drafts use the un-namespaced name on the wire.
    injectFrame({
      jsonrpc: '2.0',
      id: 2,
      method: 'requestPermission',
      params: { sessionId: 's2' },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(received).toEqual({ sessionId: 's2' })
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { outcome: { outcome: 'selected', optionId: 'allow_always' } },
    })
  })

  test('handler registered under legacy alias ALSO fires for canonical request', async () => {
    // Reverse: register under the legacy form, send canonical. Confirms
    // the alias map is bidirectional, not just legacy-to-canonical.
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })

    let received: unknown
    server.on('requestPermission', (params) => {
      received = params
      return { outcome: { outcome: 'cancelled' } }
    })

    const serving = server.serve()

    injectFrame({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/request_permission',
      params: { sessionId: 's3' },
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    expect(received).toEqual({ sessionId: 's3' })
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      result: { outcome: { outcome: 'cancelled' } },
    })
  })

  test('non-aliased methods stay unaliased (no accidental cross-routing)', async () => {
    const { transport, injectFrame, injectClose, outbound } = createTestTransport()
    const server = createAcpServer({ transport })

    server.on('session/new', () => ({ sessionId: 's-new' }))

    const serving = server.serve()

    // Send a totally different method name; should NOT route to session/new.
    injectFrame({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/load',
      params: {},
    })
    await waitForOutbound(outbound, 1)
    injectClose()
    await serving

    // Method-not-found, NOT 'session/new' result.
    expect(outbound[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32601 },
    })
  })
})
