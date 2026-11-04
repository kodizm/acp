/**
 * The tmuxd side of `live-events.v1.json`: event types, the envelope, and the mapping from CLI hook payloads and
 * transcript records to event payloads.
 *
 * Hook payloads come from the CLI (2.1.280 shapes) and can be forged by anything that reaches the daemon socket, so
 * every field is read through a type check and a missing one degrades to an absent key, never to a guess.
 */

import { redact } from './redact.ts'
import type { UsageCounts } from './transcript.ts'

export const DISPLAY_TYPES = [
  'output_chunk',
  'thinking_chunk',
  'tool_call_begin',
  'tool_call_end',
  'usage',
  'permission_request',
  'question_request',
  'subagent_spawn',
  'subagent_complete',
  'compaction_started',
  'compaction_completed',
  'heartbeat',
  'process_died',
  'session_failed',
] as const

export const CONTROL_TYPES = [
  'session_started',
  'turn_started',
  'turn_completed',
  'turn_failed',
  'session_ended',
] as const

export type LiveEventType = (typeof DISPLAY_TYPES)[number] | (typeof CONTROL_TYPES)[number]

export type Payload = Record<string, unknown>

export interface LiveEvent {
  type: LiveEventType
  seq: number
  gen: number
  ts: string
  payload: Payload
}

export interface EventDraft {
  type: LiveEventType
  payload: Payload
}

/** `watchdog` and `interrupted` are tmuxd's own: no Stop hook told it the turn ended. */
export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'watchdog' | 'interrupted'

export type SessionEndReason = 'idle_timeout' | 'stopped' | 'crashed' | 'token_expired'

/** Body of `POST /mcp/internal/live/permissions`, without the gen the daemon adds. */
export interface PermissionOpenRequest {
  toolCallId: string
  title: string
  kind: string
  rawInput: unknown
  options: Array<{
    optionId: string
    kind: string
  }>
}

const PERMISSION_OPTIONS: PermissionOpenRequest['options'] = [
  {
    optionId: 'allow',
    kind: 'allow_once',
  },
  {
    optionId: 'deny',
    kind: 'reject_once',
  },
]

const API_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'max_tokens', 'refusal'])

const TOOL_KINDS: Readonly<Record<string, string>> = {
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
}

// The fields that say what a tool call is about, in the order a title prefers them.
const TITLE_FIELDS = ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'description']

const TITLE_MAX = 200

/** A tool output larger than this is cut: a batch holds up to 200 events and the stream row is for display. */
const OUTPUT_MAX = 16_000

/**
 * StopFailure `error` values to the SessionFailureReason the ingest resolves with `tryFrom`. Anything not named here
 * is an API-side failure.
 */
const FAILURE_REASONS: Readonly<Record<string, string>> = {
  rate_limit: 'rate_limit',
  authentication_failed: 'auth_error',
  oauth_org_not_allowed: 'auth_error',
  account_on_hold: 'auth_error',
  billing_error: 'auth_error',
  cloud_credential_error: 'auth_error',
}

/**
 * Redact every string inside a payload, keys left alone.
 */
export function redactDeep<T>(value: T, knownValues: readonly string[]): T {
  if (typeof value === 'string') {
    return redact(value, knownValues) as T
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactDeep(item, knownValues)) as T
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, knownValues)])) as T
  }

  return value
}

export function sessionStarted(hook: Payload, source: 'startup' | 'resume'): EventDraft {
  return draft('session_started', {
    claudeSessionId: text(hook.session_id),
    model: text(hook.model),
    source,
  })
}

export function turnStarted(promptId: string): EventDraft {
  return draft('turn_started', { promptId })
}

export function turnCompleted(stopReason: StopReason, lastAssistantMessage: string): EventDraft {
  return draft('turn_completed', {
    stopReason,
    lastAssistantMessage,
  })
}

/**
 * The stop reason of the last assistant message when the API gave one of the contract's values, else `end_turn`.
 */
export function apiStopReason(reason: string | null): StopReason {
  return reason !== null && API_STOP_REASONS.has(reason) ? (reason as StopReason) : 'end_turn'
}

export function turnFailed(hook: Payload): EventDraft {
  const error = text(hook.error) ?? 'unknown'
  const details = text(hook.error_details)

  return turnFailedWith(
    failureReason(error),
    details === undefined ? `StopFailure ${error}` : `StopFailure ${error}: ${details}`.slice(0, TITLE_MAX * 2),
  )
}

