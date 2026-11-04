/**
 * Secret redaction for everything a Live pane emits (pane text, hook payloads, transcript lines).
 *
 * Two layers: the exact values the daemon injected into the pane, which it knows, and credential shapes it did not
 * inject but the model may have read from disk or a tool. The pattern literals stay short so the repository secret
 * scan never matches this file.
 */

export const REDACTED = '[REDACTED]'

const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /kgw-[A-Za-z0-9]{8,}/g,
  /sk-ant-[\w-]+/g,
  /kdz-int-jwt\.[\w.-]+/g,
  /-----BEGIN[\s\S]*?(?:-----END[^\n]*?-----|$)/g,
]

// Only the credential is replaced; the scheme and host stay readable.
const URL_CREDENTIAL = /(x-access-token:)[^@\s/]+@/g

/**
 * Replace every injected value and every credential-shaped token with {@link REDACTED}.
 *
 * Known values go first and longest first, so a value that contains a shorter one or a pattern prefix is replaced
 * whole.
 *
 * @param knownValues exact secret values the daemon injected; empty strings are ignored
 */
export function redact(text: string, knownValues: readonly string[]): string {
  const values = knownValues.filter((value) => value !== '').sort((left, right) => right.length - left.length)

  let result = text
  for (const value of values) {
    result = result.replaceAll(value, REDACTED)
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, REDACTED)
  }

  return result.replace(URL_CREDENTIAL, `$1${REDACTED}@`)
}
