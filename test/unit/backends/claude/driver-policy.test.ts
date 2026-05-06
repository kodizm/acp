import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'

interface ObservedOptions {
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  env?: Record<string, string>
  canUseTool?: unknown
}

function makeAdapter(observed: ObservedOptions[]): SdkAdapter {
  return {
    async *query(args) {
      const opts = args.options as unknown as Record<string, unknown>
      observed.push({
        permissionMode: opts.permissionMode as string | undefined,
        allowedTools: opts.allowedTools as string[] | undefined,
        disallowedTools: opts.disallowedTools as string[] | undefined,
        env: opts.env as Record<string, string> | undefined,
        canUseTool: opts.canUseTool,
      })
      yield { type: 'result', subtype: 'success' } satisfies SdkMessage
    },
  }
}

function makeDriver(adapter: SdkAdapter, withServer = false): ClaudeDriver {
  return new ClaudeDriver({
    credentials: { type: 'api-key', token: 'sk-test' },
    agentInfo: { version: '0.0.1-test' },
    sdk: adapter,
    ...(withServer
      ? {
          server: {
            async request<T>(): Promise<T> {
              return { outcome: { outcome: 'selected', optionId: 'allow' } } as unknown as T
            },
          },
        }
      : {}),
  })
}

const fakeEmit: EventEmitter = { send: () => {} }

describe('ClaudeDriver, default permissionMode is bypassPermissions', () => {
  test('omitted toolPolicy yields permissionMode bypassPermissions', async () => {
    const observed: ObservedOptions[] = []
    const driver = makeDriver(makeAdapter(observed))
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)
    expect(observed[0]?.permissionMode).toBe('bypassPermissions')
  })
})

describe('ClaudeDriver, toolPolicy threads to SDK', () => {
  test('allow + deny + defaultMode all surface on options', async () => {
    const observed: ObservedOptions[] = []
    const driver = makeDriver(makeAdapter(observed))
    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: {
        allow: ['Read', 'Bash:git commit*'],
        deny: ['Bash:git push*'],
        defaultMode: 'dontAsk',
      },
    })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)
    expect(observed[0]?.permissionMode).toBe('dontAsk')
    expect(observed[0]?.allowedTools).toEqual(['Read', 'Bash(git commit:*)'])
    expect(observed[0]?.disallowedTools).toEqual(['Bash(git push:*)'])
  })
})

describe('ClaudeDriver, autoCompact=false threads DISABLE_AUTO_COMPACT env', () => {
  test('env carries DISABLE_AUTO_COMPACT=1 when opt-out is set', async () => {
    const observed: ObservedOptions[] = []
    const driver = makeDriver(makeAdapter(observed))
    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      autoCompact: false,
    })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)
    expect(observed[0]?.env?.DISABLE_AUTO_COMPACT).toBe('1')
  })

  test('autoCompact omitted leaves env untouched', async () => {
    const observed: ObservedOptions[] = []
    const driver = makeDriver(makeAdapter(observed))
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)
    expect(observed[0]?.env).toBeUndefined()
  })
})

describe('ClaudeDriver, canUseTool wired only when server is present', () => {
  test('canUseTool is set when deps.server is provided', async () => {
    const observed: ObservedOptions[] = []
    const driver = makeDriver(makeAdapter(observed), true)
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)
    expect(typeof observed[0]?.canUseTool).toBe('function')
  })

  test('canUseTool is omitted when deps.server is missing (legacy path)', async () => {
    const observed: ObservedOptions[] = []
    const driver = makeDriver(makeAdapter(observed), false)
    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)
    expect(observed[0]?.canUseTool).toBeUndefined()
  })
})
