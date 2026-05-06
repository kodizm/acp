import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import { createAcpServer } from '@/server/acp-server.ts'
import { createNdjsonTransport } from '@/server/transport.ts'

const TEXT_DECODER = new TextDecoder('utf-8')
const TEXT_ENCODER = new TextEncoder()

interface InMemoryPipeline {
  /** Drive the dispatch loop until the test finishes. */
  servePromise: Promise<void>
  /** Send a JSON-RPC frame from the client side. */
  sendFrame(frame: unknown): Promise<void>
  /** Read the next NDJSON frame the server emits to the client. */
  readNextFrame(): Promise<unknown>
  /** Close the client write side so the server's read loop exits. */
  finishClient(): Promise<void>
}

function buildPipeline(adapter: SdkAdapter): InMemoryPipeline {
  // 1. Two TransformStreams give us a paired duplex: client writes
  //    into clientToServer.writable; server reads from
  //    clientToServer.readable. Server writes into
  //    serverToClient.writable; client reads from
  //    serverToClient.readable.
  const clientToServer = new TransformStream<Uint8Array, Uint8Array>()
  const serverToClient = new TransformStream<Uint8Array, Uint8Array>()

  const transport = createNdjsonTransport({
    readable: clientToServer.readable,
    writable: serverToClient.writable,
  })

  const driver = new ClaudeDriver({
    credentials: { type: 'api-key', token: 'sk-ant-fake' },
    agentInfo: { version: '0.0.1-e2e' },
    sdk: adapter,
  })

  const server = createAcpServer({ transport, backend: driver })
  const servePromise = server.serve()

  const writer = clientToServer.writable.getWriter()
  const reader = serverToClient.readable.getReader()

  let lineBuffer = ''

  return {
    servePromise,
    async sendFrame(frame) {
      await writer.write(TEXT_ENCODER.encode(`${JSON.stringify(frame)}\n`))
    },
    async readNextFrame() {
      // Read until the next newline accumulates a parseable line.
      while (true) {
        const newlineAt = lineBuffer.indexOf('\n')
        if (newlineAt !== -1) {
          const raw = lineBuffer.slice(0, newlineAt)
          lineBuffer = lineBuffer.slice(newlineAt + 1)
          if (raw.trim() === '') {
            continue
          }
          return JSON.parse(raw)
        }
        const { value, done } = await reader.read()
        if (value !== undefined) {
          lineBuffer += TEXT_DECODER.decode(value, { stream: true })
        }
        if (done) {
          throw new Error('serverToClient stream closed before a frame arrived')
        }
      }
    },
    async finishClient() {
      try {
        await writer.close()
      } catch {
        // benign on a stream already in EOF
      }
    },
  }
}

function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
    }),
  ])
}

let pipeline: InMemoryPipeline | null = null

afterEach(async () => {
  if (pipeline !== null) {
    await pipeline.finishClient()
    await deadline(pipeline.servePromise, 5000, 'serve drain')
    pipeline = null
  }
})

beforeEach(() => {
  pipeline = null
})

