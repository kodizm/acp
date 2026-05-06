/**
 * kodizm-acp bin entrypoint.
 *
 * Reads `KODIZM_BACKEND` from process.env, resolves the backend driver,
 * and boots the ACP server over stdio. The bin is the only public
 * surface; everything else is internal to the package.
 *
 * Subsequent tasks layer the ACP server (T5+), the Kodizm canonical
 * wire shape (T10+), the backend driver registry (T13+), and the
 * Claude SDK driver (T16+) on top of this entrypoint.
 */

/**
 * Backend identifier accepted at runtime. Phase 1 only ships `claude`;
 * `codex` and `opencode` arrive in phases 2 and 3 and slot in via
 * {@link resolveBackendFromEnv} pattern matching.
 */
export type SupportedBackend = 'claude'

const KNOWN_BACKENDS: ReadonlyArray<SupportedBackend> = ['claude']

/**
 * Thrown when the bin cannot resolve a backend at startup. The message
 * is intentionally explicit so container logs surface the env contract
 * violation without spelunking through stack traces.
 */
export class BackendNotConfiguredError extends Error {
  public override readonly name = 'BackendNotConfiguredError'

  public constructor(detail: string) {
    super(`KODIZM_BACKEND is not set or empty (${detail})`)
  }
}

/**
 * Thrown when `KODIZM_BACKEND` carries a value the registry does not
 * recognize. Phase 1 emits this for every value other than `claude`;
 * later phases extend the allowlist.
 */
export class UnknownBackendError extends Error {
  public override readonly name = 'UnknownBackendError'

  public constructor(value: string) {
    super(`unknown backend: ${value} (known: ${KNOWN_BACKENDS.join(', ')})`)
  }
}

/**
 * Resolve the backend identifier from a captured environment.
 *
 * @param env - mapping of environment variables; pass `process.env` in
 *              production, an inline record in tests
 *
 * @returns the recognized backend identifier
 *
 * @throws {BackendNotConfiguredError} when `KODIZM_BACKEND` is missing
 *                                     or empty
 * @throws {UnknownBackendError}        when `KODIZM_BACKEND` carries an
 *                                      unrecognized value
 */
export function resolveBackendFromEnv(env: Record<string, string | undefined>): SupportedBackend {
  // 1. Reject missing or empty configuration up front.
  const raw = env.KODIZM_BACKEND

  if (raw === undefined || raw === '') {
    throw new BackendNotConfiguredError(`expected one of: ${KNOWN_BACKENDS.join(', ')}`)
  }

  // 2. Reject unknown values; phases 2 and 3 will extend the allowlist.
  if (!KNOWN_BACKENDS.includes(raw as SupportedBackend)) {
    throw new UnknownBackendError(raw)
  }

  return raw as SupportedBackend
}

/**
 * Bin entrypoint side-effect runner. Resolves the backend at startup;
 * later tasks extend this to construct the AcpServer + register the
 * resolved backend driver + attach stdin/stdout streams.
 */
export async function main(): Promise<void> {
  const backend = resolveBackendFromEnv(process.env as Record<string, string | undefined>)

  // 1. Phase 1 placeholder: real boot path lands in T15 (wire AcpServer
  //    to BackendDriver). Until then the bin only validates env and
  //    exits cleanly so the orchestrator's spawn smoke does not hang.
  process.stderr.write(`${JSON.stringify({ level: 'info', message: 'kodizm-acp resolved backend', backend })}\n`)
}

// 1. Top-level execution guard: only run main when invoked as the bin,
//    not when imported by tests.
if (import.meta.main) {
  await main()
}
