/**
 * Canonical feature switches → Claude SDK options translator.
 *
 * A switched-off family leaves the session through one of two levers,
 * depending on what Claude Code offers for it:
 *
 *   - Tool families go into `disallowedTools` by bare name. The SDK
 *     removes a bare-name entry from the model's context entirely, so
 *     the saving is real prompt tokens, not just a refused call. A
 *     scoped pattern (`Bash(rm *)`) would keep the tool advertised,
 *     which is why nothing here is scoped. Measured on CLI 2.1.280 with a
 *     clean config: the default 26-tool prompt is 45.3k tokens, every
 *     family off 24.7k. The image's settings already deny a few of these,
 *     so the saving inside a container is smaller.
 *   - Behaviour families have no tool to remove and switch off through
 *     `CLAUDE_CODE_DISABLE_*` env instead. `CLAUDE_CODE_DISABLE_CRON`
 *     also removes the Cron tools; the others change behaviour only.
 *
 * `simple` replaces the base built-in set with web fetch + web search
 * and turns filesystem settings off. The image's user settings deny
 * both web tools and hook them to a refusal for every other role, so a
 * simple session has to skip those settings to use them at all. Their
 * env block goes with them, including ENABLE_CLAUDEAI_MCP_SERVERS=false,
 * so simple mode also sets strict MCP config: the session gets the MCP
 * servers on the wire and no account connector. With the base set down
 * to two tools, the per-family removals have nothing left to act on and
 * are dropped.
 *
 * Tool names are the ones CLI 2.1.280 advertises in `system/init`; the
 * SDK's own `sdk-tools.d.ts` lags the CLI and is not the source.
 */

import type { z } from 'zod'

import type { FeaturesSchema } from '../../wire/schemas.ts'

export type KodizmFeatures = z.infer<typeof FeaturesSchema>

type ToolFamily = Exclude<keyof KodizmFeatures, 'autoMemory' | 'bundledSkills' | 'simple'>

/**
 * Subset of Claude SDK `Options` the translator emits. The driver
 * merges `disallowedTools` with the tool policy's own deny list and
 * `env` over `process.env`.
 */
export interface ClaudeSdkFeatureOptions {
  disallowedTools: string[]
  env: Record<string, string>
  tools?: string[]
  settingSources?: []
  strictMcpConfig?: true
}

const FAMILY_TOOLS: Record<ToolFamily, readonly string[]> = {
  todos: ['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'],
  subagents: ['Agent', 'Task', 'SendMessage', 'ListAgents'],
  scheduling: ['Monitor', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger'],
  backgroundTasks: ['TaskStop'],
  planMode: ['EnterPlanMode', 'ExitPlanMode'],
  worktree: ['EnterWorktree', 'ExitWorktree'],
  notebook: ['NotebookEdit'],
  // Surfaces of the interactive product a headless session has no use for.
  clientTools: ['DesignSync', 'PushNotification', 'ShareOnboardingGuide', 'ReportFindings'],
}

const FAMILY_ENV: Partial<Record<keyof KodizmFeatures, string>> = {
  scheduling: 'CLAUDE_CODE_DISABLE_CRON',
  backgroundTasks: 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  autoMemory: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  bundledSkills: 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS',
}

const SIMPLE_MODE_TOOLS = ['WebFetch', 'WebSearch'] as const

/**
 * Translate canonical feature switches to Claude SDK options. Only an
 * explicit `false` switches a family off.
 *
 * @param permissionMode The session's effective permission mode. A
 *   session running in `plan` keeps `ExitPlanMode` even with plan mode
 *   switched off, since it is the model's only way out of that mode.
 */
export function translateFeaturesToClaude(
  features: KodizmFeatures | undefined,
  permissionMode: string | undefined,
): ClaudeSdkFeatureOptions {
  const out: ClaudeSdkFeatureOptions = { disallowedTools: [], env: {} }

  if (features === undefined) {
    return out
  }

  for (const [family, envName] of Object.entries(FAMILY_ENV)) {
    if (features[family as keyof KodizmFeatures] === false && envName !== undefined) {
      out.env[envName] = '1'
    }
  }

  if (features.simple === true) {
    out.tools = [...SIMPLE_MODE_TOOLS]
    out.settingSources = []
    out.strictMcpConfig = true

    return out
  }

  for (const [family, tools] of Object.entries(FAMILY_TOOLS)) {
    if (features[family as ToolFamily] !== false) {
      continue
    }
    for (const tool of tools) {
      if (tool === 'ExitPlanMode' && permissionMode === 'plan') {
        continue
      }
      out.disallowedTools.push(tool)
    }
  }

  return out
}
