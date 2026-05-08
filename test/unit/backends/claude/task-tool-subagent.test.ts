import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { SdkMessage } from '@/backends/claude/event-mapper.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

/**
 * Driver-level integration test for the Claude Task tool subagent
 * lifecycle mapping (event-mapper.ts changes for v0.5.4).
 *
 * The wire shape we captured from a real session:
 *   - assistant emits tool_use { name: 'Task' | 'Agent', id, input }
 *   - subagent runs internally (no separate session id, no
 *     parent_tool_use_id on the SDK side)
 *   - user emits tool_result { tool_use_id, content: '<output>\n
 *     agentId: <hex>\n<usage>total_tokens: N tool_uses: M
 *     duration_ms: D</usage>' }
 *
 * The driver passes each SDK message through mapSdkMessage; our new
 * mapper branches surface subagent_spawn + subagent_complete on the
 * fly so the orchestrator's tree builder + Filament tab populate
 * automatically.
 */

function makeAdapter(messages: SdkMessage[]): SdkAdapter {
  return {
    async *query() {
      for (const message of messages) {
        yield message
      }
    },
  }
}

function makeRecordingEmitter(): { emit: EventEmitter; events: SessionUpdateEvent[] } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (event) => events.push(event) } }
}

describe('ClaudeDriver Task tool subagent lifecycle', () => {
  test('Task tool_use + tool_result -> subagent_spawn + subagent_complete events', async () => {
    const messages: SdkMessage[] = [
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_task_real_1',
              name: 'Task',
              input: {
                subagent_type: 'general-purpose',
                prompt: 'Count *.md files under /workspace.',
              },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_task_real_1',
              content:
                '432\nagentId: af301668674acf9fc (use SendMessage with to: \'af301668674acf9fc\' to continue this agent)\n<usage>total_tokens: 12816 tool_uses: 2 duration_ms: 6236</usage>',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.0312,
        usage: {
          input_tokens: 4500,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-ant-fake' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapter(messages),
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    const spawns = events.filter((e) => e.type === 'subagent_spawn')
    const completes = events.filter((e) => e.type === 'subagent_complete')

    expect(spawns).toHaveLength(1)
    expect(completes).toHaveLength(1)

    const spawn = spawns[0]
    if (spawn?.type === 'subagent_spawn') {
      expect(spawn.childId).toBe('tu_task_real_1')
      expect(spawn.parentSessionId).toBe(sessionId)
      expect(spawn.model).toBe('general-purpose')
    }

    const complete = completes[0]
    if (complete?.type === 'subagent_complete') {
      expect(complete.childId).toBe('tu_task_real_1')
      expect(complete.inputTokens).toBe(12816)
    }

    // Order check: spawn fires BEFORE the parent tool_call_begin so
    // the orchestrator's tree observer pairs correctly.
    const spawnIdx = events.findIndex((e) => e.type === 'subagent_spawn')
    const toolBeginIdx = events.findIndex((e) => e.type === 'tool_call_begin' && e.toolUseId === 'tu_task_real_1')
    expect(spawnIdx).toBeLessThan(toolBeginIdx)

    // Likewise complete fires BEFORE its tool_call_end.
    const completeIdx = events.findIndex((e) => e.type === 'subagent_complete')
    const toolEndIdx = events.findIndex((e) => e.type === 'tool_call_end' && e.toolUseId === 'tu_task_real_1')
    expect(completeIdx).toBeLessThan(toolEndIdx)
  })

  test('Plain tool_use + tool_result (non-Task) does NOT emit subagent events', async () => {
    const messages: SdkMessage[] = [
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_glob_1',
              name: 'Glob',
              input: { path: '/workspace', pattern: '**/*.md' },
            },
          ],
        },
      },
      {
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
      },
      {
        type: 'result',
        subtype: 'success',
      },
    ]

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-ant-fake' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapter(messages),
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(events.filter((e) => e.type === 'subagent_spawn')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'subagent_complete')).toHaveLength(0)
  })

  test('Task tool_result without usage marker -> spawn fires but complete does not', async () => {
    // Edge case: SDK serialises a Task tool result without the
    // <usage> block (older Anthropic SDK builds, or aborted subagent
    // turns). The spawn still emits at the tool_use side, but the
    // complete pair stays missing — caller can spot the dangling
    // spawn and reconcile via the modal's cost-aggregation fallback.
    const messages: SdkMessage[] = [
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_task_dangling',
              name: 'Task',
              input: { prompt: 'do something' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_task_dangling',
              content: 'plain output without markers',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
      },
    ]

    const driver = new ClaudeDriver({
      credentials: { type: 'api-key', token: 'sk-ant-fake' },
      agentInfo: { version: '0.0.1-test' },
      sdk: makeAdapter(messages),
    })

    const { sessionId } = await driver.newSession({ cwd: '/workspace', mcpServers: [] })
    const { emit, events } = makeRecordingEmitter()
    await driver.prompt(sessionId, { sessionId, prompt: [] }, emit)

    expect(events.filter((e) => e.type === 'subagent_spawn')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'subagent_complete')).toHaveLength(0)
  })
})
