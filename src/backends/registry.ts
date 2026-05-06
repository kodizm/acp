/**
 * Backend registry: env-driven driver resolution.
 *
 * The bin reads `KODIZM_BACKEND` from process.env at startup and
 * resolves the matching {@link BackendDriver} through this registry.
 * Phase 1 only registers `claude`; phases 2 and 3 add `codex` and
 * `opencode` by extending the registry from the relevant boot module.
 *
 * The registry is intentionally small: a name -> driver map, plus
 * env-aware resolution that surfaces the canonical
 * {@link BackendNotConfiguredError} / {@link UnknownBackendError}
 * pair so callers branch on type, not string parsing.
 */

import { BackendNotConfiguredError, UnknownBackendError } from '../server/errors.ts'
import type { BackendDriver } from './driver.ts'

/**
 * The registry's public surface.
 */
export interface BackendRegistry {
  /**
   * Bind a backend identifier to a driver instance. Overwrites any
   * prior binding under the same name silently; the registry is
   * single-tenant per name by design.
   */
  register(name: string, driver: BackendDriver): void

  /**
   * Look up a driver by exact name. Throws when the name is not
   * registered.
   *
   * @throws {UnknownBackendError} when no driver is bound to `name`
   */
  resolve(name: string): BackendDriver

  /**
   * Resolve the driver from an environment record. Reads the
   * `KODIZM_BACKEND` value, then dispatches through {@link resolve}.
   *
   * @throws {BackendNotConfiguredError} when `KODIZM_BACKEND` is
   *                                     missing or empty
   * @throws {UnknownBackendError}        when `KODIZM_BACKEND` carries
   *                                      a value not in the registry
   */
  resolveFromEnv(env: Record<string, string | undefined>): BackendDriver

  /**
   * List every registered backend name. Useful for UnknownBackendError's
   * supported-list payload + diagnostics.
   */
  registered(): ReadonlyArray<string>
}

/**
 * Build a fresh registry. Each registry is independent; tests build
 * their own so concurrent runs do not leak driver bindings.
 */
export function createBackendRegistry(): BackendRegistry {
  const drivers = new Map<string, BackendDriver>()

  const registered = (): ReadonlyArray<string> => Array.from(drivers.keys())

  const resolve = (name: string): BackendDriver => {
    const driver = drivers.get(name)
    if (driver === undefined) {
      throw new UnknownBackendError(name, registered())
    }
    return driver
  }

  return {
    register(name: string, driver: BackendDriver): void {
      drivers.set(name, driver)
    },

    resolve,

    resolveFromEnv(env: Record<string, string | undefined>): BackendDriver {
      // 1. Env contract: KODIZM_BACKEND must be present and non-empty.
      const raw = env.KODIZM_BACKEND
      if (raw === undefined || raw === '') {
        throw new BackendNotConfiguredError(`expected one of: ${registered().join(', ') || '(no drivers registered)'}`)
      }

      // 2. Look up by exact name; UnknownBackendError surfaces when
      //    the value does not match any bound driver.
      return resolve(raw)
    },

    registered,
  }
}
