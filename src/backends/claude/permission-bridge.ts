/**
 * Claude SDK `canUseTool` bridge to the Kodizm ACP wire.
 *
 * The SDK calls `canUseTool` synchronously before each tool_use turn
 * and awaits a {@link PermissionResult}. This bridge:
 *
 *   1. Builds the outbound `session/request_permission` payload from
 *      the SDK's args (toolName, input, toolUseID, agentID, ...).
 *   2. Emits a parallel `permission_request` stream event so the
 *      orchestrator's stream-events store rolls forward in real time.
 *   3. Issues the outbound RPC + races it against the per-turn abort
 *      signal and an optional deadline.
 *   4. Maps the response outcome to the SDK's PermissionResult shape.
 *
 * Cancel + timeout semantics:
 *
 *   - `signal.aborted` -> throw `Tool use aborted` (SDK absorbs as
 *     deny+abort).
 *   - `outcome === 'cancelled'` -> same throw.
 *   - `AcpTimeoutError` (deadline elapsed) -> `{ behavior: 'deny',
 *     message: 'Permission RPC timed out' }`.
 *   - `selected.allow` / `selected.allow_always` -> `{ behavior:
 *     'allow', updatedInput, updatedPermissions? }`.
 *   - any other selected outcome (including `reject`) -> `{ behavior:
 *     'deny', message: 'User refused permission to run tool' }`.
 */

import { AcpTimeoutError } from '../../server/errors.ts'
import type { SessionUpdateEvent } from '../../wire/events.ts'

/**
 * Minimal AcpServer surface we need for the outbound RPC. Defined
 * structurally so unit tests can inject a fake server without
 * pulling the real implementation.
 */
export interface AcpServerLike {
  request<T>(method: string, params: unknown): Promise<T>
}

/**
 * Minimal emitter contract; mirrors `EventEmitter` from
 * `src/backends/driver.ts` but inlined to avoid a circular import.
 */
export interface EmitLike {
  send(event: SessionUpdateEvent): void
}

/**
 * SDK-side options the canUseTool callback receives. Defining locally
 * to keep unit tests independent of the SDK's exported types.
 */
export interface CanUseToolOptions {
  signal: AbortSignal
  toolUseID: string
  agentID?: string
  suggestions?: Array<{
    type: 'addRules' | 'replaceRules' | 'removeRules'
    rules: Array<{ toolName: string; ruleContent?: string }>
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }>
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  description?: string
}

/**
 * SDK PermissionResult shape (mirrors @anthropic-ai/claude-agent-sdk).
 */
export type PermissionResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: CanUseToolOptions['suggestions']
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

/**
 * Outbound `session/request_permission` payload shape.
 */
interface PermissionRequestPayload {
  sessionId: string
  toolCall: {
    toolCallId: string
    rawInput: unknown
    title?: string
    kind: string
  }
  options: Array<{
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
    name: string
    optionId: 'allow' | 'allow_always' | 'reject'
  }>
  agentId?: string
}

/**
 * Inbound response shape from the orchestrator.
 */
interface PermissionResponse {
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }
}

