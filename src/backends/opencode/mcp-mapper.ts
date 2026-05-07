/**
 * Canonical mcpServers -> opencode MCP shape translator (forward) +
 * opencode tool name -> canonical name resolver (reverse).
 *
 * Phase 3 T5 + locked decision D6. Forward: produces the shape
 * `MCP.Service.add(name, ConfigMCP.Info)` expects. Reverse: maps
 * opencode's `<sanitizedServer>_<tool>` tool keys back to canonical
 * `mcp__<originalServer>__<tool>` so events / permission requests
 * carry stable orchestrator-facing names regardless of opencode's
 * internal sanitization.
 *
 * Native opencode tool IDs (`bash`, `edit`, etc.) do NOT match the
 * reverse map; the resolver returns null so callers know to emit the
 * native ID unprefixed.
 */

import type { McpServer } from '../../wire/types.ts'

/**
 * One opencode MCP add entry. `name` is the opencode-side server
 * name (passed verbatim to `MCP.Service.add(name, config)`); `config`
 * is the discriminated union opencode reads. Phase 3 ships only
 * `remote` since canonical wire is HTTP-only (`McpServerSchema`
 * `type: 'http'`); future stdio support extends the union.
 */
export interface OpencodeMcpAdd {
  name: string
  config: OpencodeMcpRemoteConfig
}

/**
 * Mirror of `references/opencode/packages/opencode/src/config/mcp.ts::Remote`.
 * The opencode SDK accepts this shape on `MCP.Service.add(name, config)`.
 */
export interface OpencodeMcpRemoteConfig {
  type: 'remote'
  url: string
  headers?: Record<string, string>
}

/**
 * Result bundle: forward adds + the reverse-lookup map the
 * event-mapper uses to rebuild canonical `mcp__<server>__<tool>`
 * names from opencode's `<sanitizedServer>_<tool>` keys.
 */
export interface BuildOpencodeMcpAddsResult {
  adds: ReadonlyArray<OpencodeMcpAdd>
  /** sanitized server name -> original (un-sanitized) server name. */
  reverseMap: Map<string, string>
}

/**
 * Translate canonical mcpServers list to the opencode `MCP.add`
 * shape and build the reverse name map. The driver calls
 * `sdk.mcp.<add>(name, config)` for each entry after `session.create`.
 *
 * @param servers - canonical mcpServers list (HTTP-only in Phase 1)
 * @returns adds + reverse map; both are empty when `servers.length === 0`
 */
export function buildOpencodeMcpAdds(servers: ReadonlyArray<McpServer>): BuildOpencodeMcpAddsResult {
  const adds: OpencodeMcpAdd[] = []
  const reverseMap = new Map<string, string>()

  for (const server of servers) {
    // 1. Collapse the canonical headers tuple into the opencode
    //    Record<string,string> shape.
    const headers: Record<string, string> = {}
    if (server.headers !== undefined) {
      for (const header of server.headers) {
        headers[header.name] = header.value
      }
    }

    const config: OpencodeMcpRemoteConfig = {
      type: 'remote',
      url: server.url,
      ...(server.headers !== undefined && server.headers.length > 0 ? { headers } : {}),
    }

    // 2. Forward entry: opencode's MCP.Service.add() takes the original
    //    server name + the config. opencode internally sanitizes the
    //    name when building tool keys; we keep `name` as-is so the
    //    add() call hits the user's chosen identifier.
    adds.push({ name: server.name, config })

    // 3. Reverse map: opencode's tool key prefix is the SANITIZED
    //    server name, so we index by the sanitized form.
    const sanitized = sanitize(server.name)
    reverseMap.set(sanitized, server.name)
  }

  return { adds, reverseMap }
}

/**
 * Translate an opencode tool key (`<sanitizedServer>_<tool>`) back to
 * the canonical `mcp__<originalServer>__<tool>` form. Returns null
 * when the key does not match any known MCP server prefix in the
 * map (i.e. it is a native opencode tool like `bash`).
 *
 * Uses longest-prefix-match so servers with shared prefixes (e.g.
 * `kodizm` + `kodizm_staging`) resolve correctly.
 *
 * @param opencodeName - opencode's tool key, e.g. `kodizm_search-docs`
 * @param reverseMap   - the map produced by {@link buildOpencodeMcpAdds}
 * @returns canonical name `mcp__<server>__<tool>`, or null when the
 *          name is a native opencode tool
 */
export function reverseToolName(opencodeName: string, reverseMap: Map<string, string>): string | null {
  // 1. Try every server prefix; pick the longest match so kodizm vs
  //    kodizm_staging both resolve to their respective servers.
  let bestSanitized: string | null = null
  for (const sanitized of reverseMap.keys()) {
    const prefix = `${sanitized}_`
    if (!opencodeName.startsWith(prefix)) continue
    if (bestSanitized === null || sanitized.length > bestSanitized.length) {
      bestSanitized = sanitized
    }
  }

  if (bestSanitized === null) {
    return null
  }

  const original = reverseMap.get(bestSanitized)
  if (original === undefined) {
    return null
  }

  const tool = opencodeName.slice(bestSanitized.length + 1)
  return `mcp__${original}__${tool}`
}

/**
 * Apply opencode's MCP name sanitization. Mirrors
 * `references/opencode/packages/opencode/src/mcp/index.ts:115`.
 */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}
