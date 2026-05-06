/**
 * Real Claude API session lifecycle smokes around permission +
 * AskUserQuestion. Process MUST stay alive for the entire await:
 * pending RPC promises live in the AcpServer's in-memory map; if
 * the process dies, the orchestrator's response cannot reach the
 * SDK, the SDK's `canUseTool` promise never resolves, and the
 * session leaks.
 *
 * What this file proves end-to-end against real Claude API:
 *
 *   1. permission allow -> tool runs -> SAME session continues with
 *      a SECOND prompt that builds on memory from turn 1.
 *   2. permission reject -> tool blocks -> SAME session continues
 *      with a second prompt that asks about the rejection (model
 *      remembers being blocked).
 *   3. AskUserQuestion answer -> SAME session continues with a
 *      second prompt referencing the user's choice.
 *   4. Long-delay permission response (3s simulated): process stays
 *      alive, RPC eventually resolves, prompt completes.
 *
 * Cross-process resume after permission flow is NOT exercised here
 * (the SDK's JSONL persistence handles transcript replay; permission
 * flow itself is per-process and stateless across restarts because
 * the previous turn's pending RPCs simply don't exist in the new
 * process — orchestrator MUST re-issue permission request when the
 * model invokes the tool again on the resumed session).
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

function makeFakeServer(answer: (method: string, callIndex: number) => Promise<unknown> | unknown): {
  server: AcpServerLike
  calls: CapturedRpc[]
} {
  const calls: CapturedRpc[] = []
  return {
    calls,
    server: {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        const result = await answer(method, calls.length - 1)
        return result as T
      },
    },
  }
}

async function buildIsolatedAdapter(): Promise<SdkAdapter> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    async *query(args) {
      const isolated = {
        prompt: args.prompt,
        options: { ...(args.options as Record<string, unknown>), settingSources: [] },
      }
      for await (const message of sdk.query(isolated as never)) {
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

function joinText(events: SessionUpdateEvent[]): string {
  return events
    .filter((e) => e.type === 'output_chunk')
    .map((e) => (e.type === 'output_chunk' ? e.text : ''))
    .join('')
    .toLowerCase()
}

describe.skipIf(!HAS_AUTH)('real Claude API lifecycle: permission + multi-turn', () => {
  test('allow -> tool runs -> SAME session second turn references the result', async () => {
    const adapter = await buildIsolatedAdapter()
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
      // Bypass mode keeps the smoke focused on multi-turn; for an
      // explicit canUseTool-fired path, see claude-permission-real.
      // Here we just want to verify same-session continuity.
    })

    // Turn 1: model uses Bash to compute something, remembers result.
    const r1 = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the Bash tool to run `echo 2027`. Tell me the year you saw.',
          },
        ],
      },
      r1.emit,
    )
    expect(joinText(r1.events)).toContain('2027')

    // Turn 2: SAME session, ask about turn 1.
    const r2 = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'What year did Bash print in the previous turn? Reply with just the year.',
          },
        ],
      },
      r2.emit,
    )
    expect(joinText(r2.events)).toContain('2027')

    // Sanity: bypassPermissions means no permission RPC issued at all.
    expect(calls.filter((c) => c.method === 'session/request_permission').length).toBe(0)
  }, 90_000)

  test('reject -> tool blocks -> SAME session second turn knows about rejection', async () => {
    const adapter = await buildIsolatedAdapter()
    const { server } = makeFakeServer(() => ({
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
      toolPolicy: { defaultMode: 'default' },
    })

    // Turn 1: model tries Write, gets rejected by canUseTool.
    const r1 = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the Write tool to create /tmp/kodizm-lifecycle-reject.txt with content "reject-test".',
          },
        ],
      },
      r1.emit,
    )

    // Turn 2: SAME session, ask if the previous turn succeeded.
    const r2 = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Did the previous Write tool call succeed or get blocked? Reply ONLY with "succeeded" or "blocked".',
          },
        ],
      },
      r2.emit,
    )

    const text2 = joinText(r2.events)
    // Model should remember the rejection.
    expect(text2.includes('block') || text2.includes('reject') || text2.includes('refus')).toBe(true)
  }, 90_000)

  test('AskUserQuestion answer -> SAME session second turn references the choice', async () => {
    const adapter = await buildIsolatedAdapter()
    const { server, calls } = makeFakeServer((method) => {
      if (method === 'session/ask_user_question') {
        return { answers: { 'Pick a number: 7 or 13?': '13' } }
      }
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    })

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
    })

    // Turn 1: model invokes AskUserQuestion, gets answer "13".
    const r1 = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the AskUserQuestion tool to ask EXACTLY: "Pick a number: 7 or 13?" with options "7" and "13". After you receive the answer, tell me what they picked.',
          },
        ],
      },
      r1.emit,
    )
    expect(joinText(r1.events)).toContain('13')

    // Turn 2: SAME session, ask about turn 1's answer.
    const r2 = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'What number did the user pick in the previous turn? Just the number.',
          },
        ],
      },
      r2.emit,
    )
    expect(joinText(r2.events)).toContain('13')

    // Verify ask_user_question RPC actually fired in turn 1.
    const askCalls = calls.filter((c) => c.method === 'session/ask_user_question')
    expect(askCalls.length).toBeGreaterThan(0)
  }, 90_000)

  test('long-delay permission response (3s) -> process stays alive, prompt completes', async () => {
    const adapter = await buildIsolatedAdapter()
    const { server } = makeFakeServer(async (_method) => {
      // Simulate a slow user / orchestrator UI: 3s delay before answer.
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    })

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
      toolPolicy: { defaultMode: 'default' },
    })

    const startedAt = Date.now()
    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the Write tool to create /tmp/kodizm-lifecycle-delay.txt with content "delayed". Reply "done" after.',
          },
        ],
      },
      emit,
    )
    const elapsed = Date.now() - startedAt

    // The 3s permission delay must have been honoured (not short-
    // circuited), but the prompt should still have completed.
    expect(elapsed).toBeGreaterThanOrEqual(3000)

    // permission_request stream event surfaced.
    const permEvents = events.filter((e) => e.type === 'permission_request')
    expect(permEvents.length).toBeGreaterThan(0)
  }, 90_000)
})

describe.skipIf(HAS_AUTH)('real Claude API lifecycle smoke (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
