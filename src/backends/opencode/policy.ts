/**
 * Canonical -> opencode permission ruleset translator.
 *
 * Phase 3 T4 + locked decision D5/D6. The orchestrator passes a
 * canonical `toolPolicy` (permissionMode + allow/deny/ask string
 * patterns); this module produces opencode's native `Ruleset` shape
 * (`Array<{permission, pattern, action}>`). The shape comes from
 * `references/opencode/packages/opencode/src/permission/index.ts:35`.
 *
 * Native tool IDs are lowercase (`bash`, `edit`, `apply_patch`,
 * `read`, `glob`, `grep`, `webfetch`, `task`, `todowrite`,
 * `plan_exit`, `skill`); canonical wire uses PascalCase. The
 * translator lowercases on the way down. MCP tool keys translate
 * `mcp:<server>` -> `<server>_*` (single underscore, opencode
 * convention, see D6).
 */

import type { z } from 'zod'

import { parseCanonicalPattern } from '../../wire/policy.ts'
import type { ToolPolicySchema } from '../../wire/schemas.ts'

/**
 * Canonical tool-policy alias. Mirrors the driver-deps
 * translator pattern.
 */
export type CanonicalToolPolicy = z.infer<typeof ToolPolicySchema>

/**
 * One opencode permission rule. Mirrors
 * `references/opencode/packages/opencode/src/permission/index.ts::Rule`.
 */
export interface OpencodeRule {
  permission: string
  pattern: string
  action: 'allow' | 'deny' | 'ask'
}

/**
 * Translate a canonical {@link CanonicalToolPolicy} into an opencode
 * ruleset. Order matters: the opencode evaluator uses last-match-wins,
 * so the global default lands first and per-tool overrides append
 * after.
 *
 * @param policy - canonical toolPolicy from the new-session request
 * @returns opencode-native Ruleset, ready for `sdk.session.create({permission})`
 */
export function buildOpencodeRuleset(policy: CanonicalToolPolicy = {}): OpencodeRule[] {
  const rules: OpencodeRule[] = []

  // 1. defaultMode -> global rule(s). 'default' produces nothing
  //    so opencode falls back to its own per-tool ask flow.
  switch (policy.defaultMode) {
    case 'bypassPermissions':
    case 'dontAsk':
      rules.push({ permission: '*', pattern: '*', action: 'allow' })
      break
    case 'acceptEdits':
      rules.push(
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'write', pattern: '*', action: 'allow' },
        { permission: 'apply_patch', pattern: '*', action: 'allow' },
      )
      break
    case 'plan':
      rules.push(
        { permission: '*', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: '*', action: 'allow' },
        { permission: 'grep', pattern: '*', action: 'allow' },
        { permission: 'glob', pattern: '*', action: 'allow' },
        { permission: 'todowrite', pattern: '*', action: 'allow' },
        { permission: 'plan_exit', pattern: '*', action: 'allow' },
        { permission: 'question', pattern: '*', action: 'allow' },
      )
      break
    case 'default':
    case undefined:
      // No global rule.
      break
  }

  // 2. Per-tool overrides. Order: allow -> deny -> ask. Last-match-wins
  //    means a deny on the same key after an allow still effectively
  //    blocks the call.
  for (const raw of policy.allow ?? []) {
    rules.push(translateCanonicalPattern(raw, 'allow'))
  }
  for (const raw of policy.deny ?? []) {
    rules.push(translateCanonicalPattern(raw, 'deny'))
  }
  for (const raw of policy.ask ?? []) {
    rules.push(translateCanonicalPattern(raw, 'ask'))
  }

  return rules
}

/**
 * Translate a single canonical pattern string + action into an
 * {@link OpencodeRule}. Handles the three pattern shapes:
 *
 * - bare tool name: `Bash` -> `{permission: 'bash', pattern: '*'}`
 * - tool + arg: `Bash:rm -rf*` -> `{permission: 'bash', pattern: 'rm -rf*'}`
 * - mcp: `mcp:kodizm` or `mcp:kodizm/foo` -> `{permission: 'kodizm_<tool>'}`
 */
function translateCanonicalPattern(raw: string, action: OpencodeRule['action']): OpencodeRule {
  const parsed = parseCanonicalPattern(raw)

  // 1. MCP path: `mcp:<server>` or `mcp:<server>/<tool|*>`.
  if (parsed.mcpPath !== undefined) {
    const [server = '', tool] = parsed.mcpPath
    const sanitizedServer = sanitizeMcpSegment(server)
    const toolPart = tool === undefined || tool === '*' ? '*' : sanitizeMcpSegment(tool)
    return {
      permission: `${sanitizedServer}_${toolPart}`,
      pattern: '*',
      action,
    }
  }

  // 2. Tool with arg pattern.
  if (parsed.argPattern !== undefined) {
    return {
      permission: parsed.toolName.toLowerCase(),
      pattern: parsed.argPattern,
      action,
    }
  }

  // 3. Bare tool name.
  return {
    permission: parsed.toolName.toLowerCase(),
    pattern: '*',
    action,
  }
}

/**
 * Apply opencode's MCP name sanitization to a single segment. Mirrors
 * `references/opencode/packages/opencode/src/mcp/index.ts:657`.
 */
function sanitizeMcpSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, '_')
}
