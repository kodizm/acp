import { describe, expect, test } from 'bun:test'

import { translateFeaturesToClaude } from '@/backends/claude/features.ts'

describe('translateFeaturesToClaude', () => {
  test('an absent or all-on feature set changes nothing', () => {
    expect(translateFeaturesToClaude(undefined, 'bypassPermissions')).toEqual({ disallowedTools: [], env: {} })
    expect(translateFeaturesToClaude({ todos: true, subagents: true, scheduling: true }, 'bypassPermissions')).toEqual({
      disallowedTools: [],
      env: {},
    })
  })

  test('each switched-off family removes its tools from the model context', () => {
    const out = translateFeaturesToClaude(
      {
        todos: false,
        subagents: false,
        scheduling: false,
        worktree: false,
        notebook: false,
        clientTools: false,
      },
      'bypassPermissions',
    )

    expect(out.disallowedTools).toEqual([
      'TodoWrite',
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
      'Agent',
      'Task',
      'SendMessage',
      'ListAgents',
      'Monitor',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'RemoteTrigger',
      'EnterWorktree',
      'ExitWorktree',
      'NotebookEdit',
      'DesignSync',
      'PushNotification',
      'ShareOnboardingGuide',
      'ReportFindings',
    ])
    expect(out.env).toEqual({ CLAUDE_CODE_DISABLE_CRON: '1' })
  })

  test('behaviour-only families switch off through env', () => {
    const out = translateFeaturesToClaude(
      { backgroundTasks: false, autoMemory: false, bundledSkills: false },
      'bypassPermissions',
    )

    expect(out.disallowedTools).toEqual(['TaskStop'])
    expect(out.env).toEqual({
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    })
  })

  test('plan mode stays leavable for a session that runs in plan mode', () => {
    expect(translateFeaturesToClaude({ planMode: false }, 'bypassPermissions').disallowedTools).toEqual([
      'EnterPlanMode',
      'ExitPlanMode',
    ])
    expect(translateFeaturesToClaude({ planMode: false }, 'plan').disallowedTools).toEqual(['EnterPlanMode'])
  })

  test('simple mode narrows the built-in set to web tools and skips filesystem settings', () => {
    const out = translateFeaturesToClaude({ simple: true, todos: false }, 'bypassPermissions')

    expect(out.tools).toEqual(['WebFetch', 'WebSearch'])
    expect(out.settingSources).toEqual([])
    // With the settings files gone, ENABLE_CLAUDEAI_MCP_SERVERS=false goes
    // with them; strict config keeps the MCP surface to what the wire sent.
    expect(out.strictMcpConfig).toBe(true)
    // Nothing else is left to remove once the base set is two tools.
    expect(out.disallowedTools).toEqual([])
  })

  test('a base tool set replaces the built-in preset, and simple mode still wins', () => {
    const out = translateFeaturesToClaude({ tools: ['Bash', 'Read'], todos: false }, 'bypassPermissions')

    expect(out.tools).toEqual(['Bash', 'Read'])
    // Settings stay loaded: unlike simple mode, a base set is only a narrower menu.
    expect('settingSources' in out).toBe(false)
    expect(translateFeaturesToClaude({ tools: ['Bash'], simple: true }, 'bypassPermissions').tools).toEqual([
      'WebFetch',
      'WebSearch',
    ])
  })
})
