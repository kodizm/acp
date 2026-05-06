import { describe, expect, test } from 'bun:test'

import {
  ContentBlockSchema,
  DocumentContentBlockSchema,
  ImageContentBlockSchema,
  MAX_INLINE_BASE64_BYTES,
  TextContentBlockSchema,
  ToolResultContentBlockSchema,
  ToolUseContentBlockSchema,
} from '@/wire/content.ts'

describe('TextContentBlockSchema', () => {
  test('accepts a plain text block', () => {
    const block = { type: 'text' as const, text: 'Hello, world.' }
    expect(TextContentBlockSchema.safeParse(block).success).toBe(true)
  })

  test('rejects an empty text string', () => {
    const block = { type: 'text', text: '' }
    expect(TextContentBlockSchema.safeParse(block).success).toBe(false)
  })
})

describe('ImageContentBlockSchema', () => {
  test('accepts a base64-sourced image block under the size limit', () => {
    const block = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      },
    }
    expect(ImageContentBlockSchema.safeParse(block).success).toBe(true)
  })

  test('accepts a url-sourced image block', () => {
    const block = {
      type: 'image' as const,
      source: {
        type: 'url' as const,
        url: 'https://kodizm.com/logo.png',
      },
    }
    expect(ImageContentBlockSchema.safeParse(block).success).toBe(true)
  })

  test('rejects a base64 payload exceeding the inline size cap', () => {
    // Each 4 base64 chars decode to 3 bytes. To clear the 5MB cap we
    // need ceil(cap / 3) * 4 + 4 chars (with a small overshoot).
    const charsToClearCap = Math.ceil(MAX_INLINE_BASE64_BYTES / 3) * 4 + 4
    const oversize = 'A'.repeat(charsToClearCap)
    const block = {
      type: 'image' as const,
      source: {
        type: 'base64',
        mediaType: 'image/png',
        data: oversize,
      },
    }
    expect(ImageContentBlockSchema.safeParse(block).success).toBe(false)
  })

  test('rejects an unsupported source type', () => {
    const block = {
      type: 'image',
      source: {
        type: 'magic',
        mediaType: 'image/png',
        data: 'aaa',
      },
    }
    expect(ImageContentBlockSchema.safeParse(block).success).toBe(false)
  })
})

describe('DocumentContentBlockSchema', () => {
  test('accepts a base64-sourced PDF document block', () => {
    const block = {
      type: 'document' as const,
      source: {
        type: 'base64' as const,
        mediaType: 'application/pdf',
        data: 'JVBERi0xLjQKJeLjz9MK',
      },
    }
    expect(DocumentContentBlockSchema.safeParse(block).success).toBe(true)
  })

  test('accepts a url-sourced document block with title', () => {
    const block = {
      type: 'document' as const,
      source: {
        type: 'url' as const,
        url: 'https://kodizm.com/spec.pdf',
      },
      title: 'Spec v1',
    }
    expect(DocumentContentBlockSchema.safeParse(block).success).toBe(true)
  })
})

describe('ToolUseContentBlockSchema', () => {
  test('roundtrips a tool_use block with id + name + input', () => {
    const block = {
      type: 'tool_use' as const,
      id: 'tu_1',
      name: 'mcp__kodizm__kodizm_create_task',
      input: { title: 'Refactor auth' },
    }
    expect(ToolUseContentBlockSchema.safeParse(block).success).toBe(true)
  })

  test('rejects a tool_use without a name', () => {
    const block = { type: 'tool_use', id: 'tu_1', input: {} }
    expect(ToolUseContentBlockSchema.safeParse(block).success).toBe(false)
  })
})

describe('ToolResultContentBlockSchema', () => {
  test('roundtrips a tool_result with success payload', () => {
    const block = {
      type: 'tool_result' as const,
      toolUseId: 'tu_1',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }
    expect(ToolResultContentBlockSchema.safeParse(block).success).toBe(true)
  })

  test('roundtrips a tool_result with isError flag', () => {
    const block = {
      type: 'tool_result' as const,
      toolUseId: 'tu_1',
      content: [{ type: 'text', text: 'permission denied' }],
      isError: true,
    }
    expect(ToolResultContentBlockSchema.safeParse(block).success).toBe(true)
  })
})

describe('ContentBlockSchema (discriminated union)', () => {
  test('routes by the type discriminator', () => {
    const inputs = [
      { type: 'text', text: 'hi' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://x.com/y.png' },
      },
      {
        type: 'document',
        source: { type: 'url', url: 'https://x.com/y.pdf' },
      },
      { type: 'tool_use', id: 'tu_1', name: 'foo', input: {} },
      {
        type: 'tool_result',
        toolUseId: 'tu_1',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    ]

    for (const input of inputs) {
      expect(ContentBlockSchema.safeParse(input).success).toBe(true)
    }
  })

  test('rejects an unknown content block type', () => {
    const block = { type: 'magic', payload: 42 }
    expect(ContentBlockSchema.safeParse(block).success).toBe(false)
  })
})
