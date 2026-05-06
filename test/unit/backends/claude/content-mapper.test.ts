import { describe, expect, test } from 'bun:test'

import {
  type ClaudeSdkContentBlock,
  contentBlockToSdk,
  promptBlocksToSdk,
  sdkContentBlockToKodizm,
} from '@/backends/claude/content-mapper.ts'
import { MAX_INLINE_BASE64_BYTES } from '@/wire/content.ts'

describe('contentBlockToSdk, text', () => {
  test('text block passes through verbatim', () => {
    const sdk = contentBlockToSdk({ type: 'text', text: 'Hello world' })
    expect(sdk).toEqual({ type: 'text', text: 'Hello world' })
  })
})

describe('contentBlockToSdk, image', () => {
  test('base64 image renames mediaType to media_type for the SDK', () => {
    const sdk = contentBlockToSdk({
      type: 'image',
      source: {
        type: 'base64',
        mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      },
    })

    expect(sdk).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      },
    })
  })

  test('url image source roundtrips with no key renaming', () => {
    const sdk = contentBlockToSdk({
      type: 'image',
      source: { type: 'url', url: 'https://kodizm.com/logo.png' },
    })

    expect(sdk).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://kodizm.com/logo.png' },
    })
  })

  test('rejects an inline base64 payload over the size cap', () => {
    const charsToClearCap = Math.ceil(MAX_INLINE_BASE64_BYTES / 3) * 4 + 4
    const oversize = 'A'.repeat(charsToClearCap)

    expect(() =>
      contentBlockToSdk({
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: oversize },
      }),
    ).toThrow(/inline base64/)
  })
})

describe('contentBlockToSdk, document', () => {
  test('base64 document renames mediaType + preserves optional title', () => {
    const sdk = contentBlockToSdk({
      type: 'document',
      source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0xLjQK' },
      title: 'Spec v1',
    })

    expect(sdk).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' },
      title: 'Spec v1',
    })
  })

  test('document without a title omits the field', () => {
    const sdk = contentBlockToSdk({
      type: 'document',
      source: { type: 'url', url: 'https://kodizm.com/spec.pdf' },
    })

    expect(sdk).toEqual({
      type: 'document',
      source: { type: 'url', url: 'https://kodizm.com/spec.pdf' },
    })
  })
})

describe('contentBlockToSdk, tool_use', () => {
  test('tool_use block passes id + name + input verbatim', () => {
    const sdk = contentBlockToSdk({
      type: 'tool_use',
      id: 'tu_1',
      name: 'mcp__kodizm__kodizm_create_task',
      input: { title: 'Refactor auth' },
    })

    expect(sdk).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'mcp__kodizm__kodizm_create_task',
      input: { title: 'Refactor auth' },
    })
  })
})

describe('contentBlockToSdk, tool_result', () => {
  test('tool_result renames toolUseId/isError to snake_case', () => {
    const sdk = contentBlockToSdk({
      type: 'tool_result',
      toolUseId: 'tu_1',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })

    expect(sdk).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: [{ type: 'text', text: 'ok' }],
      is_error: false,
    })
  })
})

describe('promptBlocksToSdk', () => {
  test('translates a mixed list preserving order', () => {
    const sdkBlocks = promptBlocksToSdk([
      { type: 'text', text: 'Look at this:' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://kodizm.com/logo.png' },
      },
      { type: 'text', text: 'What is it?' },
    ])

    expect(sdkBlocks.map((b) => b.type)).toEqual(['text', 'image', 'text'])
  })
})

describe('sdkContentBlockToKodizm (inverse)', () => {
  test('SDK base64 image -> Kodizm shape (media_type renamed back)', () => {
    const kodizm = sdkContentBlockToKodizm({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
    } satisfies ClaudeSdkContentBlock)

    expect(kodizm).toEqual({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'aGk=' },
    })
  })

  test('SDK tool_result -> Kodizm shape (toolUseId/isError renamed back)', () => {
    const kodizm = sdkContentBlockToKodizm({
      type: 'tool_result',
      tool_use_id: 'tu_2',
      content: [{ type: 'text', text: 'permission denied' }],
      is_error: true,
    } satisfies ClaudeSdkContentBlock)

    expect(kodizm).toEqual({
      type: 'tool_result',
      toolUseId: 'tu_2',
      content: [{ type: 'text', text: 'permission denied' }],
      isError: true,
    })
  })

  test('SDK text passes through', () => {
    const kodizm = sdkContentBlockToKodizm({ type: 'text', text: 'hi' })
    expect(kodizm).toEqual({ type: 'text', text: 'hi' })
  })
})
