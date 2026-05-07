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

/**
 * Spawn the fixture on an ephemeral port. Returns once the listener
 * is ready to accept connections.
 */
export async function startMcpFixture(opts?: {
  toolName?: string
  toolDescription?: string
  toolResult?: string
}): Promise<McpFixture> {
  const toolName = opts?.toolName ?? 'kodizm_echo'
  const description = opts?.toolDescription ?? 'Echo a marker so the orchestrator can verify the tool ran.'
  const toolResult = opts?.toolResult ?? 'KODIZM_MCP_FIXTURE_RAN'
  const sessionId = randomUUID()
  const receivedCalls: FixtureToolCall[] = []

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
      // after the initialize handshake; we ack with 202.
      if (body.id === undefined) {
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
          if (params?.name === toolName) {
            receivedCalls.push({ name: params.name, arguments: params.arguments })
            return respond({
              content: [{ type: 'text', text: toolResult }],
              isError: false,
            })
          }
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id ?? null,
              error: { code: -32601, message: `unknown tool: ${params?.name}` },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
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

  const url = `http://localhost:${server.port}/mcp`
  return {
    url,
    port: server.port,
    toolName,
    receivedCalls,
    stop: async () => {
      server.stop(true)
    },
  }
}
