import { describe, expect, test } from 'bun:test'

import { CodexEventMapper } from '@/backends/codex/event-mapper.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const collector = (): { events: SessionUpdateEvent[]; emit: (e: SessionUpdateEvent) => void } => {
  const events: SessionUpdateEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

describe('CodexEventMapper.handle (Phase 2 T7)', () => {
  test('item/agentMessage/delta -> output_chunk', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    mapper.handle('item/agentMessage/delta', {
      thread_id: 't1',
      turn_id: 'tu1',
      delta: 'Hello',
    })
    expect(events).toEqual([{ sessionId: 's1', type: 'output_chunk', text: 'Hello' }])
  })

  test('item/agentMessage/delta with reasoning subtype -> thinking_chunk', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    mapper.handle('item/agentMessage/delta', {
      thread_id: 't1',
      turn_id: 'tu1',
      delta: 'thinking...',
      subtype: 'reasoning',
    })
    expect(events).toEqual([{ sessionId: 's1', type: 'thinking_chunk', text: 'thinking...' }])
  })

  test('item/started w/ CommandExecution -> tool_call_begin (name=Bash)', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    mapper.handle('item/started', {
      thread_id: 't1',
      turn_id: 'tu1',
      item: {
        id: 'item_exec_1',
        type: 'CommandExecution',
        cmd: 'pwd',
        cwd: '/workspace',
        status: 'running',
      },
    })
    expect(events.length).toBe(1)
    if (events[0]?.type !== 'tool_call_begin') throw new Error('expected tool_call_begin')
    expect(events[0].toolUseId).toBe('item_exec_1')
    expect(events[0].name).toBe('Bash')
  })

  test('item/completed w/ CommandExecution -> tool_call_end (isError reflects status)', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    mapper.handle('item/completed', {
      thread_id: 't1',
      turn_id: 'tu1',
      item: {
        id: 'item_exec_1',
        type: 'CommandExecution',
        cmd: 'pwd',
        status: 'error',
        aggregated_output: 'permission denied',
      },
    })
    expect(events.length).toBe(1)
    if (events[0]?.type !== 'tool_call_end') throw new Error('expected tool_call_end')
    expect(events[0].toolUseId).toBe('item_exec_1')
    expect(events[0].isError).toBe(true)
    expect(events[0].result).toBeDefined()
  })

  test('item/started w/ FileChange -> tool_call_begin (name=apply_patch)', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    mapper.handle('item/started', {
      thread_id: 't1',
      turn_id: 'tu1',
      item: {
        id: 'fc_1',
        type: 'FileChange',
        files: ['/x.ts'],
      },
    })
    if (events[0]?.type !== 'tool_call_begin') throw new Error('expected tool_call_begin')
    expect(events[0].name).toBe('apply_patch')
  })

  test('item/started w/ McpToolCall -> tool_call_begin (name=mcp__<server>__<tool>)', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    mapper.handle('item/started', {
      thread_id: 't1',
      turn_id: 'tu1',
      item: {
        id: 'mcp_1',
        type: 'McpToolCall',
        server: 'kodizm',
        tool: 'create_task',
        arguments: { title: 'x' },
      },
    })
    if (events[0]?.type !== 'tool_call_begin') throw new Error('expected tool_call_begin')
    expect(events[0].name).toBe('mcp__kodizm__create_task')
  })

  test('item/started + item/completed w/ ContextCompaction -> compaction_started + compaction_completed', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    mapper.handle('thread/tokenUsage/updated', {
      thread_id: 't1',
      total: { input_tokens: 78_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      last: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model_context_window: 200_000,
    })
    mapper.handle('item/started', {
      thread_id: 't1',
      turn_id: 'tu1',
      item: { id: 'cc_1', type: 'ContextCompaction' },
    })
    mapper.handle('thread/tokenUsage/updated', {
      thread_id: 't1',
      total: { input_tokens: 12_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      last: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model_context_window: 200_000,
    })
    mapper.handle('item/completed', {
      thread_id: 't1',
      turn_id: 'tu1',
      item: { id: 'cc_1', type: 'ContextCompaction' },
    })

    const started = events.find((e) => e.type === 'compaction_started')
    const completed = events.find((e) => e.type === 'compaction_completed')
    expect(started).toBeDefined()
    expect(completed).toBeDefined()
    if (completed?.type !== 'compaction_completed') throw new Error('expected compaction_completed')
    expect(completed.preTokens).toBe(78_000)
    expect(completed.postTokens).toBe(12_000)
    expect(completed.succeeded).toBe(true)
  })

  test('turn/completed -> usage event from latest tokenUsage', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    mapper.handle('thread/tokenUsage/updated', {
      thread_id: 't1',
      total: {
        input_tokens: 1_500,
        output_tokens: 600,
        cache_read_tokens: 8_000,
        cache_creation_tokens: 100,
      },
      last: {
        input_tokens: 1_500,
        output_tokens: 600,
        cache_read_tokens: 8_000,
        cache_creation_tokens: 100,
      },
      model_context_window: 200_000,
    })
    mapper.handle('turn/completed', {
      thread_id: 't1',
      turn: { id: 'tu1', status: 'completed' },
    })

    const usage = events.find((e) => e.type === 'usage')
    expect(usage).toBeDefined()
    if (usage?.type !== 'usage') throw new Error('expected usage')
    expect(usage.inputTokens).toBe(1_500)
    expect(usage.outputTokens).toBe(600)
    expect(usage.cacheReadTokens).toBe(8_000)
    expect(usage.cacheCreationTokens).toBe(100)
  })

  test('thread/status/changed is not surfaced as a canonical event (driver-internal)', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    mapper.handle('thread/status/changed', {
      thread_id: 't1',
      status: { type: 'Idle' },
    })
    expect(events).toEqual([])
  })

  test('unknown notifications do not throw', () => {
    const { events, emit } = collector()
    const mapper = new CodexEventMapper({ sessionId: 's1', emit })
    expect(() =>
      mapper.handle('mystery/notification', {
        thread_id: 't1',
        random: 'payload',
      }),
    ).not.toThrow()
    expect(events).toEqual([])
  })
})
