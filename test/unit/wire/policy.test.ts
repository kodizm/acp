import { describe, expect, test } from 'bun:test'

import { InvalidPatternError, parseCanonicalPattern, stringifyCanonicalPattern } from '@/wire/policy.ts'

describe('parseCanonicalPattern, plain tool names', () => {
  test('Read parses to bare tool name with no arg pattern', () => {
    expect(parseCanonicalPattern('Read')).toEqual({ toolName: 'Read' })
  })

  test('Bash parses bare', () => {
    expect(parseCanonicalPattern('Bash')).toEqual({ toolName: 'Bash' })
  })
})

describe('parseCanonicalPattern, arg patterns', () => {
  test('Read:/workspace/** carries the path glob as argPattern', () => {
    expect(parseCanonicalPattern('Read:/workspace/**')).toEqual({
      toolName: 'Read',
      argPattern: '/workspace/**',
    })
  })

  test('Bash:git commit* keeps the inner space (one wildcard spans args)', () => {
    expect(parseCanonicalPattern('Bash:git commit*')).toEqual({
      toolName: 'Bash',
      argPattern: 'git commit*',
    })
  })

  test('Edit:/data/private/** parses correctly', () => {
    expect(parseCanonicalPattern('Edit:/data/private/**')).toEqual({
      toolName: 'Edit',
      argPattern: '/data/private/**',
    })
  })
})

describe('parseCanonicalPattern, mcp paths', () => {
  test('mcp:kodizm/* parses as wildcard MCP server filter', () => {
    expect(parseCanonicalPattern('mcp:kodizm/*')).toEqual({
      toolName: 'mcp',
      mcpPath: ['kodizm', '*'],
    })
  })

  test('mcp:kodizm/create_task parses as exact MCP tool', () => {
    expect(parseCanonicalPattern('mcp:kodizm/create_task')).toEqual({
      toolName: 'mcp',
      mcpPath: ['kodizm', 'create_task'],
    })
  })

  test('mcp:kodizm parses as server-only (no tool segment)', () => {
    expect(parseCanonicalPattern('mcp:kodizm')).toEqual({
      toolName: 'mcp',
      mcpPath: ['kodizm'],
    })
  })
})

describe('parseCanonicalPattern, malformed inputs', () => {
  test('empty string throws InvalidPatternError', () => {
    expect(() => parseCanonicalPattern('')).toThrow(InvalidPatternError)
  })

  test('lone colon throws', () => {
    expect(() => parseCanonicalPattern(':')).toThrow(InvalidPatternError)
  })

  test('colon with empty toolName throws', () => {
    expect(() => parseCanonicalPattern(':something')).toThrow(InvalidPatternError)
  })

  test('toolName with empty arg pattern throws', () => {
    expect(() => parseCanonicalPattern('Read:')).toThrow(InvalidPatternError)
  })
})

describe('stringifyCanonicalPattern, round-trip', () => {
  test('plain tool name', () => {
    expect(stringifyCanonicalPattern({ toolName: 'Read' })).toBe('Read')
  })

  test('arg pattern', () => {
    expect(stringifyCanonicalPattern({ toolName: 'Bash', argPattern: 'git commit*' })).toBe('Bash:git commit*')
  })

  test('mcp wildcard', () => {
    expect(stringifyCanonicalPattern({ toolName: 'mcp', mcpPath: ['kodizm', '*'] })).toBe('mcp:kodizm/*')
  })

  test('mcp server-only', () => {
    expect(stringifyCanonicalPattern({ toolName: 'mcp', mcpPath: ['kodizm'] })).toBe('mcp:kodizm')
  })

  test('parse + stringify is identity for every documented form', () => {
    const inputs = [
      'Read',
      'Bash',
      'Read:/workspace/**',
      'Bash:git commit*',
      'mcp:kodizm',
      'mcp:kodizm/*',
      'mcp:kodizm/create_task',
    ]
    for (const input of inputs) {
      expect(stringifyCanonicalPattern(parseCanonicalPattern(input))).toBe(input)
    }
  })
})
