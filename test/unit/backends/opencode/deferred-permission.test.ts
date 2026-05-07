import { describe, expect, mock, test } from 'bun:test'

import { DEFERRED_MARKER, writeDeferredSentinel } from '@/backends/opencode/deferred-permission.ts'

/**
 * Phase 3 Task 15: opencode-side Pattern B injection.
 *
 * The handler appends a synthetic tool_result row to the opencode
 * session via `sdk.session.message.append` (or the equivalent v2
 * endpoint) so the model loop sees a deferred-marker reply on the
 * next prompt resume.
 */
describe('writeDeferredSentinel', () => {
  test('calls sdk message append with the deferred marker payload', async () => {
    const append = mock(async () => ({}))
    const sdk = {
      experimental: {
        session: {
          message: { append },
        },
      },
      session: {
        message: { append },
      },
    }

    await writeDeferredSentinel({
      sdk: sdk as unknown as Parameters<typeof writeDeferredSentinel>[0]['sdk'],
      opencodeSessionId: 'ses-1',
      requestId: 'perm-1',
      toolName: 'bash',
    })

    expect(append).toHaveBeenCalled()
    const call = (append.mock.calls[0] ?? []) as unknown[]
    const body = JSON.stringify(call[0])
    expect(body).toContain(DEFERRED_MARKER)
    expect(body).toContain('perm-1')
  })

  test('append failure swallows silently (best-effort sentinel write)', async () => {
    const append = mock(async () => {
      throw new Error('opencode unreachable')
    })
    const sdk = {
      experimental: { session: { message: { append } } },
      session: { message: { append } },
    }

    await expect(
      writeDeferredSentinel({
        sdk: sdk as unknown as Parameters<typeof writeDeferredSentinel>[0]['sdk'],
        opencodeSessionId: 'ses-1',
        requestId: 'perm-2',
        toolName: 'bash',
      }),
    ).resolves.toBeUndefined()
  })
})
