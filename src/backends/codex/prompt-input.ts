/**
 * Translate the Kodizm canonical {@link PromptRequest.prompt} (an array
 * of content blocks) into codex's `UserInput[]` shape.
 *
 * Codex's UserInput enum (codex-rs/v2/UserInput.ts) is narrower than
 * the SDK's content-block union:
 *
 *   { type: 'text', text, text_elements }
 *   { type: 'image', url }            // remote URL (http/https)
 *   { type: 'localImage', path }      // file on the host filesystem
 *   { type: 'skill', name, path }
 *   { type: 'mention', name, path }
 *
 * No `document` variant, no inline-base64 image. Round 1 of the
 * acp-attachments interview locked the bridging policy:
 *   - text → `{type:'text', text, text_elements: []}`.
 *   - image with `source.type === 'url'` → `{type:'image', url}`.
 *   - image with `source.type === 'base64'` → write the decoded bytes to
 *     a temp file under `<tmpDir>/kodizm-acp-attachments/<sessionId>/<uuid>.<ext>`,
 *     emit `{type:'localImage', path}`, and return the path in
 *     `cleanupPaths` so the caller can unlink it after the prompt
 *     settles.
 *   - document (any source) → emit a single
 *     `{type:'text', text:'[Attached document: ...]'}` block so both
 *     the operator and the model know an attachment was supplied but
 *     codex cannot ingest it directly.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ContentBlock, DocumentContentBlock, ImageContentBlock } from '../../wire/content.ts'
import type { PromptRequest } from '../../wire/types.ts'

/**
 * Codex `UserInput` shape mirror. Defined locally so the helper does
 * not depend on codex SDK module loading; the driver passes these
 * through to the codex subprocess which validates structurally.
 */
export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }

export interface BuildCodexUserInputsOptions {
  /**
   * Root for materialised image temp files. Driver passes
   * `os.tmpdir()` in production. Tests pass a per-case mkdtemp dir
   * to keep filesystem state isolated.
   */
  tmpDir: string
  /**
   * Identifier used to namespace the materialised file directory so
   * concurrent sessions cannot collide. The driver passes its own
   * `sessionId`.
   */
  sessionId: string
}

export interface BuildCodexUserInputsResult {
  inputs: CodexUserInput[]
  /**
   * Absolute paths the helper wrote during materialisation. Caller
   * MUST unlink each entry in a `finally` block so temp files do not
   * accumulate, even when the prompt resolves with an error or is
   * aborted mid-flight.
   */
  cleanupPaths: string[]
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export async function buildCodexUserInputs(
  params: PromptRequest,
  options: BuildCodexUserInputsOptions,
): Promise<BuildCodexUserInputsResult> {
  const inputs: CodexUserInput[] = []
  const cleanupPaths: string[] = []

  const blocks = params.prompt as ContentBlock[]
  for (const block of blocks) {
    if (block.type === 'text') {
      inputs.push({ type: 'text', text: block.text, text_elements: [] })
      continue
    }
    if (block.type === 'image') {
      const piece = await mapImage(block, options)
      inputs.push(piece.input)
      if (piece.cleanupPath !== undefined) {
        cleanupPaths.push(piece.cleanupPath)
      }
      continue
    }
    if (block.type === 'document') {
      inputs.push({ type: 'text', text: documentDegradeText(block), text_elements: [] })
    }
    // tool_use / tool_result blocks have no codex equivalent on the
    // outbound prompt path; skip them silently.
  }

  return { inputs, cleanupPaths }
}

async function mapImage(
  block: ImageContentBlock,
  options: BuildCodexUserInputsOptions,
): Promise<{ input: CodexUserInput; cleanupPath?: string }> {
  if (block.source.type === 'url') {
    return { input: { type: 'image', url: block.source.url } }
  }

  const ext = MIME_TO_EXT[block.source.mediaType] ?? 'bin'
  const dir = path.join(options.tmpDir, 'kodizm-acp-attachments', options.sessionId)
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${randomUUID()}.${ext}`)
  await writeFile(filePath, Buffer.from(block.source.data, 'base64'))
  return { input: { type: 'localImage', path: filePath }, cleanupPath: filePath }
}

function documentDegradeText(block: DocumentContentBlock): string {
  const filename = block.title ?? 'document'
  const size = block.source.type === 'base64' ? decodedBase64Bytes(block.source.data) : undefined
  const sizeFragment = size === undefined ? '' : `, ${size} bytes`
  return `[Attached document: ${filename}${sizeFragment} — codex backend cannot ingest documents directly]`
}

function decodedBase64Bytes(data: string): number {
  const padding = data.match(/=+$/)?.[0]?.length ?? 0
  return Math.floor(data.length / 4) * 3 - padding
}
