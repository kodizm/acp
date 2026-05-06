import { describe, expect, test } from 'bun:test'

import type { DeferredState } from '@/session/deferred-store.ts'
import { InMemoryDeferredStore } from '@/session/deferred-store.ts'

const sampleState = (): DeferredState => ({
  toolUseId: 'tu_1',
  toolName: 'Bash',
  rawInput: { command: 'pwd' },
  deferredAt: 1_700_000_000_000,
})

describe('InMemoryDeferredStore', () => {
  test('set + get roundtrips a deferred state by sessionId', async () => {
    const store = new InMemoryDeferredStore()
    const state = sampleState()
    await store.set('s1', state)

    const result = await store.get('s1')
    expect(result).toEqual(state)
  })

  test('get returns null when no deferred state exists', async () => {
    const store = new InMemoryDeferredStore()
    const result = await store.get('s_missing')
    expect(result).toBeNull()
  })

  test('set overwrites the prior value for the same sessionId', async () => {
    const store = new InMemoryDeferredStore()
    await store.set('s1', sampleState())
    await store.set('s1', { ...sampleState(), toolName: 'Write', cachedAnswer: { behavior: 'allow' } })

    const result = await store.get('s1')
    expect(result?.toolName).toBe('Write')
    expect(result?.cachedAnswer).toEqual({ behavior: 'allow' })
  })

  test('delete removes the deferred state', async () => {
    const store = new InMemoryDeferredStore()
    await store.set('s1', sampleState())
    await store.delete('s1')

    const result = await store.get('s1')
    expect(result).toBeNull()
  })

  test('preserves agentId + cachedAnswer across set / get', async () => {
    const store = new InMemoryDeferredStore()
    const state: DeferredState = {
      toolUseId: 'tu_1',
      toolName: 'Bash',
      rawInput: { command: 'ls' },
      deferredAt: 1_700_000_000_000,
      agentId: 'sub_outer',
      cachedAnswer: {
        behavior: 'allow',
        updatedInput: { command: 'ls -la' },
      },
    }
    await store.set('s1', state)

    const result = await store.get('s1')
    expect(result?.agentId).toBe('sub_outer')
    expect(result?.cachedAnswer).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    })
  })
})
