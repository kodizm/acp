/**
 * Opencode-side Pattern B sentinel injection.
 *
 * Phase 3 T15. When a permission_request stays unanswered past
 * `permissionDeferTimeoutMs`, the driver writes a synthetic
 * `tool_result` payload back into the opencode session transcript
 * carrying the {@link DEFERRED_MARKER} string. Process B's resume
 * picks this up and re-issues the original permission with the
 * cached orchestrator answer.
 *
 * The actual append goes via `sdk.session.message.append` (v1) or
 * `sdk.experimental.session.message.append` (v2 fallback) depending
 * on which endpoint the running opencode build supports.
 */

/**
 * Marker text injected into the synthetic tool_result so resume code
 * paths can detect a deferred row in the transcript without false
 * positives.
 */
export const DEFERRED_MARKER: string = '__KODIZM_PERMISSION_DEFERRED__'

interface MessageAppendApi {
  append: (params: unknown) => Promise<unknown>
}

interface OpencodeSdkLike {
  session?: {
    message?: MessageAppendApi
  }
  experimental?: {
    session?: {
      message?: MessageAppendApi
    }
  }
}

/**
 * Append the synthetic deferred-permission tool_result to the
 * opencode session transcript. Best-effort: append failures swallow
 * silently because the orchestrator-side persistence already records
 * the deferred state and is the source of truth.
 */
export async function writeDeferredSentinel(args: {
  sdk: OpencodeSdkLike
  opencodeSessionId: string
  requestId: string
  toolName: string
}): Promise<void> {
  const append = resolveAppendApi(args.sdk)
  if (append === undefined) return

  const payload = buildSentinelPayload(args)
  try {
    await append({
      sessionID: args.opencodeSessionId,
      body: payload,
    })
  } catch {
    // Best-effort: opencode may have already torn down or the
    // endpoint may not exist on older builds. The orchestrator
    // owns the deferred state.
  }
}

function resolveAppendApi(sdk: OpencodeSdkLike): ((params: unknown) => Promise<unknown>) | undefined {
  if (sdk.session?.message?.append !== undefined) return sdk.session.message.append.bind(sdk.session.message)
  if (sdk.experimental?.session?.message?.append !== undefined)
    return sdk.experimental.session.message.append.bind(sdk.experimental.session.message)
  return undefined
}

function buildSentinelPayload(args: { requestId: string; toolName: string }): Record<string, unknown> {
  return {
    role: 'user',
    parts: [
      {
        type: 'text',
        text: `${DEFERRED_MARKER} requestId=${args.requestId} tool=${args.toolName}`,
      },
    ],
  }
}
