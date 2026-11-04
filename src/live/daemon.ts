/**
 * tmuxd daemon: one per container, owning every Live pane, its event stream and its permission round trips.
 *
 * The daemon is the only process that holds the ingest token. It reads it from the 0600 env file Laravel writes,
 * deletes the file, and keeps the token in memory; the pane gets the CLI's auth env and nothing else. Hooks and ctl
 * verbs reach the daemon over one unix socket in a 0700 directory. Events get a seq per gen, are redacted when they
 * are queued, and are pushed in order with retries until the ingest acknowledges them (`live-events.v1.json`). The ctl
 * verbs and their codes are `live-ctl.v1.json`.
 *
 * The CLI does not report everything through hooks: Esc fires none, Stop is not guaranteed, and the text and token
 * counts live only in the transcript. The pane state therefore combines hook events, the transcript tail and a
 * watchdog, and a delivery guard refuses input while a permission dialog may be open, because a pasted Enter would
 * answer it.
 */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { type Server, type Socket, createServer } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'

import { type Logger, createLogger } from '../util/logger.ts'
import {
  type EventDraft,
  type LiveEvent,
  type Payload,
  type PermissionOpenRequest,
  apiStopReason,
  compactionCompleted,
  compactionStarted,
  heartbeat,
  isRecord,
  outputChunk,
  permissionRequest,
  processDied,
  redactDeep,
  sessionEnded,
  sessionFailed,
  sessionStarted,
  subagentComplete,
  subagentSpawn,
  text,
  thinkingChunk,
  toolCallBegin,
  toolCallEnd,
  toolOutput,
  turnCompleted,
  turnFailed,
  turnStarted,
  usage,
} from './events.ts'
import {
  DEFAULT_BASE_SETTINGS_PATH,
  PERMISSION_HOOK_TIMEOUT_S,
  SocketRequestError,
  socketRequest,
  writePaneSettings,
} from './hooks.ts'
import { InputRejectedError, type InputRejectionReason, MODEL_NAME, sanitizeCommand, sanitizePrompt } from './input.ts'
import {
  type DeliveryOutcome,
  LIVE_SOCKET,
  type Pane,
  PaneError,
  cancelPane,
  createPane,
  deliverCommand,
  deliverPrompt,
  killPane,
  paneAlive,
} from './pane.ts'
import { TranscriptTail, UsageLedger, assistantBlocks, assistantStopReason, classifyInterrupt } from './transcript.ts'

export const HEARTBEAT_INTERVAL_MS = 20_000

/** How long an open turn may sit on a finished assistant message with no hook and no transcript line. */
export const WATCHDOG_QUIET_MS = 30_000

/** How long cancel waits for the interrupt marker; an Esc before the first token leaves none. */
export const CANCEL_TIMEOUT_MS = 3_000

export const PERMISSION_POLL_MS = 1_500

export const INGEST_TIMEOUT_MS = 10_000

export const MAX_BATCH = 200

export const DEFAULT_MAX_PANES = 4

const STOP_DRAIN_MS = 10_000

// The daemon stops polling a permission shortly before the CLI kills the hook that waits for it.
const PERMISSION_WAIT_MS = PERMISSION_HOOK_TIMEOUT_S * 1000 - 10_000

// Injected values shorter than this are not redacted by value: replacing a "1" would shred every text.
const MIN_SECRET_LENGTH = 8

// A Write or Edit hook payload carries the whole file; anything past this is not a hook payload.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

const PANE_ID = /^[A-Za-z0-9_-]{1,64}$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const LIVE_KEY_PREFIX = 'KODIZM_LIVE_'
const TOKEN_PREFIX = 'kdz-int-jwt.'

const COMMAND_NAMES: ReadonlySet<string> = new Set(['compact', 'clear', 'model'])

const REJECTION_RULES: Readonly<Record<InputRejectionReason, string>> = {
  slash_command: 'leading_slash',
  bash_mode: 'leading_bang',
  empty: 'empty',
  unknown_command: 'unknown_command',
  invalid_model_alias: 'invalid_model_alias',
}

export type CtlCode =
  | 'ok'
  | 'usage_error'
  | 'dialog_open'
  | 'prompt_rejected'
  | 'pane_cap'
  | 'pane_exists'
  | 'busy'
  | 'pane_not_running'
  | 'timeout'

export interface CtlResult {
  ok: boolean
  code: CtlCode
  data?: Record<string, unknown>
}

const EXIT_CODES: Readonly<Record<CtlCode, number>> = {
  ok: 0,
  usage_error: 2,
  dialog_open: 3,
  prompt_rejected: 3,
  pane_cap: 3,
  pane_exists: 3,
  busy: 3,
  pane_not_running: 4,
  timeout: 5,
}

export function exitCodeFor(code: CtlCode): number {
  return EXIT_CODES[code]
}

export interface DaemonTimings {
  heartbeatMs: number
  watchdogQuietMs: number
  cancelTimeoutMs: number
  permissionPollMs: number
  ingestTimeoutMs: number
  /** Pane liveness and watchdog check. */
  monitorMs: number
  transcriptPollMs: number
  retryBaseMs: number
  retryMaxMs: number
}

const DEFAULT_TIMINGS: DaemonTimings = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  watchdogQuietMs: WATCHDOG_QUIET_MS,
  cancelTimeoutMs: CANCEL_TIMEOUT_MS,
  permissionPollMs: PERMISSION_POLL_MS,
  ingestTimeoutMs: INGEST_TIMEOUT_MS,
  monitorMs: 2_000,
  transcriptPollMs: 250,
  retryBaseMs: 250,
  retryMaxMs: 10_000,
}

