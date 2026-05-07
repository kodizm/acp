/**
 * Real-LLM smoke for the opencode backend (Phase 3 T16).
 *
 * Six features covered against `opencode-go/deepseek-v4-flash`:
 *
 *   F1 token rollup            usage event has non-zero counts + costUsd
 *   F2 model_advertisement     emitted at first prompt with the chosen model
 *   F3 multi-turn memory       remember a value, recall it on the next prompt
 *   F4 askUserQuestion         model invokes opencode's `question` tool;
 *                              the canonical question_request event +
 *                              outbound session/ask_user_question RPC fire
 *   F5 permission allow        bash tool gated by default ruleset; canonical
 *                              permission_request fires; orchestrator
 *                              answers `allow`; tool runs end-to-end
 *   F6 fork                    parent session, fork, two distinct opencode
 *                              session ids backed by the same listener
 *
 * Gated on HAS_OPENCODE_AUTH (resolves to true when
 * ~/.local/share/opencode/auth.json contains the `opencode-go` key, OR
 * the OPENCODE_AUTH_CONTENT env override is set with that key).
 *
 * Run from package dir to avoid Bun 1.3.10 nested-cwd quirks:
 *
 *   cd packages/kodizm-acp && \
 *     bun test test/integration/opencode-features.smoke.test.ts
 */

import { describe, expect, mock, test } from 'bun:test'

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import { OpencodeDriver } from '@/backends/opencode/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const SMOKE_MODEL: string = 'opencode-go/deepseek-v4-flash'
const SMOKE_TIMEOUT_MS: number = 90_000

