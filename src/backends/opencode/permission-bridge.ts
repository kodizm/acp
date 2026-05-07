/**
 * Opencode `permission.asked` -> canonical permission_request +
 * Pattern B onDefer hook.
 *
 * Phase 3 T8 + locked decision D5. The driver subscribes to opencode
 * `permission.asked` bus events; the bridge translates each to the
 * canonical wire (3-option permission_request + outbound
 * session/request_permission RPC), races against signal / hard
 * timeout / defer threshold, then maps the orchestrator's selection
 * back to opencode's `Reply.reply: 'once'|'always'|'reject'` shape
 * via `sdk.permission.reply(requestID, body)`.
 *
 * Decision mapping (orchestrator -> opencode):
 *   allow         -> {reply: 'once'}
 *   allow_always  -> {reply: 'always'} (opencode auto-injects approval
 *                    rule for matching `Request.always` patterns;
 *                    auto-resolves other pending same-session requests)
 *   reject        -> {reply: 'reject', message?} (CorrectedError carries
 *                    feedback when orchestrator's _meta.feedback is set)
 *   DEFERRED      -> onDefer hook (Pattern B); driver writes synthetic
 *                    tool_result via deferred-permission.ts + persists
 *                    DeferredState; sdk.permission.reply is NOT called.
 *
 * Tool name in the canonical event is reverse-mapped through the MCP
 * reverse name map (see mcp-mapper.ts) so `<server>_<tool>` keys
 * surface as `mcp__<server>__<tool>` for the orchestrator UI.
 */

import {
  type AcpServerLike,
  DEFERRED_SENTINEL,
  type EmitLike,
  awaitPermissionResponse,
} from '../claude/permission-bridge.ts'
import { reverseToolName } from './mcp-mapper.ts'

/**
 * Subset of opencode's `Permission.Request` shape we consume.
 */
export interface OpencodePermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: ReadonlyArray<string>
  always: ReadonlyArray<string>
  metadata: Record<string, unknown>
  tool?: { messageID: string; callID: string }
}

interface OutcomeEnvelope {
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }
  _meta?: { feedback?: string }
}

/**
 * Defer hook signature: opencode driver calls this when the
 * `deferTimeoutMs` racer wins (Pattern B). Implementation writes the
 * synthetic tool_result + persists DeferredState + emits
 * `permission_deferred` event. T15 wires the concrete impl.
 */
export type OpencodeDeferHandler = (args: {
  request: OpencodePermissionRequest
  canonicalName: string
}) => Promise<void>

/**
 * Minimal opencode SDK surface the bridge uses. Production passes
 * the full `OpencodeClient`; tests pass a small mock.
 */
export interface OpencodePermissionSdk {
  permission: {
    reply: (...args: unknown[]) => unknown
  }
}

const CANONICAL_OPTIONS = [
  { optionId: 'allow' as const, label: 'Allow' },
  { optionId: 'allow_always' as const, label: 'Always allow' },
  { optionId: 'reject' as const, label: 'Reject' },
]

/**
 * Translate one opencode permission request into the canonical wire
 * flow and reply with the orchestrator's decision.
 */
export async function handleOpencodePermission(args: {
  params: OpencodePermissionRequest
  server: AcpServerLike
  sessionId: string
  sdk: OpencodePermissionSdk
  emit: EmitLike
  signal: AbortSignal
  mcpReverseMap: Map<string, string>
  permissionTimeoutMs?: number
  deferTimeoutMs?: number
  onDefer?: OpencodeDeferHandler
}): Promise<void> {
  // 1. Resolve canonical tool name for the orchestrator-facing event.
  //    MCP keys reverse-map to `mcp__<server>__<tool>`; native keys
  //    pass through PascalCased.
  const canonicalName = canonicalToolName(args.params.permission, args.mcpReverseMap)

  // 2. Emit canonical permission_request event before the RPC.
  args.emit.send({
    sessionId: args.sessionId,
    type: 'permission_request',
    toolUseId: args.params.id,
    name: canonicalName,
    options: CANONICAL_OPTIONS,
  })

  // 3. Race the outbound RPC against signal / timeout / defer.
  let raced: OutcomeEnvelope | typeof DEFERRED_SENTINEL
  try {
    const raceOptions: { signal: AbortSignal; timeoutMs?: number; deferTimeoutMs?: number } = {
      signal: args.signal,
    }
    if (args.permissionTimeoutMs !== undefined) {
      raceOptions.timeoutMs = args.permissionTimeoutMs
    }
    if (args.deferTimeoutMs !== undefined) {
      raceOptions.deferTimeoutMs = args.deferTimeoutMs
    }

    raced = await awaitPermissionResponse<OutcomeEnvelope>(
      args.server,
      'session/request_permission',
      {
        sessionId: args.sessionId,
        toolUseId: args.params.id,
        name: canonicalName,
        options: CANONICAL_OPTIONS,
      },
      raceOptions,
    )
  } catch {
    // signal abort or hard timeout: do not reply; opencode times the
    // permission out on its own side.
    return
  }

  // 4. Pattern B: defer threshold won the race. Hand off to onDefer
  //    + return WITHOUT calling sdk.permission.reply (the synthetic
  //    tool_result satisfies the model loop on this side).
  if (raced === DEFERRED_SENTINEL) {
    if (args.onDefer !== undefined) {
      await args.onDefer({ request: args.params, canonicalName })
    }
    return
  }

  // 5. Map orchestrator outcome -> opencode reply shape.
  const outcome = raced.outcome
  if (outcome.outcome === 'cancelled') return

  const replyBody = mapOutcomeToReply(outcome.optionId, raced._meta?.feedback)
  if (replyBody === undefined) return

  await safeReply(args.sdk, args.params.id, replyBody)
}

function mapOutcomeToReply(
  optionId: string,
  feedback?: string,
): { reply: 'once' | 'always' | 'reject'; message?: string } | undefined {
  switch (optionId) {
    case 'allow':
      return { reply: 'once' }
    case 'allow_always':
      return { reply: 'always' }
    case 'reject':
      return feedback !== undefined && feedback.length > 0
        ? { reply: 'reject', message: feedback }
        : { reply: 'reject' }
    default:
      return undefined
  }
}

function canonicalToolName(opencodePermission: string, mcpReverseMap: Map<string, string>): string {
  const canonical = reverseToolName(opencodePermission, mcpReverseMap)
  if (canonical !== null) return canonical
  // Native opencode permission keys are lowercase; PascalCase for the
  // canonical wire so claude / codex / opencode all surface the same
  // case in audit logs.
  return opencodePermission
    .split('_')
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join('')
}

async function safeReply(
  sdk: OpencodePermissionSdk,
  requestId: string,
  body: { reply: 'once' | 'always' | 'reject'; message?: string },
): Promise<void> {
  try {
    await sdk.permission.reply({
      id: requestId,
      body,
    })
  } catch {
    // best-effort
  }
}