describe('e2e mocked pipeline', () => {
  test('happy path: initialize + session/new + prompt + result', async () => {
    const messages: SdkMessage[] = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.0152,
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 100,
        },
      },
    ]
    const adapter: SdkAdapter = {
      async *query() {
        for (const m of messages) {
          yield m
        }
      },
    }
    pipeline = buildPipeline(adapter)

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    })
    const initResponse = (await deadline(pipeline.readNextFrame(), 5000, 'initialize')) as {
      id: number
      result: { protocolVersion: number; agentInfo: { version: string } }
    }
    expect(initResponse.id).toBe(1)
    expect(initResponse.result.protocolVersion).toBe(1)

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/workspace', mcpServers: [] },
    })
    const newSessionResponse = (await deadline(pipeline.readNextFrame(), 5000, 'session/new')) as {
      id: number
      result: { sessionId: string }
    }
    const { sessionId } = newSessionResponse.result

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    })

    // Drain sessionUpdate notifications until the prompt response arrives.
    const updates: Array<Record<string, unknown>> = []
    let promptResult: { stopReason: string } | null = null
    while (promptResult === null) {
      const frame = (await deadline(pipeline.readNextFrame(), 5000, 'prompt')) as Record<string, unknown>
      if (frame.method === 'sessionUpdate') {
        updates.push((frame.params as Record<string, unknown>) ?? {})
      } else if (frame.id === 3) {
        promptResult = frame.result as { stopReason: string }
      }
    }

    expect(promptResult.stopReason).toBe('end_turn')
    expect(updates.map((u) => u.type)).toContain('output_chunk')
    expect(updates.map((u) => u.type)).toContain('usage')
  })

  test('cancel: cancelled event + stopReason=cancelled inside the grace window', async () => {
    const adapter: SdkAdapter = {
      async *query({ options }) {
        await new Promise<void>((_resolve, reject) => {
          options.abortController?.signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            ;(err as { name: string }).name = 'AbortError'
            reject(err)
          })
        })
      },
    }
    pipeline = buildPipeline(adapter)

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: '/workspace', mcpServers: [] },
    })
    const { sessionId } = ((await pipeline.readNextFrame()) as { result: { sessionId: string } }).result

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [] },
    })
    // Tick so the server reaches the SDK await before cancel arrives.
    await new Promise((r) => setTimeout(r, 20))
    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/cancel',
      params: { sessionId },
    })

    const collected: Array<Record<string, unknown>> = []
    let cancelResponse: Record<string, unknown> | null = null
    let promptResponse: Record<string, unknown> | null = null
    while (cancelResponse === null || promptResponse === null) {
      const frame = (await deadline(pipeline.readNextFrame(), 5000, 'cancel')) as Record<string, unknown>
      if (frame.method === 'sessionUpdate') {
        collected.push((frame.params as Record<string, unknown>) ?? {})
      } else if (frame.id === 2) {
        promptResponse = frame
      } else if (frame.id === 3) {
        cancelResponse = frame
      }
    }

    expect((cancelResponse?.result as { ok: boolean }).ok).toBe(true)
    expect((promptResponse?.result as { stopReason: string }).stopReason).toBe('cancelled')
    expect(collected.some((u) => u.type === 'cancelled')).toBe(true)
  })

  test('resume: session/load threads resume option into the next prompt', async () => {
    let observedResume: string | undefined
    const adapter: SdkAdapter = {
      async *query({ options }) {
        observedResume = options.resume
        yield { type: 'result', subtype: 'success' } satisfies SdkMessage
      },
    }
    pipeline = buildPipeline(adapter)

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/load',
      params: { sessionId: 'prior-session', cwd: '/workspace', mcpServers: [] },
    })
    const loadResponse = (await deadline(pipeline.readNextFrame(), 5000, 'session/load')) as {
      result: { sessionId: string }
    }
    expect(loadResponse.result.sessionId).toBe('prior-session')

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'prior-session', prompt: [] },
    })
    let promptResponse: Record<string, unknown> | null = null
    while (promptResponse === null) {
      const frame = (await deadline(pipeline.readNextFrame(), 5000, 'prompt')) as Record<string, unknown>
      if (frame.id === 2) {
        promptResponse = frame
      }
    }
    expect(observedResume).toBe('prior-session')
  })

  test('tool dispatch: tool_use + tool_result land as wire sessionUpdate events', async () => {
    const messages: SdkMessage[] = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'mcp__kodizm__kodizm_create_task',
              input: { title: 'X' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [{ type: 'text', text: 'ok' }],
              is_error: false,
            },
          ],
        },
      },
      { type: 'result', subtype: 'success' },
    ]
    const adapter: SdkAdapter = {
      async *query() {
        for (const m of messages) {
          yield m
        }
      },
    }
    pipeline = buildPipeline(adapter)

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: '/workspace', mcpServers: [] },
    })
    const { sessionId } = ((await pipeline.readNextFrame()) as { result: { sessionId: string } }).result

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    })

    const updates: Array<Record<string, unknown>> = []
    let promptResponse: Record<string, unknown> | null = null
    while (promptResponse === null) {
      const frame = (await deadline(pipeline.readNextFrame(), 5000, 'prompt')) as Record<string, unknown>
      if (frame.method === 'sessionUpdate') {
        updates.push((frame.params as Record<string, unknown>) ?? {})
      } else if (frame.id === 2) {
        promptResponse = frame
      }
    }

    const types = updates.map((u) => u.type)
    expect(types).toContain('tool_call_begin')
    expect(types).toContain('tool_call_end')
  })

  test('schema rejection: malformed session/new returns -32602 InvalidParams', async () => {
    const adapter: SdkAdapter = {
      async *query() {
        yield { type: 'result', subtype: 'success' } satisfies SdkMessage
      },
    }
    pipeline = buildPipeline(adapter)

    await pipeline.sendFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      // cwd missing -> schema rejects
      params: { mcpServers: [] },
    })

    const response = (await deadline(pipeline.readNextFrame(), 5000, 'invalid params')) as {
      id: number
      error: { code: number }
    }
    expect(response.id).toBe(1)
    expect(response.error.code).toBe(-32602)
  })
})
