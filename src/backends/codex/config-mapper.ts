/**
 * Build the temp `~/.codex/config.toml`-shaped file the codex
 * subprocess loads via `--config <path>` (locked decision 8).
 *
 * Phase 2 T3. The orchestrator passes canonical `mcpServers` array
 * inline on `session/new`; this module serializes it as
 * `[mcp_servers.<name>]` blocks per codex's TOML config schema.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { McpServer } from '../../wire/types.ts'

export interface BuildCodexConfigTomlArgs {
  /**
   * Kodizm session id; used to name the temp file so it's unique
   * per session and easy to identify on disk.
   */
  sessionId: string
  /**
   * Output directory; the bin passes `os.tmpdir()` in production.
   * Tests pass a per-test dir to keep outputs isolated.
   */
  dir: string
  /**
   * Canonical MCP server array from NewSessionRequest.
   */
  mcpServers: ReadonlyArray<McpServer>
}

/**
 * Write the temp config.toml to disk and return the absolute path.
 * Caller is responsible for cleanup on container exit (the bin's
 * shutdown hook deletes the file).
 *
 * @returns absolute path to the written config.toml
 */
export async function buildCodexConfigToml(args: BuildCodexConfigTomlArgs): Promise<string> {
  const path = join(args.dir, `${args.sessionId}.codex-config.toml`)
  const lines: string[] = []

  for (const server of args.mcpServers) {
    lines.push(`[mcp_servers.${server.name}]`)
    lines.push(`url = ${JSON.stringify(server.url)}`)
    if (server.headers !== undefined && server.headers.length > 0) {
      const headerObj: Record<string, string> = {}
      for (const header of server.headers) {
        headerObj[header.name] = header.value
      }
      // TOML inline-table for headers; keys are bare when alphanumeric
      // and quoted otherwise. Use JSON.stringify for safe quoting.
      const inline = Object.entries(headerObj)
        .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
        .join(', ')
      lines.push(`headers = { ${inline} }`)
    }
    lines.push('')
  }

  await writeFile(path, lines.join('\n'))
  return path
}