export interface LiveDaemonOptions {
  socketPath: string
  /** Runtime and script of tmuxd; the hook commands and nothing else run it. */
  helperArgv: readonly string[]
  /** HOME of the panes: the agent user's home, where the CLI keeps its config and transcripts. */
  home: string
  tmuxSocket?: string
  claudeBin?: string
  baseSettingsPath?: string
  maxPanes?: number
  timings?: Partial<DaemonTimings>
  /** Called once the last pane is gone; the detached daemon exits there. */
  onIdle?: () => void
  logger?: Logger
}

type Decision =
  | {
      behavior: 'allow'
    }
  | {
      behavior: 'deny'
      message: string
    }

type CloseCause = 'stop' | 'marker' | 'watchdog' | 'timeout'

interface Dialog {
  toolCallId: string
  /** False when no PreToolUse matched: the dialog is then recognised by its tool name and input. */
  correlated: boolean
  toolName: string | undefined
  input: unknown
  abort: AbortController
}

interface OpenTool {
  name: string | undefined
  input: unknown
}

interface Ack {
  ok: boolean
  decision?: Decision
}

interface StartEnv {
  ingestUrl: string
  token: string
  gen: number
  authEnv: Record<string, string>
}

/**
 * Waits for a signal that may already have fired since the last `arm()`.
 */
class Latch {
  private fired = false
  private waiters: Array<() => void> = []

  public arm(): void {
    this.fired = false
  }

  public fire(): void {
    this.fired = true
    for (const waiter of this.waiters.splice(0)) {
      waiter()
    }
  }

  public wait(timeoutMs: number): Promise<boolean> {
    if (this.fired) {
      return Promise.resolve(true)
    }

    return new Promise((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter)
        resolve(false)
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }
}

export interface EventQueueOptions {
  gen: number
  /** Full URL of `POST /internal/live/events`. */
  endpoint: string
  bearer: () => string
  secrets: () => readonly string[]
  timings: () => DaemonTimings
  /** The ingest moved to a newer gen: nobody will accept this pane's events again. */
  onStaleGen: () => void
  logger: Logger
}

type PushOutcome = 'acknowledged' | 'retry' | 'stale'

/**
 * The ordered event stream of one pane generation.
 *
 * `push` assigns the seq and redacts at once, so the order is the order of the calls and no unredacted payload is ever
 * held. One loop sends batches oldest first and drops what the ingest acknowledged; a failure keeps the batch and
 * retries it after a capped exponential backoff, and a seq_gap resends from the seq the ingest expects.
 */
export class EventQueue {
  private seq = 0
  private pending: LiveEvent[] = []
  private running = false
  private stopped = false

  public constructor(private readonly options: EventQueueOptions) {}

  public get lastSeq(): number {
    return this.seq
  }

  public get size(): number {
    return this.pending.length
  }

  public push(draft: EventDraft): void {
    if (this.stopped) {
      return
    }

    this.seq += 1
    this.pending.push({
      type: draft.type,
      seq: this.seq,
      gen: this.options.gen,
      ts: new Date().toISOString(),
      payload: redactDeep(draft.payload, this.options.secrets()),
    })
    this.kick()
  }

  /**
   * Wait until every queued event was acknowledged, the queue stopped, or the timeout passed.
   */
  public async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.pending.length > 0 && !this.stopped && Date.now() < deadline) {
      await Bun.sleep(20)
    }
  }

  public stop(): void {
    this.stopped = true
  }

  private kick(): void {
    if (this.running || this.stopped) {
      return
    }

    this.running = true
    void this.loop().finally(() => {
      this.running = false
    })
  }

  private async loop(): Promise<void> {
    let failures = 0
    while (!this.stopped && this.pending.length > 0) {
      const outcome = await this.send(this.pending.slice(0, MAX_BATCH))
      if (outcome === 'stale') {
        this.stopped = true
        this.pending = []
        this.options.onStaleGen()

        return
      }
      if (outcome === 'acknowledged') {
        failures = 0
        continue
      }

      failures += 1
      const timings = this.options.timings()
      await Bun.sleep(Math.min(timings.retryMaxMs, timings.retryBaseMs * 2 ** (failures - 1)))
    }
  }

  private async send(batch: LiveEvent[]): Promise<PushOutcome> {
    const response = await fetchJson(this.options.endpoint, {
      method: 'POST',
      bearer: this.options.bearer(),
      body: {
        events: batch,
      },
      timeoutMs: this.options.timings().ingestTimeoutMs,
    })

    if (response.status === 200 && isRecord(response.body) && typeof response.body.lastSeq === 'number') {
      return this.acknowledge(response.body.lastSeq)
    }

    const error = isRecord(response.body) && isRecord(response.body.error) ? response.body.error : {}
    if (response.status === 409 && error.code === 'stale_gen') {
      this.options.logger.warn('tmuxd ingest moved to a newer gen', {
        gen: this.options.gen,
        currentGen: error.currentGen,
      })

      return 'stale'
    }
    if (response.status === 409 && error.code === 'seq_gap' && typeof error.expectedSeq === 'number') {
      return this.acknowledge(error.expectedSeq - 1)
    }

    this.options.logger.warn('tmuxd event push failed', {
      gen: this.options.gen,
      status: response.status,
      code: error.code,
    })

    return 'retry'
  }

  private acknowledge(lastSeq: number): PushOutcome {
    const before = this.pending.length
    this.pending = this.pending.filter((event) => event.seq > lastSeq)

    // A seq_gap naming an event this queue no longer holds cannot be repaired by resending.
    const first = this.pending[0]
    if (first !== undefined && first.seq !== lastSeq + 1) {
      this.options.logger.error('tmuxd ingest expects an event that was already acknowledged', {
        gen: this.options.gen,
        expectedSeq: lastSeq + 1,
        firstPending: first.seq,
      })

      return 'retry'
    }

    return this.pending.length < before ? 'acknowledged' : 'retry'
  }
}

/**
 * One Live pane: its CLI in tmux, its turn and dialog state, its transcript and its event queue.
 */
