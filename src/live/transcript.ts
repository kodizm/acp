/**
 * Transcript tail of a Live pane: the CLI's session JSONL, read by byte offset.
 *
 * Hooks do not carry the assistant's text, thinking or token counts, and Esc fires no hook at all, so the daemon reads
 * those from the transcript. The file is only ever appended to while the session lives; each poll reads the bytes
 * past the last offset, keeps an unterminated last line for the next poll, and never re-parses what it already read.
 *
 * Shapes follow CLI 2.1.280: one content block per assistant record, every record of one API message carrying the same
 * `message.id` and usage, sidechain records flagged with `isSidechain`.
 */

import { stat } from 'node:fs/promises'

export const INTERRUPT_MARKER = '[Request interrupted by user]'
export const INTERRUPT_TOOL_MARKER = '[Request interrupted by user for tool use]'

export type TranscriptRecord = Record<string, unknown>

/** `turn`: Esc during output; `tool_use`: Esc on a permission dialog. */
export type InterruptKind = 'turn' | 'tool_use'

export interface UsageCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface AssistantBlock {
  kind: 'text' | 'thinking'
  text: string
}

const NEWLINE = 0x0a

export class TranscriptTail {
  public readonly path: string
  /** Complete lines that were not JSON; the CLI never writes one, so a count above zero is worth a log line. */
  public skipped = 0
  private offset: number
  private pending: Uint8Array = new Uint8Array(0)

  public constructor(path: string, offset = 0) {
    this.path = path
    this.offset = offset
  }

  /**
   * A tail that starts past what the file holds now: a resumed session's history was streamed by an earlier pane.
   */
  public static async atEnd(path: string): Promise<TranscriptTail> {
    const file = Bun.file(path)

    return new TranscriptTail(path, (await file.exists()) ? file.size : 0)
  }

  /**
   * The records appended since the last poll, in file order. Empty while the file does not exist yet.
   */
  public async poll(): Promise<TranscriptRecord[]> {
    const size = await fileSize(this.path)
    if (size === null) {
      return []
    }

    // 1. A shorter file was replaced, not appended to: what the offset pointed at is gone.
    if (size < this.offset) {
      this.offset = 0
      this.pending = new Uint8Array(0)
    }
    if (size === this.offset) {
      return []
    }

    // 2. Lines are cut on raw bytes, so a character split across two writes is decoded only once it is whole.
    const chunk = new Uint8Array(await Bun.file(this.path).slice(this.offset, size).arrayBuffer())
    this.offset += chunk.byteLength
    const bytes = concat(this.pending, chunk)
    const end = bytes.lastIndexOf(NEWLINE)
    if (end === -1) {
      this.pending = bytes

      return []
    }
    this.pending = bytes.slice(end + 1)

    return this.parse(new TextDecoder().decode(bytes.subarray(0, end)))
  }

  private parse(text: string): TranscriptRecord[] {
    const records: TranscriptRecord[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue
      }
      const record = parseLine(line)
      if (record === null) {
        this.skipped += 1
        continue
      }
      records.push(record)
    }

    return records
  }
}

/**
 * Whether the record is the CLI's own interrupt marker.
 *
 * The marker is a main-chain user record whose content is an array of exactly one text block equal to the marker, with
 * a timestamp. A prompt the operator typed is a plain string, so typing the marker text never matches. No
 * interruptedMessageId is required: the CLI omits it for an interrupt before the first response.
 */
export function classifyInterrupt(record: TranscriptRecord): InterruptKind | null {
  if (record.type !== 'user' || !isMainChain(record) || typeof record.timestamp !== 'string') {
    return null
  }

  const content = messageOf(record)?.content
  if (!Array.isArray(content) || content.length !== 1) {
    return null
  }

  const [block] = content
  if (!isRecord(block) || block.type !== 'text') {
    return null
  }
  if (block.text === INTERRUPT_MARKER) {
    return 'turn'
  }
  if (block.text === INTERRUPT_TOOL_MARKER) {
    return 'tool_use'
  }

  return null
}

/**
 * Token counts per API message, sent once.
 *
 * Every record of one message repeats its usage, so the ledger remembers what it already counted per `message.id` and
 * yields only the growth: a later record reporting more output still adds the difference, a repeat adds nothing.
 */
export class UsageLedger {
  private readonly counted = new Map<string, UsageCounts>()

  public take(record: TranscriptRecord): UsageCounts | null {
    const message = messageOf(record)
    if (record.type !== 'assistant' || !isMainChain(record) || message === null) {
      return null
    }
    if (typeof message.id !== 'string' || !isRecord(message.usage)) {
      return null
    }

    const seen = this.counted.get(message.id) ?? emptyCounts()
    const now: UsageCounts = {
      inputTokens: Math.max(seen.inputTokens, count(message.usage.input_tokens)),
      outputTokens: Math.max(seen.outputTokens, count(message.usage.output_tokens)),
      cacheReadTokens: Math.max(seen.cacheReadTokens, count(message.usage.cache_read_input_tokens)),
      cacheCreationTokens: Math.max(seen.cacheCreationTokens, count(message.usage.cache_creation_input_tokens)),
    }
    this.counted.set(message.id, now)

    const delta: UsageCounts = {
      inputTokens: now.inputTokens - seen.inputTokens,
      outputTokens: now.outputTokens - seen.outputTokens,
      cacheReadTokens: now.cacheReadTokens - seen.cacheReadTokens,
      cacheCreationTokens: now.cacheCreationTokens - seen.cacheCreationTokens,
    }

    return Object.values(delta).some((value) => value > 0) ? delta : null
  }
}

/**
 * The text and thinking of a main-chain assistant record. Thinking the CLI hides arrives as an empty string and is
 * dropped.
 */
export function assistantBlocks(record: TranscriptRecord): AssistantBlock[] {
  const content = messageOf(record)?.content
  if (record.type !== 'assistant' || !isMainChain(record) || !Array.isArray(content)) {
    return []
  }

  const blocks: AssistantBlock[] = []
  for (const block of content) {
    if (!isRecord(block)) {
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      blocks.push({ kind: 'text', text: block.text })
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
      blocks.push({ kind: 'thinking', text: block.thinking })
    }
  }

  return blocks
}

/**
 * The API stop reason of an assistant record (`end_turn`, `tool_use`, `max_tokens`, ...), null for anything else.
 */
export function assistantStopReason(record: TranscriptRecord): string | null {
  const reason = messageOf(record)?.stop_reason

  return record.type === 'assistant' && typeof reason === 'string' ? reason : null
}

export function isMainChain(record: TranscriptRecord): boolean {
  return record.isSidechain !== true
}

function messageOf(record: TranscriptRecord): Record<string, unknown> | null {
  return isRecord(record.message) ? record.message : null
}

function parseLine(line: string): TranscriptRecord | null {
  try {
    const value: unknown = JSON.parse(line)

    return isRecord(value) ? value : null
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) {
    return right
  }

  const joined = new Uint8Array(left.byteLength + right.byteLength)
  joined.set(left)
  joined.set(right, left.byteLength)

  return joined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function emptyCounts(): UsageCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
