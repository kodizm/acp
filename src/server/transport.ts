/**
 * NDJSON transport over a paired (ReadableStream, WritableStream).
 *
 * The ACP wire is newline-delimited JSON: each frame is a JSON object
 * followed by a single `\n`. This module owns the byte boundary:
 *
 * - Read side: streams in `Uint8Array` chunks, decodes UTF-8 with
 *   stream-mode awareness so multi-byte characters spanning chunks do
 *   not corrupt frames, splits on `\n`, parses each line as JSON, and
 *   yields the parsed object. Malformed lines are dropped through an
 *   optional `onInvalidFrame` callback so the loop never throws on a
 *   single garbled frame (which would bring the whole session down).
 *
 * - Write side: stringifies the frame, appends `\n`, writes through
 *   the shared writer. Frames are awaited in declared order so the
 *   wire stays sequential even under concurrent emit().
 *
 * The transport intentionally does no JSON-RPC framing; that lives
 * one layer up in `acp-server.ts`. Keeping the layers separate lets
 * tests exercise the wire mechanics without dragging in protocol
 * semantics.
 */

/**
 * Construction options for {@link createNdjsonTransport}.
 */
export interface NdjsonTransportOptions {
  /**
   * Source byte stream (e.g., `Bun.stdin.stream()` or a test harness).
   */
  readable: ReadableStream<Uint8Array>

  /**
   * Sink byte stream (e.g., a sink built around `process.stdout` or a
   * test harness buffering writable).
   */
  writable: WritableStream<Uint8Array>

  /**
   * Invoked for every line that fails JSON parsing. Useful to surface
   * wire corruption through the logger without crashing the loop.
   * Receives the raw line text without the trailing newline.
   */
  onInvalidFrame?: (rawLine: string, error: unknown) => void
}

/**
 * Public surface of the transport.
 */
export interface NdjsonTransport {
  /**
   * Async iterable of parsed frames. Iteration completes when the
   * source stream signals end-of-stream.
   */
  readFrames(): AsyncIterable<unknown>

  /**
   * Serialize, append `\n`, and write the frame. Awaits the underlying
   * writer's backpressure.
   */
  writeFrame(frame: unknown): Promise<void>

  /**
   * Flush + close the writer. Idempotent.
   */
  close(): Promise<void>
}

/**
 * Build a {@link NdjsonTransport} bound to the given streams.
 *
 * @param options - readable + writable streams + optional invalid-frame hook
 * @returns the transport instance
 */
export function createNdjsonTransport(options: NdjsonTransportOptions): NdjsonTransport {
  const { readable, writable, onInvalidFrame } = options
  const encoder = new TextEncoder()
  const writer = writable.getWriter()
  let closed = false

  const writeFrame = async (frame: unknown): Promise<void> => {
    if (closed) {
      throw new Error('cannot writeFrame on a closed transport')
    }

    const line = `${JSON.stringify(frame)}\n`
    await writer.write(encoder.encode(line))
  }

  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    await writer.close().catch(() => {
      // swallow: closing twice or on an already-aborted stream is benign
    })
  }

  /**
   * Internal generator. Decodes incoming bytes in UTF-8 stream mode,
   * accumulates a line buffer, and yields each parsed JSON line.
   * Skips empty lines silently; routes malformed lines through the
   * onInvalidFrame callback (when set).
   */
  async function* readFrames(): AsyncIterable<unknown> {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const reader = readable.getReader()
    let buffer = ''

    try {
      while (true) {
        const { value, done } = await reader.read()

        if (value !== undefined) {
          // 1. Append decoded chunk; stream:true preserves multi-byte
          //    characters that span chunk boundaries.
          buffer += decoder.decode(value, { stream: true })
        }

        // 2. Drain whole lines from the buffer.
        let newlineAt = buffer.indexOf('\n')
        while (newlineAt !== -1) {
          const rawLine = buffer.slice(0, newlineAt)
          buffer = buffer.slice(newlineAt + 1)

          // 3. Skip empty lines (whitespace-only is also a no-op).
          if (rawLine.trim() === '') {
            newlineAt = buffer.indexOf('\n')
            continue
          }

          // 4. Parse; route malformed lines through the invalid-frame
          //    hook and continue, do not break the loop.
          try {
            yield JSON.parse(rawLine)
          } catch (error) {
            onInvalidFrame?.(rawLine, error)
          }

          newlineAt = buffer.indexOf('\n')
        }

        if (done) {
          break
        }
      }

      // 5. EOF reached. Flush any trailing partial line that did not
      //    arrive with its newline.
      buffer += decoder.decode()
      const trailing = buffer.trim()
      if (trailing !== '') {
        try {
          yield JSON.parse(trailing)
        } catch (error) {
          onInvalidFrame?.(trailing, error)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  return {
    readFrames,
    writeFrame,
    close,
  }
}
