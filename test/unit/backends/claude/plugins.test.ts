import { describe, expect, mock, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import { OpencodeDriver } from '@/backends/opencode/driver.ts'
import type { OpencodeHttpBridge } from '@/backends/opencode/http-bridge.ts'

function makeDriver(onCall?: (options: Record<string, unknown>) => void): ClaudeDriver {
  const sdk: SdkAdapter = {
    async *query(args) {
      onCall?.(args.options as unknown as Record<string, unknown>)
      yield { type: 'result', subtype: 'success' } satisfies SdkMessage
    },
  }

  return new ClaudeDriver({
    credentials: { type: 'api-key', token: 'sk-ant-fake' },
    agentInfo: { version: '0.0.1-test' },
    sdk,
  })
}

describe('ClaudeDriver plugins', () => {
  test('session/new forwards each path as a local SDK plugin', () => {
    const options = makeDriver().buildSdkOptions({
      cwd: '/workspace',
      mcpServers: [],
      plugins: ['/opt/kodizm/plugins/ac-lsp', '/opt/kodizm/plugins/other'],
    })

    expect(options.plugins).toEqual([
      { type: 'local', path: '/opt/kodizm/plugins/ac-lsp' },
      { type: 'local', path: '/opt/kodizm/plugins/other' },
    ])
  })

  test('no plugins on the wire means no plugins option', () => {
    const options = makeDriver().buildSdkOptions({ cwd: '/workspace', mcpServers: [] })

    expect('plugins' in options).toBe(false)
  })

  test('an empty list is dropped', () => {
    const options = makeDriver().buildSdkOptions({ cwd: '/workspace', mcpServers: [], plugins: [] })

    expect('plugins' in options).toBe(false)
  })

  test('session/load carries plugins into the resumed query', async () => {
    let observed: Record<string, unknown> | undefined
    const driver = makeDriver((options) => {
      observed = options
    })

    await driver.loadSession({
      sessionId: 'prior-session',
      cwd: '/workspace',
      mcpServers: [],
      plugins: ['/opt/kodizm/plugins/ac-lsp'],
    })
    await driver.prompt('prior-session', { sessionId: 'prior-session', prompt: [] }, { send: () => {} })

    expect(observed?.resume).toBe('prior-session')
    expect(observed?.plugins).toEqual([{ type: 'local', path: '/opt/kodizm/plugins/ac-lsp' }])
  })
})

describe('OpencodeDriver plugins', () => {
  test('the field is ignored: nothing about it reaches the opencode server', async () => {
    const seen: unknown[] = []
    const driver = new OpencodeDriver({
      agentInfo: { version: '0.0.1-plugins' },
      bridgeFactory: (): OpencodeHttpBridge =>
        ({
          start: mock(async (options: unknown) => {
            seen.push(options)
            return {
              url: 'http://127.0.0.1:0',
              port: 0,
              sdk: {
                session: {
                  create: mock(async (args: unknown) => {
                    seen.push(args)
                    return { data: { id: 'ses_fake' } }
                  }),
                  get: mock(async () => ({ data: { id: 'ses_fake' } })),
                  abort: mock(async () => ({})),
                },
              },
            }
          }),
          stop: mock(async () => undefined),
          isRunning: () => true,
        }) as unknown as OpencodeHttpBridge,
    })

    await driver.newSession({ cwd: '/workspace', mcpServers: [], plugins: ['/opt/kodizm/plugins/ac-lsp'] })

    expect(seen.length).toBeGreaterThan(0)
    expect(JSON.stringify(seen)).not.toContain('plugins')
  })
})
