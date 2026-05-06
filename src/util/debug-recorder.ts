/**
 * Per-session debug capture sink.
 *
 * The recorder owns three concerns:
 *   1. Streaming `debug_log` sessionUpdate events to the orchestrator
 *      via the supplied {@link DebugRecorderEmit} (live tail).
 *   2. Buffering the last N entries in memory for late inspection
 *      (forensic snapshot when the prompt throws).
 *   3. (Phase 1.7 T6) Appending each entry as a JSONL line to the
 *      forensic file at `<KODIZM_DEBUG_DIR>/<sessionId>.jsonl`.
 *
 * The wire emit + ring buffer ship in T5; the file output lands in T6
 * as an additive extension on the same class.
 *
 * Capture stages (9, see `wire/events.ts:DebugStageSchema`) cover the
 * full reproducibility surface. Two narrowing knobs filter out the
 * heaviest stages when the orchestrator wants a partial trace:
 *
 *   - `debugCaptureRawSdk: false` skips `sdk.message` + `sdk.error`.
 *   - `debugCaptureRpc: false` skips `rpc.in` + `rpc.out`.
 *
 * `debug: false` short-circuits every record() call to a no-op so a
 * production session that never opted in pays zero recording cost.
 */

import { appendFile } from 'node:fs/promises'

import type { DebugLogLevel, DebugStage, SessionUpdateEvent } from '../wire/events.ts'
import { redact } from './redaction.ts'

/**
 * Emit sink the recorder writes `debug_log` events into. Mirrors the
 * shape of {@link import('../backends/driver.ts').EventEmitter} but
 * defined locally to keep the recorder free of backend imports.
 */
export interface DebugRecorderEmit {
  send(event: SessionUpdateEvent): void
}

/**
 * Per-session ring buffer entry. The recorder retains the last N (1000)
 * before evicting the head; `snapshot()` returns a shallow copy so
 * callers can iterate without mutating the live buffer.
 */
export interface DebugBufferEntry {
  sessionId: string
  level: DebugLogLevel
  stage: DebugStage
  capturedAt: number
  payload: unknown
  redacted: boolean
}

/**
 * Construction args for the recorder.
 */
export interface DebugRecorderOptions {
  sessionId: string
  emit: DebugRecorderEmit
  /**
   * Master toggle. When false, every record() call is a no-op.
   */
  debug: boolean
  /**
   * Skip raw SDK messages (sdk.message + sdk.error) when false.
   */
  debugCaptureRawSdk?: boolean
  /**
   * Skip JSON-RPC frames (rpc.in + rpc.out) when false.
   */
  debugCaptureRpc?: boolean
  /**
   * Disable allow-list redaction when true. Maps to the
   * `KODIZM_DEBUG_RAW_SECRETS=1` env override (see
   * `src/util/redaction.ts:isRawSecretsMode`).
   */
  rawSecretsMode?: boolean
  /**
   * Optional forensic JSONL file path. When set, every captured
   * entry is appended as a JSON line to this file (in addition to
   * the wire emit + ring buffer). The bin entrypoint resolves this
   * to `<KODIZM_DEBUG_DIR ?? '/tmp/kodizm-debug'>/<sessionId>.jsonl`.
   */
  debugFilePath?: string
}

const RING_BUFFER_LIMIT = 1000

const SDK_STAGES: ReadonlyArray<DebugStage> = ['sdk.message', 'sdk.error']
const RPC_STAGES: ReadonlyArray<DebugStage> = ['rpc.in', 'rpc.out']

/**
 * Per-session recorder. Construct one per session at prompt entry;
 * tear down (via close() in T6) when the session ends or the
 * container shuts down.
 */
export class DebugRecorder {
  private readonly buffer: DebugBufferEntry[] = []
  private readonly pendingWrites: Array<Promise<void>> = []
  private closed = false

  public constructor(private readonly options: DebugRecorderOptions) {}

  /**
   * Capture one entry. No-op when {@link DebugRecorderOptions.debug}
   * is false or the stage is suppressed by a capture-narrowing flag.
   *
   * @param stage - the canonical stage label (rpc.in, sdk.message, ...)
   * @param payload - the raw structure to capture (will be redacted)
   * @param level - log level; defaults to 'debug'
   */
  public record(stage: DebugStage, payload: unknown, level: DebugLogLevel = 'debug'): void {
    if (this.options.debug !== true) {
      return
    }
    if (this.options.debugCaptureRawSdk === false && SDK_STAGES.includes(stage)) {
      return
    }
    if (this.options.debugCaptureRpc === false && RPC_STAGES.includes(stage)) {
      return
    }

    const rawSecretsMode = this.options.rawSecretsMode === true
    const redactedPayload = redact(payload, { rawSecretsMode })
    const capturedAt = Date.now()

    const entry: DebugBufferEntry = {
      sessionId: this.options.sessionId,
      level,
      stage,
      capturedAt,
      payload: redactedPayload,
      redacted: !rawSecretsMode,
    }

    this.appendToBuffer(entry)
    this.options.emit.send({
      sessionId: entry.sessionId,
      type: 'debug_log',
      level: entry.level,
      stage: entry.stage,
      capturedAt: entry.capturedAt,
      payload: entry.payload,
      redacted: entry.redacted,
    })
    this.appendToFile(entry)
  }

  /**
   * Snapshot of the last N entries (most-recent at the tail). Returns
   * a shallow copy so callers can iterate without mutating the live
   * buffer.
   */
  public snapshot(): ReadonlyArray<DebugBufferEntry> {
    return [...this.buffer]
  }

  /**
   * Await all in-flight file appends. Called from the bin's graceful
   * SIGTERM handler so the JSONL file reflects every captured entry
   * before the container exits.
   */
  public async flushPending(): Promise<void> {
    if (this.pendingWrites.length === 0) {
      return
    }
    await Promise.allSettled(this.pendingWrites)
  }

  /**
   * Mark the recorder closed. Subsequent record() calls still emit
   * to the wire + ring buffer (so post-close events are not silently
   * dropped from the orchestrator's view) but skip the file output.
   */
  public close(): void {
    this.closed = true
  }

  private appendToBuffer(entry: DebugBufferEntry): void {
    this.buffer.push(entry)
    if (this.buffer.length > RING_BUFFER_LIMIT) {
      this.buffer.splice(0, this.buffer.length - RING_BUFFER_LIMIT)
    }
  }

  private appendToFile(entry: DebugBufferEntry): void {
    if (this.options.debugFilePath === undefined || this.closed) {
      return
    }
    const filePath = this.options.debugFilePath
    const line = `${JSON.stringify(entry)}\n`
    const promise = appendFile(filePath, line).catch((err: unknown) => {
      // Recorder must NEVER throw into the prompt path; surface the
      // failure on stderr where the bin's logger picks it up.
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          message: 'kodizm-acp debug file append failed',
          path: filePath,
          error: message,
        })}\n`,
      )
    })
    this.pendingWrites.push(promise)
  }
}
