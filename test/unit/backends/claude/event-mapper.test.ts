import { describe, expect, test } from 'bun:test'

import { type SdkMessage, mapSdkMessage } from '@/backends/claude/event-mapper.ts'

const SESSION_ID = 's1'

describe('mapSdkMessage, system init', () => {
  test('emits model_advertisement when model is announced', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
    })

    expect(events).toEqual([{ sessionId: SESSION_ID, type: 'model_advertisement', model: 'claude-sonnet-4-6' }])
  })

  test('emits subagent_spawn when parent_tool_use_id + uuid + model are present', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'init',
      model: 'claude-haiku-4-5-20251001',
      parent_tool_use_id: 'tu_parent',
      uuid: 'sub_1',
    })

    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('model_advertisement')
    expect(events[1]).toEqual({
      sessionId: SESSION_ID,
      type: 'subagent_spawn',
      childId: 'sub_1',
      parentSessionId: SESSION_ID,
      model: 'claude-haiku-4-5-20251001',
      tools: [],
    })
  })

  test('returns empty when model is missing on system init', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'init',
    })
    expect(events).toEqual([])
  })
})

describe('mapSdkMessage, assistant', () => {
  test('text block -> output_chunk', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    })

    expect(events).toEqual([{ sessionId: SESSION_ID, type: 'output_chunk', text: 'Hello world' }])
  })

  test('thinking block -> thinking_chunk', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'considering options...' }],
      },
    })

    expect(events).toEqual([{ sessionId: SESSION_ID, type: 'thinking_chunk', text: 'considering options...' }])
  })

  test('tool_use block -> tool_call_begin', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'mcp__kodizm__kodizm_create_task',
            input: { title: 'Refactor' },
          },
        ],
      },
    })

    expect(events).toEqual([
      {
        sessionId: SESSION_ID,
        type: 'tool_call_begin',
        toolUseId: 'tu_1',
        name: 'mcp__kodizm__kodizm_create_task',
        input: { title: 'Refactor' },
      },
    ])
  })

  test('Task tool_use -> subagent_spawn before tool_call_begin', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_task_1',
            name: 'Task',
            input: {
              subagent_type: 'general-purpose',
              prompt: 'Find all *.md files',
            },
          },
        ],
      },
    })

    // Two events: subagent_spawn first (so the orchestrator's tree
    // observers see the spawn before the tool_call_begin), then the
    // generic tool_call_begin.
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      sessionId: SESSION_ID,
      type: 'subagent_spawn',
      childId: 'tu_task_1',
      parentSessionId: SESSION_ID,
      model: 'general-purpose',
      tools: [],
    })
    expect(events[1]?.type).toBe('tool_call_begin')
  })

  test('Agent tool_use (legacy alias) -> subagent_spawn', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_agent_1',
            name: 'Agent',
            input: { prompt: 'count' },
          },
        ],
      },
    })

    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('subagent_spawn')
  })

  test('Task tool_result with usage marker -> subagent_complete + tool_call_end', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_task_1',
            content:
              '432\nagentId: af301668674acf9fc (use SendMessage with to: \'af301668674acf9fc\' to continue this agent)\n<usage>total_tokens: 12816 tool_uses: 2 duration_ms: 6236</usage>',
            is_error: false,
          },
        ],
      },
    })

    // Two events: subagent_complete first (so the tree observer pairs
    // it with the spawn before the tool_call_end fires), then the
    // generic tool_call_end.
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      sessionId: SESSION_ID,
      type: 'subagent_complete',
      childId: 'tu_task_1',
      inputTokens: 12816,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    })
    expect(events[1]?.type).toBe('tool_call_end')
  })

  test('Plain tool_result without Task markers -> only tool_call_end', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_glob_1',
            content: '/workspace/foo.md\n/workspace/bar.md',
            is_error: false,
          },
        ],
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('tool_call_end')
  })

  test('mixed content -> events emitted in source order', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'think' },
          { type: 'text', text: 'speak' },
          { type: 'tool_use', id: 'tu_2', name: 'foo', input: {} },
        ],
      },
    })

    expect(events.map((e) => e.type)).toEqual(['thinking_chunk', 'output_chunk', 'tool_call_begin'])
  })
})

