import { describe, expect, test } from 'bun:test'

import {
  CancelledEventSchema,
  CompactionCompletedEventSchema,
  CompactionStartedEventSchema,
  DebugLogEventSchema,
  HeartbeatEventSchema,
  KodizmQuestionSchema,
  ModelAdvertisementEventSchema,
  OutputChunkEventSchema,
  PermissionDeferredEventSchema,
  PermissionRequestEventSchema,
  PermissionResumedEventSchema,
  ProcessDiedEventSchema,
  QuestionRequestEventSchema,
  SessionFailedEventSchema,
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

describe('Phase 1.5 event extensions', () => {
  test('permission_request accepts agentId + parentSessionId for subagent calls', () => {
    const event = {
      ...baseEnvelope,
      type: 'permission_request' as const,
      toolUseId: 'tu_1',
      name: 'Bash',
      options: [{ optionId: 'allow', label: 'Allow' }],
      agentId: 'sub_outer',
      parentSessionId: 's1',
    }
    expect(PermissionRequestEventSchema.safeParse(event).success).toBe(true)
  })

  test('permission_request main-agent call omits agentId + parentSessionId', () => {
    const event = {
      ...baseEnvelope,
      type: 'permission_request' as const,
      toolUseId: 'tu_1',
      name: 'Bash',
      options: [{ optionId: 'allow', label: 'Allow' }],
    }
    expect(PermissionRequestEventSchema.safeParse(event).success).toBe(true)
  })

  test('KodizmQuestionSchema accepts a 2-option single-select question', () => {
    const question = {
      question: 'Which auth path?',
      header: 'Auth',
      options: [
        { label: 'OAuth', description: 'Subscription pool' },
        { label: 'API key', description: 'Direct key' },
      ],
      multiSelect: false,
    }
    expect(KodizmQuestionSchema.safeParse(question).success).toBe(true)
  })

  test('KodizmQuestionSchema rejects header longer than 12 chars', () => {
    const question = {
      question: 'Pick one.',
      header: 'this header is way too long',
      options: [
        { label: 'A', description: 'Option A' },
        { label: 'B', description: 'Option B' },
      ],
      multiSelect: false,
    }
    expect(KodizmQuestionSchema.safeParse(question).success).toBe(false)
  })

  test('KodizmQuestionSchema rejects fewer than 2 options', () => {
    const question = {
      question: 'Pick.',
      header: 'Pick',
      options: [{ label: 'Only', description: 'Only option' }],
      multiSelect: false,
    }
    expect(KodizmQuestionSchema.safeParse(question).success).toBe(false)
  })

  test('question_request roundtrips with one question', () => {
    const event = {
      ...baseEnvelope,
      type: 'question_request' as const,
      toolUseId: 'tu_1',
      questions: [
        {
          question: 'A or B?',
          header: 'Pick',
          options: [
            { label: 'A', description: 'Option A' },
            { label: 'B', description: 'Option B' },
          ],
          multiSelect: false,
        },
      ],
    }
    expect(QuestionRequestEventSchema.safeParse(event).success).toBe(true)
  })

  test('question_request rejects an empty questions array', () => {
    const event = {
      ...baseEnvelope,
      type: 'question_request' as const,
      toolUseId: 'tu_1',
      questions: [],
    }
    expect(QuestionRequestEventSchema.safeParse(event).success).toBe(false)
  })

  test('compaction_started accepts auto trigger', () => {
    const event = {
      ...baseEnvelope,
      type: 'compaction_started' as const,
      trigger: 'auto' as const,
    }
    expect(CompactionStartedEventSchema.safeParse(event).success).toBe(true)
  })

  test('compaction_started rejects an unknown trigger', () => {
    const event = {
      ...baseEnvelope,
      type: 'compaction_started' as const,
      trigger: 'magic',
    }
    expect(CompactionStartedEventSchema.safeParse(event).success).toBe(false)
  })

  test('compaction_completed roundtrips with full metadata', () => {
    const event = {
      ...baseEnvelope,
      type: 'compaction_completed' as const,
      trigger: 'manual' as const,
      preTokens: 78_000,
      postTokens: 12_000,
      durationMs: 1500,
      succeeded: true,
    }
    expect(CompactionCompletedEventSchema.safeParse(event).success).toBe(true)
  })

  test('compaction_completed allows minimal payload (preTokens + trigger + succeeded)', () => {
    const event = {
      ...baseEnvelope,
      type: 'compaction_completed' as const,
      trigger: 'auto' as const,
      preTokens: 78_000,
      succeeded: false,
      error: 'prompt_too_long retry exhausted',
    }
    expect(CompactionCompletedEventSchema.safeParse(event).success).toBe(true)
  })
})

describe('Phase 1.6 deferred-permission events', () => {
  test('permission_deferred carries toolUseId + name (main agent call)', () => {
    const event = {
      ...baseEnvelope,
      type: 'permission_deferred' as const,
      toolUseId: 'tu_1',
      name: 'Bash',
    }
    expect(PermissionDeferredEventSchema.safeParse(event).success).toBe(true)
  })

  test('permission_deferred accepts optional agentId for subagent calls', () => {
    const event = {
      ...baseEnvelope,
      type: 'permission_deferred' as const,
      toolUseId: 'tu_1',
      name: 'Bash',
      agentId: 'sub_outer',
    }
    expect(PermissionDeferredEventSchema.safeParse(event).success).toBe(true)
  })

  test('permission_deferred rejects an empty toolUseId', () => {
    const event = {
      ...baseEnvelope,
      type: 'permission_deferred' as const,
      toolUseId: '',
      name: 'Bash',
    }
    expect(PermissionDeferredEventSchema.safeParse(event).success).toBe(false)
  })

  test('permission_resumed roundtrips with allow decision', () => {
    const event = {
      ...baseEnvelope,
      type: 'permission_resumed' as const,
      toolUseId: 'tu_1',
      decision: 'allow' as const,
    }
    expect(PermissionResumedEventSchema.safeParse(event).success).toBe(true)
  })

  test('permission_resumed roundtrips with deny decision', () => {
    const event = {
      ...baseEnvelope,
      type: 'permission_resumed' as const,
      toolUseId: 'tu_1',
      decision: 'deny' as const,
    }
    expect(PermissionResumedEventSchema.safeParse(event).success).toBe(true)
  })

  test('permission_resumed rejects an unknown decision value', () => {
    const event = {
      ...baseEnvelope,
      type: 'permission_resumed' as const,
      toolUseId: 'tu_1',
      decision: 'magic',
    }
    expect(PermissionResumedEventSchema.safeParse(event).success).toBe(false)
  })

  test('SessionUpdateEventSchema routes permission_deferred + permission_resumed', () => {
    const deferred = {
      ...baseEnvelope,
      type: 'permission_deferred' as const,
      toolUseId: 'tu_1',
      name: 'Bash',
    }
    const resumed = {
      ...baseEnvelope,
      type: 'permission_resumed' as const,
      toolUseId: 'tu_1',
      decision: 'allow' as const,
    }
    expect(SessionUpdateEventSchema.safeParse(deferred).success).toBe(true)
    expect(SessionUpdateEventSchema.safeParse(resumed).success).toBe(true)
  })
})

describe('Phase 1.7 debug + lifecycle events', () => {
  test('debug_log accepts a minimal entry (debug level + sdk.message stage)', () => {
    const event = {
      ...baseEnvelope,
      type: 'debug_log' as const,
      level: 'debug' as const,
      stage: 'sdk.message' as const,
      capturedAt: 1_700_000_000_000,
      payload: { type: 'assistant', text: 'hi' },
    }
    expect(DebugLogEventSchema.safeParse(event).success).toBe(true)
  })

  test('debug_log accepts redacted flag + every documented stage', () => {
    const stages = [
      'rpc.in',
      'rpc.out',
      'sdk.message',
      'sdk.error',
      'tool.permission_request',
      'tool.permission_response',
      'session.config',
      'driver.state_change',
      'transport.spawn',
      'transport.exit',
    ] as const
    for (const stage of stages) {
      const result = DebugLogEventSchema.safeParse({
        ...baseEnvelope,
        type: 'debug_log',
        level: 'info',
        stage,
        capturedAt: 1_700_000_000_000,
        payload: { foo: 'bar' },
        redacted: true,
      })
      expect(result.success).toBe(true)
    }
  })

  test('debug_log rejects an unknown level', () => {
    const event = {
      ...baseEnvelope,
      type: 'debug_log' as const,
      level: 'critical',
      stage: 'sdk.message' as const,
      capturedAt: 1_700_000_000_000,
      payload: {},
    }
    expect(DebugLogEventSchema.safeParse(event).success).toBe(false)
  })

  test('debug_log rejects an unknown stage', () => {
    const event = {
      ...baseEnvelope,
      type: 'debug_log' as const,
      level: 'debug' as const,
      stage: 'mystery.stage',
      capturedAt: 1_700_000_000_000,
      payload: {},
    }
    expect(DebugLogEventSchema.safeParse(event).success).toBe(false)
  })

  test('heartbeat carries uptimeMs + lastSdkMs (both non-negative ints)', () => {
    const event = {
      ...baseEnvelope,
      type: 'heartbeat' as const,
      uptimeMs: 12_345,
      lastSdkMs: 42,
    }
    expect(HeartbeatEventSchema.safeParse(event).success).toBe(true)
  })

  test('heartbeat rejects negative ms values', () => {
    const event = {
      ...baseEnvelope,
      type: 'heartbeat' as const,
      uptimeMs: -1,
      lastSdkMs: 0,
    }
    expect(HeartbeatEventSchema.safeParse(event).success).toBe(false)
  })

  test('session_failed accepts every documented reason value', () => {
    const reasons = [
      'sdk_stall',
      'sdk_throw',
      'transport_error',
      'auth_error',
      'rate_limit',
      'protocol_violation',
      'internal_panic',
    ] as const
    for (const reason of reasons) {
      const event = {
        ...baseEnvelope,
        type: 'session_failed' as const,
        reason,
        detail: `simulated ${reason}`,
        capturedAt: 1_700_000_000_000,
      }
      expect(SessionFailedEventSchema.safeParse(event).success).toBe(true)
    }
  })

  test('session_failed accepts optional cause stack', () => {
    const event = {
      ...baseEnvelope,
      type: 'session_failed' as const,
      reason: 'sdk_throw' as const,
      detail: 'unhandled SDK error',
      capturedAt: 1_700_000_000_000,
      cause: {
        name: 'TypeError',
        message: 'undefined is not a function',
        stack: 'TypeError: ...\n    at fn (file:1:1)',
      },
    }
    expect(SessionFailedEventSchema.safeParse(event).success).toBe(true)
  })

  test('session_failed rejects unknown reason value', () => {
    const event = {
      ...baseEnvelope,
      type: 'session_failed' as const,
      reason: 'unknown_failure',
      detail: 'x',
      capturedAt: 1_700_000_000_000,
    }
    expect(SessionFailedEventSchema.safeParse(event).success).toBe(false)
  })

  test('SessionUpdateEventSchema routes all 3 new variants', () => {
    const debugLog = {
      ...baseEnvelope,
      type: 'debug_log' as const,
      level: 'debug' as const,
      stage: 'sdk.message' as const,
      capturedAt: 1,
      payload: {},
    }
    const heartbeat = {
      ...baseEnvelope,
      type: 'heartbeat' as const,
      uptimeMs: 1,
      lastSdkMs: 0,
    }
    const sessionFailed = {
      ...baseEnvelope,
      type: 'session_failed' as const,
      reason: 'sdk_stall' as const,
      detail: 'no SDK message for 60s',
      capturedAt: 1,
    }
    expect(SessionUpdateEventSchema.safeParse(debugLog).success).toBe(true)
    expect(SessionUpdateEventSchema.safeParse(heartbeat).success).toBe(true)
    expect(SessionUpdateEventSchema.safeParse(sessionFailed).success).toBe(true)
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
