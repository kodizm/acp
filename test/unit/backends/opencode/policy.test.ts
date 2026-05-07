import { describe, expect, test } from 'bun:test'

import { type OpencodeRule, buildOpencodeRuleset } from '@/backends/opencode/policy.ts'

/**
 * Phase 3 Task 4: canonical toolPolicy -> opencode permission Ruleset.
 *
 * Asserts the exact ruleset shape per defaultMode plus per-tool
 * overrides. Order matters (last-match-wins on opencode's evaluator)
 * so the suite pins the array order, not just the elements.
 */
describe('buildOpencodeRuleset', () => {
  test('defaultMode=default produces an empty ruleset (per-tool ask via opencode native flow)', () => {
    const ruleset = buildOpencodeRuleset({ defaultMode: 'default' })
    expect(ruleset).toEqual([])
  })

  test('defaultMode=bypassPermissions allows everything globally', () => {
    const ruleset = buildOpencodeRuleset({ defaultMode: 'bypassPermissions' })
    expect(ruleset).toEqual([{ permission: '*', pattern: '*', action: 'allow' }])
  })

  test('defaultMode=dontAsk is an alias for bypassPermissions (no separate semantics in opencode)', () => {
    const ruleset = buildOpencodeRuleset({ defaultMode: 'dontAsk' })
    expect(ruleset).toEqual([{ permission: '*', pattern: '*', action: 'allow' }])
  })

  test('defaultMode=acceptEdits opens edit/write/apply_patch', () => {
    const ruleset = buildOpencodeRuleset({ defaultMode: 'acceptEdits' })
    expect(ruleset).toEqual([
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'write', pattern: '*', action: 'allow' },
      { permission: 'apply_patch', pattern: '*', action: 'allow' },
    ])
  })

  test('defaultMode=plan denies all but the read-only + plan-exit + question + todowrite tools', () => {
    const ruleset = buildOpencodeRuleset({ defaultMode: 'plan' })
    // 1. Global deny first.
    expect(ruleset[0]).toEqual({ permission: '*', pattern: '*', action: 'deny' })
    // 2. Read-only allow set after the global deny (last-match-wins).
    const allowedTools = ruleset.slice(1).map((r) => r.permission)
    expect(allowedTools).toEqual(['read', 'grep', 'glob', 'todowrite', 'plan_exit', 'question'])
    expect(ruleset.slice(1).every((r) => r.action === 'allow' && r.pattern === '*')).toBe(true)
  })

  test('per-tool allow / deny / ask overrides append after the default rule', () => {
    const ruleset = buildOpencodeRuleset({
      defaultMode: 'bypassPermissions',
      allow: ['Bash', 'Read'],
      deny: ['Bash:rm -rf*'],
      ask: ['mcp:kodizm/dangerous'],
    })

    // 1. Global allow first.
    expect(ruleset[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    // 2. Overrides land after, in allow -> deny -> ask order so deny
    //    wins last over allow for the same tool, then ask refines.
    const tail = ruleset.slice(1)
    expect(tail).toContainEqual({ permission: 'bash', pattern: '*', action: 'allow' })
    expect(tail).toContainEqual({ permission: 'read', pattern: '*', action: 'allow' })
    expect(tail).toContainEqual({ permission: 'bash', pattern: 'rm -rf*', action: 'deny' })
    // mcp pattern translates: 'mcp:kodizm/dangerous' -> permission='kodizm_dangerous'
    expect(tail).toContainEqual({ permission: 'kodizm_dangerous', pattern: '*', action: 'ask' })
  })

  test('PascalCase canonical tool names lowercase to opencode native', () => {
    const ruleset = buildOpencodeRuleset({
      allow: ['Bash:ls*', 'Read:/workspace/**'],
    })
    expect(ruleset).toContainEqual({ permission: 'bash', pattern: 'ls*', action: 'allow' })
    expect(ruleset).toContainEqual({ permission: 'read', pattern: '/workspace/**', action: 'allow' })
  })

  test('mcp:server (no tool path) translates to server-level permission with wildcard pattern', () => {
    const ruleset = buildOpencodeRuleset({
      allow: ['mcp:kodizm'],
    })
    // 'mcp:kodizm' means "any tool from the kodizm server"; translate
    // to a permission key matching the server prefix with wildcard
    // pattern. opencode does not have a per-server gate; we encode
    // it as a wildcard-on-tool permission.
    expect(ruleset).toContainEqual({ permission: 'kodizm_*', pattern: '*', action: 'allow' })
  })

  test('mcp:server/tool wildcard expands correctly', () => {
    const ruleset = buildOpencodeRuleset({
      ask: ['mcp:kodizm/*'],
    })
    expect(ruleset).toContainEqual({ permission: 'kodizm_*', pattern: '*', action: 'ask' })
  })

  test('returned ruleset is a plain array of OpencodeRule objects', () => {
    const ruleset: OpencodeRule[] = buildOpencodeRuleset({ defaultMode: 'bypassPermissions' })
    expect(Array.isArray(ruleset)).toBe(true)
    for (const rule of ruleset) {
      expect(typeof rule.permission).toBe('string')
      expect(typeof rule.pattern).toBe('string')
      expect(['allow', 'deny', 'ask']).toContain(rule.action)
    }
  })
})
