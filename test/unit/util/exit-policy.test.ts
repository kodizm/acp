import { describe, expect, test } from 'bun:test'

import { shouldExitOnReason } from '@/util/exit-policy.ts'

describe('shouldExitOnReason', () => {
  test('sdk_stall -> exit (container cannot recover from a hung SDK)', () => {
    expect(shouldExitOnReason('sdk_stall')).toBe(true)
  })

  test('transport_error -> exit (stdio is dead)', () => {
    expect(shouldExitOnReason('transport_error')).toBe(true)
  })

  test('internal_panic -> exit (bridge-side bug)', () => {
    expect(shouldExitOnReason('internal_panic')).toBe(true)
  })

  test('protocol_violation -> exit (wire is corrupted)', () => {
    expect(shouldExitOnReason('protocol_violation')).toBe(true)
  })

  test('sdk_throw -> stay alive (transient; orchestrator may retry)', () => {
    expect(shouldExitOnReason('sdk_throw')).toBe(false)
  })

  test('auth_error -> stay alive (orchestrator can refresh credentials)', () => {
    expect(shouldExitOnReason('auth_error')).toBe(false)
  })

  test('rate_limit -> stay alive (transient; orchestrator backs off + retries)', () => {
    expect(shouldExitOnReason('rate_limit')).toBe(false)
  })
})
