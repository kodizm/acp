/**
 * Map a thrown SDK error to a canonical {@link SessionFailedReason}.
 *
 * The classifier walks the error message + name + nested cause chain
 * with a priority-ordered list of pattern matchers. The first match
 * wins. The function intentionally returns `null` for the
 * `Tool use aborted` path — that error is the SDK's reaction to a
 * Pattern B defer-fired deny+interrupt and is NOT a real failure;
 * the driver's catch block handles it before reaching the
 * classifier.
 *
 * Phase 1.7 T11. Phases 2 (codex) + 3 (opencode) provide their own
 * error-classifier modules; the return type is shared so the driver
 * code path stays uniform.
 */

import type { SessionFailedReason } from '../../wire/events.ts'

export interface ClassifiedFailure {
  reason: SessionFailedReason
  detail: string
}

const TOOL_USE_ABORTED_PATTERN = /tool use aborted/i

const PATTERN_MATCHERS: ReadonlyArray<{ test: (msg: string) => boolean; reason: SessionFailedReason }> = [
  // Auth errors win first.
  {
    test: (msg) => /401|unauthorized|invalid api key|invalid token|could not resolve authentication/i.test(msg),
    reason: 'auth_error',
  },
  // Rate-limit / overloaded come before generic sdk_throw.
  {
    test: (msg) => /429|rate[_\s-]?limit|overloaded|529/i.test(msg),
    reason: 'rate_limit',
  },
  // Transport-layer signals.
  {
    test: (msg) => /epipe|econnreset|stdio (closed|hangup)|broken pipe|stream closed/i.test(msg),
    reason: 'transport_error',
  },
  // SDK-internal diagnostic envelope.
  {
    test: (msg) => /ede_diagnostic|claude code returned an error/i.test(msg),
    reason: 'sdk_throw',
  },
]

/**
 * Classify an SDK throw. Returns the matched reason + detail, or
 * `null` for the tool-use-aborted path (not a real failure).
 *
 * @param err - the thrown value (typically Error, but unknown values
 *              are tolerated)
 * @returns the classified failure or null when the error is the
 *          defer-fired Tool-use-aborted sentinel
 */
export function classifyClaudeError(err: unknown): ClassifiedFailure | null {
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
  if (err instanceof Error) {
    return err.message
  }
  if (typeof err === 'string') {
    return err
  }
  if (err === undefined) {
    return 'unknown error (undefined thrown)'
  }
  if (err === null) {
    return 'unknown error (null thrown)'
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
