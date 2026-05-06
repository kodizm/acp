/**
 * Canonical Kodizm tool-policy pattern grammar.
 *
 * The canonical wire shape (`NewSessionRequest.toolPolicy.{allow,deny,ask}`)
 * is a list of opaque pattern strings. This module is the one parser
 * for those strings; per-backend translators in
 * `src/backends/<name>/policy.ts` consume {@link CanonicalPattern} and
 * produce native CLI rule strings.
 *
 * Grammar:
 *
 *   <ToolName>                       - bare tool name, matches all invocations
 *   <ToolName>:<argPattern>          - pattern against the tool's primary arg
 *   mcp:<server>                     - any MCP tool from that server
 *   mcp:<server>/<tool|*>            - exact tool or wildcard
 *
 * Examples:
 *
 *   Read                  -> { toolName: 'Read' }
 *   Read:/workspace/**    -> { toolName: 'Read', argPattern: '/workspace/**' }
 *   Bash                  -> { toolName: 'Bash' }
 *   Bash:git commit*      -> { toolName: 'Bash', argPattern: 'git commit*' }
 *   mcp:kodizm            -> { toolName: 'mcp', mcpPath: ['kodizm'] }
 *   mcp:kodizm/*          -> { toolName: 'mcp', mcpPath: ['kodizm', '*'] }
 *   mcp:kodizm/foo        -> { toolName: 'mcp', mcpPath: ['kodizm', 'foo'] }
 *
 * The grammar is deliberately close to the SDK's so the translation
 * to Claude is mostly a delimiter swap, but it stays
 * implementation-agnostic so codex / opencode drivers can map to
 * their own native shapes without leaking semantics into the wire.
 */

/**
 * Parsed canonical pattern. One of three shapes:
 * - bare: only `toolName`
 * - arg: `toolName` + `argPattern`
 * - mcp: `toolName === 'mcp'` + `mcpPath` (array of segments)
 */
export interface CanonicalPattern {
  toolName: string
  argPattern?: string
  mcpPath?: string[]
}

/**
 * Thrown when an input string cannot be parsed by
 * {@link parseCanonicalPattern}. The error message names the offending
 * input so callers can surface a useful schema validation message.
 */
export class InvalidPatternError extends Error {
  public constructor(input: string, reason: string) {
    super(`invalid pattern "${input}": ${reason}`)
    this.name = 'InvalidPatternError'
  }
}

/**
 * Parse a canonical pattern string into a {@link CanonicalPattern}.
 *
 * @throws {InvalidPatternError} on malformed input.
 */
export function parseCanonicalPattern(input: string): CanonicalPattern {
  if (input.length === 0) {
    throw new InvalidPatternError(input, 'empty pattern')
  }

  // 1. Split on the first colon. Bare tool name has no colon.
  const colonAt = input.indexOf(':')
  if (colonAt === -1) {
    return { toolName: input }
  }

  const toolName = input.slice(0, colonAt)
  const rest = input.slice(colonAt + 1)

  if (toolName.length === 0) {
    throw new InvalidPatternError(input, 'tool name segment is empty')
  }
  if (rest.length === 0) {
    throw new InvalidPatternError(input, 'arg pattern segment after colon is empty')
  }

  // 2. mcp pattern: split the rest on '/'.
  if (toolName === 'mcp') {
    const segments = rest.split('/')
    if (segments.some((segment) => segment.length === 0)) {
      throw new InvalidPatternError(input, 'mcp path segment is empty')
    }
    return { toolName, mcpPath: segments }
  }

  // 3. Generic tool with arg pattern.
  return { toolName, argPattern: rest }
}

/**
 * Inverse of {@link parseCanonicalPattern}. Useful for normalisation
 * (round-trip a parsed pattern to the canonical form) and for tests.
 */
export function stringifyCanonicalPattern(pattern: CanonicalPattern): string {
  if (pattern.mcpPath !== undefined) {
    return `${pattern.toolName}:${pattern.mcpPath.join('/')}`
  }
  if (pattern.argPattern !== undefined) {
    return `${pattern.toolName}:${pattern.argPattern}`
  }
  return pattern.toolName
}