class LivePane {
  public readonly started = new Latch()
  public readonly submitted = new Latch()
  public readonly turnClosed = new Latch()
  public readonly queue: EventQueue
  public claudeSessionId: string | undefined
  public model: string | undefined
  public pid: number | undefined
  public turn: { promptId: string } | undefined
  public pendingPromptId: string | undefined
  public dialog: Dialog | undefined
  public compacting = false
  public lastCloseCause: CloseCause | undefined
  private token: string
  private readonly secrets: string[]
  private readonly openTools = new Map<string, OpenTool>()
  private readonly subagents = new Set<string>()
  private tail: TranscriptTail | undefined
  private readonly ledger = new UsageLedger()
  private reading: Promise<void> | undefined
  private skippedLines = 0
  private lastAssistantText: string | undefined
  private lastStopReason: string | null = null
  private settled = false
  private lastActivityAt = Date.now()
  private sessionEndReason: string | undefined
  private timers: Array<ReturnType<typeof setInterval>> = []
  private monitoring = false
  private closed = false

  public constructor(
    public readonly pane: Pane,
    public readonly gen: number,
    private readonly ingestUrl: string,
    token: string,
    authValues: readonly string[],
    private readonly daemon: LiveDaemon,
  ) {
    this.token = token
    this.secrets = [token, ...authValues.filter((value) => value.length >= MIN_SECRET_LENGTH)]
    this.queue = new EventQueue({
      gen,
      endpoint: `${ingestUrl}/events`,
      bearer: () => this.token,
      secrets: () => this.secrets,
      timings: () => daemon.timings,
      onStaleGen: () => void this.abandon(),
      logger: daemon.logger,
    })
  }

  public get id(): string {
    return this.pane.id
  }

  public get busy(): boolean {
    return this.turn !== undefined || this.compacting
  }

  /** Start the transcript tail, the liveness monitor and the heartbeat once the pane runs. */
  public begin(): void {
    const timings = this.daemon.timings
    this.timers = [
      setInterval(() => void this.guard('transcript', () => this.readTranscript()), timings.transcriptPollMs),
      setInterval(() => void this.guard('monitor', () => this.monitor()), timings.monitorMs),
      setInterval(() => void this.guard('heartbeat', () => this.beat()), timings.heartbeatMs),
    ]
  }

  public rotate(token: string): void {
    this.token = token
    this.secrets.push(token)
  }

  public async handleHook(event: string, payload: Payload, signal: AbortSignal): Promise<Ack> {
    if (this.closed) {
      return { ok: false }
    }
    this.lastActivityAt = Date.now()

    switch (event) {
      case 'SessionStart':
        await this.onSessionStart(payload)
        break
      case 'UserPromptSubmit':
        this.onPromptSubmit(payload)
        break
      case 'PreToolUse':
        this.onPreToolUse(payload)
        break
      case 'PermissionRequest':
        return this.onPermissionRequest(payload, signal)
      case 'PostToolUse':
        this.closeTool(payload, 'completed', toolOutput(payload.tool_response))
        break
      case 'PostToolUseFailure':
        this.closeTool(payload, 'failed', text(payload.error))
        break
      case 'PermissionDenied':
        this.closeTool(payload, 'failed')
        break
      case 'Stop':
        await this.onStop(payload)
        break
      case 'StopFailure':
        await this.onStopFailure(payload)
        break
      case 'SessionEnd':
        // /clear ends one conversation and starts the next in the same pane.
        if (payload.reason !== 'clear') {
          this.sessionEndReason = text(payload.reason) ?? 'other'
        }
        break
      case 'SubagentStart':
        this.onSubagentStart(payload)
        break
      case 'SubagentStop':
        this.onSubagentStop(payload)
        break
      case 'PreCompact':
        this.compacting = true
        this.queue.push(compactionStarted(payload))
        break
      case 'PostCompact':
        this.compacting = false
        this.queue.push(compactionCompleted(payload))
        break
    }

    return { ok: true }
  }

  /**
   * Close the turn and wake a waiting cancel. A turn that is already closed stays closed: only one end per turn.
   */
  public closeTurn(draft: EventDraft, cause: CloseCause): void {
    if (this.turn === undefined) {
      return
    }

    this.closeOpenTools()
    this.clearDialog()
    this.queue.push(draft)
    this.turn = undefined
    this.lastCloseCause = cause
    this.turnClosed.fire()
  }

  /** Esc and the hook answer both close a dialog without a tool hook, so the dialog state is dropped by hand. */
  public clearDialog(): void {
    this.dialog?.abort.abort()
    this.dialog = undefined
  }

  public interruptedTurn(): EventDraft {
    return turnCompleted('interrupted', this.lastAssistantText)
  }

  /** Kill the pane on request and report the end. */
  public async stop(): Promise<void> {
    this.close()
    await killPane(this.pane)
    this.queue.push(sessionEnded('stopped'))
    await this.queue.drain(STOP_DRAIN_MS)
    this.queue.stop()
  }

  /** Tear down without reporting: the daemon itself is shutting down. */
  public async dispose(): Promise<void> {
    this.close()
    this.queue.stop()
    await this.killLogged()
  }

  private close(): void {
    this.closed = true
    for (const timer of this.timers.splice(0)) {
      clearInterval(timer)
    }
    this.clearDialog()
  }

  private async onSessionStart(payload: Payload): Promise<void> {
    const source = text(payload.source)
    this.model = text(payload.model) ?? this.model

    // 1. A compaction restarts the conversation in place: same id, same transcript.
    if (source === 'compact') {
      return
    }

    // 2. A resumed transcript already holds history an earlier pane streamed; startup and /clear begin a new file.
    const path = text(payload.transcript_path)
    if (path !== undefined) {
      this.tail = source === 'resume' ? await TranscriptTail.atEnd(path) : new TranscriptTail(path)
    }

    // 3. /clear changes the conversation id, which a later --resume needs: it is reported as a fresh start.
    this.claudeSessionId = text(payload.session_id) ?? this.claudeSessionId
    this.queue.push(
      sessionStarted(
        {
          ...payload,
          model: this.model,
        },
        source === 'resume' ? 'resume' : 'startup',
      ),
    )
    this.started.fire()
  }

