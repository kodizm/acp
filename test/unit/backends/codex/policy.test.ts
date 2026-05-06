import { describe, expect, test } from 'bun:test'

import { buildSandboxPolicy, mapPermissionMode } from '@/backends/codex/policy.ts'

describe('mapPermissionMode (canonical -> codex AskForApproval)', () => {
  test("'default' -> 'untrusted' (every tool asks)", () => {
    expect(mapPermissionMode('default')).toBe('untrusted')
  })

  test("'acceptEdits' -> 'on-failure'", () => {
    expect(mapPermissionMode('acceptEdits')).toBe('on-failure')
  })

  test("'plan' -> 'untrusted' (paired with ReadOnly sandbox via buildSandboxPolicy)", () => {
    expect(mapPermissionMode('plan')).toBe('untrusted')
  })

  test("'dontAsk' -> 'on-request'", () => {
    expect(mapPermissionMode('dontAsk')).toBe('on-request')
  })

  test("'bypassPermissions' -> 'never' (Kodizm sandboxed default)", () => {
    expect(mapPermissionMode('bypassPermissions')).toBe('never')
  })
})

describe('buildSandboxPolicy', () => {
  test('default mode -> WorkspaceWrite with cwd in writable_roots, network off', () => {
    const policy = buildSandboxPolicy({
      cwd: '/workspace',
      mode: 'default',
    })
    expect(policy).toEqual({
      mode: 'workspace-write',
      writable_roots: ['/workspace'],
      network_access: false,
    })
  })

  test('plan mode -> ReadOnly with network off', () => {
    const policy = buildSandboxPolicy({ cwd: '/workspace', mode: 'plan' })
    expect(policy).toEqual({
      mode: 'read-only',
      network_access: false,
    })
  })

  test('bypassPermissions -> DangerFullAccess', () => {
    const policy = buildSandboxPolicy({ cwd: '/workspace', mode: 'bypassPermissions' })
    expect(policy).toEqual({ mode: 'danger-full-access' })
  })

  test('additionalDirectories extends writable_roots', () => {
    const policy = buildSandboxPolicy({
      cwd: '/workspace',
      mode: 'acceptEdits',
      additionalDirectories: ['/data/shared', '/mnt/repo'],
    })
    expect(policy).toEqual({
      mode: 'workspace-write',
      writable_roots: ['/workspace', '/data/shared', '/mnt/repo'],
      network_access: false,
    })
  })
})
