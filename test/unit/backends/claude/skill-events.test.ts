import { describe, expect, test } from 'bun:test'

import { mapSdkMessage } from '@/backends/claude/event-mapper.ts'

const SESSION_ID = 's1'

describe('mapSdkMessage, skill auto-activation', () => {
  test('system init with skills[] emits one skill_activation per name (source=auto)', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      skills: ['my-coding', 'my-language'],
    })

    const skillEvents = events.filter((e) => e.type === 'skill_activation')
    expect(skillEvents).toHaveLength(2)
    if (skillEvents[0]?.type === 'skill_activation') {
      expect(skillEvents[0]).toEqual({
        sessionId: SESSION_ID,
        type: 'skill_activation',
        skillName: 'my-coding',
        source: 'auto',
      })
    }
    if (skillEvents[1]?.type === 'skill_activation') {
      expect(skillEvents[1].skillName).toBe('my-language')
      expect(skillEvents[1].source).toBe('auto')
    }
  })

  test('system init without skills[] emits no skill_activation events', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
    })
    expect(events.filter((e) => e.type === 'skill_activation')).toHaveLength(0)
  })

  test('empty skills[] emits no skill_activation events', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      skills: [],
    })
    expect(events.filter((e) => e.type === 'skill_activation')).toHaveLength(0)
  })
})

describe('mapSdkMessage, skill explicit invoke', () => {
  test('assistant tool_use with name=Skill emits skill_activation (source=invoked) + tool_call_begin', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_skill_1',
            name: 'Skill',
            input: { skill: 'my-coding', args: 'review the diff' },
          },
        ],
      },
    })

    expect(events.map((e) => e.type)).toEqual(['skill_activation', 'tool_call_begin'])
    if (events[0]?.type === 'skill_activation') {
      expect(events[0]).toEqual({
        sessionId: SESSION_ID,
        type: 'skill_activation',
        skillName: 'my-coding',
        source: 'invoked',
      })
    }
  })

  test('assistant tool_use with name=Skill but no skill key in input emits only tool_call_begin', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_skill_2',
            name: 'Skill',
            input: { args: 'no skill key' },
          },
        ],
      },
    })

    expect(events.map((e) => e.type)).toEqual(['tool_call_begin'])
  })

  test('non-Skill tool_use does not emit skill_activation', () => {
    const events = mapSdkMessage(SESSION_ID, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_other',
            name: 'mcp__kodizm__kodizm_create_task',
            input: { title: 'X' },
          },
        ],
      },
    })

    expect(events.filter((e) => e.type === 'skill_activation')).toHaveLength(0)
    expect(events.map((e) => e.type)).toEqual(['tool_call_begin'])
  })
})
