/**
 * Allow-list secret redactor for the debug recorder.
 *
 * Walks any JSON-serializable structure, replaces every match of the
 * known secret regex set with the literal `<REDACTED>` sentinel.
 * Non-string primitives (number, boolean, null, undefined) pass
 * through unchanged. Objects and arrays are recursed into; their
 * containers stay structurally identical.
 *
 * `KODIZM_DEBUG_RAW_SECRETS=1` env disables redaction entirely (an
 * incident-only kill switch for emergency reproduction).
 *
 * Reproducibility note: prompt content (user message text, model
 * output, tool args / results) is intentionally NOT redacted; the
 * orchestrator's debug viewer needs the full trace to mirror a
 * production failure. Only credential-shaped strings are masked.
 */

const REDACTED_LITERAL = '<REDACTED>'

/**
 * Token regex set. Each pattern is global so a single string can
 * carry multiple secrets (e.g., a JSON blob with both `apiKey` and
 * `accessToken`).
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-(api|oat|ort)\d+-[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9_.-]+/g,
  /(api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?[A-Za-z0-9_.-]{16,}["']?/gi,
  /kdz-(int|prj|sess)-[A-Za-z0-9_.-]+/g,
]

/**
 * Optional knobs controlling redaction. Tests pass these inline;
 * production callers default to env-driven behaviour.
 */
export interface RedactOptions {
  /**
   * When true, `redact()` is a no-op pass-through. Used for emergency
   * incident reproduction when raw secrets in the trace are
   * unavoidable.
   */
  rawSecretsMode?: boolean
}

/**
 * Apply allow-list redaction to any JSON-serializable input.
 *
 * @param input - the value to redact (string, object, array, primitive)
 * @param options - optional knobs (see {@link RedactOptions})
 * @returns the value with secrets masked; structure preserved
 */
export function redact(input: unknown, options: RedactOptions = {}): unknown {
  if (options.rawSecretsMode === true) {
    return input
  }

  return walk(input)
}

/**
 * Read `KODIZM_DEBUG_RAW_SECRETS` from the supplied env map and
 * decide whether raw-secrets mode should be active. The exact value
 * `'1'` enables it; anything else (including `'true'`, `'yes'`,
 * unset) keeps redaction on.
 *
 * @param env - typically `process.env`; tests pass an inline record
 */
export function isRawSecretsMode(env: Record<string, string | undefined>): boolean {
  return env.KODIZM_DEBUG_RAW_SECRETS === '1'
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (Array.isArray(value)) {
    return value.map(walk)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walk(v)
    }
    return out
  }
  return value
}

function redactString(str: string): string {
  let out = str
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED_LITERAL)
  }
  return out
}
