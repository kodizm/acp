import { describe, expect, test } from 'bun:test'

import { type OpencodeMcpAdd, buildOpencodeMcpAdds, reverseToolName } from '@/backends/opencode/mcp-mapper.ts'
import type { McpServer } from '@/wire/types.ts'

/**
 * Phase 3 Task 5: canonical mcpServers -> opencode MCP shape.
 *
 * Locked decision D6: opencode native tool format is
 * `sanitize(server) + "_" + sanitize(tool)` (single underscore);
 * canonical wire is `mcp__<server>__<tool>` (double underscore).
 * Driver maps both directions.
 */
describe('buildOpencodeMcpAdds', () => {
  test('http canonical entry translates to remote opencode config + records reverse map', () => {
    const servers: McpServer[] = [
      {
        type: 'http',
        name: 'kodizm',
        url: 'https://kodizm.com/mcp/internal',
        headers: [{ name: 'Authorization', value: 'Bearer kdz-int-jwt.x.y' }],
      },
    ]

    const result = buildOpencodeMcpAdds(servers)

    expect(result.adds).toHaveLength(1)
    const entry = result.adds[0] as OpencodeMcpAdd
    expect(entry.name).toBe('kodizm')
    expect(entry.config).toEqual({
      type: 'remote',
      url: 'https://kodizm.com/mcp/internal',
      headers: { Authorization: 'Bearer kdz-int-jwt.x.y' },
    })

    expect(result.reverseMap.get('kodizm')).toBe('kodizm')
  })

  test('server name with non-alphanumerics sanitizes for opencode tool key + reverse map', () => {
    const servers: McpServer[] = [
      {
        type: 'http',
        name: 'kodizm.staging',
        url: 'https://staging.kodizm.com/mcp',
        headers: [],
      },
    ]
    const result = buildOpencodeMcpAdds(servers)
    expect(result.adds[0]?.name).toBe('kodizm.staging') // opencode keeps original `name` for the add() call
    expect(result.reverseMap.get('kodizm_staging')).toBe('kodizm.staging')
  })

  test('multiple headers collapse into a single Record<string,string>', () => {
    const servers: McpServer[] = [
      {
        type: 'http',
        name: 'agent',
        url: 'https://example.com/mcp',
        headers: [
          { name: 'Authorization', value: 'Bearer abc' },
          { name: 'X-Trace', value: 'trace-1' },
        ],
      },
    ]
    const result = buildOpencodeMcpAdds(servers)
    expect(result.adds[0]?.config).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: {
        Authorization: 'Bearer abc',
        'X-Trace': 'trace-1',
      },
    })
  })

  test('empty mcpServers list yields empty adds + empty reverseMap', () => {
    const result = buildOpencodeMcpAdds([])
    expect(result.adds).toEqual([])
    expect(result.reverseMap.size).toBe(0)
  })
})

describe('reverseToolName', () => {
  test('opencode <sanitizedServer>_<tool> resolves to canonical mcp__<server>__<tool>', () => {
    const reverseMap = new Map([['kodizm', 'kodizm']])
    expect(reverseToolName('kodizm_search-docs', reverseMap)).toBe('mcp__kodizm__search-docs')
  })

  test('longest-prefix-match handles servers with shared prefixes', () => {
    const reverseMap = new Map([
      ['kodizm', 'kodizm'],
      ['kodizm_staging', 'kodizm.staging'],
    ])
    // Tool name `kodizm_staging_run` should match the longer prefix
    // first.
    expect(reverseToolName('kodizm_staging_run', reverseMap)).toBe('mcp__kodizm.staging__run')
    // Tool name `kodizm_search` should match the shorter prefix.
    expect(reverseToolName('kodizm_search', reverseMap)).toBe('mcp__kodizm__search')
  })

  test('native opencode tool IDs (no underscore prefix from MCP) return null', () => {
    const reverseMap = new Map([['kodizm', 'kodizm']])
    expect(reverseToolName('bash', reverseMap)).toBeNull()
    expect(reverseToolName('apply_patch', reverseMap)).toBeNull()
  })

  test('round-trip: canonical mcp__server__tool -> opencode -> canonical', () => {
    const servers: McpServer[] = [{ type: 'http', name: 'kodizm', url: 'https://x.test/mcp', headers: [] }]
    const { reverseMap } = buildOpencodeMcpAdds(servers)
    const opencodeTool = 'kodizm_search-docs'
    const canonical = reverseToolName(opencodeTool, reverseMap)
    expect(canonical).toBe('mcp__kodizm__search-docs')
  })
})
