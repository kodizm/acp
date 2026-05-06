import { describe, expect, test } from 'bun:test'

import {
  CancelRequestSchema,
  ForkSessionRequestSchema,
  InitializeRequestSchema,
  LoadSessionRequestSchema,
  McpServerSchema,
  NewSessionRequestSchema,
  PromptRequestSchema,
} from '@/wire/schemas.ts'

describe('McpServerSchema', () => {
  test('accepts a well-formed http MCP server entry', () => {
    const result = McpServerSchema.safeParse({
      type: 'http',
      name: 'kodizm',
      url: 'https://kodizm.com/mcp/internal',
      headers: [{ name: 'Authorization', value: 'Bearer kdz-int-jwt.x.y' }],
    })
    expect(result.success).toBe(true)
  })

  test('accepts an MCP server entry without headers', () => {
    const result = McpServerSchema.safeParse({
      type: 'http',
      name: 'kodizm',
      url: 'https://kodizm.com/mcp/internal',
    })
    expect(result.success).toBe(true)
  })

  test('rejects a non-http transport type', () => {
    const result = McpServerSchema.safeParse({
      type: 'stdio',
      name: 'kodizm',
      url: 'https://kodizm.com/mcp/internal',
    })
    expect(result.success).toBe(false)
  })

  test('rejects a malformed url', () => {
    const result = McpServerSchema.safeParse({
      type: 'http',
      name: 'kodizm',
      url: 'not a url',
    })
    expect(result.success).toBe(false)
  })
})

describe('InitializeRequestSchema', () => {
  test('accepts a minimal initialize payload', () => {
    const result = InitializeRequestSchema.safeParse({ protocolVersion: 1 })
    expect(result.success).toBe(true)
  })

  test('accepts initialize with capabilities + _meta', () => {
    const result = InitializeRequestSchema.safeParse({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true } },
      _meta: { traceId: 'abc' },
    })
    expect(result.success).toBe(true)
  })

  test('rejects a non-integer protocolVersion', () => {
    const result = InitializeRequestSchema.safeParse({ protocolVersion: '1' })
    expect(result.success).toBe(false)
  })
})

describe('NewSessionRequestSchema', () => {
  test('accepts the full canonical Kodizm payload', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace/auto-mount-test',
      mcpServers: [
        {
          type: 'http',
          name: 'kodizm',
          url: 'https://kodizm.com/mcp/internal',
          headers: [{ name: 'Authorization', value: 'Bearer kdz-int-jwt.x.y' }],
        },
      ],
      additionalDirectories: ['/data/shared', '/mnt/repo'],
      systemPrompt: 'You are a senior reviewer.',
      model: 'claude-sonnet-4-6',
      skills: ['my-coding', 'my-language'],
      _meta: { traceId: 'abc' },
    })
    expect(result.success).toBe(true)
  })

  test('accepts the minimal payload (cwd + mcpServers only)', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(result.success).toBe(true)
  })

  test('accepts systemPrompt as the {append: string} object form', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      systemPrompt: { append: 'Always respond in Turkish.' },
    })
    expect(result.success).toBe(true)
  })

  test('rejects a relative cwd path', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: 'workspace',
      mcpServers: [],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('absolute')
    }
  })

  test('rejects a relative path inside additionalDirectories', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      additionalDirectories: ['/abs/ok', './rel/bad'],
    })
    expect(result.success).toBe(false)
  })

  test('rejects systemPrompt smuggled inside _meta (must be top-level)', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      _meta: { systemPrompt: 'smuggled value' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message)
      expect(messages.some((message) => message.includes('top-level'))).toBe(true)
    }
  })

  test('rejects additionalDirectories smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      _meta: { additionalDirectories: ['/extra'] },
    })
    expect(result.success).toBe(false)
  })

  test('rejects mcpServers smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      _meta: { mcpServers: [] },
    })
    expect(result.success).toBe(false)
  })
})

describe('NewSessionRequestSchema, toolPolicy + autoCompact + permissionTimeoutMs', () => {
  test('accepts a full toolPolicy with allow + deny + ask + defaultMode', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: {
        allow: ['Read', 'Bash:git commit*', 'mcp:kodizm/*'],
        deny: ['Bash:git push*'],
        ask: ['Edit'],
        defaultMode: 'dontAsk',
      },
    })
    expect(result.success).toBe(true)
  })

  test('accepts every documented defaultMode enum value', () => {
    const modes = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const
    for (const defaultMode of modes) {
      const result = NewSessionRequestSchema.safeParse({
        cwd: '/workspace',
        mcpServers: [],
        toolPolicy: { defaultMode },
      })
      expect(result.success).toBe(true)
    }
  })

  test('rejects an unknown defaultMode', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      toolPolicy: { defaultMode: 'magic' },
    })
    expect(result.success).toBe(false)
  })

  test('accepts autoCompact: false', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      autoCompact: false,
    })
    expect(result.success).toBe(true)
  })

  test('accepts permissionTimeoutMs as a positive integer', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      permissionTimeoutMs: 30_000,
    })
    expect(result.success).toBe(true)
  })

  test('rejects a non-integer permissionTimeoutMs', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      permissionTimeoutMs: 30.5,
    })
    expect(result.success).toBe(false)
  })

  test('rejects a non-positive permissionTimeoutMs', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      permissionTimeoutMs: 0,
    })
    expect(result.success).toBe(false)
  })

  test('rejects toolPolicy smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      _meta: { toolPolicy: { allow: ['Read'] } },
    })
    expect(result.success).toBe(false)
  })

  test('rejects autoCompact smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      _meta: { autoCompact: false },
    })
    expect(result.success).toBe(false)
  })
})

