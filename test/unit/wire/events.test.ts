import { describe, expect, test } from 'bun:test'

import {
  CancelledEventSchema,
  ModelAdvertisementEventSchema,
  OutputChunkEventSchema,
  PermissionRequestEventSchema,
  ProcessDiedEventSchema,
  SessionUpdateEventSchema,
  SkillActivationEventSchema,
  SubagentCompleteEventSchema,
  SubagentSpawnEventSchema,
  ThinkingChunkEventSchema,
  ToolCallBeginEventSchema,
  ToolCallEndEventSchema,
  ToolCallProgressEventSchema,
  UsageEventSchema,
} from '@/wire/events.ts'

const baseEnvelope = { sessionId: 's1' }

describe('Per-event schemas (12 sessionUpdate types)', () => {
  test('output_chunk roundtrips with text payload', () => {
    const event = { ...baseEnvelope, type: 'output_chunk' as const, text: 'Hello' }
    expect(OutputChunkEventSchema.safeParse(event).success).toBe(true)
  })

  test('thinking_chunk roundtrips with reasoning text', () => {
    const event = { ...baseEnvelope, type: 'thinking_chunk' as const, text: 'Considering...' }
    expect(ThinkingChunkEventSchema.safeParse(event).success).toBe(true)
  })

  test('tool_call_begin carries toolUseId + name + input', () => {
    const event = {
      ...baseEnvelope,
      type: 'tool_call_begin' as const,
      toolUseId: 'tu_1',
      name: 'mcp__kodizm__kodizm_create_task',
      input: { title: 'Refactor' },
    }
    expect(ToolCallBeginEventSchema.safeParse(event).success).toBe(true)
  })

  test('tool_call_progress streams partial input', () => {
    const event = {
      ...baseEnvelope,
      type: 'tool_call_progress' as const,
      toolUseId: 'tu_1',
      delta: { partial: 'in-progress' },
    }
    expect(ToolCallProgressEventSchema.safeParse(event).success).toBe(true)
  })

  test('tool_call_end carries result + isError', () => {
    const event = {
      ...baseEnvelope,
      type: 'tool_call_end' as const,
      toolUseId: 'tu_1',
      result: { ok: true, taskId: 't_1' },
      isError: false,
    }
    expect(ToolCallEndEventSchema.safeParse(event).success).toBe(true)
  })

  test('permission_request carries toolUseId + name + options', () => {
    const event = {
      ...baseEnvelope,
      type: 'permission_request' as const,
      toolUseId: 'tu_1',
      name: 'mcp__kodizm__kodizm_create_task',
      options: [
        { optionId: 'allow', label: 'Allow once' },
        { optionId: 'allow_always', label: 'Always allow' },
        { optionId: 'reject', label: 'Reject' },
      ],
    }
    expect(PermissionRequestEventSchema.safeParse(event).success).toBe(true)
  })

  test('usage carries the four token counts + cost', () => {
    const event = {
      ...baseEnvelope,
      type: 'usage' as const,
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 8000,
      cacheCreationTokens: 100,
      costUsd: 0.0152,
    }
    expect(UsageEventSchema.safeParse(event).success).toBe(true)
  })

  test('usage rejects negative token counts', () => {
    const event = {
      ...baseEnvelope,
      type: 'usage' as const,
      inputTokens: -1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    }
    expect(UsageEventSchema.safeParse(event).success).toBe(false)
  })

  test('subagent_spawn carries parent + child + model + tools', () => {
    const event = {
      ...baseEnvelope,
      type: 'subagent_spawn' as const,
      childId: 'sub_1',
      parentSessionId: 's1',
      model: 'claude-haiku-4-5-20251001',
      tools: ['kodizm_create_task', 'kodizm_search_docs'],
    }
    expect(SubagentSpawnEventSchema.safeParse(event).success).toBe(true)
  })

  test('subagent_complete carries token slice + cost slice', () => {
    const event = {
      ...baseEnvelope,
      type: 'subagent_complete' as const,
      childId: 'sub_1',
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 1000,
      cacheCreationTokens: 0,
      costUsd: 0.005,
    }
    expect(SubagentCompleteEventSchema.safeParse(event).success).toBe(true)
  })

  test('skill_activation carries skillName + source', () => {
    const event = {
      ...baseEnvelope,
      type: 'skill_activation' as const,
      skillName: 'my-coding',
      source: 'auto' as const,
    }
    expect(SkillActivationEventSchema.safeParse(event).success).toBe(true)
  })

  test('skill_activation rejects an unknown source', () => {
    const event = {
      ...baseEnvelope,
      type: 'skill_activation' as const,
      skillName: 'my-coding',
      source: 'magic',
    }
    expect(SkillActivationEventSchema.safeParse(event).success).toBe(false)
  })

  test('model_advertisement announces the active model for a turn', () => {
    const event = {
      ...baseEnvelope,
      type: 'model_advertisement' as const,
      model: 'claude-sonnet-4-6',
    }
    expect(ModelAdvertisementEventSchema.safeParse(event).success).toBe(true)
  })

  test('process_died carries exitCode + optional detail', () => {
    const event = {
      ...baseEnvelope,
      type: 'process_died' as const,
      exitCode: 137,
      detail: 'killed by oom',
    }
    expect(ProcessDiedEventSchema.safeParse(event).success).toBe(true)
  })

  test('cancelled carries the cancelled sessionId', () => {
    const event = {
      ...baseEnvelope,
      type: 'cancelled' as const,
      reason: 'user-initiated',
    }
    expect(CancelledEventSchema.safeParse(event).success).toBe(true)
  })
})

describe('SessionUpdateEventSchema (discriminated union)', () => {
  test('routes by the type discriminator', () => {
    const inputs = [
      { ...baseEnvelope, type: 'output_chunk' as const, text: 'hi' },
      { ...baseEnvelope, type: 'thinking_chunk' as const, text: 'thinking' },
      {
        ...baseEnvelope,
        type: 'tool_call_begin' as const,
        toolUseId: 'tu_1',
        name: 'foo',
        input: {},
      },
      {
        ...baseEnvelope,
        type: 'usage' as const,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
      { ...baseEnvelope, type: 'cancelled' as const, reason: 'x' },
    ]

    for (const input of inputs) {
      const result = SessionUpdateEventSchema.safeParse(input)
      expect(result.success).toBe(true)
    }
  })

  test('rejects an unknown discriminator value', () => {
    const event = { ...baseEnvelope, type: 'mystery_event', payload: {} }
    expect(SessionUpdateEventSchema.safeParse(event).success).toBe(false)
  })

  test('rejects a frame missing the type discriminator', () => {
    const event = { ...baseEnvelope, text: 'hi' }
    expect(SessionUpdateEventSchema.safeParse(event).success).toBe(false)
  })

  test('every member of the union carries the sessionId envelope', () => {
    const event = { type: 'output_chunk', text: 'hi' }
    expect(SessionUpdateEventSchema.safeParse(event).success).toBe(false)
  })
})
