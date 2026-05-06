import { describe, expect, test } from 'bun:test'

import { askUserQuestionBranch } from '@/backends/claude/ask-user-question.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

interface FakeServer {
  request<T>(method: string, params: unknown): Promise<T>
  lastCall?: { method: string; params: unknown }
}

function makeFakeServer(handler: (method: string, params: unknown) => Promise<unknown>): FakeServer {
  const server: FakeServer = {
    async request<T>(method: string, params: unknown): Promise<T> {
      server.lastCall = { method, params }
      return (await handler(method, params)) as T
    },
  }
  return server
}

function recorder(): { emit: { send: (e: SessionUpdateEvent) => void }; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

const VALID_QUESTIONS = [
  {
    question: 'A or B?',
    header: 'Pick',
    options: [
      { label: 'A', description: 'Option A' },
      { label: 'B', description: 'Option B' },
    ],
    multiSelect: false,
  },
]

describe('askUserQuestionBranch, passthrough on non-Skill tool', () => {
  test('returns null when toolName !== AskUserQuestion', async () => {
    const branch = askUserQuestionBranch({
      server: makeFakeServer(async () => ({})),
      sessionId: 's1',
      ...recorder(),
      signal: new AbortController().signal,
    })

    const result = await branch('Bash', { command: 'ls' }, { toolUseID: 'tu_1' })
    expect(result).toBeNull()
  })
})

describe('askUserQuestionBranch, valid roundtrip', () => {
  test('issues session/ask_user_question RPC + returns updatedInput with answers', async () => {
    const server = makeFakeServer(async () => ({
      answers: { 'A or B?': 'A' },
    }))
    const { emit, events } = recorder()
    const branch = askUserQuestionBranch({
      server,
      sessionId: 's1',
      emit,
      signal: new AbortController().signal,
    })

    const result = await branch('AskUserQuestion', { questions: VALID_QUESTIONS }, { toolUseID: 'tu_1' })

    expect(server.lastCall?.method).toBe('session/ask_user_question')
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: VALID_QUESTIONS,
        answers: { 'A or B?': 'A' },
      },
    })
    expect(events.find((e) => e.type === 'question_request')).toBeDefined()
  })
})

describe('askUserQuestionBranch, annotations propagation', () => {
  test('annotations from response surface in updatedInput', async () => {
    const server = makeFakeServer(async () => ({
      answers: { 'A or B?': 'A' },
      annotations: { 'A or B?': { preview: 'snippet', notes: 'side note' } },
    }))
    const branch = askUserQuestionBranch({
      server,
      sessionId: 's1',
      ...recorder(),
      signal: new AbortController().signal,
    })

    const result = await branch('AskUserQuestion', { questions: VALID_QUESTIONS }, { toolUseID: 'tu_1' })

    if (result?.behavior === 'allow') {
      expect((result.updatedInput as { annotations?: Record<string, unknown> })?.annotations).toEqual({
        'A or B?': { preview: 'snippet', notes: 'side note' },
      })
    }
  })
})

describe('askUserQuestionBranch, invalid input', () => {
  test('throws when input.questions is missing or malformed', async () => {
    const branch = askUserQuestionBranch({
      server: makeFakeServer(async () => ({})),
      sessionId: 's1',
      ...recorder(),
      signal: new AbortController().signal,
    })

    await expect(branch('AskUserQuestion', { questions: 'not an array' }, { toolUseID: 'tu_1' })).rejects.toThrow()
  })
})

describe('askUserQuestionBranch, cancellation envelope', () => {
  test('outcome cancelled throws Tool use aborted', async () => {
    const server = makeFakeServer(async () => ({ outcome: { outcome: 'cancelled' } }))
    const branch = askUserQuestionBranch({
      server,
      sessionId: 's1',
      ...recorder(),
      signal: new AbortController().signal,
    })

    await expect(branch('AskUserQuestion', { questions: VALID_QUESTIONS }, { toolUseID: 'tu_1' })).rejects.toThrow(
      /aborted/,
    )
  })
})
