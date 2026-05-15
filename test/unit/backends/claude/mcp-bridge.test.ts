import { describe, expect, test } from 'bun:test'

import { translateMcpServers } from '@/backends/claude/mcp-bridge.ts'
import type { McpServer } from '@/wire/types.ts'

describe('translateMcpServers', () => {
  test('returns an empty record when the input list is empty', () => {
    expect(translateMcpServers([])).toEqual({})
  })

  test('translates a single http MCP server with Authorization header', () => {
    const input: McpServer[] = [
      {
        type: 'http',
        name: 'kodizm',
        url: 'https://kodizm.com/mcp/internal',
        headers: [{ name: 'Authorization', value: 'Bearer kdz-int-jwt.x.y' }],
      },
    ]

    const sdkServers = translateMcpServers(input)
    expect(sdkServers).toEqual({
      kodizm: {
        type: 'http',
        url: 'https://kodizm.com/mcp/internal',
        alwaysLoad: true,
        headers: { Authorization: 'Bearer kdz-int-jwt.x.y' },
      },
    })
  })

  test('omits headers field when no headers are provided', () => {
    const input: McpServer[] = [
      {
        type: 'http',
        name: 'public',
        url: 'https://public.example.com/mcp',
      },
    ]

    const sdkServers = translateMcpServers(input)
    expect(sdkServers.public).toEqual({
      type: 'http',
      url: 'https://public.example.com/mcp',
      alwaysLoad: true,
    })
    expect('headers' in (sdkServers.public ?? {})).toBe(false)
  })

  test('preserves multi-header order via the SDK record (last-write-wins on key collision)', () => {
    const input: McpServer[] = [
      {
        type: 'http',
        name: 'kodizm',
        url: 'https://kodizm.com/mcp/internal',
        headers: [
          { name: 'Authorization', value: 'Bearer X' },
          { name: 'X-Trace-Id', value: 'trace-abc' },
        ],
      },
    ]

    const sdkServers = translateMcpServers(input)
    expect(sdkServers.kodizm?.headers).toEqual({
      Authorization: 'Bearer X',
      'X-Trace-Id': 'trace-abc',
    })
  })

  test('forces alwaysLoad: true so SDK eager-connects and skips deferred-tool defer', () => {
    // Without alwaysLoad, the SDK treats MCP tools as deferred and the agent
    // must discover them via ToolSearch. In Kodizm's deployment the kodizm
    // server is mandatory (memories / tasks / project-state) so we always
    // want the tools surfaced in the initial tools/list. The SDK's
    // `_meta.anthropic/alwaysLoad` flag bypasses defer-loading at registration
    // time and forces a synchronous connect during SDK startup.
    const input: McpServer[] = [
      {
        type: 'http',
        name: 'kodizm',
        url: 'https://kodizm.com/mcp/internal',
        headers: [{ name: 'Authorization', value: 'Bearer kdz-int-jwt.x.y' }],
      },
    ]

    const sdkServers = translateMcpServers(input)
    expect(sdkServers.kodizm?.alwaysLoad).toBe(true)
  })

  test('translates multiple servers into a name-keyed record', () => {
    const input: McpServer[] = [
      {
        type: 'http',
        name: 'kodizm',
        url: 'https://kodizm.com/mcp/internal',
      },
      {
        type: 'http',
        name: 'github',
        url: 'https://api.github.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer gh-pat' }],
      },
    ]

    const sdkServers = translateMcpServers(input)
    expect(Object.keys(sdkServers).sort()).toEqual(['github', 'kodizm'])
    expect(sdkServers.github?.url).toBe('https://api.github.com/mcp')
    expect(sdkServers.kodizm?.url).toBe('https://kodizm.com/mcp/internal')
  })
})
