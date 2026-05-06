/**
 * MCP server bridge: Kodizm canonical wire shape -> Claude SDK shape.
 *
 * The orchestrator sends MCP servers as a list of typed entries with
 * an explicit `headers: [{name, value}]` array (so the wire shape is
 * deterministic and order-stable). The Claude SDK's
 * `Options.mcpServers` is a name-keyed record where headers are a
 * single `Record<string, string>`. This module converts between the
 * two without losing order or duplicating any per-header validation.
 */

import type { McpServer } from '../../wire/types.ts'

/**
 * Subset of the Claude SDK's `McpHttpServerConfig` we need. Defining
 * it locally avoids a transitive dep on the SDK's exported types
 * just for this bridge.
 */
export interface ClaudeSdkMcpServer {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

/**
 * Translate the Kodizm canonical MCP server list to the Claude SDK's
 * keyed record. Empty input returns an empty record (the SDK accepts
 * either an absent `mcpServers` option or an empty record).
 *
 * @param servers - Kodizm canonical MCP server list from session/new
 * @returns name-keyed record matching the SDK's `Options.mcpServers`
 */
export function translateMcpServers(servers: ReadonlyArray<McpServer>): Record<string, ClaudeSdkMcpServer> {
  const out: Record<string, ClaudeSdkMcpServer> = {}

  for (const server of servers) {
    out[server.name] = buildSdkServer(server)
  }

  return out
}

/**
 * Build a single SDK MCP server entry from a wire-shape McpServer.
 * Headers list collapses into a record; absent headers omit the
 * field entirely so the SDK's defaults apply.
 */
function buildSdkServer(server: McpServer): ClaudeSdkMcpServer {
  const sdkServer: ClaudeSdkMcpServer = {
    type: server.type,
    url: server.url,
  }

  if (server.headers !== undefined && server.headers.length > 0) {
    const headers: Record<string, string> = {}
    for (const entry of server.headers) {
      headers[entry.name] = entry.value
    }
    sdkServer.headers = headers
  }

  return sdkServer
}
