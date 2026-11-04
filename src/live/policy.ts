/**
 * Tool policy of a Live pane: the canonical Kodizm policy JSON translated to the CLI's `permissions` rule strings.
 *
 * The translation keeps every rule enforceable by the CLI: write-side file tools collapse to `Edit` and search-side
 * file tools to `Read` (the CLI accepts path rules on the others but never matches them), and an absolute path gets
 * the `//` anchor the CLI reads as filesystem root. A deny or ask Bash glob stays a glob, the broader match being the
 * safe side. The policy's `defaultMode` is ignored: a permission mode is never derived from it.
 */

import { InvalidPatternError, parseCanonicalPattern } from '../wire/policy.ts'
import type { PermissionRules } from './hooks.ts'

type RuleList = keyof PermissionRules

const RULE_LISTS: readonly RuleList[] = ['allow', 'deny', 'ask']

const FILE_TOOLS: Readonly<Record<string, string>> = {
  Read: 'Read',
  Edit: 'Edit',
  Write: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  Glob: 'Read',
  Grep: 'Read',
}

/**
 * Parse and translate a tool policy. A missing list is empty; every output list is deduped in order.
 *
 * Returns null for anything that is not a full policy: text that is not JSON, a non-object, a list that is not a
 * string array, or one entry that cannot translate. An entry is never dropped on its own.
 */
export function parseToolPolicy(text: string): PermissionRules | null {
  const policy = parseJson(text)
  if (!isRecord(policy)) {
    return null
  }

  const rules: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  }
  for (const list of RULE_LISTS) {
    const entries = policy[list] === undefined ? [] : policy[list]
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
      return null
    }

    for (const entry of entries) {
      const rule = translatePattern(entry, list)
      if (rule === null) {
        return null
      }
      if (!rules[list].includes(rule)) {
        rules[list].push(rule)
      }
    }
  }

  return rules
}

/**
 * One canonical pattern as a CLI rule string, or null when the pattern does not parse or cannot translate.
 */
function translatePattern(pattern: string, list: RuleList): string | null {
  let parsed: ReturnType<typeof parseCanonicalPattern>
  try {
    parsed = parseCanonicalPattern(pattern)
  } catch (error) {
    if (error instanceof InvalidPatternError) {
      return null
    }
    throw error
  }

  // 1. mcp:server[/tool] becomes mcp__server[__tool].
  if (parsed.mcpPath !== undefined) {
    return `mcp__${parsed.mcpPath.join('__')}`
  }

  // 2. A bare name, or a lone wildcard arg, matches every call of the tool.
  const { toolName, argPattern } = parsed
  if (argPattern === undefined || argPattern === '*') {
    return toolName
  }

  // 3. File tools carry a path rule under the tool the CLI matches it on.
  const fileTool = FILE_TOOLS[toolName]
  if (fileTool !== undefined) {
    return argPattern.includes(':*') ? null : `${fileTool}(${anchorPath(argPattern)})`
  }

  return toolName === 'Bash' ? `Bash(${bashArg(argPattern, list)})` : `${toolName}(${argPattern})`
}

/**
 * An absolute path gets a second leading slash; `//x`, `~/x`, `./x` and relative paths stay.
 */
function anchorPath(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') ? `/${path}` : path
}

/**
 * An allow glob with one trailing wildcard and a plain prefix becomes the CLI's `prefix:*` form. Everything else
 * stays a glob: the prefix form matches its prefix literally, so a wildcard inside it would narrow the rule, and a
 * deny or ask rule keeps the broader glob.
 */
function bashArg(argPattern: string, list: RuleList): string {
  const prefix = argPattern.slice(0, -1)
  if (list !== 'allow' || !argPattern.endsWith('*') || prefix.includes('*') || prefix.endsWith(':')) {
    return argPattern
  }

  return `${prefix}:*`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
