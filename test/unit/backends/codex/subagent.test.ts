import { describe, expect, test } from 'bun:test'

import { CodexEventMapper } from '@/backends/codex/event-mapper.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const collector = (): { events: SessionUpdateEvent[]; emit: (e: SessionUpdateEvent) => void } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

describe('CodexEventMapper subagent (Phase 2 T8)', () => {
  test('item/started w/ CollabAgentToolCall.SpawnAgent -> subagent_spawn with allocated childId', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's-parent', emit })
    mapper.handle('item/started', {
      thread_id: 't-parent',
      turn_id: 'tu1',
      item: {
        id: 'collab_1',
        type: 'CollabAgentToolCall',
        tool: 'SpawnAgent',
        sender_thread_id: 't-parent',
        receiver_thread_ids: ['t-sub-uuid-1'],
        prompt: 'Refactor the auth module',
        model: 'gpt-5-codex',
      },
    })

    const spawn = events.find((e) => e.type === 'subagent_spawn')
    expect(spawn).toBeDefined()
    if (spawn?.type !== 'subagent_spawn') throw new Error('expected subagent_spawn')
    expect(spawn.parentSessionId).toBe('s-parent')
    expect(spawn.model).toBe('gpt-5-codex')
    expect(spawn.childId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('item/completed w/ CollabAgentToolCall -> subagent_complete with same childId', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's-parent', emit })
    mapper.handle('item/started', {
      thread_id: 't-parent',
      turn_id: 'tu1',
      item: {
        id: 'collab_2',
        type: 'CollabAgentToolCall',
        tool: 'SpawnAgent',
        receiver_thread_ids: ['t-sub-2'],
      },
    })
    const spawn = events.find((e) => e.type === 'subagent_spawn')
    if (spawn?.type !== 'subagent_spawn') throw new Error('expected subagent_spawn')
    const childId = spawn.childId

    mapper.handle('item/completed', {
      thread_id: 't-parent',
      turn_id: 'tu1',
      item: {
        id: 'collab_2',
        type: 'CollabAgentToolCall',
        tool: 'CloseAgent',
        receiver_thread_ids: ['t-sub-2'],
      },
    })

    const complete = events.find((e) => e.type === 'subagent_complete')
    expect(complete).toBeDefined()
    if (complete?.type !== 'subagent_complete') throw new Error('expected subagent_complete')
    expect(complete.childId).toBe(childId)
  })

  test('non-SpawnAgent CollabAgentToolCall variants do NOT emit subagent_spawn', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's-parent', emit })
    mapper.handle('item/started', {
      thread_id: 't-parent',
      turn_id: 'tu1',
      item: {
        id: 'collab_3',
        type: 'CollabAgentToolCall',
        tool: 'SendInput',
        receiver_thread_ids: ['t-sub-3'],
      },
    })
    expect(events.some((e) => e.type === 'subagent_spawn')).toBe(false)
  })

  test('child thread is mapped to fresh Kodizm UUID; not codex thread id leaked', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's-parent', emit })
    mapper.handle('item/started', {
      thread_id: 't-parent',
      turn_id: 'tu1',
      item: {
        id: 'collab_4',
        type: 'CollabAgentToolCall',
        tool: 'SpawnAgent',
        receiver_thread_ids: ['t-sub-codex-uuid'],
      },
    })
    const spawn = events.find((e) => e.type === 'subagent_spawn')
    if (spawn?.type !== 'subagent_spawn') throw new Error('expected subagent_spawn')
    // childId is NOT the codex thread id (orchestrator never sees codex internals).
    expect(spawn.childId).not.toBe('t-sub-codex-uuid')
  })
})
