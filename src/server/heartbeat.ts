/**
 * HeartbeatTimer: periodic liveness ping while a prompt is in flight.
 *
 * The timer emits a `heartbeat` sessionUpdate event at a configurable
 * cadence (default 10s in driver). Orchestrators use the absence of
 * heartbeats as a pipe-broken signal (typically 3x the cadence). The
 * driver constructs one timer per prompt() call: start() at SDK loop
 * entry, stop() in finally.
 *
 * The timer is intentionally simple: it does NOT detect inactivity
 * itself. The driver's separate inactivity probe handles SDK message
 * gap detection (Phase 1.7 T9). Heartbeat emits regardless of whether
 * the SDK has produced any messages; lastSdkMs surfaces the gap so
 * the orchestrator can correlate liveness vs. progress.
 */

import type { SessionUpdateEvent } from '../wire/events.ts'

/**
 * Emit sink for heartbeat events. Mirrors the public surface of
 * {@link import('../backends/driver.ts').EventEmitter}.
 */
export interface HeartbeatEmit {
  send(event: SessionUpdateEvent): void
}

/**
 * Construction args for the timer.
 */
export interface HeartbeatTimerOptions {
  sessionId: string
  /**
   * Emit cadence in ms. Per-session override comes from
   * `NewSessionRequest.heartbeatIntervalMs`; default 10_000 in the
   * Claude driver wiring (T9).
   */
  intervalMs: number
  emit: HeartbeatEmit
  /**
   * Returns the wall-clock timestamp (ms since epoch) of the last
   * SDK message the driver observed. The timer subtracts from
   * `Date.now()` at each tick to produce `lastSdkMs`.
   */
  getLastSdkMs(): number
}

/**
 * Per-prompt heartbeat timer. Constructed at prompt entry; start()
 * begins emitting; stop() halts emission.
 */
export class HeartbeatTimer {
  private interval: ReturnType<typeof setInterval> | undefined

  public constructor(private readonly options: HeartbeatTimerOptions) {}

  /**
   * Begin emitting heartbeat events at the configured cadence.
   *
   * @param uptimeStartMs - the wall-clock timestamp the prompt started.
   *                        Each tick subtracts from `Date.now()` to
   *                        produce `uptimeMs` on the event.
   */
  public start(uptimeStartMs: number): void {
    this.interval = setInterval(() => {
      const now = Date.now()
      this.options.emit.send({
        sessionId: this.options.sessionId,
        type: 'heartbeat',
        uptimeMs: Math.max(0, now - uptimeStartMs),
        lastSdkMs: Math.max(0, now - this.options.getLastSdkMs()),
      })
    }, this.options.intervalMs)
  }

  /**
   * Halt emission. Idempotent; safe to call when start() has not run
   * or after stop() has already fired.
   */
  public stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval)
      this.interval = undefined
    }
  }
}
