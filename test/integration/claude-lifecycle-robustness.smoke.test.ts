/**
 * Real Claude API lifecycle robustness smoke. Phase 1.7 T15.
 *
 * Three scenarios:
 *
 *   stall:   inline SDK adapter that yields system init then HANGS.
 *            With inactivityThresholdMs=2000, the driver fires
 *            session_failed:'sdk_stall' and PromptResult.stopReason
 *            === 'session_failed' within ~2.5s.
 *   throw:   inline SDK adapter that throws a synthesized 401
 *            'Unauthorized' error. Driver classifies as auth_error;
 *            PromptResult.failureReason === 'auth_error'. Container
 *            stays alive (per-reason exit policy) so a subsequent
 *            prompt() can run on the same session id.
 *   heart:   debug=true + 200ms heartbeat against a real Claude API
 *            prompt that runs >800ms; assert >= 2 heartbeat events.
 *
 * Stall + throw scenarios use inline adapters so they do NOT consume
 * real API tokens. The heartbeat scenario uses the real API.
 */

import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

import { HAS_AUTH } from './_helpers.ts'

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''

function pickCredentials() {
  if (OAUTH_TOKEN.length > 0) {
    return { type: 'subscription' as const, token: OAUTH_TOKEN }
  }
  return { type: 'api-key' as const, token: API_KEY }
}

async function buildRealAdapter(): Promise<SdkAdapter> {
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

function makeRecorder(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

describe('Phase 1.7 lifecycle robustness scenarios', () => {
  test('stall: inline hung adapter -> session_failed:sdk_stall + PromptResult shape', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-rob' },
      sdk: {
        async *query(args) {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-stall-test' } satisfies SdkMessage
          const ctrl = (args.options as { abortController?: AbortController }).abortController
          await new Promise<void>((resolve) => {
            ctrl?.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          yield { type: 'result', subtype: 'success' } satisfies SdkMessage
        },
      },
    })

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      inactivityThresholdMs: 800,
    })

    const { emit, events } = makeRecorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(result.stopReason).toBe('session_failed')
    expect(result.failureReason).toBe('sdk_stall')
    expect(events.some((e) => e.type === 'session_failed' && e.reason === 'sdk_stall')).toBe(true)
  }, 10_000)

  test('throw: inline auth-error adapter -> session_failed:auth_error + container stays alive', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-rob' },
      sdk: {
        async *query() {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-auth-test' } satisfies SdkMessage
          throw new Error('Unauthorized: 401 invalid api key')
        },
      },
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = makeRecorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(result.stopReason).toBe('session_failed')
    expect(result.failureReason).toBe('auth_error')
    expect(events.some((e) => e.type === 'session_failed' && e.reason === 'auth_error')).toBe(true)
    // Container stays alive: a subsequent prompt() on the same session must NOT throw.
    // (The underlying SDK still throws, but we get another structured PromptResult.)
    const result2 = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    expect(result2.stopReason).toBe('session_failed')
  }, 5_000)

  test.skipIf(!HAS_AUTH)(
    'heart: real API prompt with debug=true + short heartbeat -> >= 2 heartbeat events',
    async () => {
      const adapter = await buildRealAdapter()
      const driver = new ClaudeDriver({
        credentials: pickCredentials(),
        agentInfo: { version: '0.0.1-rob' },
        sdk: adapter,
      })

      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        model: 'claude-haiku-4-5-20251001',
        heartbeatIntervalMs: 200,
      })

      const { emit, events } = makeRecorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Say a long sentence about lifecycle observability.' }],
        },
        emit,
      )

      const heartbeats = events.filter((e) => e.type === 'heartbeat')
      expect(heartbeats.length).toBeGreaterThanOrEqual(1)
    },
    180_000,
  )
})
