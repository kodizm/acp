/**
 * Tool policy of a Live pane: the canonical Kodizm policy JSON translated to the CLI's `permissions` rule strings.
 *
 * The translation keeps every rule enforceable by the CLI: write-side file tools collapse to `Edit` and search-side
 * file tools to `Read` (the CLI accepts path rules on the others but never matches them), and an absolute path gets
 * the `//` anchor the CLI reads as filesystem root. A deny or ask Bash glob stays a glob, the broader match being the
 * safe side. An allow never collapses: a path argument on a tool that is not `Read` or `Edit` is refused, because
 * widening an allow would grant more than the author wrote. The policy's `defaultMode` is ignored: a permission mode
 * is never derived from it.
 */

import { InvalidPatternError, parseCanonicalPattern } from '../wire/policy.ts'
import type { PermissionRules } from './hooks.ts'

type RuleList = keyof PermissionRules

const RULE_LISTS: readonly RuleList[] = ['allow', 'deny', 'ask']

const POLICY_KEYS: readonly string[] = [...RULE_LISTS, 'defaultMode']

/** A Map, not an object: a lookup of `constructor` or `__proto__` must not hit Object.prototype. */
const FILE_TOOLS: ReadonlyMap<string, string> = new Map([
  ['Read', 'Read'],
  ['Edit', 'Edit'],
  ['Write', 'Edit'],
  ['MultiEdit', 'Edit'],
  ['NotebookEdit', 'Edit'],
  ['Glob', 'Read'],
  ['Grep', 'Read'],
])

const TOOL_NAME = /^[A-Z][A-Za-z0-9_]*$/

/**
 * Parse and translate a tool policy. A missing list is empty; every output list is deduped in order.
 *
 * Returns null for anything that is not a full policy: text that is not JSON, a non-object, a key outside
 * allow, deny, ask and defaultMode, a list that is not a string array, or one entry that cannot translate into a rule
 * the CLI enforces as written. An entry is never dropped on its own.
 */
export function parseToolPolicy(text: string): PermissionRules | null {
  const policy = parseJson(text)
  if (!isRecord(policy) || !Object.keys(policy).every((key) => POLICY_KEYS.includes(key))) {
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
    return mcpRule(parsed.mcpPath)
  }

  // 2. Anything but an MCP entry names a tool by a capitalized identifier; a bare `mcp` fails here.
  const { toolName, argPattern } = parsed
  if (!TOOL_NAME.test(toolName)) {
    return null
  }

  // 3. A bare name, or a lone wildcard arg, matches every call of the tool.
  if (argPattern === undefined || argPattern === '*') {
    return toolName
  }

  // 4. File tools carry a path rule under the tool the CLI matches it on; only deny and ask may collapse to it.
  const fileTool = FILE_TOOLS.get(toolName)
  if (fileTool !== undefined && fileTool !== toolName && list === 'allow') {
    return null
  }

  // 5. Build the unescaped content, refuse one the CLI would reject or misread, and escape it into the rule.
  const tool = fileTool ?? toolName
  const content = ruleContent(tool, argPattern, list)

  return isEnforceableContent(tool, content) ? `${tool}(${escapeRuleContent(content)})` : null
}

/**
 * `mcp__server` or `mcp__server__tool`. A wildcard is only meaningful as the whole tool segment: the CLI matches an
 * MCP name literally otherwise, so a wildcard in the server or inside a tool name would deny nothing.
 */
function mcpRule(path: readonly string[]): string | null {
  const wildcardMisplaced = path.some((segment, index) => segment.includes('*') && !(index === 1 && segment === '*'))
  if (path.length > 2 || wildcardMisplaced || path.some((segment) => /[()]/.test(segment))) {
    return null
  }

  return `mcp__${path.join('__')}`
}

function ruleContent(tool: string, argPattern: string, list: RuleList): string {
  if (tool === 'Read' || tool === 'Edit') {
    return anchorPath(argPattern)
  }

  return tool === 'Bash' ? bashArg(argPattern, list) : argPattern
}

/**
 * An absolute path gets a second leading slash; `//x`, `~/x`, `./x` and relative paths stay.
 */
function anchorPath(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') ? `/${path}` : path
}

/**
 * An allow glob with one trailing wildcard and a plain prefix becomes the CLI's `prefix:*` form. Everything else
 * stays a glob: the prefix form matches its prefix literally, so a wildcard inside it would narrow the rule, a
 * prefix ending in whitespace never matches in the prefix form, and a deny or ask rule keeps the broader glob.
 */
function bashArg(argPattern: string, list: RuleList): string {
  const prefix = argPattern.slice(0, -1)
  if (list !== 'allow' || !argPattern.endsWith('*') || prefix.includes('*') || /[:\s]$/.test(prefix)) {
    return argPattern
  }

  return `${prefix}:*`
}

/**
 * The CLI's rule content escaping: backslash first so the escapes added for parentheses are not doubled.
 */
function escapeRuleContent(content: string): string {
  return content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * Local port of the content checks of the CLI's `validatePermissionRule` that can fail for a rule this module builds:
 * the Bash `:*` placement and the file tool `:*` and wildcard placement checks. The CLI drops a failing rule with a
 * warning, so the caller refuses the whole policy instead. `content` is the argument before escaping, which is what
 * the CLI checks once it has unescaped.
 */
function isEnforceableContent(tool: string, content: string): boolean {
  // 1. Bash: `:*` is the legacy prefix form, valid only as the end of a non-empty prefix.
  if (tool === 'Bash') {
    return (!content.includes(':*') || content.endsWith(':*')) && content !== ':*'
  }

  // 2. File tools: no `:*`, and a wildcard sits at a path boundary.
  if (tool === 'Read' || tool === 'Edit') {
    return !content.includes(':*') && (!content.includes('*') || /^\*|\*$|\*\*|\/\*|\*\.|\*\)/.test(content))
  }

  return true
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
