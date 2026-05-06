/**
 * Canonical Kodizm tool-policy → Claude SDK options translator.
 *
 * The orchestrator emits canonical pattern strings via
 * {@link KodizmToolPolicy}; this module is the one place that maps
 * them to the SDK's `allowedTools` / `disallowedTools` /
 * `permissionMode` shape. Pattern grammar lives in `src/wire/policy.ts`
 * and is shared across drivers; only the SDK-specific output shape
 * lives here.
 *
 * Translation table:
 *
 *   Read                       -> Read
 *   Read:/workspace/**         -> Read(/workspace/**)
 *   Bash:git commit*           -> Bash(git commit:*)
 *   mcp:kodizm                 -> mcp__kodizm
 *   mcp:kodizm/*               -> mcp__kodizm__*
 *   mcp:kodizm/create_task     -> mcp__kodizm__create_task
 *
 * Plan-mode hardening: when `defaultMode === 'plan'`, the driver
 * opportunistically merges `AskUserQuestion`, `ExitPlanMode`, and
 * `Skill` into `allowedTools` so the model can clarify, exit plan
 * mode, and load skills even when the orchestrator's allow-list is
 * empty. User entries are preserved + de-duplicated.
 */

import type { z } from 'zod'

import { parseCanonicalPattern } from '../../wire/policy.ts'
import type { ToolPolicySchema } from '../../wire/schemas.ts'

/**
 * Canonical Kodizm tool policy. Inferred from the wire schema so the
 * shape stays in sync with `NewSessionRequest.toolPolicy`.
 */
export type KodizmToolPolicy = z.infer<typeof ToolPolicySchema>

/**
 * Subset of Claude SDK `Options` the translator emits. Only the four
 * gate-shaped fields; the rest of the SDK options stay caller-built.
 */
export interface ClaudeSdkPolicyOptions {
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: KodizmToolPolicy['defaultMode']
  /**
   * Canonical-shaped ask list. The driver layers this into the SDK's
   * permission-rule machinery as session-scope `addRules` updates;
   * keeping the canonical strings here defers SDK-specific ask
   * encoding to the call site.
   */
  askRules?: string[]
}

const PLAN_MODE_ESCAPE_TOOLS = ['AskUserQuestion', 'ExitPlanMode', 'Skill'] as const

/**
 * Translate one canonical pattern to its Claude SDK equivalent.
 *
 * @throws {InvalidPatternError} when the input is malformed (raised
 *   by {@link parseCanonicalPattern}; surfaces to the caller).
 */
function translatePatternToClaude(pattern: string): string {
  const parsed = parseCanonicalPattern(pattern)

  // 1. mcp:server[/tool] -> mcp__server[__tool]
  if (parsed.toolName === 'mcp' && parsed.mcpPath !== undefined) {
    return `mcp__${parsed.mcpPath.join('__')}`
  }

  // 2. ToolName:argPattern -> ToolName(argPattern with `:*` suffix
  //    when the pattern matches Bash subcommand wildcard convention)
  if (parsed.argPattern !== undefined) {
    const argPattern = normaliseArgPattern(parsed.toolName, parsed.argPattern)
    return `${parsed.toolName}(${argPattern})`
  }

  // 3. Bare tool name passes through.
  return parsed.toolName
}

/**
 * Bash-specific arg pattern normalisation: trailing `*` becomes `:*`
 * (the SDK's preferred Bash subcommand wildcard form). Other tools
 * keep the wildcard verbatim.
 *
 * Example: `Bash:git commit*` -> `Bash(git commit:*)`.
 */
function normaliseArgPattern(toolName: string, argPattern: string): string {
  if (toolName !== 'Bash') {
    return argPattern
  }
  if (argPattern.endsWith('*') && !argPattern.endsWith(':*')) {
    return `${argPattern.slice(0, -1)}:*`
  }
  return argPattern
}

/**
 * Translate a canonical Kodizm tool policy to the matching Claude SDK
 * options subset. Empty inputs return an empty object so the driver
 * can spread the result without affecting other options.
 */
export function translateToolPolicyToClaude(policy: KodizmToolPolicy): ClaudeSdkPolicyOptions {
  const out: ClaudeSdkPolicyOptions = {}

  if (policy.allow !== undefined && policy.allow.length > 0) {
    out.allowedTools = policy.allow.map(translatePatternToClaude)
  }
  if (policy.deny !== undefined && policy.deny.length > 0) {
    out.disallowedTools = policy.deny.map(translatePatternToClaude)
  }
  if (policy.ask !== undefined && policy.ask.length > 0) {
    out.askRules = [...policy.ask]
  }
  if (policy.defaultMode !== undefined) {
    out.permissionMode = policy.defaultMode
  }

  // Plan-mode escape: merge AskUserQuestion / ExitPlanMode / Skill
  // into allowedTools so the model can clarify + exit + load skills
  // even when the orchestrator's allow-list is empty. De-dup to keep
  // user entries unique.
  if (policy.defaultMode === 'plan') {
    const merged = [...(out.allowedTools ?? [])]
    for (const escapeTool of PLAN_MODE_ESCAPE_TOOLS) {
      if (!merged.includes(escapeTool)) {
        merged.push(escapeTool)
      }
    }
    out.allowedTools = merged
  }

  return out
}
