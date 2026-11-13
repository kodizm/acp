import { describe, expect, test } from 'bun:test'

import { START_FILE_FLAGS, START_FLAGS, parsePaneFeatures, parseStartExtras } from '@/live/start-flags.ts'

const BASE_ARGS: Readonly<Record<string, string>> = {
  pane: 'p1',
  cwd: '/work',
  'settings-base': '/etc/settings.json',
}

describe('START_FLAGS', () => {
  test('holds exactly the nineteen start flag names', () => {
    expect([...START_FLAGS].sort()).toEqual(
      [
        'pane',
        'cwd',
        'settings-base',
        'env-file',
        'model',
        'resume',
        'mcp-config',
        'tool-policy',
        'system-prompt-file',
        'features',
        'permission-mode',
        'one-shot',
        'deadline-seconds',
        'retain-failed-seconds',
        'plugin-dir',
        'setting-sources',
        'prompt-mode',
        'agent',
        'cli-config-file',
      ].sort(),
    )
  })

  test('file flags are the six hand-off files, all known start flags', () => {
    expect([...START_FILE_FLAGS]).toEqual([
      'env-file',
      'tool-policy',
      'system-prompt-file',
      'mcp-config',
      'features',
      'cli-config-file',
    ])
    for (const flag of START_FILE_FLAGS) {
      expect(START_FLAGS.has(flag)).toBe(true)
    }
  })

  test('the plugin dir is no hand-off file, so a start never unlinks it', () => {
    expect(START_FILE_FLAGS).not.toContain('plugin-dir')
  })
})

describe('parseStartExtras, defaults', () => {
  test('absent optional flags give undefined, false, undefined, 0, no plugin dir or source, and append', () => {
    expect(parseStartExtras(BASE_ARGS)).toEqual({
      permissionMode: undefined,
      oneShot: false,
      deadlineSeconds: undefined,
      retainFailedSeconds: 0,
      pluginDir: undefined,
      settingSources: undefined,
      promptMode: 'append',
      agent: undefined,
    })
  })

  test('accepts every flag at once', () => {
    const args = {
      ...BASE_ARGS,
      'env-file': '/tmp/env',
      model: 'opus',
      resume: 'abc',
      'mcp-config': '/tmp/mcp.json',
      'tool-policy': '/tmp/policy.json',
      'system-prompt-file': '/tmp/prompt.md',
      'permission-mode': 'dontAsk',
      'one-shot': '1',
      'deadline-seconds': '600',
      'retain-failed-seconds': '90',
      'plugin-dir': '/opt/kodizm/plugins/live-1',
      'setting-sources': 'project',
      'prompt-mode': 'system',
      'cli-config-file': '/tmp/cli-config.json',
    }

    expect(parseStartExtras(args)).toEqual({
      permissionMode: 'dontAsk',
      oneShot: true,
      deadlineSeconds: 600,
      retainFailedSeconds: 90,
      pluginDir: '/opt/kodizm/plugins/live-1',
      settingSources: 'project',
      promptMode: 'system',
      agent: undefined,
    })
  })
})

describe('parseStartExtras, permission-mode', () => {
  test('accepts default', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'permission-mode': 'default' })?.permissionMode).toBe('default')
  })

  test('accepts dontAsk', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'permission-mode': 'dontAsk' })?.permissionMode).toBe('dontAsk')
  })

  for (const bad of ['', 'DontAsk', 'bypassPermissions', 'plan', 'dontask']) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseStartExtras({ ...BASE_ARGS, 'permission-mode': bad })).toBeNull()
    })
  }
})

describe('parseStartExtras, one-shot', () => {
  test('1 is true', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'one-shot': '1' })?.oneShot).toBe(true)
  })

  test('0 is false', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'one-shot': '0' })?.oneShot).toBe(false)
  })

  for (const bad of ['', 'true', 'false', '2', '01', '-1', ' 1']) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseStartExtras({ ...BASE_ARGS, 'one-shot': bad })).toBeNull()
    })
  }
})

