/**
 * Content block schemas (zod) for `session/prompt` payloads.
 *
 * Mirrors Anthropic's SDK content block shapes (text, image, document,
 * tool_use, tool_result) but lives at the Kodizm wire boundary. Every
 * backend driver translates these to its native shape:
 *   - Claude SDK: passes through with light renaming
 *   - Codex: maps to its multi-turn content array
 *   - Opencode: maps to its prompt parts
 *
 * Inline binary attachments (base64) are capped to 5MB to keep the
 * wire light; larger payloads should use `url` sources backed by
 * presigned object storage.
 */

import { z } from 'zod'

/**
 * Maximum size in bytes for a single inline base64 attachment. Beyond
 * this, callers must use a URL-sourced block backed by external
 * storage. Decode size, not the base64 string length: each 4 base64
 * chars decode to 3 bytes.
 */
export const MAX_INLINE_BASE64_BYTES = 5 * 1024 * 1024

/**
 * Compute decoded byte length of a base64 string without actually
 * decoding it. Standard formula: floor(len/4) * 3, minus padding.
 */
function decodedBase64Bytes(data: string): number {
  // 1. Strip padding for the math; each '=' subtracts a byte.
  const padding = data.match(/=+$/)?.[0]?.length ?? 0
  return Math.floor(data.length / 4) * 3 - padding
}

const Base64Source = z
  .object({
    type: z.literal('base64'),
    mediaType: z.string().min(1),
    data: z.string().min(1),
  })
  .refine((source) => decodedBase64Bytes(source.data) <= MAX_INLINE_BASE64_BYTES, {
    message: `inline base64 must decode to <= ${MAX_INLINE_BASE64_BYTES} bytes; use a URL source for larger attachments`,
  })

const UrlSource = z.object({
  type: z.literal('url'),
  url: z.string().url(),
})

// z.discriminatedUnion rejects refined members (ZodEffects), so the binary
// source uses a plain union. Both members still keep the `type` literal so
// runtime narrowing works through the union.
const BinarySource = z.union([Base64Source, UrlSource])

/**
 * `text` block: plain text turn from the user or the assistant.
 */
export const TextContentBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
})

/**
 * `image` block: PNG / JPEG / WEBP image, inline (base64) or URL.
 */
export const ImageContentBlockSchema = z.object({
  type: z.literal('image'),
  source: BinarySource,
})

/**
 * `document` block: PDF (or other binary docs the SDK supports),
 * inline (base64) or URL. Optional `title` surfaces in the SDK's
 * tool descriptions.
 */
export const DocumentContentBlockSchema = z.object({
  type: z.literal('document'),
  source: BinarySource,
  title: z.string().min(1).optional(),
})

/**
 * `tool_use` block: a tool invocation requested by the assistant.
 * Mirrors Anthropic's tool_use shape; the wire-level event stream
 * surfaces these via `tool_call_begin`.
 */
export const ToolUseContentBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
})

/**
 * `tool_result` block: settles a prior `tool_use`. The `content`
 * array carries the result back to the model; usually a single text
 * block but the SDK accepts arbitrary nested content.
 */
export const ToolResultContentBlockSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string().min(1),
  content: z.array(
    z.object({
      type: z.literal('text'),
      text: z.string(),
    }),
  ),
  isError: z.boolean(),
})

/**
 * Discriminated union of every content block. Used as
 * `PromptRequest.prompt[]` once T15 wires it into the request schema.
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextContentBlockSchema,
  ImageContentBlockSchema,
  DocumentContentBlockSchema,
  ToolUseContentBlockSchema,
  ToolResultContentBlockSchema,
])

export type ContentBlock = z.infer<typeof ContentBlockSchema>
export type TextContentBlock = z.infer<typeof TextContentBlockSchema>
export type ImageContentBlock = z.infer<typeof ImageContentBlockSchema>
export type DocumentContentBlock = z.infer<typeof DocumentContentBlockSchema>
export type ToolUseContentBlock = z.infer<typeof ToolUseContentBlockSchema>
export type ToolResultContentBlock = z.infer<typeof ToolResultContentBlockSchema>
