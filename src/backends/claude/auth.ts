/**
 * Claude credential resolution.
 *
 * Mirrors the Laravel-side `CliAuthEnvBuilder::buildEnv` dispatch:
 * subscription pool first, api-key fallback. The subscription path
 * stamps `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CODE_REMOTE=1` on the
 * spawn env; the api-key path uses `ANTHROPIC_API_KEY` directly.
 *
 * Both paths are mutually exclusive in practice: when both are set
 * AND `CLAUDE_CODE_REMOTE=1`, subscription wins. Otherwise api-key
 * is used.
 *
 * The Claude SDK reads these env values from process.env on its own;
 * this module exists for the driver's startup logging + audit
 * (`agent_sessions.last_credential_id`).
 */

/**
 * Discriminated credential pair returned by {@link resolveClaudeCredentials}.
 *
 * - `subscription`: OAuth token from the subscription pool, used in
 *   conjunction with `CLAUDE_CODE_REMOTE=1` to flag the SDK that the
 *   request is going through Anthropic's hosted infrastructure.
 * - `api-key`: classic `sk-ant-api03-*` key for the standard API.
 */
export type ClaudeCredentials = { type: 'subscription'; token: string } | { type: 'api-key'; token: string }

/**
 * Thrown when neither credential path is configured. Startup-only;
 * never serialized to the wire (the bin exits non-zero before any
 * ACP frame is processed).
 */
export class AuthMissingError extends Error {
  public override readonly name = 'AuthMissingError'

  public constructor() {
    super(
      'Claude auth missing: set CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_CODE_REMOTE=1 (subscription) or ANTHROPIC_API_KEY (api-key)',
    )
  }
}

/**
 * Resolve the credential pair from a captured environment.
 *
 * Priority:
 *   1. Subscription: `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CODE_REMOTE=1`
 *   2. API key: `ANTHROPIC_API_KEY` (any non-empty value)
 *
 * @param env - mapping of environment variables; pass `process.env`
 *              in production, an inline record in tests
 * @returns the resolved {@link ClaudeCredentials}
 * @throws {AuthMissingError} when neither path is configured
 */
export function resolveClaudeCredentials(env: Record<string, string | undefined>): ClaudeCredentials {
  // 1. Subscription path: OAuth token + remote flag must both be set
  //    AND non-empty. Empty token => fall through to api-key.
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN
  const remoteFlag = env.CLAUDE_CODE_REMOTE
  if (oauthToken !== undefined && oauthToken !== '' && remoteFlag === '1') {
    return { type: 'subscription', token: oauthToken }
  }

  // 2. API key fallback: any non-empty ANTHROPIC_API_KEY value.
  const apiKey = env.ANTHROPIC_API_KEY
  if (apiKey !== undefined && apiKey !== '') {
    return { type: 'api-key', token: apiKey }
  }

  // 3. Neither path: surface the missing-auth error so the bin exits
  //    cleanly with a clear message instead of dying inside the SDK.
  throw new AuthMissingError()
}
