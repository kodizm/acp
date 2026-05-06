/**
 * Map a thrown codex error to a canonical {@link SessionFailedReason}.
 *
 * Phase 2 T12. Mirrors `claudeDriver/error-classifier.ts` shape +
 * patterns adapted to codex CLI / app-server error surface.
 *
 * Pattern priority:
 *   1. Tool-use-aborted  -> null (defer sentinel; not a real failure)
 *   2. auth_error        (401, Unauthorized, invalid api key, CODEX_API_KEY)
 *   3. rate_limit        (429, 503, Overloaded)
 *   4. transport_error   (EPIPE, ECONNRESET, subprocess exited, stdio closed)
 *   5. protocol_violation (JSON-RPC parse, Invalid Params, Method not found)
 *   6. internal_panic    (panic, assertion failed, unwrap on None)
 *   7. sdk_throw         (default fallback)
 */

import type { SessionFailedReason } from '../../wire/events.ts'

export interface ClassifiedFailure {
  reason: SessionFailedReason
  detail: string
}

const TOOL_USE_ABORTED_PATTERN = /tool use aborted/i

const PATTERN_MATCHERS: ReadonlyArray<{ test: (msg: string) => boolean; reason: SessionFailedReason }> = [
  {
    test: (msg) => /401|unauthorized|invalid api key|invalid token|codex_api_key|openai_api_key/i.test(msg),
    reason: 'auth_error',
  },
  {
    test: (msg) => /429|503|rate[_\s-]?limit|overloaded/i.test(msg),
    reason: 'rate_limit',
  },
  {
    test: (msg) => /epipe|econnreset|subprocess exited|stdio (closed|hangup)|broken pipe/i.test(msg),
    reason: 'transport_error',
  },
  {
    test: (msg) => /json-?rpc parse|invalid params|method not found|malformed frame/i.test(msg),
    reason: 'protocol_violation',
  },
  {
    test: (msg) => /\bpanic\b|assertion failed|unwrap on (none|null)/i.test(msg),
    reason: 'internal_panic',
  },
]

/**
 * Classify a codex throw. Returns the matched reason + detail, or
 * `null` for the tool-use-aborted defer sentinel.
 */
export function classifyCodexError(err: unknown): ClassifiedFailure | null {
  const message = extractMessage(err)
  if (TOOL_USE_ABORTED_PATTERN.test(message)) {
    return null
  }
  for (const matcher of PATTERN_MATCHERS) {
    if (matcher.test(message)) {
      return { reason: matcher.reason, detail: message }
    }
  }
  return { reason: 'sdk_throw', detail: message }
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err === undefined) return 'unknown error (undefined thrown)'
  if (err === null) return 'unknown error (null thrown)'
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
