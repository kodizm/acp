import { describe, expect, test } from 'bun:test'

import { OpencodeEventMapper } from '@/backends/opencode/event-mapper.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

/**
 * Phase 3 Task 6: opencode bus events -> canonical SessionUpdateEvent.
 *
 * Tests synthesise the bus event shapes that opencode's
 * `message.part.delta`, `message.part.updated`, `message.updated`,
 * `session.updated`, and `session.compacted` produce. Each branch in
 * the mapper has at least one assertion; thirteen branches in total
 * (D6 + D7 + D8).
 */

function recorder(): { events: SessionUpdateEvent[]; emit: (e: SessionUpdateEvent) => void } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

describe('OpencodeEventMapper', () => {
  test('TextPart delta -> output_chunk', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    // Track partID -> TextPart via message.part.updated first.
    mapper.handle('message.part.updated', {
      sessionID: 'opencode-1',
      part: { id: 'p1', type: 'text', text: '' },
      time: 1,
    })
    mapper.handle('message.part.delta', {
      sessionID: 'opencode-1',
      messageID: 'm1',
      partID: 'p1',
      field: 'text',
      delta: 'Hello',
    })

    expect(events).toContainEqual({ sessionId: 'k-1', type: 'output_chunk', text: 'Hello' })
  })

  test('ReasoningPart delta -> thinking_chunk', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    mapper.handle('message.part.updated', {
      sessionID: 'opencode-1',
      part: { id: 'p1', type: 'reasoning', text: '' },
      time: 1,
    })
    mapper.handle('message.part.delta', {
      sessionID: 'opencode-1',
      messageID: 'm1',
      partID: 'p1',
      field: 'text',
      delta: 'reasoning step',
    })

    expect(events).toContainEqual({ sessionId: 'k-1', type: 'thinking_chunk', text: 'reasoning step' })
  })

  test('Tool part transitions running -> tool_call_begin', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    mapper.handle('message.part.updated', {
      sessionID: 'opencode-1',
      part: {
        id: 'p1',
        type: 'tool',
        callID: 'call-1',
        tool: 'bash',
        state: { status: 'running', input: { command: 'ls' }, time: { start: 1 } },
      },
      time: 1,
    })

    expect(events).toContainEqual({
      sessionId: 'k-1',
      type: 'tool_call_begin',
      toolUseId: 'call-1',
      name: 'Bash',
      input: { command: 'ls' },
    })
  })

  test('Tool part completed -> tool_call_end (isError=false)', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    mapper.handle('message.part.updated', {
      sessionID: 'opencode-1',
      part: {
        id: 'p1',
        type: 'tool',
        callID: 'call-1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'ls' },
          output: 'file1\nfile2',
          title: 'ls',
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
      time: 2,
    })

    expect(events).toContainEqual({
      sessionId: 'k-1',
      type: 'tool_call_end',
      toolUseId: 'call-1',
      result: 'file1\nfile2',
      isError: false,
    })
  })

  test('Tool part error -> tool_call_end (isError=true)', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    mapper.handle('message.part.updated', {
      sessionID: 'opencode-1',
      part: {
        id: 'p1',
        type: 'tool',
        callID: 'call-1',
        tool: 'bash',
        state: {
          status: 'error',
          input: { command: 'badcmd' },
          error: 'command not found',
          time: { start: 1, end: 2 },
        },
      },
      time: 2,
    })

    expect(events).toContainEqual({
      sessionId: 'k-1',
      type: 'tool_call_end',
      toolUseId: 'call-1',
      result: 'command not found',
      isError: true,
    })
  })

  test('task tool running -> subagent_spawn', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    mapper.handle('message.part.updated', {
      sessionID: 'opencode-parent',
      part: {
        id: 'p1',
        type: 'tool',
        callID: 'call-1',
        tool: 'task',
        state: {
          status: 'running',
          input: { description: 'subtask' },
          metadata: { sessionID: 'opencode-child', model: { providerID: 'anthropic', modelID: 'haiku' } },
          time: { start: 1 },
        },
      },
      time: 1,
    })

    const spawnEvent = events.find((e) => e.type === 'subagent_spawn')
    expect(spawnEvent).toBeDefined()
    expect(spawnEvent).toMatchObject({
      sessionId: 'k-1',
      type: 'subagent_spawn',
      childId: 'opencode-child',
      parentSessionId: 'k-1',
    })
  })

  test('task tool completed -> subagent_complete', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    // Spawn first.
    mapper.handle('message.part.updated', {
      sessionID: 'opencode-parent',
      part: {
        id: 'p1',
        type: 'tool',
        callID: 'call-1',
        tool: 'task',
        state: {
          status: 'running',
          input: {},
          metadata: { sessionID: 'opencode-child', model: { providerID: 'a', modelID: 'h' } },
          time: { start: 1 },
        },
      },
      time: 1,
    })
    mapper.handle('message.part.updated', {
      sessionID: 'opencode-parent',
      part: {
        id: 'p1',
        type: 'tool',
        callID: 'call-1',
        tool: 'task',
        state: {
          status: 'completed',
          input: {},
          output: 'done',
          title: 'subtask',
          metadata: { sessionID: 'opencode-child' },
          time: { start: 1, end: 2 },
        },
      },
      time: 2,
    })

    const complete = events.find((e) => e.type === 'subagent_complete')
    expect(complete).toMatchObject({
      sessionId: 'k-1',
      type: 'subagent_complete',
      childId: 'opencode-child',
    })
  })

  test('session.updated newly carries info.time.compacting -> compaction_started', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    mapper.handle('session.updated', {
      info: { id: 'opencode-1', time: { compacting: 1234 } },
    })
    expect(events).toContainEqual({
      sessionId: 'k-1',
      type: 'compaction_started',
      trigger: 'auto',
    })
  })

  test('session.compacted -> compaction_completed', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    // Set compacting first so the started event fires (driver asserts state).
    mapper.handle('session.updated', { info: { id: 'opencode-1', time: { compacting: 1 } } })
    mapper.handle('session.compacted', { sessionID: 'opencode-1' })

    expect(events.some((e) => e.type === 'compaction_completed')).toBe(true)
  })

  test('message.updated role=assistant time.completed -> usage event', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    mapper.handle('message.updated', {
      info: {
        id: 'm1',
        role: 'assistant',
        time: { created: 1, completed: 2 },
        cost: 0.0042,
        tokens: { total: 100, input: 50, output: 30, reasoning: 0, cache: { read: 10, write: 5 } },
      },
    })

    const usage = events.find((e) => e.type === 'usage')
    expect(usage).toMatchObject({
      sessionId: 'k-1',
      type: 'usage',
      inputTokens: 50,
      outputTokens: 30,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      costUsd: 0.0042,
    })
  })

  test('a revised message.updated emits only the delta', () => {
    // opencode re-sends message.updated as it revises a message's
    // token counts. The orchestrator ADDS every usage event it gets, so
    // absolute figures each time multiply the accounting: a real turn
    // produced four usage events for one message's worth of tokens.
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    const update = (input: number, output: number, cost: number): void => {
      mapper.handle('message.updated', {
        info: {
          id: 'm1',
          role: 'assistant',
          time: { created: 1, completed: 2 },
          cost,
          tokens: { total: input + output, input, output, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })
    }

    update(50, 10, 0.001)
    update(50, 30, 0.003)

    const usages = events.filter((e) => e.type === 'usage')
    expect(usages).toHaveLength(2)
    expect(usages[0]).toMatchObject({ inputTokens: 50, outputTokens: 10, costUsd: 0.001 })
    // Second event carries the increment, so the two sum to the truth.
    expect(usages[1]).toMatchObject({ inputTokens: 0, outputTokens: 20 })
    expect((usages[1] as { costUsd: number }).costUsd).toBeCloseTo(0.002, 6)
  })

  test('an unchanged message.updated emits no usage event', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    const payload = {
      info: {
        id: 'm1',
        role: 'assistant' as const,
        time: { created: 1, completed: 2 },
        cost: 0.002,
        tokens: { total: 80, input: 50, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }
    mapper.handle('message.updated', payload)
    mapper.handle('message.updated', payload)

    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1)
  })

  test('two assistant messages in one turn each contribute their own usage', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    for (const id of ['m1', 'm2']) {
      mapper.handle('message.updated', {
        info: {
          id,
          role: 'assistant',
          time: { created: 1, completed: 2 },
          cost: 0.001,
          tokens: { total: 20, input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })
    }

    const usages = events.filter((e) => e.type === 'usage')
    expect(usages).toHaveLength(2)
    expect(usages[1]).toMatchObject({ inputTokens: 10, outputTokens: 10 })
  })

  test('MCP tool name reverse-translates kodizm_search -> mcp__kodizm__search', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({
      sessionId: 'k-1',
      emit,
      mcpReverseMap: new Map([['kodizm', 'kodizm']]),
    })

    mapper.handle('message.part.updated', {
      sessionID: 'opencode-1',
      part: {
        id: 'p1',
        type: 'tool',
        callID: 'call-1',
        tool: 'kodizm_search-docs',
        state: { status: 'running', input: { query: 'route' }, time: { start: 1 } },
      },
      time: 1,
    })

    const begin = events.find((e) => e.type === 'tool_call_begin')
    expect(begin?.name).toBe('mcp__kodizm__search-docs')
  })

  test('native opencode tool ids passthrough with PascalCase normalisation', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    mapper.handle('message.part.updated', {
      sessionID: 'opencode-1',
      part: {
        id: 'p1',
        type: 'tool',
        callID: 'call-1',
        tool: 'edit',
        state: { status: 'running', input: { filePath: '/x' }, time: { start: 1 } },
      },
      time: 1,
    })

    const begin = events.find((e) => e.type === 'tool_call_begin')
    expect(begin?.name).toBe('Edit')
  })

  test('unknown / passthrough event method does not throw or emit', () => {
    const { events, emit } = recorder()
    const mapper = new OpencodeEventMapper({ sessionId: 'k-1', emit, mcpReverseMap: new Map() })

    expect(() => mapper.handle('something.unknown', { foo: 'bar' })).not.toThrow()
    expect(events).toEqual([])
  })
})
