import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  INTERRUPT_MARKER,
  INTERRUPT_TOOL_MARKER,
  TranscriptTail,
  UsageLedger,
  assistantBlocks,
  assistantStopReason,
  classifyInterrupt,
  isMainChain,
} from '@/live/transcript.ts'

// Record shapes captured from CLI 2.1.280 (haiku): one content block per assistant record, every record of one API
// message carrying the same message.id and usage, and an empty `thinking` text when the model's thinking is hidden.
const USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 8783,
  cache_read_input_tokens: 21225,
  output_tokens: 141,
  output_tokens_details: {
    thinking_tokens: 59,
  },
  service_tier: 'standard',
}

function assistant(id: string, block: Record<string, unknown>, usage: Record<string, unknown> = USAGE) {
  return {
    type: 'assistant',
    isSidechain: false,
    timestamp: '2026-11-04T02:05:57.000Z',
    message: {
      id,
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'end_turn',
      content: [block],
      usage,
    },
  }
}

function userText(text: string, sidechain = false) {
  return {
    type: 'user',
    isSidechain: sidechain,
    timestamp: '2026-11-04T02:06:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text,
        },
      ],
    },
  }
}

let root = ''
let counter = 0

function path(): string {
  counter += 1

  return join(root, `t-${counter}.jsonl`)
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kdz-transcript-test-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('TranscriptTail', () => {
  test('returns nothing while the file does not exist', async () => {
    const tail = new TranscriptTail(path())

    expect(await tail.poll()).toEqual([])
  })

  test('reads only what was appended since the last poll', async () => {
    const file = path()
    await writeFile(file, line({ type: 'mode', n: 1 }))
    const tail = new TranscriptTail(file)

    expect(await tail.poll()).toEqual([{ type: 'mode', n: 1 }])
    expect(await tail.poll()).toEqual([])

    await appendFile(file, line({ type: 'mode', n: 2 }) + line({ type: 'mode', n: 3 }))
    expect(await tail.poll()).toEqual([
      { type: 'mode', n: 2 },
      { type: 'mode', n: 3 },
    ])
  })

  test('holds a partial last line until its newline arrives', async () => {
    const file = path()
    const full = JSON.stringify({ type: 'mode', text: 'split' })
    await writeFile(file, full.slice(0, 10))
    const tail = new TranscriptTail(file)

    expect(await tail.poll()).toEqual([])

    await appendFile(file, `${full.slice(10)}\n`)
    expect(await tail.poll()).toEqual([{ type: 'mode', text: 'split' }])
  })

  test('keeps a multi-byte character split across two writes intact', async () => {
    const file = path()
    const bytes = new TextEncoder().encode(line({ text: 'çğüşö 🚀' }))
    const cut = bytes.indexOf(0xf0) + 2
    await writeFile(file, bytes.slice(0, cut))
    const tail = new TranscriptTail(file)

    expect(await tail.poll()).toEqual([])

    await appendFile(file, bytes.slice(cut))
    expect(await tail.poll()).toEqual([{ text: 'çğüşö 🚀' }])
  })

  test('skips a complete line that is not JSON and counts it', async () => {
    const file = path()
    await writeFile(file, `not json\n${line({ ok: true })}`)
    const tail = new TranscriptTail(file)

    expect(await tail.poll()).toEqual([{ ok: true }])
    expect(tail.skipped).toBe(1)
  })

  test('starts over when the file shrinks', async () => {
    const file = path()
    await writeFile(file, line({ n: 1 }) + line({ n: 2 }))
    const tail = new TranscriptTail(file)
    await tail.poll()

    await writeFile(file, line({ n: 3 }))
    expect(await tail.poll()).toEqual([{ n: 3 }])
  })

  test('atEnd skips the history a resumed transcript already holds', async () => {
    const file = path()
    await writeFile(file, line({ n: 1 }))
    const tail = await TranscriptTail.atEnd(file)

    expect(await tail.poll()).toEqual([])

    await appendFile(file, line({ n: 2 }))
    expect(await tail.poll()).toEqual([{ n: 2 }])
  })
})

describe('classifyInterrupt', () => {
  test('detects the turn marker', () => {
    expect(classifyInterrupt(userText(INTERRUPT_MARKER))).toBe('turn')
  })

  test('detects the tool dialog marker', () => {
    expect(classifyInterrupt(userText(INTERRUPT_TOOL_MARKER))).toBe('tool_use')
  })

  test('ignores a typed prompt that carries the marker text as a plain string', () => {
    const typed = {
      ...userText(''),
      message: {
        role: 'user',
        content: INTERRUPT_MARKER,
      },
    }

    expect(classifyInterrupt(typed)).toBeNull()
  })

  test('ignores a marker inside a sidechain, a longer content array and a record without a timestamp', () => {
    const twoBlocks = userText(INTERRUPT_MARKER)
    twoBlocks.message.content.push({ type: 'text', text: 'more' })
    const { timestamp: _dropped, ...noTimestamp } = userText(INTERRUPT_MARKER)

    expect(classifyInterrupt(userText(INTERRUPT_MARKER, true))).toBeNull()
    expect(classifyInterrupt(twoBlocks)).toBeNull()
    expect(classifyInterrupt(noTimestamp)).toBeNull()
    expect(classifyInterrupt(assistant('msg_1', { type: 'text', text: INTERRUPT_MARKER }))).toBeNull()
  })
})

describe('UsageLedger', () => {
  test('counts the usage of one message id once across its records', () => {
    const ledger = new UsageLedger()

    expect(ledger.take(assistant('msg_A', { type: 'thinking', thinking: '' }))).toEqual({
      inputTokens: 10,
      outputTokens: 141,
      cacheReadTokens: 21225,
      cacheCreationTokens: 8783,
    })
    expect(ledger.take(assistant('msg_A', { type: 'text', text: 'hi' }))).toBeNull()
  })

  test('sends only the growth when a later record of the same message reports more', () => {
    const ledger = new UsageLedger()
    ledger.take(assistant('msg_A', { type: 'text', text: 'a' }, { ...USAGE, output_tokens: 100 }))

    expect(ledger.take(assistant('msg_A', { type: 'text', text: 'b' }))).toEqual({
      inputTokens: 0,
      outputTokens: 41,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })

  test('counts a new message id again and ignores sidechain and non-assistant records', () => {
    const ledger = new UsageLedger()
    ledger.take(assistant('msg_A', { type: 'text', text: 'a' }))
    const sidechain = { ...assistant('msg_S', { type: 'text', text: 's' }), isSidechain: true }

    expect(ledger.take(assistant('msg_B', { type: 'text', text: 'b' }))?.outputTokens).toBe(141)
    expect(ledger.take(sidechain)).toBeNull()
    expect(ledger.take(userText('x'))).toBeNull()
  })
})

describe('record helpers', () => {
  test('assistantBlocks yields text and non-empty thinking only', () => {
    expect(assistantBlocks(assistant('m', { type: 'text', text: 'Hello' }))).toEqual([{ kind: 'text', text: 'Hello' }])
    expect(assistantBlocks(assistant('m', { type: 'thinking', thinking: 'Plan' }))).toEqual([
      { kind: 'thinking', text: 'Plan' },
    ])
    expect(assistantBlocks(assistant('m', { type: 'thinking', thinking: '' }))).toEqual([])
    expect(assistantBlocks(assistant('m', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }))).toEqual([])
    expect(assistantBlocks(userText('x'))).toEqual([])
  })

  test('assistantStopReason and isMainChain read the record', () => {
    expect(assistantStopReason(assistant('m', { type: 'text', text: 'a' }))).toBe('end_turn')
    expect(assistantStopReason(userText('x'))).toBeNull()
    expect(isMainChain(userText('x'))).toBe(true)
    expect(isMainChain(userText('x', true))).toBe(false)
  })
})
