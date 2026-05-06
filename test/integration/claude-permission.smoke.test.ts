/**
 * Real Claude API permission flow smoke. Two production-aligned
 * scenarios:
 *
 *  1. Kodizm default (bypassPermissions): Bash runs without any
 *     permission RPC; orchestrator never asked.
 *  2. dontAsk + Read-only allowlist: Bash invocation is rejected
 *     at the SDK boundary; the RPC fake server should NEVER be
 *     called for Bash (SDK denies via the rule machinery before
 *     canUseTool is reached).
 *
 * canUseTool runtime path is exercised by the unit tests
 * (driver-permission.test.ts + permission-bridge.test.ts); SDK's
 * internal `tool.checkPermissions` auto-allow on benign Bash
 * commands like `pwd` makes a forced canUseTool roundtrip in
 * real-API smokes unreliable, so we focus this file on the wire
 * shapes the orchestrator actually relies on in production.
 */

import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

import { HAS_AUTH } from './_helpers.ts'

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''

interface CapturedRpc {
  method: string
  params: unknown
}

function makeFakeServer(answer: (method: string) => unknown): {
  server: AcpServerLike
  calls: CapturedRpc[]
} {
  const calls: CapturedRpc[] = []
  return {
    calls,
    server: {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        return answer(method) as T
      },
    },
  }
}

async function buildRealAdapter(): Promise<SdkAdapter> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    async *query(args) {
      for await (const message of sdk.query(args as never)) {
        yield message as SdkMessage
      }
    },
  }
}

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

function pickCredentials() {
  if (OAUTH_TOKEN.length > 0) {
    return { type: 'subscription' as const, token: OAUTH_TOKEN }
  }
  return { type: 'api-key' as const, token: API_KEY }
}

describe.skipIf(!HAS_AUTH)('real Claude API permission smoke', () => {
  test('Kodizm default (bypassPermissions) -> Bash runs, NO permission RPC issued', async () => {
    const adapter = await buildRealAdapter()
    const { server, calls } = makeFakeServer(() => ({
      outcome: { outcome: 'selected', optionId: 'reject' },
    }))

    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapter,
      server,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: 'claude-sonnet-4-6',
      // No toolPolicy -> driver default = bypassPermissions
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Run `pwd` using the Bash tool. Reply with EXACTLY the directory it printed.',
          },
        ],
      },
      emit,
    )

    // Bypass mode: no permission RPC issued even though the model
    // ran a tool.
    const permissionCalls = calls.filter((c) => c.method === 'session/request_permission')
    expect(permissionCalls.length).toBe(0)

    // Tool actually executed (proof bypassPermissions worked).
    const toolBegins = events.filter((e) => e.type === 'tool_call_begin')
    expect(toolBegins.length).toBeGreaterThan(0)
  }, 60_000)

  test('dontAsk + Read-only allowlist -> Write attempt fails (no canUseTool fired)', async () => {
    const adapter = await buildRealAdapter()
    const { server, calls } = makeFakeServer(() => ({
      outcome: { outcome: 'selected', optionId: 'allow' },
    }))

    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-smoke' },
      sdk: adapter,
      server,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: 'claude-sonnet-4-6',
      toolPolicy: {
        allow: ['Read', 'Glob', 'Grep'],
        defaultMode: 'dontAsk',
      },
    })

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the Write tool to create /tmp/kodizm-perm-blocked.txt with content "x". If you cannot, reply ONLY "blocked".',
          },
        ],
      },
      emit,
    )

    // Whatever the model does, the orchestrator's permission RPC
    // should NOT have been called for Write (SDK denies via rule
    // machinery before canUseTool).
    const permissionCalls = calls.filter((c) => c.method === 'session/request_permission')
    const writePermissions = permissionCalls.filter(
      (c) => (c.params as { toolCall?: { title?: string } }).toolCall?.title === 'Write',
    )
    expect(writePermissions.length).toBe(0)

    // No successful Write tool_call_end (file was not created).
    const writeSuccesses = events.filter(
      (e) =>
        e.type === 'tool_call_end' &&
        events.some(
          (b) => b.type === 'tool_call_begin' && b.name === 'Write' && b.toolUseId === e.toolUseId,
        ) &&
        e.isError === false,
    )
    expect(writeSuccesses.length).toBe(0)
  }, 60_000)
})

describe.skipIf(HAS_AUTH)('real Claude API permission smoke (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