  private onPromptSubmit(payload: Payload): void {
    if (this.turn !== undefined) {
      return
    }

    this.turn = {
      promptId: this.pendingPromptId ?? text(payload.prompt_id) ?? randomUUID(),
    }
    this.pendingPromptId = undefined
    this.settled = false
    this.lastAssistantText = undefined
    this.lastStopReason = null
    this.queue.push(turnStarted(this.turn.promptId))
    this.submitted.fire()
  }

  private onPreToolUse(payload: Payload): void {
    // A prompt-suggestion fork fires a PreToolUse after Stop with no PostToolUse; it belongs to no turn.
    if (this.turn === undefined) {
      return
    }

    const toolCallId = text(payload.tool_use_id) ?? randomUUID()
    this.openTools.set(toolCallId, {
      name: text(payload.tool_name),
      input: payload.tool_input,
    })
    this.settled = false
    this.queue.push(toolCallBegin(payload, toolCallId))
  }

  private async onPermissionRequest(payload: Payload, signal: AbortSignal): Promise<Ack> {
    // 1. PermissionRequest carries no tool_use_id; the PreToolUse of the same tool and input does.
    const correlated = this.findOpenTool(payload)
    const dialog: Dialog = {
      toolCallId: correlated ?? randomUUID(),
      correlated: correlated !== undefined,
      toolName: text(payload.tool_name),
      input: payload.tool_input,
      abort: new AbortController(),
    }
    this.dialog?.abort.abort()
    this.dialog = dialog
    signal.addEventListener('abort', () => dialog.abort.abort())

    // 2. The timeline event, then the decision row the operator answers.
    const request = permissionRequest(payload, dialog.toolCallId)
    this.queue.push({
      type: 'permission_request',
      payload: {
        ...request,
      },
    })
    const decision = await this.askIngest(request, dialog.abort.signal)

    // 3. Only an explicit answer for the dialog that is still open goes back; the CLI keeps the dialog otherwise.
    if (decision === undefined || this.dialog !== dialog) {
      return { ok: true }
    }
    this.dialog = undefined

    return {
      ok: true,
      decision,
    }
  }

  private async askIngest(request: PermissionOpenRequest, signal: AbortSignal): Promise<Decision | undefined> {
    const timings = this.daemon.timings
    const opened = await fetchJson(`${this.ingestUrl}/permissions`, {
      method: 'POST',
      bearer: this.token,
      body: redactDeep(
        {
          gen: this.gen,
          ...request,
        },
        this.secrets,
      ),
      timeoutMs: timings.ingestTimeoutMs,
      signal,
    })
    if (opened.status !== 200 && opened.status !== 201) {
      this.daemon.logger.warn('tmuxd permission open failed', { pane: this.id, status: opened.status })

      return undefined
    }

    // 1. The role's auto-approve list answers at once.
    const immediate = decisionFrom(opened.body)
    if (immediate !== 'pending') {
      return immediate
    }
    const id = isRecord(opened.body) ? text(opened.body.id) : undefined
    if (id === undefined) {
      return undefined
    }

    // 2. A failed poll is retried: giving up would strand a row the operator can still answer.
    const deadline = Date.now() + PERMISSION_WAIT_MS
    while (!signal.aborted && Date.now() < deadline) {
      await Bun.sleep(timings.permissionPollMs)
      if (signal.aborted) {
        return undefined
      }

      const polled = await fetchJson(`${this.ingestUrl}/permissions/${encodeURIComponent(id)}`, {
        method: 'GET',
        bearer: this.token,
        timeoutMs: timings.ingestTimeoutMs,
        signal,
      })
      if (polled.status === 404) {
        return undefined
      }
      if (polled.status !== 200) {
        continue
      }

      const decision = decisionFrom(polled.body)
      if (decision !== 'pending') {
        return decision
      }
    }

    return undefined
  }

  private closeTool(payload: Payload, status: 'completed' | 'failed', output?: string): void {
    const toolCallId = text(payload.tool_use_id) ?? this.findOpenTool(payload)
    if (this.dialog !== undefined && this.isDialogOf(this.dialog, payload, toolCallId)) {
      this.clearDialog()
    }
    if (toolCallId === undefined || !this.openTools.delete(toolCallId)) {
      return
    }

    this.queue.push(toolCallEnd(toolCallId, status, output))
  }

  // A parallel tool call finishing must not lift another tool's dialog.
  private isDialogOf(dialog: Dialog, payload: Payload, toolCallId: string | undefined): boolean {
    if (dialog.correlated) {
      return toolCallId === dialog.toolCallId
    }

    return dialog.toolName === text(payload.tool_name) && sameJson(dialog.input, payload.tool_input)
  }

  private findOpenTool(payload: Payload): string | undefined {
    const name = text(payload.tool_name)
    const matches = [...this.openTools.entries()].filter(
      ([, tool]) => tool.name === name && sameJson(tool.input, payload.tool_input),
    )

    return matches.at(-1)?.[0]
  }

  // A tool denied through the hook or cut by the end of its turn gets no PostToolUse.
  private closeOpenTools(): void {
    for (const toolCallId of this.openTools.keys()) {
      this.queue.push(toolCallEnd(toolCallId, 'failed'))
    }
    this.openTools.clear()
  }

  private async onStop(payload: Payload): Promise<void> {
    if (this.turn === undefined) {
      return
    }

    // The text and usage written before Stop go out before the turn ends.
    await this.syncTranscript()
    this.closeTurn(
      turnCompleted(apiStopReason(this.lastStopReason), text(payload.last_assistant_message) ?? this.lastAssistantText),
      'stop',
    )
  }

