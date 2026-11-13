/**
 * The `ctl start` flag contract (v2): which flags exist, which of them carry a file path the daemon hands off, and the
 * validation of the value-taking extras. Pure: no I/O, so the daemon and the tests share one definition.
 */

import { translateFeaturesToClaude } from '../backends/claude/features.ts'
import { FeaturesSchema, PluginPathSchema } from '../wire/schemas.ts'

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
  'plugin-dir',
  'setting-sources',
  'prompt-mode',
  'agent',
  'cli-config-file',
])

/**
 * The start flags whose value is an absolute path to a hand-off file the caller wrote for this start. `plugin-dir` is
 * not one: it names a plugin directory the caller manages, which a start must never unlink.
 */
export const START_FILE_FLAGS: readonly string[] = [
  'env-file',
  'tool-policy',
  'system-prompt-file',
  'mcp-config',
  'features',
  'cli-config-file',
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

/** A tool name rides inside one comma-joined argv element, so it may hold neither a comma nor a leading dash. */
export const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * Read the content of a `--features` file: the canonical `features` object of the wire, translated by the same
 * function the SDK sessions use, so one family means the same tools on both transports.
 *
 * An unknown key is ignored, as the SDK path ignores it: a family Laravel learns before this package must not stop
 * every automated pane from starting.
 *
 * `simple` is refused. The SDK reaches web fetch and web search in that mode by skipping the settings files, whose
 * base deny list blocks both tools; a pane always runs on its settings file, so the same narrowing would leave it no
 * usable built-in tool.
 *
 * @returns `null` for content that is no JSON object, has a mistyped value, sets `simple`, names a tool that is not a
 *   plain identifier, or gives an empty `tools` list (`--tools ""` would switch every built-in tool off).
 */
export function parsePaneFeatures(content: string, permissionMode: PermissionMode | undefined): PaneFeatures | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }

  const parsed = FeaturesSchema.safeParse(json)
  if (!parsed.success || parsed.data.simple === true) {
    return null
  }
  const names = parsed.data.tools
  if (names !== undefined && (names.length === 0 || !names.every((name) => TOOL_NAME.test(name)))) {
    return null
  }

  const translated = translateFeaturesToClaude(parsed.data, permissionMode)

  return { tools: translated.tools, disallowedTools: translated.disallowedTools, env: translated.env }
}

/** The one settings source a pane may load besides its `--settings` file; absent means none. */
export type SettingSource = 'project'

/**
 * How the role text reaches the CLI: appended to its default prompt (`--append-system-prompt-file`), replacing it
 * (`--system-prompt-file`), or as the body of a plugin agent the main session runs as (`--agent`).
 */
export type PromptMode = 'append' | 'system' | 'agent'

export interface StartExtras {
  permissionMode: PermissionMode | undefined
  oneShot: boolean
  deadlineSeconds: number | undefined
  retainFailedSeconds: number
  /** A plugin directory strictly under `/opt/kodizm/plugins/` with no `..` segment. */
  pluginDir: string | undefined
  settingSources: SettingSource | undefined
  promptMode: PromptMode
  /** The `<plugin>:<agent>` the main session runs as; set exactly when `promptMode` is `agent`. */
  agent: string | undefined
}

const MAX_SECONDS = 2147483
const DIGITS = /^[0-9]+$/

// The CLI takes the name as one argv element; a leading dash would read as an option.
const AGENT_NAME = /^(?!-)[A-Za-z0-9_.:-]{1,80}$/

/**
 * Validate the start args and read the value-taking extras out of them.
 *
 * Absent optional flags give `undefined`, `false`, `undefined`, `0`, `undefined`, `undefined`, `append` and
 * `undefined`. Flags that are plain strings (pane, cwd, model and the file paths) are not checked here; only their key
 * has to be known.
 *
 * @returns `null` when a key is not a start flag or an extra has a bad value: `permission-mode` outside
 *   `default|dontAsk`, `one-shot` outside `0|1`, `deadline-seconds` outside 1..2147483, `retain-failed-seconds`
 *   outside 0..2147483, `plugin-dir` not strictly under the plugin root or holding a `..` segment, `setting-sources`
 *   other than `project`, `prompt-mode` outside `append|system|agent`, an `agent` name outside the pattern, an
 *   `agent` without `prompt-mode agent`, or an agent mode missing `agent` or `plugin-dir` or carrying a
 *   `system-prompt-file`.
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
  const pluginDir = parsePluginDir(args['plugin-dir'])
  const settingSources = parseSettingSources(args['setting-sources'])
  const promptMode = parsePromptMode(args['prompt-mode'])
  const agent = args.agent

  if (
    permissionMode === null ||
    oneShot === null ||
    deadlineSeconds === null ||
    retainFailedSeconds === null ||
    pluginDir === null ||
    settingSources === null ||
    promptMode === null ||
    !agentFits(promptMode, agent, pluginDir, args['system-prompt-file'])
  ) {
    return null
  }

  return {
    permissionMode,
    oneShot,
    deadlineSeconds,
    retainFailedSeconds: retainFailedSeconds ?? 0,
    pluginDir,
    settingSources,
    promptMode,
    agent,
  }
}

function parsePromptMode(value: string | undefined): PromptMode | null {
  if (value === undefined) {
    return 'append'
  }

  return value === 'append' || value === 'system' || value === 'agent' ? value : null
}

// An agent is looked up in a `--plugin-dir` plugin, and its body is the whole prompt: a prompt file beside it would be
// a second prompt the role never meant to send.
function agentFits(
  mode: PromptMode,
  agent: string | undefined,
  pluginDir: string | undefined,
  systemPromptFile: string | undefined,
): boolean {
  if (mode !== 'agent') {
    return agent === undefined
  }

  return agent !== undefined && AGENT_NAME.test(agent) && pluginDir !== undefined && systemPromptFile === undefined
}

// The same confinement the session wire applies to `plugins`, so both transports load code from one root only.
function parsePluginDir(value: string | undefined): string | undefined | null {
  if (value === undefined) {
    return undefined
  }

  return PluginPathSchema.safeParse(value).success ? value : null
}

function parseSettingSources(value: string | undefined): SettingSource | undefined | null {
  if (value === undefined) {
    return undefined
  }

  return value === 'project' ? value : null
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
