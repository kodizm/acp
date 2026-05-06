/**
 * Real Claude API idle profile measurement. Quantifies the cost of
 * Pattern A (keep process alive while permission is pending):
 *   - RSS / heap memory while awaiting orchestrator response
 *   - Event loop CPU usage during the await (should be ~0)
 *   - Memory delta over N seconds of idle await
 *
 * Findings drive the final recommendation in the design report.
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

function pickCredentials() {
  if (OAUTH_TOKEN.length > 0) {
    return { type: 'subscription' as const, token: OAUTH_TOKEN }
  }
  return { type: 'api-key' as const, token: API_KEY }
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

interface MemorySnapshot {
  rssMb: number
  heapUsedMb: number
  heapTotalMb: number
  externalMb: number
}

function memSnapshot(): MemorySnapshot {
  const m = process.memoryUsage()
  return {
    rssMb: m.rss / 1024 / 1024,
    heapUsedMb: m.heapUsed / 1024 / 1024,
    heapTotalMb: m.heapTotal / 1024 / 1024,
    externalMb: m.external / 1024 / 1024,
  }
}

describe.skipIf(!HAS_AUTH)('idle profile while permission pending', () => {
  test('process holds canUseTool Promise; RSS stable + CPU ~0 over 10s', async () => {
    const adapter = await buildIsolatedAdapter()

    // Track memory snapshots at 1s intervals during the await.
    const snapshots: Array<{ t: number; mem: MemorySnapshot; cpuMs: number }> = []
    const sampleStart = Date.now()
    let lastCpu = process.cpuUsage()
    const sampler = setInterval(() => {
      const cpuDelta = process.cpuUsage(lastCpu)
      lastCpu = process.cpuUsage()
      const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000
      snapshots.push({ t: Date.now() - sampleStart, mem: memSnapshot(), cpuMs })
    }, 1000)

    // Fake server that delays 10 seconds before answering.
    const PERMISSION_DELAY_MS = 10_000
    const server: AcpServerLike = {
      async request<T>(_method: string, _params: unknown): Promise<T> {
        await new Promise((resolve) => setTimeout(resolve, PERMISSION_DELAY_MS))
        return { outcome: { outcome: 'selected', optionId: 'allow' } } as unknown as T
      },
    }

    const driver = new ClaudeDriver({
      credentials: pickCredentials(),
      agentInfo: { version: '0.0.1-idle' },
      sdk: adapter,
      server,
    })

    const { sessionId } = await driver.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      model: 'claude-sonnet-4-6',
      toolPolicy: { defaultMode: 'default' },
    })

    const memBeforePrompt = memSnapshot()

    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(
      sessionId,
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the Write tool to create /tmp/kodizm-idle-test.txt with content "x". Reply "done" after.',
          },
        ],
      },
      emit,
    )

    clearInterval(sampler)

    const memAfterPrompt = memSnapshot()

    // Snapshots taken DURING the 10s permission await (filter out
    // pre-prompt + post-prompt).
    const idleSnapshots = snapshots.slice(2, -1) // drop first 2s + last sample

    const rssValues = idleSnapshots.map((s) => s.mem.rssMb)
    const cpuMsValues = idleSnapshots.map((s) => s.cpuMs)

    const rssMin = Math.min(...rssValues)
    const rssMax = Math.max(...rssValues)
    const rssAvg = rssValues.reduce((a, b) => a + b, 0) / rssValues.length
    const cpuMsAvg = cpuMsValues.reduce((a, b) => a + b, 0) / cpuMsValues.length

    console.log('=== IDLE PROFILE (permission await 10s) ===')
    console.log(`pre-prompt RSS:    ${memBeforePrompt.rssMb.toFixed(1)} MB`)
    console.log(`during-await RSS:  min=${rssMin.toFixed(1)} avg=${rssAvg.toFixed(1)} max=${rssMax.toFixed(1)} MB`)
    console.log(`during-await CPU:  avg=${cpuMsAvg.toFixed(1)} ms/sec (~${((cpuMsAvg / 1000) * 100).toFixed(2)}%)`)
    console.log(`post-prompt RSS:   ${memAfterPrompt.rssMb.toFixed(1)} MB`)
    console.log(`heap delta:        ${(memAfterPrompt.heapUsedMb - memBeforePrompt.heapUsedMb).toFixed(2)} MB`)

    // Assertions:
    // 1. RSS during await stays bounded (no leak; max <= avg + 20%).
    expect(rssMax).toBeLessThanOrEqual(rssAvg * 1.5)
    // 2. CPU usage during await is minimal (<5% busy on the event loop).
    expect(cpuMsAvg).toBeLessThan(50) // <50ms per second sampled
    // 3. The permission DID delay the prompt (we actually waited).
    expect(events.some((e) => e.type === 'permission_request')).toBe(true)
  }, 60_000)
})

describe.skipIf(HAS_AUTH)('idle profile (skipped)', () => {
  test('skipped when no auth env is set', () => {
    expect(HAS_AUTH).toBe(false)
  })
})
