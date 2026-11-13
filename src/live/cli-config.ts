/**
 * The `--cli-config-file` contract of `ctl start`: per-role Claude Code switches a pane launches with. Laravel
 * validates the same shape; this check is the second line, so a role can never reach an auth, ingest, HOME or PATH
 * variable through it. Pure: no I/O, so the daemon and the tests share one definition.
 */

import { TOOL_NAME } from './start-flags.ts'

/**
 * Every env switch a CLI config may set, with the one value it must carry. The only source of both the validation
 * and the env a pane gets: a name or a value outside it refuses the start.
 */
export const CLI_CONFIG_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1',
  CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
  CLAUDE_CODE_DISABLE_WEB_FETCH: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
  DISABLE_AUTOUPDATER: '1',
})

/** What a CLI config changes about the pane. */
export interface PaneCliConfig {
  /** Bare tool names, deduplicated in first-seen order; the daemon appends them to the features' removals. */
  disallowedTools: string[]
  /** Allowlisted switches only, each at its pinned value. */
  env: Record<string, string>
  disableSlashCommands: boolean
}

/**
 * A parsed config, or the refusal. `key` names what was refused (`disallowedTools`, `env.NAME`, an unknown top-level
 * key) and is undefined for content that is no JSON object or a key that is no plain identifier, so a refusal never
 * echoes a value, nor a key that could be one.
 */
export type CliConfigResult = { ok: true; config: PaneCliConfig } | { ok: false; key: string | undefined }

const KNOWN_KEYS: ReadonlySet<string> = new Set(['disallowedTools', 'env', 'disableSlashCommands'])

const REPORTABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/**
 * Validate the content of a `--cli-config-file`. Every key is optional; `{}` changes nothing.
 */
export function parseCliConfig(content: string): CliConfigResult {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return refused(undefined)
  }
  if (!isRecord(json)) {
    return refused(undefined)
  }

  // 1. The key set is closed: a key Laravel learns before this package must fail loudly, not run unenforced.
  const unknown = Object.keys(json).find((key) => !KNOWN_KEYS.has(key))
  if (unknown !== undefined) {
    return refused(reportable(unknown))
  }

  // 2. Bare names only: a scoped rule or a wildcard would keep the tool advertised or remove more than one.
  const tools: unknown = json.disallowedTools ?? []
  if (
    !Array.isArray(tools) ||
    !tools.every((tool): tool is string => typeof tool === 'string' && TOOL_NAME.test(tool))
  ) {
    return refused('disallowedTools')
  }

  // 3. Each switch has to match the allowlist on name and value; the pinned value is what the pane gets.
  const env = json.env ?? {}
  if (!isRecord(env)) {
    return refused('env')
  }
  const switches: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    const pinned = Object.hasOwn(CLI_CONFIG_ENV, name) ? CLI_CONFIG_ENV[name] : undefined
    if (pinned === undefined || value !== pinned) {
      return refused(reportable(name) === undefined ? 'env' : `env.${name}`)
    }
    switches[name] = pinned
  }

  const disableSlashCommands = json.disableSlashCommands ?? false
  if (typeof disableSlashCommands !== 'boolean') {
    return refused('disableSlashCommands')
  }

  return {
    ok: true,
    config: {
      disallowedTools: [...new Set(tools)],
      env: switches,
      disableSlashCommands,
    },
  }
}

function refused(key: string | undefined): CliConfigResult {
  return { ok: false, key }
}

function reportable(key: string): string | undefined {
  return REPORTABLE_KEY.test(key) ? key : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
