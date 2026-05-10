/**
 * Opencode HTTP-fixture coverage for the attachment forwarding path.
 *
 * Bypasses the real `opencode serve` subprocess by injecting a fake
 * `OpencodeHttpBridge` whose `sdk.session.prompt` records the params
 * the driver passes through. Asserts that {@link buildOpencodeParts}'s
 * output reaches the wire layer untouched.
 *
 * Avoids real-LLM cost (~$0.05/run per CLAUDE.local.md); the fixture
 * here exercises the prompt translation contract only.
 */

import { describe, expect, test } from 'bun:test'

import { OpencodeDriver } from '@/backends/opencode/driver.ts'
import type {
  OpencodeHttpBridge,
  OpencodeHttpBridgeHandle,
  OpencodeHttpBridgeStartOptions,
} from '@/backends/opencode/http-bridge.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const FAKE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

interface CapturedPrompt {
  sessionID: string
  parts: Array<{ type: string; text?: string; mime?: string; filename?: string; url?: string }>
  model?: { providerID: string; modelID: string }
}

interface FakeBridgeState {
  prompts: CapturedPrompt[]
}

function buildFakeBridge(state: FakeBridgeState): OpencodeHttpBridge {
  const sdk = {
    session: {
      create: async (_params: unknown) => ({ data: { id: 'ses_fake_123' } }),
      prompt: async (params: CapturedPrompt) => {
        state.prompts.push(params)
        return { data: undefined, error: undefined }
      },
    },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          // Synthesise a single turn-complete frame so the driver's
          // SSE loop terminates without waiting on a real opencode
          // server. The shape mirrors `prompt-stream.isTurnComplete`'s
          // expected envelope.
          yield {
            event: 'message.updated',
            data: { properties: { info: { time: { completed: 1 } } } },
          }
        })(),
      }),
    },
    mcp: {},
  }

  const handle: OpencodeHttpBridgeHandle = {
    url: 'http://127.0.0.1:0',
    port: 0,
    sdk: sdk as unknown as OpencodeHttpBridgeHandle['sdk'],
  }

  const fake: Pick<OpencodeHttpBridge, 'start' | 'stop'> = {
    start: async (_opts: OpencodeHttpBridgeStartOptions = {}) => handle,
    stop: async () => undefined,
  }
  return fake as OpencodeHttpBridge
}

async function runWithFakeBridge(prompt: Array<unknown>): Promise<{
  prompts: CapturedPrompt[]
  events: SessionUpdateEvent[]
}> {
  const state: FakeBridgeState = { prompts: [] }
  const driver = new OpencodeDriver({
    agentInfo: { version: '0.0.1-attachment-fixture' },
    bridgeFactory: () => buildFakeBridge(state),
  })

  const session = await driver.newSession({
    cwd: process.cwd(),
    mcpServers: [],
    toolPolicy: { defaultMode: 'bypassPermissions' },
  })

  const events: SessionUpdateEvent[] = []
  await driver.prompt(
    session.sessionId,
    {
      sessionId: session.sessionId,
      prompt: prompt as never,
    },
    { send: (e) => events.push(e) },
  )

  await driver.disposeAll()
  return { prompts: state.prompts, events }
}

describe('opencode attachment forwarding via HTTP fixture', () => {
  test('base64 image content block emits FilePartInput with data: URL', async () => {
    const { prompts } = await runWithFakeBridge([
      { type: 'text', text: 'see this' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_PNG_B64 } },
    ])

    expect(prompts.length).toBe(1)
    const parts = prompts[0]?.parts ?? []
    expect(parts.length).toBe(2)
    expect(parts[0]).toEqual({ type: 'text', text: 'see this' })
    expect(parts[1]?.type).toBe('file')
    expect(parts[1]?.mime).toBe('image/png')
    expect(parts[1]?.url).toBe(`data:image/png;base64,${FAKE_PNG_B64}`)
    expect(parts[1]?.filename).toMatch(/^[0-9a-f-]+\.png$/)
  })

  test('url image content block emits FilePartInput with the original URL', async () => {
    const { prompts } = await runWithFakeBridge([
      { type: 'image', source: { type: 'url', url: 'https://kodizm.com/assets/logo.png' } },
    ])

    const parts = prompts[0]?.parts ?? []
    expect(parts.length).toBe(1)
    expect(parts[0]?.type).toBe('file')
    expect(parts[0]?.url).toBe('https://kodizm.com/assets/logo.png')
    expect(parts[0]?.filename).toBe('logo.png')
  })

  test('base64 document content block emits FilePartInput with sanitised filename', async () => {
    const { prompts } = await runWithFakeBridge([
      {
        type: 'document',
        source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PNG_B64 },
        title: 'release notes; v2.pdf',
      },
    ])

    const parts = prompts[0]?.parts ?? []
    expect(parts.length).toBe(1)
    expect(parts[0]?.type).toBe('file')
    expect(parts[0]?.mime).toBe('application/pdf')
    expect(parts[0]?.filename).toBe('release_notes__v2.pdf')
    expect(parts[0]?.url).toBe(`data:application/pdf;base64,${FAKE_PNG_B64}`)
  })
})
