/**
 * Codex 3 approval RPCs collapse to canonical permission_request.
 *
 * Phase 2 T10 + locked decision 3. The orchestrator never knows
 * which codex RPC fired; it sees one canonical `permission_request`
 * event with the `name` discriminator + outbound
 * `session/request_permission` RPC. Decision is translated back to
 * codex's per-RPC decision shape inside `handleCodexApproval`.
 *
 * Codex RPCs handled:
 *   item/commandExecution/requestApproval   -> name: 'codex_exec'
 *   item/fileChange/requestApproval         -> name: 'codex_apply_patch'
 *   item/permissions/requestApproval        -> name: 'codex_permission_grant'
 *
 * Decision translation (orchestrator returns allow/allow_always/reject):
 *   exec / fileChange:
 *     allow         -> { decision: 'Accept' }
 *     allow_always  -> { decision: 'AcceptForSession' }
 *     reject        -> { decision: 'Decline' }
 *   permissions:
 *     allow         -> { permissions: <orig>, scope: 'Turn' }
 *     allow_always  -> { permissions: <orig>, scope: 'Session' }
 *     reject        -> { permissions: { type: 'disabled' }, scope: 'Turn' }
 */

import { DEFERRED_SENTINEL, awaitPermissionResponse } from '../claude/permission-bridge.ts'
import type { AcpServerLike, EmitLike } from '../claude/permission-bridge.ts'

/**
 * Defer hook signature: codex driver calls this when the
 * `deferTimeoutMs` racer wins (Phase 1.6 Pattern B). Implementation
 * writes the synthetic RolloutItem sentinel + persists deferred
 * state + emits `permission_deferred` event.
 */
export type CodexDeferHandler = (args: {
  method: CodexApprovalMethod
  params: CodexApprovalParams
}) => Promise<void>

type CodexApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'

interface CodexApprovalParams {
  thread_id?: string
  turn_id?: string
  item_id: string
  approval_id?: string
  command?: string
  cwd?: string
  reason?: string
  permissions?: unknown
}

interface CodexApprovalResult {
  decision?: 'Accept' | 'AcceptForSession' | 'Decline'
  permissions?: unknown
  scope?: 'Turn' | 'Session'
}

interface OutcomeEnvelope {
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }
}

const CANONICAL_OPTIONS = [
  { optionId: 'allow' as const, label: 'Accept' },
  { optionId: 'allow_always' as const, label: 'AcceptForSession' },
  { optionId: 'reject' as const, label: 'Decline' },
]

/**
 * Translate one codex approval RPC into the canonical wire flow.
 *
 * Emits the canonical `permission_request` event + sends outbound
 * `session/request_permission` RPC + maps the orchestrator's
 * decision back to the codex per-RPC shape.
 */
export async function handleCodexApproval(args: {
  method: CodexApprovalMethod
  params: CodexApprovalParams
  server: AcpServerLike
  sessionId: string
  emit: EmitLike
  signal: AbortSignal
  permissionTimeoutMs?: number
  deferTimeoutMs?: number
  onDefer?: CodexDeferHandler
}): Promise<CodexApprovalResult> {
  const name = approvalRpcToCanonicalName(args.method)
  const toolUseId =
    args.params.approval_id !== undefined ? `${args.params.item_id}-${args.params.approval_id}` : args.params.item_id

  // 1. Emit canonical permission_request event so orchestrator's
  //    stream-event store rolls forward in real time.
  args.emit.send({
    sessionId: args.sessionId,
    type: 'permission_request',
    toolUseId,
    name,
    options: CANONICAL_OPTIONS,
  })

  // 2. Send outbound session/request_permission RPC + race against
  //    abort signal + optional deadline + defer threshold (Pattern B).
  const raceOptions: { signal: AbortSignal; timeoutMs?: number; deferTimeoutMs?: number } = {
    signal: args.signal,
  }
  if (args.permissionTimeoutMs !== undefined) {
    raceOptions.timeoutMs = args.permissionTimeoutMs
  }
  if (args.deferTimeoutMs !== undefined && args.onDefer !== undefined) {
    raceOptions.deferTimeoutMs = args.deferTimeoutMs
  }

  const response = await awaitPermissionResponse<OutcomeEnvelope>(
    args.server,
    'session/request_permission',
    {
      sessionId: args.sessionId,
      toolCall: {
        toolCallId: toolUseId,
        rawInput: args.params,
        title: name,
        kind: 'tool_use',
      },
      options: [
        { kind: 'allow_once', name: 'Accept', optionId: 'allow' },
        { kind: 'allow_always', name: 'AcceptForSession', optionId: 'allow_always' },
        { kind: 'reject_once', name: 'Decline', optionId: 'reject' },
      ],
    },
    raceOptions,
  )

  // 3. Pattern B: defer racer won. Driver-supplied onDefer writes
  //    JSONL sentinel + persists deferred state + emits
  //    permission_deferred event; we return Decline so codex
  //    unwinds the turn.
  if (response === DEFERRED_SENTINEL) {
    if (args.onDefer !== undefined) {
      await args.onDefer({ method: args.method, params: args.params })
    }
    return defaultDecline(args.method)
  }

  if (response === undefined || (response as { outcome?: unknown }).outcome === undefined) {
    return defaultDecline(args.method)
  }
  const env = response as OutcomeEnvelope
  if (env.outcome.outcome === 'cancelled') {
    return defaultDecline(args.method)
  }
  return mapOutcomeToCodex(args.method, env.outcome.optionId)
}

function approvalRpcToCanonicalName(method: CodexApprovalMethod): string {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return 'codex_exec'
    case 'item/fileChange/requestApproval':
      return 'codex_apply_patch'
    case 'item/permissions/requestApproval':
      return 'codex_permission_grant'
  }
}

function mapOutcomeToCodex(method: CodexApprovalMethod, optionId: string): CodexApprovalResult {
  if (method === 'item/permissions/requestApproval') {
    if (optionId === 'allow') {
      return { permissions: { type: 'managed' }, scope: 'Turn' }
    }
    if (optionId === 'allow_always') {
      return { permissions: { type: 'managed' }, scope: 'Session' }
    }
    return { permissions: { type: 'disabled' }, scope: 'Turn' }
  }

  if (optionId === 'allow') return { decision: 'Accept' }
  if (optionId === 'allow_always') return { decision: 'AcceptForSession' }
  return { decision: 'Decline' }
}

function defaultDecline(method: CodexApprovalMethod): CodexApprovalResult {
  if (method === 'item/permissions/requestApproval') {
    return { permissions: { type: 'disabled' }, scope: 'Turn' }
  }
  return { decision: 'Decline' }
}
