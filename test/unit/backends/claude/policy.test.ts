import { describe, expect, test } from 'bun:test'

import { translateToolPolicyToClaude } from '@/backends/claude/policy.ts'

describe('translateToolPolicyToClaude, pattern translation', () => {
  test('bare tool names pass through unchanged', () => {
    const out = translateToolPolicyToClaude({ allow: ['Read', 'Glob', 'Grep'] })
    expect(out.allowedTools).toEqual(['Read', 'Glob', 'Grep'])
  })

  test('arg-pattern tools translate to SDK parens form', () => {
    const out = translateToolPolicyToClaude({
      allow: ['Read:/workspace/**', 'Bash:git commit*', 'Edit:/data/**'],
    })
    expect(out.allowedTools).toEqual(['Read(/workspace/**)', 'Bash(git commit:*)', 'Edit(/data/**)'])
  })

  test('mcp wildcard translates to double-underscore form', () => {
    const out = translateToolPolicyToClaude({
      allow: ['mcp:kodizm/*', 'mcp:kodizm/create_task'],
    })
    expect(out.allowedTools).toEqual(['mcp__kodizm__*', 'mcp__kodizm__create_task'])
  })

  test('mcp server-only translates to bare mcp__server form', () => {
    const out = translateToolPolicyToClaude({ allow: ['mcp:kodizm'] })
    expect(out.allowedTools).toEqual(['mcp__kodizm'])
  })

  test('deny list translates the same way', () => {
    const out = translateToolPolicyToClaude({
      deny: ['Bash:git push*', 'mcp:malicious/*'],
    })
    expect(out.disallowedTools).toEqual(['Bash(git push:*)', 'mcp__malicious__*'])
  })
})

describe('translateToolPolicyToClaude, defaultMode', () => {
  test('defaultMode passes through verbatim', () => {
    const out = translateToolPolicyToClaude({ defaultMode: 'dontAsk' })
    expect(out.permissionMode).toBe('dontAsk')
  })

  test('undefined defaultMode keeps permissionMode undefined', () => {
    const out = translateToolPolicyToClaude({})
    expect(out.permissionMode).toBeUndefined()
  })
})

describe('translateToolPolicyToClaude, plan mode hardening', () => {
  test('plan mode merges AskUserQuestion + ExitPlanMode + Skill into allowedTools', () => {
    const out = translateToolPolicyToClaude({ defaultMode: 'plan', allow: ['Read'] })
    expect(out.permissionMode).toBe('plan')
    expect(out.allowedTools).toContain('Read')
    expect(out.allowedTools).toContain('AskUserQuestion')
    expect(out.allowedTools).toContain('ExitPlanMode')
    expect(out.allowedTools).toContain('Skill')
  })

  test('plan mode without explicit allow still merges the three escape tools', () => {
    const out = translateToolPolicyToClaude({ defaultMode: 'plan' })
    expect(out.allowedTools).toEqual(expect.arrayContaining(['AskUserQuestion', 'ExitPlanMode', 'Skill']))
  })

  test('plan mode does not duplicate when user already allow-listed AskUserQuestion', () => {
    const out = translateToolPolicyToClaude({
      defaultMode: 'plan',
      allow: ['AskUserQuestion', 'Read'],
    })
    const askCount = out.allowedTools?.filter((tool) => tool === 'AskUserQuestion').length
    expect(askCount).toBe(1)
  })

  test('non-plan modes do not auto-merge escape tools', () => {
    const out = translateToolPolicyToClaude({ defaultMode: 'dontAsk', allow: ['Read'] })
    expect(out.allowedTools).toEqual(['Read'])
  })
})

describe('translateToolPolicyToClaude, empty input', () => {
  test('empty policy returns empty SDK options object', () => {
    const out = translateToolPolicyToClaude({})
    expect(out).toEqual({})
  })

  test('only ask list translates without touching allow / deny', () => {
    const out = translateToolPolicyToClaude({ ask: ['Edit'] })
    expect(out.allowedTools).toBeUndefined()
    expect(out.disallowedTools).toBeUndefined()
    expect(out.askRules).toEqual(['Edit'])
  })
})