  private async onStopFailure(payload: Payload): Promise<void> {
    if (this.turn === undefined) {
      return
    }

    await this.syncTranscript()
    this.closeTurn(turnFailed(payload), 'stop')
  }

  private onSubagentStart(payload: Payload): void {
    const id = text(payload.agent_id)
    if (id !== undefined) {
      this.subagents.add(id)
    }
    this.queue.push(subagentSpawn(payload))
  }

  // A compaction runs its own agent and reports only its SubagentStop; that one is not a subagent of the session.
  private onSubagentStop(payload: Payload): void {
    const id = text(payload.agent_id)
    if (id === undefined || !this.subagents.delete(id)) {
      return
    }
    this.queue.push(subagentComplete(payload))
  }

  private async syncTranscript(): Promise<void> {
    await this.reading
    await this.readTranscript()
  }

  private readTranscript(): Promise<void> {
    if (this.reading === undefined) {
      this.reading = this.consumeTranscript().finally(() => {
        this.reading = undefined
      })
    }

    return this.reading
  }

  private async consumeTranscript(): Promise<void> {
    const tail = this.tail
    if (tail === undefined || this.closed) {
      return
    }

    const records = await tail.poll()
    if (tail.skipped > this.skippedLines) {
      this.daemon.logger.warn('tmuxd skipped transcript lines that are not JSON', {
        pane: this.id,
        skipped: tail.skipped - this.skippedLines,
      })
      this.skippedLines = tail.skipped
    }

    for (const record of records) {
      if (record.isSidechain === true) {
        continue
      }
      this.lastActivityAt = Date.now()

      // 1. Esc fires no hook: the marker is the only sign, and it also closes a dialog Esc dismissed.
      if (classifyInterrupt(record) !== null) {
        this.closeTurn(this.interruptedTurn(), 'marker')
        this.clearDialog()
        continue
      }

      // 2. Text, thinking and the message's token counts.
      for (const block of assistantBlocks(record)) {
        this.queue.push(block.kind === 'text' ? outputChunk(block.text) : thinkingChunk(block.text))
        if (block.kind === 'text') {
          this.lastAssistantText = block.text
        }
      }
      const counts = this.ledger.take(record)
      if (counts !== null) {
        this.queue.push(usage(counts))
      }

      // 3. The watchdog may only end a turn whose last word is a finished assistant message.
      if (record.type === 'assistant') {
        this.lastStopReason = assistantStopReason(record)
        this.settled = this.lastStopReason !== null && this.lastStopReason !== 'tool_use'
      } else if (record.type === 'user') {
        this.settled = false
      }
    }
  }

  private async monitor(): Promise<void> {
    if (this.monitoring || this.closed) {
      return
    }
    this.monitoring = true

    try {
      if (!(await this.alive())) {
        await this.onDeath()

        return
      }

      // Stop is not guaranteed: a turn that went quiet on a finished message is over.
      const quiet = Date.now() - this.lastActivityAt >= this.daemon.timings.watchdogQuietMs
      const idle = this.dialog === undefined && this.openTools.size === 0 && !this.compacting && this.settled
      if (this.turn !== undefined && quiet && idle) {
        this.closeTurn(turnCompleted('watchdog', this.lastAssistantText), 'watchdog')
      }
    } finally {
      this.monitoring = false
    }
  }

  private async beat(): Promise<void> {
    if (!this.closed && (await this.alive())) {
      this.queue.push(heartbeat())
    }
  }

  private async alive(): Promise<boolean> {
    return (await paneAlive(this.pane)) && (this.pid === undefined || processAlive(this.pid))
  }

  private async onDeath(): Promise<void> {
    if (this.closed) {
      return
    }
    const turnRunning = this.turn !== undefined
    this.close()

    // An exit the CLI reported (/exit, logout) is an ordinary end; a silent one is a crash.
    if (this.sessionEndReason !== undefined) {
      this.queue.push(sessionEnded('stopped'))
    } else {
      this.queue.push(sessionEnded('crashed'))
      this.queue.push(processDied())
      if (turnRunning) {
        this.queue.push(sessionFailed('process_died', 'claude exited while a turn was running.'))
      }
    }

    await this.queue.drain(STOP_DRAIN_MS)
    this.queue.stop()
    this.daemon.remove(this)
  }

  private async abandon(): Promise<void> {
    if (this.closed) {
      return
    }
    this.close()
    await this.killLogged()
    this.daemon.remove(this)
  }

  // Teardown paths nobody awaits: a pane that survives the kill is logged, the rest of the teardown still runs.
  private async killLogged(): Promise<void> {
    try {
      await killPane(this.pane)
    } catch (error) {
      if (!(error instanceof PaneError)) {
        throw error
      }
      this.daemon.logger.error('tmuxd could not kill a pane', { pane: this.id, reason: error.reason })
    }
  }

  private async guard(task: string, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch (error) {
      this.daemon.logger.error('tmuxd pane task failed', {
        pane: this.id,
        task,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * The daemon: the socket server, the pane registry and the ctl verbs.
 */
export class LiveDaemon {
  public readonly logger: Logger
  public timings: DaemonTimings
  private readonly panes = new Map<string, LivePane>()
  private server: Server | undefined

  public constructor(private readonly options: LiveDaemonOptions) {
    this.logger = options.logger ?? createLogger({ env: process.env })
    this.timings = {
      ...DEFAULT_TIMINGS,
      ...options.timings,
    }
  }

  /** Applies to panes started afterwards. */
  public setTimings(timings: Partial<DaemonTimings>): void {
    this.timings = {
      ...this.timings,
      ...timings,
    }
  }

  /**
   * Listen on the socket. A stale socket file is replaced; a socket another daemon answers on is not.
   *
   * @throws when another daemon already listens on the path
   */
  public async listen(): Promise<void> {
    const { socketPath } = this.options
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })

    if (await Bun.file(socketPath).exists()) {
      if (await this.answering(socketPath)) {
        throw new Error(`a tmuxd daemon already listens on ${socketPath}`)
      }
      await unlink(socketPath)
    }

    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(socketPath, 0o600)
    this.server = server
  }

  /**
   * Kill every pane without reporting and stop listening. Resolves once every open connection closed.
   */
  public async close(): Promise<void> {
    for (const pane of [...this.panes.values()]) {
      this.panes.delete(pane.id)
      await pane.dispose()
    }

    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(this.options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error
        }
      })
    }
  }

