/**
 * Translate the Kodizm canonical {@link PromptRequest.prompt} (an array
 * of content blocks) into opencode's `parts` array.
 *
 * Opencode's session.prompt accepts a parts union:
 *
 *   { type: 'text', text }
 *   { type: 'file', mime, filename?, url }
 *   { type: 'agent', name, source? }   // not used here
 *   { type: 'subtask', ... }           // not used here
 *
 * Both image and document content blocks fold into the single `file`
 * part shape: base64 sources are encoded as `data:<mime>;base64,<data>`
 * URIs (opencode accepts these natively); URL sources pass through.
 *
 * The helper does NOT touch the filesystem; the orchestrator already
 * produced canonical bytes (PHP GD on the kodizm.com side), and
 * opencode reads the data URL inline.
 */

import { randomUUID } from 'node:crypto'

import type { ContentBlock, DocumentContentBlock, ImageContentBlock, TextContentBlock } from '../../wire/content.ts'
import type { PromptRequest } from '../../wire/types.ts'

export type OpencodePart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename: string; url: string }

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/markdown': 'md',
  'text/plain': 'txt',
}

const FILENAME_SAFE_RE = /[^A-Za-z0-9._-]/g

export function buildOpencodeParts(params: PromptRequest): OpencodePart[] {
  const out: OpencodePart[] = []
  const blocks = params.prompt as ContentBlock[]
  for (const block of blocks) {
    if (block.type === 'text') {
      out.push(mapText(block))
    } else if (block.type === 'image') {
      out.push(mapImage(block))
    } else if (block.type === 'document') {
      out.push(mapDocument(block))
    }
    // tool_use / tool_result blocks have no opencode equivalent on the
    // outbound prompt path; skip them silently.
  }
  return out
}

function mapText(block: TextContentBlock): OpencodePart {
  return { type: 'text', text: block.text }
}

function mapImage(block: ImageContentBlock): OpencodePart {
  const mime = block.source.type === 'base64' ? block.source.mediaType : 'image/*'
  const ext = MIME_TO_EXT[mime] ?? 'bin'
  const filename = `${randomUUID()}.${ext}`
  if (block.source.type === 'url') {
    return { type: 'file', mime, filename: filenameFromUrl(block.source.url, ext), url: block.source.url }
  }
  return {
    type: 'file',
    mime,
    filename,
    url: `data:${mime};base64,${block.source.data}`,
  }
}

function mapDocument(block: DocumentContentBlock): OpencodePart {
  const mime = block.source.type === 'base64' ? block.source.mediaType : 'application/octet-stream'
  const ext = MIME_TO_EXT[mime] ?? 'bin'
  const rawFilename = block.title ?? `${randomUUID()}.${ext}`
  const filename = rawFilename.replace(FILENAME_SAFE_RE, '_')
  if (block.source.type === 'url') {
    return { type: 'file', mime, filename, url: block.source.url }
  }
  return {
    type: 'file',
    mime,
    filename,
    url: `data:${mime};base64,${block.source.data}`,
  }
}

function filenameFromUrl(url: string, fallbackExt: string): string {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').pop()
    if (last && last.length > 0) {
      return last.replace(FILENAME_SAFE_RE, '_')
    }
  } catch {
    // Fall through to a UUID filename when the URL can't be parsed
    // (opencode requires a non-empty filename for FilePartInput).
  }
  return `${randomUUID()}.${fallbackExt}`
}
