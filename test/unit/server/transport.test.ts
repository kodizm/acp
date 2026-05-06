import { describe, expect, test } from 'bun:test'

import { createNdjsonTransport } from '@/server/transport.ts'

/**
 * Helper: build a readable stream from a sequence of raw byte chunks
 * (so tests can simulate chunked stdin where lines may span chunks).
 */
function chunkedReadable(chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
  const queue = [...chunks]

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift()
      if (next === undefined) {
        controller.close()
        return
      }
      controller.enqueue(next)
    },
  })
}

/**
 * Helper: collect everything written into an in-memory buffer.
 */
function bufferingWritable(): { writable: WritableStream<Uint8Array>; bytes: () => Uint8Array } {
  const collected: Uint8Array[] = []

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      collected.push(chunk)
    },
  })

  return {
    writable,
    bytes: () => {
      const total = collected.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of collected) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      return out
    },
  }
}

const utf8 = new TextEncoder()
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('createNdjsonTransport.readFrames', () => {
  test('yields each well-formed frame from a single chunk', async () => {
    const readable = chunkedReadable([utf8.encode('{"a":1}\n{"b":2}\n')])
    const transport = createNdjsonTransport({ readable, writable: bufferingWritable().writable })

    const frames: unknown[] = []
    for await (const frame of transport.readFrames()) {
      frames.push(frame)
    }

    expect(frames).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('buffers a partial line across chunk boundaries', async () => {
    const readable = chunkedReadable([utf8.encode('{"a":'), utf8.encode('1}\n')])
    const transport = createNdjsonTransport({ readable, writable: bufferingWritable().writable })

    const frames: unknown[] = []
    for await (const frame of transport.readFrames()) {
      frames.push(frame)
    }

    expect(frames).toEqual([{ a: 1 }])
  })

  test('handles a UTF-8 multi-byte char split across chunks', async () => {
    // Turkish 'ş' = 0xC5 0x9F. Split between bytes.
    const readable = chunkedReadable([
      new Uint8Array([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xc5]), // {"n":"<half-byte>
      new Uint8Array([0x9f, 0x22, 0x7d, 0x0a]), // <other-half>"}\n
    ])
    const transport = createNdjsonTransport({ readable, writable: bufferingWritable().writable })

    const frames: unknown[] = []
    for await (const frame of transport.readFrames()) {
      frames.push(frame)
    }

    expect(frames).toEqual([{ n: 'ş' }])
  })

  test('skips a malformed line, calls onInvalidFrame, continues with next', async () => {
    const invalidLines: string[] = []
    const readable = chunkedReadable([utf8.encode('{"a":1}\nthis is not json\n{"b":2}\n')])
    const transport = createNdjsonTransport({
      readable,
      writable: bufferingWritable().writable,
      onInvalidFrame: (raw) => invalidLines.push(raw),
    })

    const frames: unknown[] = []
    for await (const frame of transport.readFrames()) {
      frames.push(frame)
    }

    expect(frames).toEqual([{ a: 1 }, { b: 2 }])
    expect(invalidLines).toEqual(['this is not json'])
  })

  test('drains buffered partial line at EOF (no trailing newline)', async () => {
    const readable = chunkedReadable([utf8.encode('{"a":1}\n{"b":2}')])
    const transport = createNdjsonTransport({ readable, writable: bufferingWritable().writable })

    const frames: unknown[] = []
    for await (const frame of transport.readFrames()) {
      frames.push(frame)
    }

    expect(frames).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('skips empty lines silently', async () => {
    const invalidLines: string[] = []
    const readable = chunkedReadable([utf8.encode('{"a":1}\n\n{"b":2}\n')])
    const transport = createNdjsonTransport({
      readable,
      writable: bufferingWritable().writable,
      onInvalidFrame: (raw) => invalidLines.push(raw),
    })

    const frames: unknown[] = []
    for await (const frame of transport.readFrames()) {
      frames.push(frame)
    }

    expect(frames).toEqual([{ a: 1 }, { b: 2 }])
    expect(invalidLines).toEqual([])
  })
})

describe('createNdjsonTransport.writeFrame', () => {
  test('writes a single JSON line with trailing newline', async () => {
    const target = bufferingWritable()
    const transport = createNdjsonTransport({
      readable: chunkedReadable([]),
      writable: target.writable,
    })

    await transport.writeFrame({ ok: true })
    await transport.close()

    expect(decode(target.bytes())).toBe('{"ok":true}\n')
  })

  test('round-trips multiple frames in declared order', async () => {
    const target = bufferingWritable()
    const transport = createNdjsonTransport({
      readable: chunkedReadable([]),
      writable: target.writable,
    })

    await transport.writeFrame({ id: 1 })
    await transport.writeFrame({ id: 2 })
    await transport.writeFrame({ id: 3 })
    await transport.close()

    expect(decode(target.bytes())).toBe('{"id":1}\n{"id":2}\n{"id":3}\n')
  })
})