describe('parseStartExtras, deadline-seconds', () => {
  test('accepts the lower bound 1', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'deadline-seconds': '1' })?.deadlineSeconds).toBe(1)
  })

  test('accepts the upper bound 2147483', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'deadline-seconds': '2147483' })?.deadlineSeconds).toBe(2147483)
  })

  for (const bad of ['0', '2147484', '-5', '1.5', 'abc', '', '1e3', ' 5', '99999999999999999999']) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseStartExtras({ ...BASE_ARGS, 'deadline-seconds': bad })).toBeNull()
    })
  }
})

describe('parseStartExtras, retain-failed-seconds', () => {
  test('accepts 0', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'retain-failed-seconds': '0' })?.retainFailedSeconds).toBe(0)
  })

  test('accepts the upper bound 2147483', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'retain-failed-seconds': '2147483' })?.retainFailedSeconds).toBe(2147483)
  })

  for (const bad of ['2147484', '-1', '1.5', 'abc', '', '0x10', ' 5']) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseStartExtras({ ...BASE_ARGS, 'retain-failed-seconds': bad })).toBeNull()
    })
  }
})

describe('parseStartExtras, plugin-dir', () => {
  test('accepts a directory under the plugin root', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'plugin-dir': '/opt/kodizm/plugins/live-1' })?.pluginDir).toBe(
      '/opt/kodizm/plugins/live-1',
    )
  })

  test.each([
    ['a parent segment that climbs out of the root', '/opt/kodizm/plugins/../etc'],
    ['a parent segment in the middle', '/opt/kodizm/plugins/live-1/../../etc'],
    ['a sibling that merely shares the prefix', '/opt/kodizm/pluginsx/a'],
    ['a relative path', 'opt/kodizm/plugins/live-1'],
    ['a relative path below the root name', 'plugins/live-1'],
    ['the root itself', '/opt/kodizm/plugins/'],
    ['the root without its slash', '/opt/kodizm/plugins'],
    ['a path outside the root', '/etc/passwd'],
    ['an empty value', ''],
  ])('rejects %s', (_label, path) => {
    expect(parseStartExtras({ ...BASE_ARGS, 'plugin-dir': path })).toBeNull()
  })
})

describe('parseStartExtras, setting-sources', () => {
  test('accepts project', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'setting-sources': 'project' })?.settingSources).toBe('project')
  })

  for (const bad of ['user', 'local', '', 'Project', 'project,user', 'user,project', ' project', 'project ']) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseStartExtras({ ...BASE_ARGS, 'setting-sources': bad })).toBeNull()
    })
  }
})

