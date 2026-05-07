import { describe, expect, mock, test } from 'bun:test'

import { type DispatchHandlers, dispatchOpencodeEvent, isTurnComplete } from '@/backends/opencode/prompt-stream.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

function recorder(): { events: SessionUpdateEvent[]; emit: { send: (e: SessionUpdateEvent) => void } } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

function makeHandlers(): DispatchHandlers {
  return {
    onMessageBus: mock(() => undefined),
    onPermissionAsked: mock(() => undefined),
    onQuestionAsked: mock(() => undefined),
    onSessionError: mock(() => undefined),
  }
}

/**
 * Phase 3 Task 9: dispatch one parsed bus event into the right
 * handler. The full SSE-loop is wired in Task 10's prompt() call;
 * this layer is the routing table + turn-complete predicate.
 */
describe('dispatchOpencodeEvent', () => {
  test('message.part.delta -> onMessageBus', () => {
    const handlers = makeHandlers()
    dispatchOpencodeEvent(
      { type: 'message.part.delta', properties: { partID: 'p1', field: 'text', delta: 'hi' } },
      handlers,
    )
    expect(handlers.onMessageBus).toHaveBeenCalled()
  })

  test('permission.asked -> onPermissionAsked', () => {
    const handlers = makeHandlers()
    dispatchOpencodeEvent(
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-1',
          sessionID: 'opencode-1',
          permission: 'bash',
          patterns: ['*'],
          always: [],
          metadata: {},
        },
      },
      handlers,
    )
    expect(handlers.onPermissionAsked).toHaveBeenCalled()
  })

  test('question.asked -> onQuestionAsked', () => {
    const handlers = makeHandlers()
    dispatchOpencodeEvent(
      {
        type: 'question.asked',
        properties: {
          id: 'q-1',
          sessionID: 'opencode-1',
          questions: [],
        },
      },
      handlers,
    )
    expect(handlers.onQuestionAsked).toHaveBeenCalled()
  })

  test('session.error -> onSessionError', () => {
    const handlers = makeHandlers()
    dispatchOpencodeEvent(
      {
        type: 'session.error',
        properties: { error: { name: 'ProviderAuthError', message: 'bad key' } },
      },
      handlers,
    )
    expect(handlers.onSessionError).toHaveBeenCalled()
  })

  test('unknown event type silently passes (no handler invoked, no throw)', () => {
    const handlers = makeHandlers()
    expect(() => dispatchOpencodeEvent({ type: 'unknown.event', properties: {} }, handlers)).not.toThrow()
    expect(handlers.onMessageBus).not.toHaveBeenCalled()
  })
})

describe('isTurnComplete', () => {
  test('message.updated with role=assistant + time.completed -> true', () => {
    expect(
      isTurnComplete({
        type: 'message.updated',
        properties: { info: { role: 'assistant', time: { completed: 123 } } },
      }),
    ).toBe(true)
  })

  test('message.updated without time.completed -> false', () => {
    expect(
      isTurnComplete({
        type: 'message.updated',
        properties: { info: { role: 'assistant', time: { created: 1 } } },
      }),
    ).toBe(false)
  })

  test('message.updated role=user -> false', () => {
    expect(
      isTurnComplete({
        type: 'message.updated',
        properties: { info: { role: 'user', time: { completed: 1 } } },
      }),
    ).toBe(false)
  })

  test('any other event type -> false', () => {
    expect(isTurnComplete({ type: 'message.part.delta', properties: {} })).toBe(false)
  })
})