export function turnFailedWith(reason: string, detail: string): EventDraft {
  return draft('turn_failed', {
    reason,
    detail,
  })
}

/** The SessionFailureReason a CLI error name maps to; a name the table does not know is an API-side failure. */
export function failureReason(error: string): string {
  return FAILURE_REASONS[error] ?? 'api_error'
}

export function sessionEnded(reason: SessionEndReason): EventDraft {
  return draft('session_ended', { reason })
}

export function toolCallBegin(hook: Payload, toolCallId: string): EventDraft {
  return draft('tool_call_begin', {
    toolCallId,
    name: text(hook.tool_name),
    input: hook.tool_input,
  })
}

export function toolCallEnd(toolCallId: string, status: 'completed' | 'failed', output?: string): EventDraft {
  return draft('tool_call_end', {
    toolCallId,
    status,
    output,
  })
}

/**
 * The display text of a PostToolUse `tool_response`: the CLI gives Bash an object of streams, most tools a string.
 */
export function toolOutput(response: unknown): string | undefined {
  if (response === undefined || response === null) {
    return undefined
  }
  if (typeof response === 'string') {
    return response.slice(0, OUTPUT_MAX)
  }
  if (isRecord(response) && typeof response.stdout === 'string') {
    const stderr = typeof response.stderr === 'string' && response.stderr !== '' ? `\n${response.stderr}` : ''

    return `${response.stdout}${stderr}`.slice(0, OUTPUT_MAX)
  }

  return JSON.stringify(response).slice(0, OUTPUT_MAX)
}

/**
 * The permission row the ingest opens and the matching timeline event. The CLI offers no option ids, so the two
 * fixed options of the contract stand in for allow and deny.
 */
export function permissionRequest(hook: Payload, toolCallId: string): PermissionOpenRequest {
  const name = text(hook.tool_name) ?? 'unknown'

  return {
    toolCallId,
    title: toolTitle(name, hook.tool_input),
    kind: TOOL_KINDS[name] ?? 'other',
    rawInput: hook.tool_input ?? null,
    options: PERMISSION_OPTIONS,
  }
}

export function subagentSpawn(hook: Payload): EventDraft {
  const type = text(hook.agent_type)

  return draft('subagent_spawn', {
    subagent_id: text(hook.agent_id),
    subagent_type: type === undefined || type === '' ? 'general-purpose' : type,
  })
}

export function subagentComplete(hook: Payload): EventDraft {
  return draft('subagent_complete', {
    subagent_id: text(hook.agent_id),
  })
}

export function compactionStarted(hook: Payload): EventDraft {
  return draft('compaction_started', {
    trigger: hook.trigger === 'auto' ? 'auto' : 'manual',
  })
}

/** PostCompact carries no success flag: it fires only once a compaction finished. */
export function compactionCompleted(hook: Payload): EventDraft {
  return draft('compaction_completed', {
    succeeded: true,
    trigger: hook.trigger === 'auto' ? 'auto' : 'manual',
  })
}

export function usage(counts: UsageCounts): EventDraft {
  return draft('usage', { ...counts })
}

export function outputChunk(chunk: string): EventDraft {
  return draft('output_chunk', { text: chunk })
}

export function thinkingChunk(chunk: string): EventDraft {
  return draft('thinking_chunk', { text: chunk })
}

export function heartbeat(): EventDraft {
  return draft('heartbeat', {})
}

/** The pane is gone and its exit status with it, so the code is unknown. */
export function processDied(): EventDraft {
  return draft('process_died', { exitCode: null })
}

export function sessionFailed(reason: string, detail: string): EventDraft {
  return draft('session_failed', {
    reason,
    detail,
  })
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolTitle(name: string, input: unknown): string {
  if (!isRecord(input)) {
    return name
  }

  const field = TITLE_FIELDS.find((key) => typeof input[key] === 'string' && input[key] !== '')
  const subject = field === undefined ? JSON.stringify(input) : (input[field] as string)

  return `${name}: ${subject}`.slice(0, TITLE_MAX)
}

function draft(type: LiveEventType, payload: Payload): EventDraft {
  return {
    type,
    payload: Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)),
  }
}