  public remove(pane: LivePane): void {
    if (this.panes.get(pane.id) !== pane) {
      return
    }

    this.panes.delete(pane.id)
    if (this.panes.size === 0 && this.options.onIdle !== undefined) {
      // After the current ctl answer went out.
      setTimeout(this.options.onIdle, 0)
    }
  }

  public async hook(paneId: string, event: string, payload: Payload, signal: AbortSignal): Promise<Ack> {
    const pane = this.panes.get(paneId)

    return pane === undefined ? { ok: false } : pane.handleHook(event, payload, signal)
  }

  public async ctl(verb: string, args: Readonly<Record<string, string>>): Promise<CtlResult> {
    switch (verb) {
      case 'start':
        return this.start(args)
      case 'prompt':
        return this.prompt(args)
      case 'command':
        return this.command(args)
      case 'cancel':
        return this.cancel(args)
      case 'stop':
        return this.stop(args)
      case 'rotate-token':
        return this.rotateToken(args)
      case 'status':
        return this.status(args)
      default:
        return refuse('usage_error')
    }
  }

  private async start(args: Readonly<Record<string, string>>): Promise<CtlResult> {
    const envFile = args['env-file']
    if (envFile === undefined || !isAbsolute(envFile)) {
      return refuse('usage_error')
    }

    // The env file holds the token: whatever the outcome, a refusal included, it does not outlive this call.
    try {
      return await this.launch(args, envFile)
    } finally {
      await removeFile(envFile)
    }
  }

  private async launch(args: Readonly<Record<string, string>>, envFile: string): Promise<CtlResult> {
    const { pane: id, cwd, model, resume } = args
    const settingsBase = args['settings-base']
    if (id === undefined || !PANE_ID.test(id) || cwd === undefined || !isAbsolute(cwd)) {
      return refuse('usage_error')
    }
    if (settingsBase === undefined || !isAbsolute(settingsBase)) {
      return refuse('usage_error')
    }
    if (model !== undefined && !MODEL_NAME.test(model)) {
      return refuse('usage_error')
    }

    // 1. State guards first, so a refused start never reads the token.
    if (this.panes.has(id)) {
      return refuse('pane_exists')
    }
    if (this.panes.size >= (this.options.maxPanes ?? DEFAULT_MAX_PANES)) {
      return refuse('pane_cap')
    }

    const content = await readSecretFile(envFile)
    const env = content === null ? null : parseStartEnv(content)
    if (env === null) {
      return refuse('usage_error')
    }

    // 2. The settings file carries the hooks and the deny list, never the token.
    const settingsPath = join(settingsBase, `${id}.settings.json`)
    await mkdir(settingsBase, { recursive: true, mode: 0o700 })
    await writePaneSettings(settingsPath, {
      basePath: this.options.baseSettingsPath ?? DEFAULT_BASE_SETTINGS_PATH,
      helperArgv: this.options.helperArgv,
      socketPath: this.options.socketPath,
      paneId: id,
    })

    // 3. Registered before launch: SessionStart arrives while createPane still waits for it.
    const pane: Pane = {
      id,
      socket: this.options.tmuxSocket ?? LIVE_SOCKET,
    }
    const live = new LivePane(pane, env.gen, env.ingestUrl, env.token, Object.values(env.authEnv), this)
    this.panes.set(id, live)

    try {
      await createPane({
        id,
        cwd,
        home: this.options.home,
        settingsPath,
        env: env.authEnv,
        model,
        resumeSessionId: resume,
        claudeBin: this.options.claudeBin,
        socket: pane.socket,
        confirmStarted: (timeoutMs) => live.started.wait(timeoutMs),
      })
    } catch (error) {
      this.panes.delete(id)
      live.queue.stop()

      return refuse(launchFailure(error))
    }

    // 4. The pane runs: the pid backs the liveness check and the answer.
    live.pid = await panePid(pane)
    live.begin()

    return accept({
      pane: id,
      gen: env.gen,
      pid: live.pid,
      claudeSessionId: live.claudeSessionId,
      resumed: resume !== undefined,
    })
  }

  private async prompt(args: Readonly<Record<string, string>>): Promise<CtlResult> {
    const { pane: id, file } = args
    if (file === undefined || !isAbsolute(file)) {
      return refuse('usage_error')
    }

    // 1. The prompt file is Laravel's hand-off: read and gone before any refusal can return.
    const content = await takeFile(file, readFileOrNull)
    if (id === undefined || content === null) {
      return refuse('usage_error')
    }
    const live = this.panes.get(id)
    if (live === undefined) {
      return notRunning(id)
    }

    // 2. A pasted Enter would answer an open dialog; a running turn would queue the text behind it.
    const refused = this.deliveryRefusal(live)
    if (refused !== null) {
      return refused
    }
    let sanitized: string
    try {
      sanitized = sanitizePrompt(content)
    } catch (error) {
      if (error instanceof InputRejectedError) {
        return refuse('prompt_rejected', { rule: REJECTION_RULES[error.reason] })
      }
      throw error
    }

    // 3. turn_started carries Laravel's prompt id; UserPromptSubmit confirms the submit.
    const promptId = randomUUID()
    live.pendingPromptId = promptId
    live.submitted.arm()

    // 4. A dialog can open between two Enters of the ladder; the next Enter would answer it.
    let outcome: DeliveryOutcome
    try {
      outcome = await deliverPrompt(
        live.pane,
        content,
        (timeoutMs) => live.submitted.wait(timeoutMs),
        () => live.dialog !== undefined,
      )
    } catch (error) {
      live.pendingPromptId = undefined

      return deliveryFailure(error, id)
    }
    if (outcome === 'aborted') {
      live.pendingPromptId = undefined

      return refuse('dialog_open')
    }

    return accept({
      promptId,
      bytes: Buffer.byteLength(sanitized),
    })
  }