describe('mapSdkMessage, user (tool_result)', () => {
  test('tool_result block -> tool_call_end with concatenated text + isError', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
            is_error: false,
          },
        ],
      },
    })

    expect(events).toEqual([
      {
        sessionId: SESSION_ID,
        type: 'tool_call_end',
        toolUseId: 'tu_1',
        result: 'line one\nline two',
        isError: false,
      },
    ])
  })

  test('tool_result with is_error=true preserves the flag', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: [{ type: 'text', text: 'permission denied' }],
            is_error: true,
          },
        ],
      },
    })

    expect(events).toHaveLength(1)
    if (events[0]?.type === 'tool_call_end') {
      expect(events[0].isError).toBe(true)
    }
  })
})

describe('mapSdkMessage, result', () => {
  test('emits usage event with the four token counts + cost', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.0152,
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 100,
      },
    })

    expect(events).toEqual([
      {
        sessionId: SESSION_ID,
        type: 'usage',
        inputTokens: 1234,
        outputTokens: 567,
        cacheReadTokens: 8000,
        cacheCreationTokens: 100,
        costUsd: 0.0152,
      },
    ])
  })

  test('missing token fields default to 0', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'result',
      subtype: 'success',
      usage: {},
    })

    if (events[0]?.type === 'usage') {
      expect(events[0].inputTokens).toBe(0)
      expect(events[0].outputTokens).toBe(0)
      expect(events[0].cacheReadTokens).toBe(0)
      expect(events[0].cacheCreationTokens).toBe(0)
      expect(events[0].costUsd).toBe(0)
    }
  })

  test('missing usage block -> no events', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'result',
      subtype: 'success',
    })
    expect(events).toEqual([])
  })

  test('parent_tool_use_id present -> emits subagent_complete with token slice', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.005,
      parent_tool_use_id: 'sub_1',
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
      },
    })

    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({
      sessionId: SESSION_ID,
      type: 'subagent_complete',
      childId: 'sub_1',
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 1000,
      cacheCreationTokens: 0,
      costUsd: 0.005,
    })
  })
})

describe('mapSdkMessage, compaction lifecycle', () => {
  test('system status:compacting -> compaction_started (trigger=auto default)', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
    } as unknown as SdkMessage)

    expect(events).toEqual([{ sessionId: SESSION_ID, type: 'compaction_started', trigger: 'auto' }])
  })

  test('compact_boundary -> compaction_completed with full metadata', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'manual',
        pre_tokens: 78_000,
        post_tokens: 12_000,
        duration_ms: 1500,
      },
    } as unknown as SdkMessage)

    expect(events).toEqual([
      {
        sessionId: SESSION_ID,
        type: 'compaction_completed',
        trigger: 'manual',
        preTokens: 78_000,
        postTokens: 12_000,
        durationMs: 1500,
        succeeded: true,
      },
    ])
  })

  test('compact_boundary minimal payload', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 50_000,
      },
    } as unknown as SdkMessage)

    expect(events).toEqual([
      {
        sessionId: SESSION_ID,
        type: 'compaction_completed',
        trigger: 'auto',
        preTokens: 50_000,
        succeeded: true,
      },
    ])
  })

  test('status:null + compact_result:failed -> compaction_completed (succeeded:false + error)', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'prompt_too_long retry exhausted',
    } as unknown as SdkMessage)

    expect(events).toHaveLength(1)
    if (events[0]?.type === 'compaction_completed') {
      expect(events[0].succeeded).toBe(false)
      expect(events[0].error).toContain('prompt_too_long')
    }
  })

  test('status:null + compact_result:success -> no event (boundary already fired)', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'success',
    } as unknown as SdkMessage)

    expect(events).toEqual([])
  })

  test('status:requesting -> no event', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'status',
      status: 'requesting',
    } as unknown as SdkMessage)

    expect(events).toEqual([])
  })
})

describe('mapSdkMessage, unknown variants', () => {
  test('returns empty for an unknown message type', () => {
    const events = mapSdkMessage(SESSION_ID, { type: 'mystery' } as unknown as SdkMessage)
    expect(events).toEqual([])
  })
})
