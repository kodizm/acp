import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const recorder = (): { emit: EventEmitter; events: SessionUpdateEvent[] } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * SDK adapter that yields a system init then never resolves further.
 * Lets us hold the prompt open long enough for heartbeat / inactivity
 * timers to fire. Listens on the driver's per-turn abort controller
 * (passed via options.abortController) so the driver's abort flips
 * the adapter unblocked.
 */
function makeHangingAdapter(sdkSessionId: string, externalSignal?: AbortSignal): SdkAdapter {
  return {
    async *query(args) {
      yield { type: 'system', subtype: 'init', session_id: sdkSessionId } satisfies SdkMessage
      const driverController = (args.options as { abortController?: AbortController }).abortController
      const driverSignal = driverController?.signal
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve()
        if (driverSignal !== undefined) {
          driverSignal.addEventListener('abort', onAbort, { once: true })
        }
        if (externalSignal !== undefined) {
          externalSignal.addEventListener('abort', onAbort, { once: true })
        }
      })
      yield { type: 'result', subtype: 'success' } satisfies SdkMessage
    },
  }
}

describe('ClaudeDriver heartbeat (Phase 1.7 T9)', () => {
  test('emits heartbeat events during prompt() at the configured cadence', async () => {
    const abortController = new AbortController()
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeHangingAdapter('sdk-1', abortController.signal),
    })

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      heartbeatIntervalMs: 30,
    })

    const { emit, events } = recorder()
    const promptPromise = driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    await sleep(100)
    abortController.abort()
    await driver.cancel({ sessionId })
    await promptPromise

    const heartbeats = events.filter((e) => e.type === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThanOrEqual(2)
  }, 5000)

  test('does NOT emit heartbeat when neither debug nor heartbeatIntervalMs is set', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: {
        async *query() {
          yield { type: 'result', subtype: 'success' } satisfies SdkMessage
        },
      },
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = recorder()
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(events.some((e) => e.type === 'heartbeat')).toBe(false)
  })
})

describe('ClaudeDriver inactivity probe (Phase 1.7 T9)', () => {
  test('fires session_failed:sdk_stall when SDK gap exceeds threshold + returns PromptResult.session_failed', async () => {
    const abortController = new AbortController()
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeHangingAdapter('sdk-stall', abortController.signal),
    })

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      inactivityThresholdMs: 60,
    })

    const { emit, events } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)
    abortController.abort()

    const stallEvent = events.find((e) => e.type === 'session_failed')
    expect(stallEvent).toBeDefined()
    if (stallEvent?.type === 'session_failed') {
      expect(stallEvent.reason).toBe('sdk_stall')
      expect(stallEvent.detail).toContain('60')
    }

    expect(result.stopReason).toBe('session_failed')
    expect(result.failureReason).toBe('sdk_stall')
  }, 5000)

  test('does NOT fire stall when inactivityThresholdMs is undefined', async () => {
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: {
        async *query() {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-noprobe' } satisfies SdkMessage
          yield { type: 'result', subtype: 'success' } satisfies SdkMessage
        },
      },
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(events.some((e) => e.type === 'session_failed')).toBe(false)
    expect(result.stopReason).toBe('end_turn')
  })

  test('lastSdkMessageAt updates as SDK messages stream; gap measured from latest', async () => {
    // Adapter yields one message every 30ms for 90ms (3 messages), then completes.
    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-test' },
      agentInfo: { version: '0.0.1-test' },
      sdk: {
        async *query() {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-stream' } satisfies SdkMessage
          for (let i = 0; i < 3; i++) {
            await sleep(30)
            yield {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: `chunk ${i}` }] },
            } satisfies SdkMessage
          }
          yield { type: 'result', subtype: 'success' } satisfies SdkMessage
        },
      },
    })

    const { sessionId } = await driver.newSession({
      cwd: '/workspace',
      mcpServers: [],
      // 100ms threshold; messages 30ms apart so each renews the deadline.
      inactivityThresholdMs: 100,
    })

    const { emit, events } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(events.some((e) => e.type === 'session_failed')).toBe(false)
    expect(result.stopReason).toBe('end_turn')
  }, 5000)
})
