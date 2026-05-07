/**
 * Minimal HTTP MCP server fixture for integration tests.
 *
 * Implements just enough of the streamable-HTTP MCP transport for
 * codex's rmcp-client to:
 *   1. initialize the session
 *   2. tools/list -> one synthetic tool
 *   3. tools/call -> echo the input back
 *
 * The fixture is intentionally tiny: no authentication, no SSE
 * notifications back from server to client, no resources, no prompts.
 * It exists so the codex driver's mcpServers config can point at it
 * and the model can invoke a known tool deterministically.
 */

import { randomUUID } from 'node:crypto'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

export interface FixtureToolCall {
  name: string
  arguments: unknown
}

export interface McpFixture {
  url: string
  port: number
  toolName: string
  receivedCalls: FixtureToolCall[]
  stop: () => Promise<void>
}

export interface ElicitOptions {
  /**
   * When set, every tools/call FIRST emits an `elicitation/create`
   * server→client request via the SSE response, waits for the client's
   * answer, and only then returns the actual tool result.
   */
  elicitMessage: string
}

/**
 * Spawn the fixture on an ephemeral port. Returns once the listener
 * is ready to accept connections.
 */
export async function startMcpFixture(opts?: {
  toolName?: string
  toolDescription?: string
  toolResult?: string
  elicit?: ElicitOptions
}): Promise<McpFixture> {
  const toolName = opts?.toolName ?? 'kodizm_echo'
  const description = opts?.toolDescription ?? 'Echo a marker so the orchestrator can verify the tool ran.'
  const toolResult = opts?.toolResult ?? 'KODIZM_MCP_FIXTURE_RAN'
  const elicit = opts?.elicit
  const sessionId = randomUUID()
  const receivedCalls: FixtureToolCall[] = []
  // Pending elicit responses keyed by elicit message id. Resolved when
  // the client posts an answer matching the id.
  const pendingElicits = new Map<number, (resp: unknown) => void>()
  let nextElicitId = 9000

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== '/mcp') {
        return new Response('not found', { status: 404 })
      }
      // GET is used for the optional server->client SSE channel; we
      // return 405 so codex falls back to POST-only.
      if (req.method === 'GET') {
        return new Response('method not allowed', { status: 405 })
      }
      if (req.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }

      let body: JsonRpcRequest
      try {
        body = (await req.json()) as JsonRpcRequest
      } catch {
        return new Response('bad json', { status: 400 })
      }

      const respond = (result: unknown): Response => {
        const envelope: JsonRpcResponse = { jsonrpc: '2.0', id: body.id ?? null, result }
        return new Response(JSON.stringify(envelope), {
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': sessionId,
          },
        })
      }

      // notifications: id absent. Client sends 'notifications/initialized'
      // after the initialize handshake; we ack with 202. We also accept
      // elicit responses (notification-style result frames) and resolve
      // the pending promise keyed by their `id`.
      if (body.id === undefined) {
        // The client may post a JSON-RPC response (id + result/error
        // shape) at the top level when answering a server-initiated
        // request. The shape arrives without the `method` field.
        const rb = body as unknown as { id?: number; result?: unknown; error?: unknown }
        if (typeof rb.id === 'number' && (rb.result !== undefined || rb.error !== undefined)) {
          const pending = pendingElicits.get(rb.id)
          if (pending !== undefined) {
            pendingElicits.delete(rb.id)
            pending(rb.result ?? rb.error)
          }
        }
        return new Response(null, { status: 202 })
      }
      // Top-level JSON-RPC response (rare but spec-allowed): the
      // client answers a server request with `{id, result|error}` at
      // top level + no jsonrpc method. Treat as an elicit response.
      if ('result' in body || 'error' in body) {
        const rb = body as unknown as { id: number; result?: unknown; error?: unknown }
        const pending = pendingElicits.get(rb.id)
        if (pending !== undefined) {
          pendingElicits.delete(rb.id)
          pending(rb.result ?? rb.error)
        }
        return new Response(null, { status: 202 })
      }

      switch (body.method) {
        case 'initialize':
          return respond({
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'kodizm-mcp-fixture', version: '0.0.1' },
          })
        case 'tools/list':
          return respond({
            tools: [
              {
                name: toolName,
                description,
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', description: 'Free-form payload to log.' },
                  },
                  additionalProperties: false,
                },
              },
            ],
          })
        case 'tools/call': {
          const params = body.params as { name?: string; arguments?: unknown }
          if (params?.name !== toolName) {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id ?? null,
                error: { code: -32601, message: `unknown tool: ${params?.name}` },
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          }
          receivedCalls.push({ name: params.name, arguments: params.arguments })

          // Plain (no elicit) path: respond synchronously.
          if (elicit === undefined) {
            return respond({
              content: [{ type: 'text', text: toolResult }],
              isError: false,
            })
          }

          // Elicit-enabled path: stream an SSE response. First we
          // emit the server-initiated `elicitation/create` request,
          // wait for the client to POST a response (matching id),
          // then emit the final tools/call result and close.
          const elicitId = nextElicitId++
          const callId = body.id
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder()
              const sendSseFrame = (frame: unknown) => {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`))
              }
              sendSseFrame({
                jsonrpc: '2.0',
                id: elicitId,
                method: 'elicitation/create',
                params: {
                  message: elicit.elicitMessage,
                  requestedSchema: { type: 'object', properties: {} },
                },
              })
              // Wait for the client to answer. Resolve when the POST
              // handler matches the elicitId.
              const settle = new Promise<unknown>((resolve) => {
                pendingElicits.set(elicitId, resolve)
              })
              void settle.then((elicitResp) => {
                sendSseFrame({
                  jsonrpc: '2.0',
                  id: callId ?? null,
                  result: {
                    content: [{ type: 'text', text: `${toolResult} (elicit answered: ${JSON.stringify(elicitResp)})` }],
                    isError: false,
                  },
                })
                controller.close()
              })
            },
          })
          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
              'mcp-session-id': sessionId,
            },
          })
        }
        case 'ping':
          return respond({})
        default:
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id ?? null,
              error: { code: -32601, message: `method not found: ${body.method}` },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
      }
    },
  })

  const port = server.port ?? 0
  const url = `http://localhost:${port}/mcp`
  return {
    url,
    port,
    toolName,
    receivedCalls,
    stop: async () => {
      server.stop(true)
    },
  }
}