  private async command(args: Readonly<Record<string, string>>): Promise<CtlResult> {
    const { pane: id, name, arg } = args
    if (
      id === undefined ||
      name === undefined ||
      !COMMAND_NAMES.has(name) ||
      (name === 'model') !== (arg !== undefined)
    ) {
      return refuse('usage_error')
    }
    let typed: string
    try {
      typed = sanitizeCommand(arg === undefined ? `/${name}` : `/${name} ${arg}`)
    } catch (error) {
      if (error instanceof InputRejectedError) {
        return refuse('usage_error')
      }
      throw error
    }

    const live = this.panes.get(id)
    if (live === undefined) {
      return notRunning(id)
    }
    const refused = this.deliveryRefusal(live)
    if (refused !== null) {
      return refused
    }

    try {
      await deliverCommand(live.pane, typed)
    } catch (error) {
      return deliveryFailure(error, id)
    }

    return accept(arg === undefined ? { name } : { name, arg })
  }

  private async cancel(args: Readonly<Record<string, string>>): Promise<CtlResult> {
    const id = args.pane
    if (id === undefined) {
      return refuse('usage_error')
    }
    const live = this.panes.get(id)
    if (live === undefined) {
      return notRunning(id)
    }
    // Esc on an idle pane would stay pending and swallow the next C-u.
    if (live.turn === undefined) {
      return accept({ wasBusy: false })
    }

    // 1. Esc closes a dialog without a hook, so the dialog state goes with the cancel.
    live.turnClosed.arm()
    live.clearDialog()
    try {
      await cancelPane(live.pane)
    } catch (error) {
      return deliveryFailure(error, id)
    }

    // 2. The marker, or for an Esc before the first token nothing at all: then the timeout ends the turn.
    if (await live.turnClosed.wait(this.timings.cancelTimeoutMs)) {
      return accept({
        wasBusy: true,
        detectedBy: live.lastCloseCause === 'marker' ? 'transcript_marker' : 'timeout',
      })
    }
    live.closeTurn(live.interruptedTurn(), 'timeout')

    return accept({
      wasBusy: true,
      detectedBy: 'timeout',
    })
  }

  private async stop(args: Readonly<Record<string, string>>): Promise<CtlResult> {
    const id = args.pane
    if (id === undefined) {
      return refuse('usage_error')
    }
    const live = this.panes.get(id)
    if (live === undefined) {
      return notRunning(id)
    }

    try {
      await live.stop()
    } catch (error) {
      if (error instanceof PaneError) {
        return refuse('timeout')
      }
      throw error
    } finally {
      this.remove(live)
    }

    return accept({ claudeSessionId: live.claudeSessionId })
  }

  private async rotateToken(args: Readonly<Record<string, string>>): Promise<CtlResult> {
    const id = args.pane
    const file = args['token-file']
    if (file === undefined || !isAbsolute(file)) {
      return refuse('usage_error')
    }

    // The token file is gone before any refusal can return.
    const content = await takeFile(file, readSecretFile)
    if (id === undefined) {
      return refuse('usage_error')
    }
    const live = this.panes.get(id)
    if (live === undefined) {
      return notRunning(id)
    }

    const token = content?.trim() ?? ''
    if (token === '' || tokenGen(token) !== live.gen) {
      return refuse('usage_error')
    }

    live.rotate(token)

    return accept({ gen: live.gen })
  }

  private status(args: Readonly<Record<string, string>>): CtlResult {
    const id = args.pane
    if (id === undefined) {
      return refuse('usage_error')
    }
    const live = this.panes.get(id)
    if (live === undefined) {
      return notRunning(id)
    }

    return accept({
      pane: id,
      running: true,
      gen: live.gen,
      busy: live.busy,
      dialogOpen: live.dialog !== undefined,
      lastSeq: live.queue.lastSeq,
      pendingEvents: live.queue.size,
      claudeSessionId: live.claudeSessionId,
      model: live.model,
    })
  }

  private deliveryRefusal(live: LivePane): CtlResult | null {
    if (live.dialog !== undefined) {
      return refuse('dialog_open')
    }
    if (live.busy || live.pendingPromptId !== undefined) {
      return refuse('busy')
    }

    return null
  }

  private accept(socket: Socket): void {
    const controller = new AbortController()
    let buffer = ''
    let handled = false

    socket.on('close', () => controller.abort())
    socket.on('error', (error) => {
      controller.abort()
      this.logger.debug('tmuxd socket client error', { error: error.message })
    })
    socket.on('data', (chunk) => {
      if (handled) {
        return
      }
      buffer += chunk.toString('utf8')
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy()

        return
      }
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      handled = true
      void this.answer(buffer.slice(0, newline), controller.signal).then((response) => {
        if (!socket.destroyed) {
          socket.end(`${JSON.stringify(response)}\n`)
        }
      })
    })
  }

  private async answer(line: string, signal: AbortSignal): Promise<unknown> {
    const request = parseRequest(line)
    try {
      if (request?.kind === 'hook' && typeof request.pane === 'string' && typeof request.event === 'string') {
        return await this.hook(request.pane, request.event, isRecord(request.payload) ? request.payload : {}, signal)
      }
      if (request?.kind === 'ctl' && typeof request.verb === 'string') {
        return await this.ctl(request.verb, stringArgs(request.args))
      }
    } catch (error) {
      this.logger.error('tmuxd request failed', {
        kind: request?.kind,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return refuse('usage_error')
  }

  private async answering(socketPath: string): Promise<boolean> {
    try {
      await socketRequest(socketPath, { kind: 'ping' }, 1_000)

      return true
    } catch (error) {
      if (error instanceof SocketRequestError) {
        return error.reason !== 'unreachable'
      }
      throw error
    }
  }
}

/**
 * Socket path of the daemon: under the agent user's runtime dir, in a directory only that user can enter.
 */
export function defaultSocketPath(env: Readonly<Record<string, string | undefined>>, tempDir: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'agent'

  return join(env.XDG_RUNTIME_DIR ?? tempDir, `kodizm-live-${uid}`, 'tmuxd.sock')
}

/**
 * The gen claim inside a live token, or null when the token cannot be read. The signature is Laravel's to check.
 */
export function tokenGen(token: string): number | null {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null
  }

  const [payload] = token.slice(TOKEN_PREFIX.length).split('.')
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))

    return isRecord(claims) && Number.isInteger(claims.gen) ? (claims.gen as number) : null
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

