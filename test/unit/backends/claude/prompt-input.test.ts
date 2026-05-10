import { describe, expect, test } from 'bun:test'

import { type ClaudeSdkUserMessage, buildClaudePromptInput } from '@/backends/claude/prompt-input.ts'
import type { PromptRequest } from '@/wire/types.ts'

const FAKE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const baseRequest = (prompt: PromptRequest['prompt']): PromptRequest => ({
  sessionId: 'sess-test',
  prompt,
})

async function collectIterable(input: AsyncIterable<ClaudeSdkUserMessage>): Promise<ClaudeSdkUserMessage[]> {
  const out: ClaudeSdkUserMessage[] = []
  for await (const message of input) {
    out.push(message)
  }
  return out
}

describe('buildClaudePromptInput, text-only fast path', () => {
  test('single text block returns the literal text as a string', () => {
    const result = buildClaudePromptInput(baseRequest([{ type: 'text', text: 'Hello world' }]))
    expect(typeof result).toBe('string')
    expect(result).toBe('Hello world')
  })

  test('multiple text blocks join with newline (matches legacy serializePrompt)', () => {
    const result = buildClaudePromptInput(
      baseRequest([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    )
    expect(result).toBe('first\nsecond')
  })

  test('resume prefix prepends as-is on the string path', () => {
    const result = buildClaudePromptInput(baseRequest([{ type: 'text', text: 'body' }]), 'PREFIX: ')
    expect(result).toBe('PREFIX: body')
  })
})

describe('buildClaudePromptInput, image branch', () => {
  test('base64 image returns iterable yielding one user message with one image block', async () => {
    const result = buildClaudePromptInput(
      baseRequest([{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_PNG_B64 } }]),
    )

    expect(typeof result).not.toBe('string')
    const messages = await collectIterable(result as AsyncIterable<ClaudeSdkUserMessage>)
    expect(messages.length).toBe(1)
    expect(messages[0]?.type).toBe('user')
    expect(messages[0]?.parent_tool_use_id).toBeNull()
    expect(messages[0]?.message.role).toBe('user')
    expect(messages[0]?.message.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: FAKE_PNG_B64 },
      },
    ])
  })

  test('url image source preserves the url verbatim', async () => {
    const result = buildClaudePromptInput(
      baseRequest([{ type: 'image', source: { type: 'url', url: 'https://kodizm.com/logo.png' } }]),
    )
    const messages = await collectIterable(result as AsyncIterable<ClaudeSdkUserMessage>)
    expect(messages[0]?.message.content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://kodizm.com/logo.png' } },
    ])
  })
})

describe('buildClaudePromptInput, document branch', () => {
  test('document with title preserves the title field', async () => {
    const result = buildClaudePromptInput(
      baseRequest([
        {
          type: 'document',
          source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PNG_B64 },
          title: 'spec.pdf',
        },
      ]),
    )
    const messages = await collectIterable(result as AsyncIterable<ClaudeSdkUserMessage>)
    expect(messages[0]?.message.content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: FAKE_PNG_B64 },
        title: 'spec.pdf',
      },
    ])
  })
})

describe('buildClaudePromptInput, mixed payload', () => {
  test('preserves block order: text -> image -> text', async () => {
    const result = buildClaudePromptInput(
      baseRequest([
        { type: 'text', text: 'before' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_PNG_B64 } },
        { type: 'text', text: 'after' },
      ]),
    )
    const messages = await collectIterable(result as AsyncIterable<ClaudeSdkUserMessage>)
    const content = messages[0]?.message.content
    expect(content?.[0]).toEqual({ type: 'text', text: 'before' })
    expect(content?.[1]?.type).toBe('image')
    expect(content?.[2]).toEqual({ type: 'text', text: 'after' })
  })

  test('resume prefix becomes a leading text block ahead of the multimodal blocks', async () => {
    const result = buildClaudePromptInput(
      baseRequest([{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_PNG_B64 } }]),
      'RESUME PREFIX: ',
    )
    const messages = await collectIterable(result as AsyncIterable<ClaudeSdkUserMessage>)
    expect(messages[0]?.message.content[0]).toEqual({ type: 'text', text: 'RESUME PREFIX: ' })
    expect(messages[0]?.message.content[1]?.type).toBe('image')
  })

  test('iterating twice yields the same content (idempotent iteration)', async () => {
    const result = buildClaudePromptInput(
      baseRequest([{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_PNG_B64 } }]),
    ) as AsyncIterable<ClaudeSdkUserMessage>
    const first = await collectIterable(result)
    const second = await collectIterable(result)
    expect(first.length).toBe(1)
    expect(second.length).toBe(1)
    expect(first[0]?.message.content).toEqual(second[0]?.message.content)
  })
})
