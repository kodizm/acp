/**
 * The `ctl start` flag contract (v2): which flags exist, which of them carry a file path the daemon hands off, and the
 * validation of the value-taking extras. Pure: no I/O, so the daemon and the tests share one definition.
 */

import { translateFeaturesToClaude } from '../backends/claude/features.ts'
import { FeaturesSchema } from '../wire/schemas.ts'

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
  'features',
  'permission-mode',
  'one-shot',
  'deadline-seconds',
  'retain-failed-seconds',
])

/**
 * The start flags whose value is an absolute path to a hand-off file the caller wrote for this start.
 */
export const START_FILE_FLAGS: readonly string[] = [
  'env-file',
  'tool-policy',
  'system-prompt-file',
  'mcp-config',
  'features',
]

export type PermissionMode = 'default' | 'dontAsk'

/**
 * What a features file changes about the pane: the CLI's `--tools` set, the bare tool names its `--disallowedTools`
 * removes from the model's context, and the `CLAUDE_CODE_DISABLE_*` switches that go into the pane env.
 */
export interface PaneFeatures {
  tools: string[] | undefined
  disallowedTools: string[]
  env: Record<string, string>
}

// A tool name rides inside one comma-joined argv element, so it may hold neither a comma nor a leading dash.
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * Read the content of a `--features` file: the canonical `features` object of the wire, translated by the same
 * function the SDK sessions use, so one family means the same tools on both transports.
 *
 * `simple` narrows `tools` to web fetch and web search; its settings and strict-MCP effects are what a pane does
 * anyway (an empty `--setting-sources` and `--strict-mcp-config`).
 *
 * @returns `null` for content that is no JSON object, carries an unknown key or a mistyped value, names a tool that
 *   is not a plain identifier, or gives an empty `tools` list (`--tools ""` would switch every built-in tool off).
 */
export function parsePaneFeatures(content: string, permissionMode: PermissionMode | undefined): PaneFeatures | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }

  const parsed = FeaturesSchema.strict().safeParse(json)
  if (!parsed.success) {
    return null
  }
  const names = parsed.data.tools
  if (names !== undefined && (names.length === 0 || !names.every((name) => TOOL_NAME.test(name)))) {
    return null
  }

  const translated = translateFeaturesToClaude(parsed.data, permissionMode)

  return { tools: translated.tools, disallowedTools: translated.disallowedTools, env: translated.env }
}

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