describe('NewSessionRequestSchema, permissionDeferTimeoutMs', () => {
  test('accepts permissionDeferTimeoutMs alone as a positive integer', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      permissionDeferTimeoutMs: 1_800_000,
    })
    expect(result.success).toBe(true)
  })

  test('rejects payloads where both permissionTimeoutMs and permissionDeferTimeoutMs are set', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      permissionTimeoutMs: 30_000,
      permissionDeferTimeoutMs: 1_800_000,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message)
      expect(messages.some((message) => message.includes('mutually exclusive'))).toBe(true)
    }
  })

  test('rejects a non-integer permissionDeferTimeoutMs', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      permissionDeferTimeoutMs: 1_800_000.5,
    })
    expect(result.success).toBe(false)
  })

  test('rejects permissionDeferTimeoutMs smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      _meta: { permissionDeferTimeoutMs: 1_800_000 },
    })
    expect(result.success).toBe(false)
  })
})

describe('NewSessionRequestSchema, debug + lifecycle fields (Phase 1.7)', () => {
  test('accepts all five new fields with sane values', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      debug: true,
      debugCaptureRawSdk: true,
      debugCaptureRpc: false,
      heartbeatIntervalMs: 5_000,
      inactivityThresholdMs: 30_000,
    })
    expect(result.success).toBe(true)
  })

  test('accepts payload without any debug fields (all optional)', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(result.success).toBe(true)
  })

  test('rejects non-integer heartbeatIntervalMs', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      heartbeatIntervalMs: 5.5,
    })
    expect(result.success).toBe(false)
  })

  test('rejects non-positive inactivityThresholdMs', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      inactivityThresholdMs: 0,
    })
    expect(result.success).toBe(false)
  })

  test('rejects debug smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      _meta: { debug: true },
    })
    expect(result.success).toBe(false)
  })

  test('rejects heartbeatIntervalMs smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      _meta: { heartbeatIntervalMs: 5_000 },
    })
    expect(result.success).toBe(false)
  })

  test('rejects inactivityThresholdMs smuggled inside _meta', () => {
    const result = NewSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
      _meta: { inactivityThresholdMs: 30_000 },
    })
    expect(result.success).toBe(false)
  })
})

describe('PromptRequestSchema', () => {
  test('accepts a minimal prompt with sessionId and an empty prompt array', () => {
    const result = PromptRequestSchema.safeParse({
      sessionId: 's1',
      prompt: [],
    })
    expect(result.success).toBe(true)
  })

  test('accepts a per-turn model override', () => {
    const result = PromptRequestSchema.safeParse({
      sessionId: 's1',
      prompt: [],
      model: 'claude-haiku-4-5-20251001',
    })
    expect(result.success).toBe(true)
  })

  test('rejects a missing sessionId', () => {
    const result = PromptRequestSchema.safeParse({
      prompt: [],
    })
    expect(result.success).toBe(false)
  })

  test('rejects a non-array prompt field', () => {
    const result = PromptRequestSchema.safeParse({
      sessionId: 's1',
      prompt: 'just text',
    })
    expect(result.success).toBe(false)
  })
})

describe('CancelRequestSchema', () => {
  test('accepts a sessionId-only cancel', () => {
    const result = CancelRequestSchema.safeParse({ sessionId: 's1' })
    expect(result.success).toBe(true)
  })

  test('rejects a missing sessionId', () => {
    const result = CancelRequestSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  test('rejects a non-string sessionId', () => {
    const result = CancelRequestSchema.safeParse({ sessionId: 42 })
    expect(result.success).toBe(false)
  })
})

describe('LoadSessionRequestSchema', () => {
  test('accepts a load with sessionId + cwd + mcpServers', () => {
    const result = LoadSessionRequestSchema.safeParse({
      sessionId: 's1',
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(result.success).toBe(true)
  })

  test('rejects a missing sessionId', () => {
    const result = LoadSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(result.success).toBe(false)
  })

  test('rejects a relative cwd', () => {
    const result = LoadSessionRequestSchema.safeParse({
      sessionId: 's1',
      cwd: 'workspace',
      mcpServers: [],
    })
    expect(result.success).toBe(false)
  })
})

describe('ForkSessionRequestSchema', () => {
  test('accepts a fork inheriting source options', () => {
    const result = ForkSessionRequestSchema.safeParse({
      sourceSessionId: 's1',
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(result.success).toBe(true)
  })

  test('accepts a fork with a new system prompt + model override', () => {
    const result = ForkSessionRequestSchema.safeParse({
      sourceSessionId: 's1',
      cwd: '/workspace',
      mcpServers: [],
      systemPrompt: { append: 'Branch-specific guidance.' },
      model: 'claude-opus-4-7',
    })
    expect(result.success).toBe(true)
  })

  test('rejects a missing sourceSessionId', () => {
    const result = ForkSessionRequestSchema.safeParse({
      cwd: '/workspace',
      mcpServers: [],
    })
    expect(result.success).toBe(false)
  })
})
