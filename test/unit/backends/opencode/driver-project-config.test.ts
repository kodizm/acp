import { describe, expect, mock, test } from 'bun:test'

import { OpencodeDriver } from '@/backends/opencode/driver.ts'
import type { OpencodeHttpBridge } from '@/backends/opencode/http-bridge.ts'

/**
 * A checkout Kodizm does not trust must not configure opencode.
 *
 * opencode executes every `.opencode/plugin/*.{ts,js}` in the checkout, in
 * a process whose env carries the provider credentials, unless
 * `OPENCODE_DISABLE_PROJECT_CONFIG` is set. The orchestrator marks an
 * untrusted checkout with `settingSources` that leave out `project`.
 */
function recordingDriver(): { driver: OpencodeDriver; envs: Array<Record<string, string> | undefined> } {
  const envs: Array<Record<string, string> | undefined> = []
  const driver = new OpencodeDriver({
    agentInfo: { version: '0.0.1-project-config' },
    bridgeFactory: (): OpencodeHttpBridge =>
      ({
        start: mock(async (options: { env?: Record<string, string> }) => {
          envs.push(options.env)
          return {
            url: 'http://127.0.0.1:0',
            port: 0,
            sdk: {
              session: {
                create: mock(async () => ({ data: { id: 'ses_fake' } })),
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

  return { driver, envs }
}

describe('OpencodeDriver project config gate', () => {
  test('settingSources without project disables the project layer', async () => {
    const { driver, envs } = recordingDriver()

    await driver.newSession({ cwd: '/tmp/pr', mcpServers: [], settingSources: ['user'] })

    expect(envs[0]?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
  })

  test('simple mode disables it too, whatever settingSources says', async () => {
    const { driver, envs } = recordingDriver()

    await driver.newSession({
      cwd: '/tmp/pr',
      mcpServers: [],
      settingSources: ['user', 'project'],
      features: { simple: true },
    })

    expect(envs[0]?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
  })

  test('a trusted checkout keeps its project config', async () => {
    const { driver, envs } = recordingDriver()

    await driver.newSession({ cwd: '/tmp/own', mcpServers: [], settingSources: ['user', 'project'] })
    await driver.newSession({ cwd: '/tmp/own', mcpServers: [] })

    expect(envs[0]?.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
    expect(envs[1]?.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
  })

  test('a cross-process load carries the gate and the auth of the session it resumes', async () => {
    const { driver, envs } = recordingDriver()

    await driver.loadSession({
      sessionId: 'kodizm-session',
      cwd: '/tmp/pr',
      mcpServers: [],
      settingSources: ['user'],
      _meta: { opencodeSessionId: 'ses_fake', opencodeAuth: '{"p":{"type":"api","key":"k"}}' },
    })

    expect(envs[0]?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(envs[0]?.OPENCODE_AUTH_CONTENT).toBe('{"p":{"type":"api","key":"k"}}')
  })
})
