/**
 * Bidirectional content block mapping between the Kodizm canonical
 * wire shape (`@/wire/content`) and the Claude SDK's content block
 * shape.
 *
 * The shapes are nearly identical; the differences are surface-level
 * key naming. The Anthropic SDK uses snake_case in the JSON wire
 * (`media_type`, `tool_use_id`, `is_error`); Kodizm canonical uses
 * camelCase (`mediaType`, `toolUseId`, `isError`). This module is the
 * one place that translation lives.
 *
 * Outgoing direction ({@link contentBlockToSdk}) re-enforces the inline
 * base64 size cap: the wire schema (`@/wire/content`) already gates on
 * the cap, but defense-in-depth prevents an internal caller from
 * smuggling an oversized payload past the schema layer.
 */

import {
  type ContentBlock,
  type DocumentContentBlock,
  type ImageContentBlock,
  MAX_INLINE_BASE64_BYTES,
  type TextContentBlock,
  type ToolResultContentBlock,
  type ToolUseContentBlock,
} from '../../wire/content.ts'

/**
 * SDK-shaped content block. Mirrors the Anthropic SDK's content block
 * union (snake_case keys at the wire). Kept structural so the SDK's
 * own type imports are not required for unit tests.
 */
export type ClaudeSdkContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ClaudeSdkBinarySource }
  | { type: 'document'; source: ClaudeSdkBinarySource; title?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: Array<{ type: 'text'; text: string }>
      is_error: boolean
    }

type ClaudeSdkBinarySource = { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }

/**
 * Translate a single Kodizm content block into the SDK's shape.
 *
 * @throws {RangeError} when an inline base64 image/document exceeds
 *   {@link MAX_INLINE_BASE64_BYTES}.
 */
export function contentBlockToSdk(block: ContentBlock): ClaudeSdkContentBlock {
  switch (block.type) {
    case 'text':
      return mapText(block)
    case 'image':
      return mapImage(block)
    case 'document':
      return mapDocument(block)
    case 'tool_use':
      return mapToolUse(block)
    case 'tool_result':
      return mapToolResult(block)
  }
}

/**
 * Translate a list of Kodizm content blocks preserving order. Used
 * when the orchestrator hands the driver a `PromptRequest.prompt[]`.
 */
export function promptBlocksToSdk(blocks: ContentBlock[]): ClaudeSdkContentBlock[] {
  return blocks.map(contentBlockToSdk)
}

/**
 * Inverse mapping: SDK content block back to the Kodizm canonical
 * shape. Used when the driver receives content blocks from the SDK
 * (e.g., assistant `tool_use` echoed for the orchestrator).
 */
export function sdkContentBlockToKodizm(block: ClaudeSdkContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return { type: 'image', source: sdkSourceToKodizm(block.source) }
    case 'document': {
      const base = { type: 'document' as const, source: sdkSourceToKodizm(block.source) }
      return block.title === undefined ? base : { ...base, title: block.title }
    }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content: block.content.map((c) => ({ type: 'text', text: c.text })),
        isError: block.is_error,
      }
  }
}

function mapText(block: TextContentBlock): ClaudeSdkContentBlock {
  return { type: 'text', text: block.text }
}

function mapImage(block: ImageContentBlock): ClaudeSdkContentBlock {
  return { type: 'image', source: kodizmSourceToSdk(block.source) }
}

function mapDocument(block: DocumentContentBlock): ClaudeSdkContentBlock {
  const base = { type: 'document' as const, source: kodizmSourceToSdk(block.source) }
  return block.title === undefined ? base : { ...base, title: block.title }
}

function mapToolUse(block: ToolUseContentBlock): ClaudeSdkContentBlock {
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
}

function mapToolResult(block: ToolResultContentBlock): ClaudeSdkContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: block.toolUseId,
    content: block.content.map((c) => ({ type: 'text', text: c.text })),
    is_error: block.isError,
  }
}

function kodizmSourceToSdk(source: ImageContentBlock['source']): ClaudeSdkBinarySource {
  if (source.type === 'url') {
    return { type: 'url', url: source.url }
  }
  ensureInlineSizeUnderCap(source.data)
  return { type: 'base64', media_type: source.mediaType, data: source.data }
}

function sdkSourceToKodizm(source: ClaudeSdkBinarySource): ImageContentBlock['source'] {
  if (source.type === 'url') {
    return { type: 'url', url: source.url }
  }
  return { type: 'base64', mediaType: source.media_type, data: source.data }
}

/**
 * Defense-in-depth size cap. The wire schema already gates on this
 * limit; this guard catches internal callers that bypass the schema.
 */
function ensureInlineSizeUnderCap(data: string): void {
  const padding = data.match(/=+$/)?.[0]?.length ?? 0
  const decoded = Math.floor(data.length / 4) * 3 - padding
  if (decoded > MAX_INLINE_BASE64_BYTES) {
    throw new RangeError(
      `inline base64 must decode to <= ${MAX_INLINE_BASE64_BYTES} bytes; use a URL source for larger attachments`,
    )
  }
}