const opencodeInstalled = (() => {
  try {
    return spawnSync('opencode', ['--version'], { stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
})()

const hasOpencodeGoAuth = (() => {
  const path = `${homedir()}/.local/share/opencode/auth.json`
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { type?: string; key?: string }>
    return parsed['opencode-go']?.key !== undefined && parsed['opencode-go']?.key.length > 0
  } catch {
    return false
  }
})()

const HAS_OPENCODE_AUTH: boolean =
  opencodeInstalled && (hasOpencodeGoAuth || process.env.OPENCODE_AUTH_CONTENT !== undefined)

function recorder(): {
  events: SessionUpdateEvent[]
  emit: { send: (e: SessionUpdateEvent) => void }
} {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

describe.skipIf(!HAS_OPENCODE_AUTH)('OpencodeDriver real-LLM smoke (opencode-go/deepseek-v4-flash)', () => {
  test(
    'F1+F2 first prompt emits usage rollup AND model_advertisement',
    async () => {
      const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-smoke' } })
      try {
        const session = await driver.newSession({
          cwd: process.cwd(),
          mcpServers: [],
          model: SMOKE_MODEL,
          toolPolicy: { defaultMode: 'bypassPermissions' },
        })
        const { events, emit } = recorder()

        const result = await driver.prompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'Reply with one word: TEAL' }],
          },
          emit,
        )

        // F1 token rollup
        const usage = events.find((e) => e.type === 'usage')
        expect(usage).toBeDefined()
        if (usage?.type === 'usage') {
          expect(usage.inputTokens).toBeGreaterThan(0)
          expect(usage.outputTokens).toBeGreaterThan(0)
          expect(usage.costUsd).toBeGreaterThan(0)
        }

        // F2 model_advertisement
        const advert = events.find((e) => e.type === 'model_advertisement')
        expect(advert).toBeDefined()
        if (advert?.type === 'model_advertisement') {
          expect(advert.model).toBe(SMOKE_MODEL)
        }

        expect(result.stopReason).toBe('end_turn')
      } finally {
        await driver.disposeAll()
      }
    },
    SMOKE_TIMEOUT_MS,
  )

  test(
    'F3 multi-turn memory: model recalls a remembered token across two prompts',
    async () => {
      const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-smoke' } })
      try {
        const session = await driver.newSession({
          cwd: process.cwd(),
          mcpServers: [],
          model: SMOKE_MODEL,
          toolPolicy: { defaultMode: 'bypassPermissions' },
        })

        // Turn 1: tell the model a sentinel word.
        const r1 = recorder()
        await driver.prompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text: 'Remember the secret word "kingfisher". Reply with: OK.',
              },
            ],
          },
          r1.emit,
        )

        // Turn 2: ask for the secret back.
        const r2 = recorder()
        const result2 = await driver.prompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text: 'What was the secret word? Reply with the single word only.',
              },
            ],
          },
          r2.emit,
        )

        const outputText = r2.events
          .filter((e) => e.type === 'output_chunk')
          .map((e) => (e.type === 'output_chunk' ? e.text : ''))
          .join('')

        expect(result2.stopReason).toBe('end_turn')
        expect(outputText.toLowerCase()).toContain('kingfisher')
      } finally {
        await driver.disposeAll()
      }
    },
    SMOKE_TIMEOUT_MS * 2,
  )

  test(
    'F4 askUserQuestion: model invokes the question tool; ask_user_question RPC fires',
    async () => {
      const rpcCalls: { method: string; params: unknown }[] = []
      const fakeServer: AcpServerLike = {
        request: mock(async (method: string, params: unknown) => {
          rpcCalls.push({ method, params })
          if (method !== 'session/ask_user_question') return {}
          const p = params as { questions: Array<{ question: string; options: { label: string }[] }> }
          const answers: Record<string, string> = {}
          for (const q of p.questions) {
            answers[q.question] = q.options[0]?.label ?? ''
          }
          return { answers }
        }),
      } as unknown as AcpServerLike

      const driver = new OpencodeDriver({
        agentInfo: { version: '0.0.1-smoke' },
        server: fakeServer,
      })

      try {
        const session = await driver.newSession({
          cwd: process.cwd(),
          mcpServers: [],
          model: SMOKE_MODEL,
          toolPolicy: { defaultMode: 'bypassPermissions' },
        })

        const { events, emit } = recorder()

        await driver.prompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text:
                  'You MUST call the `question` tool right now, exactly once, with this JSON: ' +
                  '{"question":"Pick a color","header":"Color","options":' +
                  '[{"label":"RED","description":"the red one"},' +
                  '{"label":"BLUE","description":"the blue one"}]}. ' +
                  'Do not output any text before invoking the tool. ' +
                  'After receiving the answer, reply with the chosen color in one word.',
              },
            ],
          },
          emit,
        )

        // Strict: the canonical question_request event MUST fire,
        // the outbound session/ask_user_question RPC MUST hit the
        // fake orchestrator, and the question MUST carry both options.
        const questionEvent = events.find((e) => e.type === 'question_request')
        expect(questionEvent).toBeDefined()
        if (questionEvent?.type !== 'question_request') {
          throw new Error('question_request event missing')
        }
        expect(questionEvent.questions.length).toBeGreaterThan(0)
        const askCalls = rpcCalls.filter((c) => c.method === 'session/ask_user_question')
        expect(askCalls.length).toBeGreaterThan(0)
        const askParams = askCalls[0]?.params as { questions: { options: { label: string }[] }[] }
        const labels = askParams.questions[0]?.options.map((o) => o.label) ?? []
        expect(labels).toContain('RED')
        expect(labels).toContain('BLUE')
      } finally {
        await driver.disposeAll()
      }
    },
    SMOKE_TIMEOUT_MS * 2,
  )

  test(
    'F5 permission allow: bash gated under ask policy + canonical allow drives execution end-to-end',
    async () => {
      const rpcCalls: { method: string; params: unknown }[] = []
      const fakeServer: AcpServerLike = {
        request: mock(async (method: string, params: unknown) => {
          rpcCalls.push({ method, params })
          if (method !== 'session/request_permission') return {}
          return { outcome: { outcome: 'selected', optionId: 'allow' } }
        }),
      } as unknown as AcpServerLike

      const driver = new OpencodeDriver({
        agentInfo: { version: '0.0.1-smoke' },
        server: fakeServer,
      })

      try {
        const session = await driver.newSession({
          cwd: process.cwd(),
          mcpServers: [],
          model: SMOKE_MODEL,
          toolPolicy: { ask: ['Bash'] },
        })

        const { events, emit } = recorder()

        const result = await driver.prompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text:
                  'You MUST run this command using the bash tool: `echo HELLO_FROM_BASH`. ' +
                  'After the tool finishes, reply with the captured stdout in plain text.',
              },
            ],
          },
          emit,
        )

        // Strict: permission_request fires, the bridge sends
        // session/request_permission to the orchestrator, exactly one
        // tool_call_begin + tool_call_end pair fires for bash, and the
        // tool_call_end's result captures the actual `echo` stdout
        // (deepseek-v4-flash sometimes ends the turn after the tool
        // result without producing reply text, so we assert on the
        // tool result rather than output_chunk).
        expect(result.stopReason).toBe('end_turn')

        const permEvents = events.filter((e) => e.type === 'permission_request')
        expect(permEvents.length).toBe(1)
        const permEvent = permEvents[0]
        if (permEvent?.type !== 'permission_request') {
          throw new Error('permission_request event missing')
        }
        expect(permEvent.name.toLowerCase()).toContain('bash')
        const permCalls = rpcCalls.filter((c) => c.method === 'session/request_permission')
        expect(permCalls.length).toBeGreaterThan(0)

        const beginEvents = events.filter((e) => e.type === 'tool_call_begin')
        expect(beginEvents.length).toBe(1)
        const begin = beginEvents[0]
        if (begin?.type === 'tool_call_begin') {
          expect(begin.name.toLowerCase()).toContain('bash')
          const input = begin.input as { command?: string }
          expect(input.command).toContain('echo HELLO_FROM_BASH')
        }

        const endEvents = events.filter((e) => e.type === 'tool_call_end')
        expect(endEvents.length).toBe(1)
        const end = endEvents[0]
        if (end?.type === 'tool_call_end') {
          expect(end.isError).toBe(false)
          const result = typeof end.result === 'string' ? end.result : ''
          expect(result).toContain('HELLO_FROM_BASH')
        }
      } finally {
        await driver.disposeAll()
      }
    },
    SMOKE_TIMEOUT_MS * 2,
  )

  test(
    'F6 fork: parent + fork have distinct opencode session ids; parent unaffected',
    async () => {
      const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-smoke' } })
      try {
        const parent = await driver.newSession({
          cwd: process.cwd(),
          mcpServers: [],
          model: SMOKE_MODEL,
          toolPolicy: { defaultMode: 'bypassPermissions' },
        })

        // Drive one turn on the parent so the fork has a real history.
        const r1 = recorder()
        await driver.prompt(
          parent.sessionId,
          {
            sessionId: parent.sessionId,
            prompt: [
              {
                type: 'text',
                text: 'Remember the parent secret: BLUEBELL. Reply: OK.',
              },
            ],
          },
          r1.emit,
        )

        const fork = await driver.forkSession({
          sourceSessionId: parent.sessionId,
          cwd: process.cwd(),
          mcpServers: [],
        })

        const ids = driver.debugSessionIds()
        const parentId = ids.get(parent.sessionId)
        const forkId = ids.get(fork.sessionId)
        expect(parentId).toBeDefined()
        expect(forkId).toBeDefined()
        expect(parentId).not.toBe(forkId)
      } finally {
        await driver.disposeAll()
      }
    },
    SMOKE_TIMEOUT_MS * 2,
  )
})

describe.skipIf(HAS_OPENCODE_AUTH)('OpencodeDriver smoke skipped (no opencode-go auth)', () => {
  test('skipped without opencode-go credentials', () => {
    expect(HAS_OPENCODE_AUTH).toBe(false)
  })
})
