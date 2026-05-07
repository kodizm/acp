import { describe, expect, mock, test } from 'bun:test'

import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import { type OpencodeQuestionRequest, handleOpencodeQuestion } from '@/backends/opencode/ask-user-question.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

function recorder(): { events: SessionUpdateEvent[]; emit: { send: (e: SessionUpdateEvent) => void } } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

function fakeServer(answers: Record<string, string>): AcpServerLike {
  return {
    request: mock(async () => ({ answers })),
  } as unknown as AcpServerLike
}

function fakeSdk(): { question: { reply: ReturnType<typeof mock>; reject: ReturnType<typeof mock> } } {
  return {
    question: {
      reply: mock(async () => ({})),
      reject: mock(async () => ({})),
    },
  }
}

describe('handleOpencodeQuestion', () => {
  test('translates single-select Question.Info to KodizmQuestion + replies via sdk', async () => {
    const { events, emit } = recorder()
    const server = fakeServer({ 'Pick one?': 'Option A' })
    const sdk = fakeSdk()

    const params: OpencodeQuestionRequest = {
      id: 'qreq-1',
      sessionID: 'opencode-1',
      questions: [
        {
          question: 'Pick one?',
          header: 'Choose',
          options: [
            { label: 'Option A', description: 'first option' },
            { label: 'Option B', description: 'second option' },
          ],
        },
      ],
    }

    await handleOpencodeQuestion({
      params,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as {
        question: { reply: (...a: unknown[]) => unknown; reject: (...a: unknown[]) => unknown }
      },
      emit,
      signal: new AbortController().signal,
    })

    // 1. Canonical event emitted before RPC.
    const evt = events.find((e) => e.type === 'question_request')
    expect(evt).toMatchObject({
      sessionId: 'k-1',
      type: 'question_request',
      toolUseId: 'qreq-1',
    })
    expect(evt?.questions).toHaveLength(1)

    // 2. SDK reply with the orchestrator's answers in opencode shape:
    //    answers = Answer[][]; one Answer per question = [selectedLabel].
    expect(sdk.question.reply).toHaveBeenCalled()
    const replyCall = (sdk.question.reply.mock.calls[0] ?? []) as unknown[]
    expect(replyCall[0]).toMatchObject({ id: 'qreq-1' })
    const replyBody = (replyCall[0] as { body: { answers: string[][] } }).body
    expect(replyBody.answers).toEqual([['Option A']])
  })

  test('multiSelect=true splits comma-separated orchestrator answer', async () => {
    const { emit } = recorder()
    const server = fakeServer({ 'Pick many?': 'Option A,Option B' })
    const sdk = fakeSdk()

    const params: OpencodeQuestionRequest = {
      id: 'qreq-2',
      sessionID: 'opencode-1',
      questions: [
        {
          question: 'Pick many?',
          header: 'Multi',
          multiple: true,
          options: [
            { label: 'Option A', description: 'a' },
            { label: 'Option B', description: 'b' },
            { label: 'Option C', description: 'c' },
          ],
        },
      ],
    }

    await handleOpencodeQuestion({
      params,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as {
        question: { reply: (...a: unknown[]) => unknown; reject: (...a: unknown[]) => unknown }
      },
      emit,
      signal: new AbortController().signal,
    })

    const replyCall = (sdk.question.reply.mock.calls[0] ?? []) as unknown[]
    const body = (replyCall[0] as { body: { answers: string[][] } }).body
    expect(body.answers).toEqual([['Option A', 'Option B']])
  })

  test('opencode `multiple` field translates to canonical `multiSelect`', async () => {
    const { events, emit } = recorder()
    const server = fakeServer({})
    const sdk = fakeSdk()

    const params: OpencodeQuestionRequest = {
      id: 'qreq-3',
      sessionID: 'opencode-1',
      questions: [
        {
          question: 'Q?',
          header: 'H',
          multiple: true,
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    }

    await handleOpencodeQuestion({
      params,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as {
        question: { reply: (...a: unknown[]) => unknown; reject: (...a: unknown[]) => unknown }
      },
      emit,
      signal: new AbortController().signal,
    })

    const evt = events.find((e) => e.type === 'question_request')
    expect(evt?.questions[0]?.multiSelect).toBe(true)
  })

  test('signal abort triggers sdk.question.reject', async () => {
    const { emit } = recorder()
    const server: AcpServerLike = {
      // Simulates orchestrator hanging; resolve only on abort signal.
      request: mock(async () => new Promise(() => undefined)),
    } as unknown as AcpServerLike
    const sdk = fakeSdk()

    const controller = new AbortController()
    const params: OpencodeQuestionRequest = {
      id: 'qreq-cancel',
      sessionID: 'opencode-1',
      questions: [
        {
          question: 'Q?',
          header: 'H',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    }

    const promise = handleOpencodeQuestion({
      params,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as {
        question: { reply: (...a: unknown[]) => unknown; reject: (...a: unknown[]) => unknown }
      },
      emit,
      signal: controller.signal,
    })
    controller.abort()
    await promise

    expect(sdk.question.reject).toHaveBeenCalled()
    expect(sdk.question.reply).not.toHaveBeenCalled()
  })

  test('header longer than 12 chars truncates to canonical max', async () => {
    const { events, emit } = recorder()
    const server = fakeServer({})
    const sdk = fakeSdk()

    const params: OpencodeQuestionRequest = {
      id: 'qreq-trim',
      sessionID: 'opencode-1',
      questions: [
        {
          question: 'Q?',
          header: 'this header is too long',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    }

    await handleOpencodeQuestion({
      params,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as {
        question: { reply: (...a: unknown[]) => unknown; reject: (...a: unknown[]) => unknown }
      },
      emit,
      signal: new AbortController().signal,
    })

    const evt = events.find((e) => e.type === 'question_request')
    expect(evt?.questions[0]?.header.length).toBeLessThanOrEqual(12)
  })

  test('opencode-only `custom` flag passes through via _meta on canonical question', async () => {
    const { events, emit } = recorder()
    const server = fakeServer({})
    const sdk = fakeSdk()

    const params: OpencodeQuestionRequest = {
      id: 'qreq-custom',
      sessionID: 'opencode-1',
      questions: [
        {
          question: 'Pick or type?',
          header: 'Free',
          custom: true,
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    }

    await handleOpencodeQuestion({
      params,
      server,
      sessionId: 'k-1',
      sdk: sdk as unknown as {
        question: { reply: (...a: unknown[]) => unknown; reject: (...a: unknown[]) => unknown }
      },
      emit,
      signal: new AbortController().signal,
    })

    // The canonical event itself stays clean (no `custom`); the
    // outbound RPC carries `_meta.custom` so the orchestrator can
    // surface a free-form input field.
    const requestCall = (server.request as { mock: { calls: unknown[][] } }).mock.calls[0]
    const rpcBody = requestCall?.[1] as { _meta?: { customByQuestion?: Record<string, boolean> } }
    expect(rpcBody._meta?.customByQuestion).toEqual({ 'Pick or type?': true })
  })
})
