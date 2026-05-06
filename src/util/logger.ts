/**
 * Structured stderr-only logger.
 *
 * Stdout is reserved for the ACP wire (NDJSON JSON-RPC frames). A single
 * accidental write to stdout would garble the protocol stream and break
 * the orchestrator's frame parser. This module guarantees stderr-only
 * output even at the lowest level.
 *
 * Lines are JSON objects with a stable shape:
 *   { level, message, timestamp, ...meta }
 *
 * Level filtering reads `KODIZM_LOG_LEVEL` from env at construction
 * time. Default is `info`.
 */

/**
 * Severity ordinals. Higher number = louder. Filter rule: emit when
 * `LEVEL_ORDER[entry.level] >= LEVEL_ORDER[configuredLevel]`.
 */
const LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const

/**
 * Allowed level identifiers; exported so callers can type their own
 * config without re-deriving it.
 */
export type LogLevel = keyof typeof LEVEL_ORDER

/**
 * Free-form metadata attached to a log entry. Values must be
 * JSON-serializable; the logger does not coerce or sanitize.
 */
export type LogMeta = Record<string, unknown>

/**
 * The runtime logger contract. Each level method appends an NDJSON
 * line to stderr when its severity passes the configured threshold.
 */
export interface Logger {
  debug(message: string, meta?: LogMeta): void
  info(message: string, meta?: LogMeta): void
  warn(message: string, meta?: LogMeta): void
  error(message: string, meta?: LogMeta): void
}

/**
 * Logger factory dependencies. Pass `process.env` in production; pass
 * an inline record in tests so level filtering stays deterministic.
 */
export interface LoggerOptions {
  env: Record<string, string | undefined>
}

/**
 * Build a logger bound to the given environment. The threshold is
 * resolved once at construction; callers needing dynamic threshold
 * updates should rebuild the logger.
 *
 * @param options - environment + optional dependencies
 * @returns a {@link Logger} bound to the resolved threshold
 */
export function createLogger(options: LoggerOptions): Logger {
  // 1. Resolve the configured threshold; fall back to `info` when the
  //    env value is missing or unrecognized.
  const raw = options.env.KODIZM_LOG_LEVEL
  const configured: LogLevel = raw && raw in LEVEL_ORDER ? (raw as LogLevel) : 'info'
  const threshold = LEVEL_ORDER[configured]

  // 2. Single emit primitive: format + filter + stderr write. Each
  //    level method delegates here so the no-stdout invariant is held
  //    in exactly one place.
  const emit = (level: LogLevel, message: string, meta?: LogMeta): void => {
    if (LEVEL_ORDER[level] < threshold) {
      return
    }

    const line = JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(meta ?? {}),
    })

    process.stderr.write(`${line}\n`)
  }

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  }
}
