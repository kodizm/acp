/**
 * Shared helpers for the real-API integration smokes.
 *
 * The SDK reads its own auth from the process env: either
 * `ANTHROPIC_API_KEY` (api-key path) or `CLAUDE_CODE_OAUTH_TOKEN`
 * with `CLAUDE_CODE_REMOTE=1` (subscription path). This helper
 * detects either so the smokes can run under either credential.
 *
 * Cheap default model: claude-haiku-4-5-20251001. Override per-test
 * by passing `model` to the prompt.
 */

import type { ClaudeCredentials } from '@/backends/claude/auth.ts'
import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

/**
 * Cheap test model. Haiku 4.5 keeps real-API smoke cost trivial.
 */
export const TEST_MODEL = 'claude-haiku-4-5-20251001'

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''

/**
 * True when ANY auth path is configured. The SDK will read the
 * matching env var at import time.
 */
export const HAS_AUTH = API_KEY.length > 0 || OAUTH_TOKEN.length > 0

/**
 * Pick the credential shape the driver carries. The SDK uses env
 * directly; the driver's credentials field is metadata for audit.
 */
function pickCredentials(): ClaudeCredentials {
  if (OAUTH_TOKEN.length > 0) {
    return { type: 'subscription', token: OAUTH_TOKEN }
  }
  return { type: 'api-key', token: API_KEY }
}

/**
 * Build an SdkAdapter wrapping the real `@anthropic-ai/claude-agent-sdk`
 * `query()` function.
 */
export async function buildRealAdapter(
  enrich?: (args: { prompt: string; options: unknown }) => { prompt: string; options: unknown },
): Promise<SdkAdapter> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    async *query(args) {
      const finalArgs = enrich !== undefined ? enrich(args as { prompt: string; options: unknown }) : args
      for await (const message of sdk.query(finalArgs as never)) {
        yield message as SdkMessage
      }
    },
  }
}

/**
 * Build a fully-wired ClaudeDriver against the real SDK.
 */
export async function buildRealDriver(
  enrich?: (args: { prompt: string; options: unknown }) => { prompt: string; options: unknown },
): Promise<ClaudeDriver> {
  const adapter = await buildRealAdapter(enrich)
  return new ClaudeDriver({
    credentials: pickCredentials(),
    agentInfo: { version: '0.0.1-smoke' },
    sdk: adapter,
  })
}

/**
 * Recording emitter for collecting events in test assertions.
 */
export function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

/**
 * Find a single event of the given type, or undefined.
 */
export function findEvent<T extends SessionUpdateEvent['type']>(
  events: SessionUpdateEvent[],
  type: T,
): Extract<SessionUpdateEvent, { type: T }> | undefined {
  return events.find((e): e is Extract<SessionUpdateEvent, { type: T }> => e.type === type)
}

/**
 * Concatenate every output_chunk text for assertions on final answer.
 */
export function joinOutputText(events: SessionUpdateEvent[]): string {
  return events
    .filter((e) => e.type === 'output_chunk')
    .map((e) => (e.type === 'output_chunk' ? e.text : ''))
    .join('')
}