describe('parseStartExtras, prompt-mode and agent', () => {
  const AGENT_ARGS: Readonly<Record<string, string>> = {
    ...BASE_ARGS,
    'prompt-mode': 'agent',
    agent: 'kodizm-review:reviewer',
    'plugin-dir': '/opt/kodizm/plugins/live-1',
  }

  test('accepts append and system, each without an agent', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'prompt-mode': 'append' })?.promptMode).toBe('append')
    expect(parseStartExtras({ ...BASE_ARGS, 'prompt-mode': 'system' })?.promptMode).toBe('system')
  })

  test('accepts agent with an agent name, a plugin dir and no system prompt file', () => {
    expect(parseStartExtras(AGENT_ARGS)).toMatchObject({
      promptMode: 'agent',
      agent: 'kodizm-review:reviewer',
      pluginDir: '/opt/kodizm/plugins/live-1',
    })
  })

  test('accepts an agent name of 80 characters from the whole allowed alphabet', () => {
    const name = `Ab0_.:-${'x'.repeat(73)}`

    expect(parseStartExtras({ ...AGENT_ARGS, agent: name })?.agent).toBe(name)
  })

  for (const bad of ['', 'Append', 'replace', 'agent ', 'append,system']) {
    test(`rejects the prompt mode ${JSON.stringify(bad)}`, () => {
      expect(parseStartExtras({ ...BASE_ARGS, 'prompt-mode': bad })).toBeNull()
    })
  }

  test.each([
    ['an empty name', ''],
    ['a name over 80 characters', 'x'.repeat(81)],
    ['a space', 'kodizm review'],
    ['a slash', 'kodizm/reviewer'],
    ['a comma', 'a,b'],
    ['a name the CLI could read as an option', '--dangerously-skip-permissions'],
    ['a leading dash', '-x'],
  ])('rejects an agent with %s', (_label, agent) => {
    expect(parseStartExtras({ ...AGENT_ARGS, agent })).toBeNull()
  })

  test('agent mode without an agent name is refused', () => {
    const { agent: _agent, ...args } = AGENT_ARGS

    expect(parseStartExtras(args)).toBeNull()
  })

  test('agent mode without a plugin dir is refused', () => {
    const { 'plugin-dir': _pluginDir, ...args } = AGENT_ARGS

    expect(parseStartExtras(args)).toBeNull()
  })

  test('agent mode with a system prompt file is refused', () => {
    expect(parseStartExtras({ ...AGENT_ARGS, 'system-prompt-file': '/tmp/prompt.md' })).toBeNull()
  })

  for (const mode of [undefined, 'append', 'system']) {
    test(`an agent name under the prompt mode ${mode ?? '(absent)'} is refused`, () => {
      const { 'prompt-mode': _mode, ...args } = AGENT_ARGS

      expect(parseStartExtras(mode === undefined ? args : { ...args, 'prompt-mode': mode })).toBeNull()
    })
  }
})

describe('parseStartExtras, cli-config-file', () => {
  test('is a known flag whose content the daemon checks', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'cli-config-file': '/tmp/cli-config.json' })).not.toBeNull()
  })
})

describe('parseStartExtras, unknown keys', () => {
  test('rejects a key outside the start flags', () => {
    expect(parseStartExtras({ ...BASE_ARGS, bogus: 'x' })).toBeNull()
  })

  test('rejects a flag that belongs to another ctl command', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'token-file': '/tmp/t' })).toBeNull()
  })
})

describe('parsePaneFeatures', () => {
  const REVIEWER = JSON.stringify({
    todos: false,
    subagents: false,
    backgroundTasks: false,
    scheduling: false,
    planMode: false,
    worktree: false,
    notebook: false,
    clientTools: false,
    autoMemory: false,
    bundledSkills: false,
    tools: ['Bash', 'Read'],
  })

  test('translates the reviewer role the way an SDK session does', () => {
    const features = parsePaneFeatures(REVIEWER, 'dontAsk')

    expect(features?.tools).toEqual(['Bash', 'Read'])
    expect(features?.disallowedTools).toEqual(expect.arrayContaining(['TodoWrite', 'Agent', 'Monitor', 'NotebookEdit']))
    expect(features?.env).toEqual({
      CLAUDE_CODE_DISABLE_CRON: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    })
  })

  test('an empty object changes nothing', () => {
    expect(parsePaneFeatures('{}', undefined)).toEqual({ tools: undefined, disallowedTools: [], env: {} })
  })

  test('ignores a key it does not know, as the SDK path does', () => {
    expect(parsePaneFeatures('{"someNewFamily":false,"todos":false}', undefined)?.disallowedTools).toContain(
      'TodoWrite',
    )
  })

  test('rejects what no pane may start with', () => {
    const bad = [
      'not json',
      '[]',
      // The base settings deny both web tools, so simple mode would leave a pane no usable built-in tool.
      '{"simple":true}',
      '{"todos":"no"}',
      '{"tools":[]}',
      '{"tools":["--dangerously-skip-permissions"]}',
      '{"tools":["Bash,Read"]}',
      '{"tools":["Bash Read"]}',
      `{"tools":["${'A'.repeat(65)}"]}`,
    ]

    for (const content of bad) {
      expect(parsePaneFeatures(content, 'dontAsk')).toBeNull()
    }
  })
})
