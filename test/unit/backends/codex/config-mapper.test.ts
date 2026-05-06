import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCodexConfigToml } from '@/backends/codex/config-mapper.ts'

describe('buildCodexConfigToml', () => {
  test('writes TOML with [mcp_servers.<name>] blocks for each canonical MCP server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-cfg-'))
    const sessionId = 'sess-1'
    const path = await buildCodexConfigToml({
      sessionId,
      dir,
      mcpServers: [
        {
          type: 'http',
          name: 'kodizm',
          url: 'https://kodizm.com/mcp/internal',
          headers: [{ name: 'Authorization', value: 'Bearer kdz-int-abc' }],
        },
      ],
    })

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('[mcp_servers.kodizm]')
    expect(content).toContain('url = "https://kodizm.com/mcp/internal"')
    expect(content).toContain('Authorization')
    expect(content).toContain('kdz-int-abc')
    expect(path).toContain(sessionId)
    expect(path.endsWith('.toml')).toBe(true)
  })

  test('produces minimal TOML when no mcpServers are passed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-cfg-'))
    const path = await buildCodexConfigToml({ sessionId: 'sess-2', dir, mcpServers: [] })
    const content = readFileSync(path, 'utf8')
    expect(content).not.toContain('[mcp_servers')
  })

  test('multiple servers produce multiple [mcp_servers.<name>] blocks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-cfg-'))
    const path = await buildCodexConfigToml({
      sessionId: 'sess-3',
      dir,
      mcpServers: [
        { type: 'http', name: 'kodizm', url: 'https://a.com' },
        { type: 'http', name: 'context7', url: 'https://b.com' },
      ],
    })
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('[mcp_servers.kodizm]')
    expect(content).toContain('[mcp_servers.context7]')
  })
})
