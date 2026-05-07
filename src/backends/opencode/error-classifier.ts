/**
 * Map a thrown opencode error to a canonical {@link SessionFailedReason}.
 *
 * Phase 3 T11. opencode surfaces errors via two surfaces:
 *   - AssistantError (discriminated by `name`):
 *       ProviderAuthError | UnknownError | MessageOutputLengthError |
 *       MessageAbortedError | StructuredOutputError | ContextOverflowError |
 *       APIError (with `data: {statusCode, isRetryable, ...}`)
 *   - HttpError thrown by the v2 SDK fetch interceptors with a message
 *     like `opencode server <method> <url> → <status> ...`.
 *
 * Branch order:
 *   1. MessageAbortedError      -> null (cancel sentinel)
 *   2. ProviderAuthError        -> auth_error
 *   3. APIError data.statusCode 429/503  -> rate_limit
 *   4. APIError data.statusCode 5xx      -> transport_error
 *   5. ContextOverflowError     -> compaction_failure
 *   6. HTTP 401/403             -> auth_error
 *   7. default                  -> sdk_throw
 */

import type { SessionFailedReason } from '../../wire/events.ts'

export interface ClassifiedFailure {
  reason: SessionFailedReason
  detail: string
}

interface AssistantErrorLike {
  name?: string
  message?: string
  data?: { statusCode?: number; message?: string }
}

/**
 * Classify an opencode throw. Returns the matched reason + detail, or
 * `null` when the throw is the abort sentinel (orchestrator cancelled).
 */
export function classifyOpencodeError(err: unknown): ClassifiedFailure | null {
  const detail = extractMessage(err)
  const tagged = err as AssistantErrorLike

  // 1. Cancel sentinel.
  if (tagged?.name === 'MessageAbortedError') {
    return null
  }

  // 2. Auth via discriminated tag.
  if (tagged?.name === 'ProviderAuthError') {
    return { reason: 'auth_error', detail }
  }

  // 3. APIError statusCode-based dispatch.
  if (tagged?.name === 'APIError' && typeof tagged.data?.statusCode === 'number') {
    const code = tagged.data.statusCode
    if (code === 429 || code === 503) {
      return { reason: 'rate_limit', detail }
    }
    if (code >= 500) {
      return { reason: 'transport_error', detail }
    }
    if (code === 401 || code === 403) {
      return { reason: 'auth_error', detail }
    }
  }

  // 4. ContextOverflowError -> compaction_failure (transport semantics
  //    align: the conversation cannot continue on this driver).
  if (tagged?.name === 'ContextOverflowError') {
    return { reason: 'compaction_failure', detail }
  }

  // 5. Plain HttpError messages from the v2 SDK fetch interceptor.
  if (/→\s*(401|403)\b|\bunauthorized\b|\bforbidden\b/i.test(detail)) {
    return { reason: 'auth_error', detail }
  }
  if (/→\s*(429|503)\b|\brate[\s_-]?limit\b/i.test(detail)) {
    return { reason: 'rate_limit', detail }
  }
  if (/→\s*5\d\d\b|\beconnreset\b|\bepipe\b/i.test(detail)) {
    return { reason: 'transport_error', detail }
  }

  // 6. Default fallback.
  return { reason: 'sdk_throw', detail }
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null) {
    const e = err as { message?: string; data?: { message?: string } }
    if (typeof e.message === 'string' && e.message.length > 0) return e.message
    if (typeof e.data?.message === 'string') return e.data.message
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  if (typeof err === 'string') return err
  return String(err)
}