const DEFAULT_OPTIONS: PermissionRequestPayload['options'] = [
  { kind: 'allow_always', name: 'Always allow this tool', optionId: 'allow_always' },
  { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
  { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
]

export interface BuildCanUseToolDeps {
  server: AcpServerLike
  sessionId: string
  emit: EmitLike
  signal: AbortSignal
  permissionTimeoutMs?: number
}

/**
 * Construct a Claude SDK `canUseTool` callback that fans out to the
 * Kodizm ACP wire. Returns a closure ready to be passed as
 * `Options.canUseTool` on the SDK's `query()` call.
 */
export function buildCanUseTool(
  deps: BuildCanUseToolDeps,
): (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<PermissionResult> {
  return async function canUseTool(toolName, input, options) {
    // 1. Build the outbound payload from SDK args + Kodizm defaults.
    const payload: PermissionRequestPayload = {
      sessionId: deps.sessionId,
      toolCall: {
        toolCallId: options.toolUseID,
        rawInput: input,
        title: options.title ?? toolName,
        kind: 'tool_use',
      },
      options: DEFAULT_OPTIONS,
    }
    if (options.agentID !== undefined) {
      payload.agentId = options.agentID
    }

    // 2. Emit the parallel stream event so orchestrator UI updates live.
    const event: SessionUpdateEvent = {
      sessionId: deps.sessionId,
      type: 'permission_request',
      toolUseId: options.toolUseID,
      name: toolName,
      options: DEFAULT_OPTIONS.map((o) => ({ optionId: o.optionId, label: o.name })),
      ...(options.agentID === undefined ? {} : { agentId: options.agentID, parentSessionId: deps.sessionId }),
    }
    deps.emit.send(event)

    // 3. Issue the outbound RPC + race against signal + optional deadline.
    let response: PermissionResponse
    try {
      response = await awaitPermissionResponse<PermissionResponse>(deps.server, 'session/request_permission', payload, {
        signal: composeSignals(deps.signal, options.signal),
        timeoutMs: deps.permissionTimeoutMs,
      })
    } catch (error) {
      if (error instanceof AcpTimeoutError) {
        return { behavior: 'deny', message: 'Permission RPC timed out' }
      }
      throw error
    }

    // 4. Map the outcome.
    return mapPermissionOutcome(response, input, options.suggestions)
  }
}

/**
 * Resource-bounded await for an outbound permission-style RPC.
 *
 * Race semantics:
 *   - The RPC promise.
 *   - Optional abort signal -> rejects with `Error('aborted')`.
 *   - Optional `timeoutMs` -> rejects with {@link AcpTimeoutError}.
 *
 * Pure helper so AskUserQuestion (T8) can reuse it for its own
 * outbound RPC without re-implementing the race.
 */
export async function awaitPermissionResponse<T>(
  server: AcpServerLike,
  method: string,
  params: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const racers: Array<Promise<T>> = [server.request<T>(method, params)]
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined

  if (options.signal !== undefined) {
    const signal = options.signal
    racers.push(
      new Promise<T>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        abortListener = () => reject(new Error('aborted'))
        signal.addEventListener('abort', abortListener)
      }),
    )
  }

  if (options.timeoutMs !== undefined) {
    const timeoutMs = options.timeoutMs
    racers.push(
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new AcpTimeoutError(`permission RPC ${method} timed out`, {
              data: { method, elapsedMs: timeoutMs },
            }),
          )
        }, timeoutMs)
      }),
    )
  }

  try {
    return await Promise.race(racers)
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    if (abortListener !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener('abort', abortListener)
    }
  }
}

/**
 * Combine two abort signals into one that fires when either does.
 * Used to merge the per-turn signal (`deps.signal`) with the SDK's
 * own canUseTool-scoped signal (`options.signal`).
 */
function composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a
  if (b.aborted) return b

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return controller.signal
}

/**
 * Map the orchestrator's response outcome to the SDK's
 * PermissionResult shape.
 *
 * @throws when the outcome is `cancelled` (SDK interprets as deny+abort).
 */
function mapPermissionOutcome(
  response: PermissionResponse,
  input: Record<string, unknown>,
  suggestions: CanUseToolOptions['suggestions'],
): PermissionResult {
  const outcome = response.outcome

  if (outcome.outcome === 'cancelled') {
    throw new Error('Tool use aborted')
  }

  if (outcome.optionId === 'allow') {
    return { behavior: 'allow', updatedInput: input }
  }

  if (outcome.optionId === 'allow_always') {
    return {
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions:
        suggestions !== undefined && suggestions.length > 0
          ? suggestions
          : [
              {
                type: 'addRules',
                rules: [{ toolName: 'unknown' }],
                behavior: 'allow',
                destination: 'session',
              },
            ],
    }
  }

  return { behavior: 'deny', message: 'User refused permission to run tool' }
}
