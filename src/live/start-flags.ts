/**
 * The `ctl start` flag contract (v2): which flags exist, which of them carry a file path the daemon hands off, and the
 * validation of the value-taking extras. Pure: no I/O, so the daemon and the tests share one definition.
 */

/**
 * Every key a `ctl start` request may carry. Anything else is rejected by the caller.
 */
export const START_FLAGS: ReadonlySet<string> = new Set([
  'pane',
  'cwd',
  'settings-base',
  'env-file',
  'model',
  'resume',
  'mcp-config',
  'tool-policy',
  'system-prompt-file',
  'permission-mode',
  'one-shot',
  'deadline-seconds',
  'retain-failed-seconds',
])

/**
 * The start flags whose value is an absolute path to a hand-off file the caller wrote for this start.
 */
export const START_FILE_FLAGS: readonly string[] = ['env-file', 'tool-policy', 'system-prompt-file', 'mcp-config']

export type PermissionMode = 'default' | 'dontAsk'

export interface StartExtras {
  permissionMode: PermissionMode | undefined
  oneShot: boolean
  deadlineSeconds: number | undefined
  retainFailedSeconds: number
}

const MAX_SECONDS = 2147483
const DIGITS = /^[0-9]+$/

/**
 * Validate the start args and read the value-taking extras out of them.
 *
 * Absent optional flags give `undefined`, `false`, `undefined` and `0`. Flags that are plain strings (pane, cwd,
 * model and the file paths) are not checked here; only their key has to be known.
 *
 * @returns `null` when a key is not a start flag or an extra has a bad value: `permission-mode` outside
 *   `default|dontAsk`, `one-shot` outside `0|1`, `deadline-seconds` outside 1..2147483, `retain-failed-seconds`
 *   outside 0..2147483.
 */
export function parseStartExtras(args: Readonly<Record<string, string>>): StartExtras | null {
  for (const key of Object.keys(args)) {
    if (!START_FLAGS.has(key)) {
      return null
    }
  }

  const permissionMode = parsePermissionMode(args['permission-mode'])
  const oneShot = parseOneShot(args['one-shot'])
  const deadlineSeconds = parseSeconds(args['deadline-seconds'], 1)
  const retainFailedSeconds = parseSeconds(args['retain-failed-seconds'], 0)

  if (permissionMode === null || oneShot === null || deadlineSeconds === null || retainFailedSeconds === null) {
    return null
  }

  return {
    permissionMode,
    oneShot,
    deadlineSeconds,
    retainFailedSeconds: retainFailedSeconds ?? 0,
  }
}

function parsePermissionMode(value: string | undefined): PermissionMode | undefined | null {
  if (value === undefined) {
    return undefined
  }

  return value === 'default' || value === 'dontAsk' ? value : null
}

function parseOneShot(value: string | undefined): boolean | null {
  if (value === undefined || value === '0') {
    return false
  }

  return value === '1' ? true : null
}

function parseSeconds(value: string | undefined, min: number): number | undefined | null {
  if (value === undefined) {
    return undefined
  }
  if (!DIGITS.test(value)) {
    return null
  }

  const seconds = Number(value)

  return seconds >= min && seconds <= MAX_SECONDS ? seconds : null
}
