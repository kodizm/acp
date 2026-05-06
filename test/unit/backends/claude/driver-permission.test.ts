import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { CanUseToolOptions, PermissionResult } from '@/backends/claude/permission-bridge.ts'
import type { EventEmitter } from '@/backends/driver.ts'

interface CapturedCall {
  method: string
  params: unknown
}

function makeAdapterThatInvokesCanUseTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  capturedResults: PermissionResult[],
): SdkAdapter {
  return {
    async *query(args) {
      const canUseTool = (args.options as { canUseTool?: unknown }).canUseTool as
        | ((t: string, i: Record<string, unknown>, o: CanUseToolOptions) => Promise<PermissionResult>)
        | undefined
      if (canUseTool !== undefined) {
        const result = await canUseTool(toolName, toolInput, {
          signal: new AbortController().signal,
          toolUseID: 'tu_1',
        })
        capturedResults.push(result)
      }
      yield { type: 'result', subtype: 'success' } satisfies SdkMessage
    },
  }
}

function makeServerThatAnswers(method: string, response: unknown) {
  const calls: CapturedCall[] = []
  return {
    calls,
    server: {
      async request<T>(m: string, params: unknown): Promise<T> {
        calls.push({ method: m, params })
        if (m === method) {
          return response as T
        }
        return { outcome: { outcome: 'selected', optionId: 'reject' } } as unknown as T
      },
    },
  }
}

const fakeEmit: EventEmitter = { send: () => {} }

describe('ClaudeDriver canUseTool composition', () => {
  test('AskUserQuestion routes to session/ask_user_question (branch wins)', async () => {
    const captured: PermissionResult[] = []
    const { server, calls } = makeServerThatAnswers('session/ask_user_question', {
      answers: { 'A or B?': 'A' },
    })

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapterThatInvokesCanUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              question: 'A or B?',
              header: 'Pick',
              options: [
                { label: 'A', description: 'Option A' },
                { label: 'B', description: 'Option B' },
              ],
              multiSelect: false,
            },
          ],
        },
        captured,
      ),
      server,
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)

    expect(calls.some((c) => c.method === 'session/ask_user_question')).toBe(true)
    expect(captured[0]?.behavior).toBe('allow')
  })

  test('non-AskUserQuestion tool routes to session/request_permission (fallback)', async () => {
    const captured: PermissionResult[] = []
    const { server, calls } = makeServerThatAnswers('session/request_permission', {
      outcome: { outcome: 'selected', optionId: 'allow' },
    })

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapterThatInvokesCanUseTool('Bash', { command: 'ls' }, captured),
      server,
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)

    expect(calls.some((c) => c.method === 'session/request_permission')).toBe(true)
    expect(captured[0]).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  test('deny short-circuits without affecting subsequent tool gates', async () => {
    const captured: PermissionResult[] = []
    const { server } = makeServerThatAnswers('session/request_permission', {
      outcome: { outcome: 'selected', optionId: 'reject' },
    })

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapterThatInvokesCanUseTool('Bash', {}, captured),
      server,
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)

    expect(captured[0]?.behavior).toBe('deny')
  })

  test('allow_always returns updatedPermissions with session destination', async () => {
    const captured: PermissionResult[] = []
    const { server } = makeServerThatAnswers('session/request_permission', {
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    })

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapterThatInvokesCanUseTool('Bash', {}, captured),
      server,
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    await driver.prompt(sessionId, { sessionId, prompt: [] }, fakeEmit)

    expect(captured[0]?.behavior).toBe('allow')
    if (captured[0]?.behavior === 'allow') {
      expect(captured[0].updatedPermissions?.[0]?.destination).toBe('session')
    }
  })
})