function parseStartEnv(content: string): StartEnv | null {
  const values: Record<string, string> = {}
  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    const separator = line.indexOf('=')
    const key = line.slice(0, separator)
    if (separator <= 0 || !ENV_KEY.test(key)) {
      return null
    }
    values[key] = line.slice(separator + 1)
  }

  const ingestUrl = values.KODIZM_LIVE_INGEST_URL ?? ''
  const token = values.KODIZM_LIVE_TOKEN ?? ''
  const gen = Number(values.KODIZM_LIVE_GEN)
  if (!/^https?:\/\//.test(ingestUrl) || !Number.isInteger(gen) || gen < 1 || tokenGen(token) !== gen) {
    return null
  }

  return {
    ingestUrl: ingestUrl.replace(/\/+$/, ''),
    token,
    gen,
    authEnv: Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith(LIVE_KEY_PREFIX))),
  }
}

/** The content of a regular 0600 file, or null when it is missing, not a file or readable by others. */
async function readSecretFile(path: string): Promise<string | null> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (info === null || !info.isFile() || (info.mode & 0o777) !== 0o600) {
    return null
  }

  return readFile(path, 'utf8')
}

async function readFileOrNull(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      return null
    }
    throw error
  })
}

/** Read a hand-off file and delete it, also when the read throws. */
async function takeFile(path: string, read: (path: string) => Promise<string | null>): Promise<string | null> {
  try {
    return await read(path)
  } finally {
    await removeFile(path)
  }
}

/** Delete a file; one already gone counts as deleted. */
export async function removeFile(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error
    }
  })
}

function decisionFrom(body: unknown): Decision | 'pending' | undefined {
  const status = isRecord(body) ? body.status : undefined
  switch (status) {
    case 'pending':
      return 'pending'
    case 'allowed':
      return { behavior: 'allow' }
    case 'denied':
      return {
        behavior: 'deny',
        message: (isRecord(body) ? text(body.message) : undefined) ?? 'Denied by the operator.',
      }
    case 'expired':
      return {
        behavior: 'deny',
        message: 'The permission request expired.',
      }
    default:
      return undefined
  }
}

interface FetchJsonOptions {
  method: 'GET' | 'POST'
  bearer: string
  body?: unknown
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * One ingest call. A network error, a timeout or an abort reads as status 0, a body that is not JSON as undefined:
 * every caller treats anything but its expected status as no answer.
 */
async function fetchJson(url: string, options: FetchJsonOptions): Promise<{ status: number; body: unknown }> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

  let status: number
  let raw: string
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        authorization: `Bearer ${options.bearer}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    })
    status = response.status
    raw = await response.text()
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && isAbort(error))) {
      return { status: 0, body: undefined }
    }
    throw error
  }

  let body: unknown
  try {
    body = raw === '' ? undefined : JSON.parse(raw)
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
  }

  return {
    status,
    body,
  }
}

function isAbort(error: DOMException): boolean {
  return error.name === 'AbortError' || error.name === 'TimeoutError'
}

function launchFailure(error: unknown): CtlCode {
  if (error instanceof PaneError) {
    return error.reason === 'start_timeout' ? 'timeout' : 'usage_error'
  }
  // realpath of a missing or unreadable cwd.
  if (isErrno(error)) {
    return 'usage_error'
  }
  throw error
}

function deliveryFailure(error: unknown, id: string): CtlResult {
  if (!(error instanceof PaneError)) {
    throw error
  }

  return error.reason === 'pane_dead' ? notRunning(id) : refuse('timeout')
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
}

async function panePid(pane: Pane): Promise<number | undefined> {
  const tmux = Bun.which('tmux')
  if (tmux === null) {
    return undefined
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  }
  if (process.env.TMUX_TMPDIR !== undefined) {
    env.TMUX_TMPDIR = process.env.TMUX_TMPDIR
  }
  const child = Bun.spawn([tmux, '-L', pane.socket, 'display-message', '-p', '-t', `=${pane.id}:`, '#{pane_pid}'], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
  const pid = Number(output.trim())

  return exitCode === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    if (isErrno(error) && error.code === 'ESRCH') {
      return false
    }
    // EPERM: the process exists under another user.
    if (isErrno(error) && error.code === 'EPERM') {
      return true
    }
    throw error
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function parseRequest(line: string): Record<string, unknown> | null {
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

function stringArgs(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function accept(data: Record<string, unknown>): CtlResult {
  return {
    ok: true,
    code: 'ok',
    data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
  }
}

function refuse(code: CtlCode, data?: Record<string, unknown>): CtlResult {
  return data === undefined ? { ok: false, code } : { ok: false, code, data }
}

function notRunning(id: string): CtlResult {
  return refuse('pane_not_running', {
    pane: id,
    running: false,
  })
}
