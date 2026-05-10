import { describe, expect, test } from 'bun:test'

import { type OpencodePart, buildOpencodeParts } from '@/backends/opencode/prompt-input.ts'
import type { PromptRequest } from '@/wire/types.ts'

const FAKE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const baseRequest = (prompt: PromptRequest['prompt']): PromptRequest => ({
  sessionId: 'sess-test',
  prompt,
})

describe('buildOpencodeParts, text', () => {
  test('text block becomes opencode TextPartInput', () => {
    const parts = buildOpencodeParts(baseRequest([{ type: 'text', text: 'hello' }]))
    expect(parts).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('buildOpencodeParts, image', () => {
  test('base64 png image emits FilePartInput with data: URL', () => {
    const parts = buildOpencodeParts(
      baseRequest([{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_PNG_B64 } }]),
    )
    expect(parts.length).toBe(1)
    const file = parts[0] as Extract<OpencodePart, { type: 'file' }>
    expect(file.type).toBe('file')
    expect(file.mime).toBe('image/png')
    expect(file.url).toBe(`data:image/png;base64,${FAKE_PNG_B64}`)
    expect(file.filename).toMatch(/^[0-9a-f-]+\.png$/)
  })

  test('url image source preserves the original url + derives filename from path basename', () => {
    const parts = buildOpencodeParts(
      baseRequest([{ type: 'image', source: { type: 'url', url: 'https://kodizm.com/static/logo.png' } }]),
    )
    const file = parts[0] as Extract<OpencodePart, { type: 'file' }>
    expect(file.url).toBe('https://kodizm.com/static/logo.png')
    expect(file.filename).toBe('logo.png')
  })
})

describe('buildOpencodeParts, document', () => {
  test('base64 document with title preserves the title as filename', () => {
    const parts = buildOpencodeParts(
      baseRequest([
        {
          type: 'document',
          source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PNG_B64 },
          title: 'spec.pdf',
        },
      ]),
    )
    const file = parts[0] as Extract<OpencodePart, { type: 'file' }>
    expect(file.mime).toBe('application/pdf')
    expect(file.filename).toBe('spec.pdf')
    expect(file.url).toBe(`data:application/pdf;base64,${FAKE_PNG_B64}`)
  })

  test('document title is sanitised: unsafe chars become underscores', () => {
    const parts = buildOpencodeParts(
      baseRequest([
        {
          type: 'document',
          source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PNG_B64 },
          title: 'my; bad,name.pdf',
        },
      ]),
    )
    const file = parts[0] as Extract<OpencodePart, { type: 'file' }>
    expect(file.filename).toBe('my__bad_name.pdf')
  })

  test('url document falls back to a safe synthetic filename when no title is given', () => {
    const parts = buildOpencodeParts(
      baseRequest([
        {
          type: 'document',
          source: { type: 'url', url: 'https://kodizm.com/spec.pdf' },
        },
      ]),
    )
    const file = parts[0] as Extract<OpencodePart, { type: 'file' }>
    expect(file.url).toBe('https://kodizm.com/spec.pdf')
    expect(file.filename).toMatch(/^[0-9a-f-]+\.(pdf|bin)$/)
  })
})

describe('buildOpencodeParts, mixed payload', () => {
  test('preserves block order: text → image → document → text', () => {
    const parts = buildOpencodeParts(
      baseRequest([
        { type: 'text', text: 'before' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_PNG_B64 } },
        {
          type: 'document',
          source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PNG_B64 },
          title: 'spec.pdf',
        },
        { type: 'text', text: 'after' },
      ]),
    )
    expect(parts.length).toBe(4)
    expect(parts[0]).toEqual({ type: 'text', text: 'before' })
    expect(parts[1]?.type).toBe('file')
    expect((parts[1] as { mime: string }).mime).toBe('image/png')
    expect(parts[2]?.type).toBe('file')
    expect((parts[2] as { filename: string }).filename).toBe('spec.pdf')
    expect(parts[3]).toEqual({ type: 'text', text: 'after' })
  })
})
