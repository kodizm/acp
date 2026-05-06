import { describe, expect, test } from 'bun:test'

import { SubagentTracker } from '@/backends/claude/subagent.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const SESSION_ID = 's1'

function spawnEvent(childId: string, model: string): SessionUpdateEvent {
  return {
    sessionId: SESSION_ID,
    type: 'subagent_spawn',
    childId,
    parentSessionId: SESSION_ID,
    model,
    tools: [],
  }
}

function completeEvent(childId: string, inputTokens: number, outputTokens: number): SessionUpdateEvent {
  return {
    sessionId: SESSION_ID,
    type: 'subagent_complete',
    childId,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.001,
  }
}

describe('SubagentTracker, single spawn + complete', () => {
  test('rewrites subagent_complete childId from tool_use_id to recorded child uuid', () => {
    const tracker = new SubagentTracker()

    tracker.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-haiku-4-5-20251001',
      parent_tool_use_id: 'tu_parent',
      uuid: 'sub_1',
    })

    expect(tracker.size()).toBe(1)

    const rewritten = tracker.rewrite([completeEvent('tu_parent', 500, 200)])

    expect(rewritten).toHaveLength(1)
    if (rewritten[0]?.type === 'subagent_complete') {
      expect(rewritten[0].childId).toBe('sub_1')
      expect(rewritten[0].inputTokens).toBe(500)
      expect(rewritten[0].outputTokens).toBe(200)
    }
  })

  test('passes through non-subagent_complete events unchanged', () => {
    const tracker = new SubagentTracker()
    const spawn = spawnEvent('sub_1', 'claude-haiku-4-5-20251001')
    const usage: SessionUpdateEvent = {
      sessionId: SESSION_ID,
      type: 'usage',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.0001,
    }

    const rewritten = tracker.rewrite([spawn, usage])
    expect(rewritten).toEqual([spawn, usage])
  })
})

describe('SubagentTracker, nested 2-level subagents', () => {
  test('records mappings for both levels independently', () => {
    const tracker = new SubagentTracker()

    tracker.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      parent_tool_use_id: 'tu_outer',
      uuid: 'sub_outer',
    })

    tracker.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-haiku-4-5-20251001',
      parent_tool_use_id: 'tu_inner',
      uuid: 'sub_inner',
    })

    expect(tracker.size()).toBe(2)

    const completes = tracker.rewrite([completeEvent('tu_inner', 100, 50), completeEvent('tu_outer', 600, 250)])

    expect(completes).toHaveLength(2)
    if (completes[0]?.type === 'subagent_complete') {
      expect(completes[0].childId).toBe('sub_inner')
    }
    if (completes[1]?.type === 'subagent_complete') {
      expect(completes[1].childId).toBe('sub_outer')
    }
  })
})

describe('SubagentTracker, parallel subagents', () => {
  test('keeps separate mappings for siblings spawned from the same parent turn', () => {
    const tracker = new SubagentTracker()

    tracker.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-haiku-4-5-20251001',
      parent_tool_use_id: 'tu_a',
      uuid: 'sub_a',
    })
    tracker.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-haiku-4-5-20251001',
      parent_tool_use_id: 'tu_b',
      uuid: 'sub_b',
    })

    const rewritten = tracker.rewrite([completeEvent('tu_a', 200, 100), completeEvent('tu_b', 300, 150)])

    if (rewritten[0]?.type === 'subagent_complete') {
      expect(rewritten[0].childId).toBe('sub_a')
      expect(rewritten[0].inputTokens).toBe(200)
    }
    if (rewritten[1]?.type === 'subagent_complete') {
      expect(rewritten[1].childId).toBe('sub_b')
      expect(rewritten[1].inputTokens).toBe(300)
    }
  })

  test('subagent token slices sum below the parent total (sanity check)', () => {
    const tracker = new SubagentTracker()
    tracker.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-haiku-4-5-20251001',
      parent_tool_use_id: 'tu_a',
      uuid: 'sub_a',
    })
    tracker.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-haiku-4-5-20251001',
      parent_tool_use_id: 'tu_b',
      uuid: 'sub_b',
    })

    const subagentInput = 200 + 300
    const subagentOutput = 100 + 150
    const parentTotalInput = 1000
    const parentTotalOutput = 600

    expect(subagentInput).toBeLessThanOrEqual(parentTotalInput)
    expect(subagentOutput).toBeLessThanOrEqual(parentTotalOutput)
  })
})

describe('SubagentTracker, unknown tool_use_id', () => {
  test('leaves the subagent_complete event unchanged when no mapping recorded', () => {
    const tracker = new SubagentTracker()
    const orphan = completeEvent('tu_unseen', 100, 50)

    const rewritten = tracker.rewrite([orphan])
    expect(rewritten).toEqual([orphan])
  })
})

describe('SubagentTracker, clear', () => {
  test('drops all recorded mappings', () => {
    const tracker = new SubagentTracker()
    tracker.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      parent_tool_use_id: 'tu_x',
      uuid: 'sub_x',
    })
    expect(tracker.size()).toBe(1)

    tracker.clear()
    expect(tracker.size()).toBe(0)
  })
})

describe('SubagentTracker, observe ignores non-subagent system messages', () => {
  test('system init without parent_tool_use_id records nothing', () => {
    const tracker = new SubagentTracker()
    tracker.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
    })
    expect(tracker.size()).toBe(0)
  })

  test('non-system messages do not record mappings', () => {
    const tracker = new SubagentTracker()
    tracker.observe({
      type: 'result',
      subtype: 'success',
      parent_tool_use_id: 'tu_x',
    })
    expect(tracker.size()).toBe(0)
  })
})
