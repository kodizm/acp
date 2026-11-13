import { describe, expect, test } from 'bun:test'

import { CLI_CONFIG_ENV, parseCliConfig } from '@/live/cli-config.ts'

describe('CLI_CONFIG_ENV', () => {
  test('holds exactly the ten allowlisted switches with their pinned values', () => {
    expect(CLI_CONFIG_ENV).toEqual({
      CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1',
      CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
      CLAUDE_CODE_DISABLE_WEB_FETCH: '1',
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
      DISABLE_AUTOUPDATER: '1',
    })
  })

  test('names no auth, ingest, home, path or other variable the daemon sets itself', () => {
    const protectedName =
      /^(ANTHROPIC_|KODIZM_|CLAUDE_CODE_OAUTH|AWS_|GOOGLE_|HOME$|PATH$|TERM$|CI$|CLAUDE_CONFIG_DIR$|CLAUDE_CODE_DISABLE_BACKGROUND_TASKS$|CLAUDE_CODE_SESSION_ID$|CLAUDE_CODE_CHILD_SESSION$)/

    for (const name of Object.keys(CLI_CONFIG_ENV)) {
      expect(name).not.toMatch(protectedName)
    }
  })
})

describe('parseCliConfig, success', () => {
  test('an empty object changes nothing', () => {
    expect(parseCliConfig('{}')).toEqual({
      ok: true,
      config: {
        disallowedTools: [],
        env: {},
        disableSlashCommands: false,
      },
    })
  })

  test('reads every key of a full config', () => {
    const content = JSON.stringify({
      disallowedTools: ['Monitor', 'Write', 'TodoWrite', 'Monitor'],
      env: {
        CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
      },
      disableSlashCommands: true,
    })

    expect(parseCliConfig(content)).toEqual({
      ok: true,
      config: {
        disallowedTools: ['Monitor', 'Write', 'TodoWrite'],
        env: {
          CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
          CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
        },
        disableSlashCommands: true,
      },
    })
  })

  test('accepts every allowlisted switch at its pinned value', () => {
    const result = parseCliConfig(JSON.stringify({ env: CLI_CONFIG_ENV }))

    expect(result).toEqual({
      ok: true,
      config: {
        disallowedTools: [],
        env: { ...CLI_CONFIG_ENV },
        disableSlashCommands: false,
      },
    })
  })

  test('disableSlashCommands false stays false', () => {
    expect(parseCliConfig('{"disableSlashCommands":false}')).toMatchObject({
      ok: true,
      config: { disableSlashCommands: false },
    })
  })
})

describe('parseCliConfig, refusals', () => {
  test.each([
    ['no JSON', 'not json', undefined],
    ['a JSON array', '[]', undefined],
    ['a JSON string', '"x"', undefined],
    ['null', 'null', undefined],
    ['an unknown top-level key', '{"settings":{}}', 'settings'],
    ['a snake_case spelling of a known key', '{"disallowed_tools":[]}', 'disallowed_tools'],
    ['disallowedTools that is no list', '{"disallowedTools":"Write"}', 'disallowedTools'],
    ['a tool name that is no string', '{"disallowedTools":[1]}', 'disallowedTools'],
    ['a scoped tool rule', '{"disallowedTools":["Bash(rm *)"]}', 'disallowedTools'],
    ['a wildcard tool', '{"disallowedTools":["*"]}', 'disallowedTools'],
    ['an MCP glob', '{"disallowedTools":["mcp__*"]}', 'disallowedTools'],
    ['a tool name with a comma', '{"disallowedTools":["Bash,Read"]}', 'disallowedTools'],
    ['a tool name the CLI reads as an option', '{"disallowedTools":["--x"]}', 'disallowedTools'],
    ['an empty tool name', '{"disallowedTools":[""]}', 'disallowedTools'],
    ['a tool name with a leading digit', '{"disallowedTools":["1Write"]}', 'disallowedTools'],
    ['env that is no object', '{"env":["CLAUDE_CODE_DISABLE_WORKFLOWS"]}', 'env'],
    [
      'an env name outside the allowlist',
      '{"env":{"ANTHROPIC_BASE_URL":"https://evil.example"}}',
      'env.ANTHROPIC_BASE_URL',
    ],
    ['an auth variable', '{"env":{"ANTHROPIC_API_KEY":"sk-ant-x"}}', 'env.ANTHROPIC_API_KEY'],
    ['HOME', '{"env":{"HOME":"/tmp"}}', 'env.HOME'],
    ['PATH', '{"env":{"PATH":"/tmp"}}', 'env.PATH'],
    ['an ingest variable', '{"env":{"KODIZM_LIVE_TOKEN":"x"}}', 'env.KODIZM_LIVE_TOKEN'],
    [
      'an allowlisted name at another value',
      '{"env":{"CLAUDE_CODE_DISABLE_WORKFLOWS":"0"}}',
      'env.CLAUDE_CODE_DISABLE_WORKFLOWS',
    ],
    ['an allowlisted name as a number', '{"env":{"DISABLE_AUTOUPDATER":1}}', 'env.DISABLE_AUTOUPDATER'],
    [
      'prompt suggestion switched on',
      '{"env":{"CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION":"1"}}',
      'env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION',
    ],
    ['disableSlashCommands as a string', '{"disableSlashCommands":"true"}', 'disableSlashCommands'],
    ['disableSlashCommands as a number', '{"disableSlashCommands":1}', 'disableSlashCommands'],
  ])('refuses %s and names the key', (_label, content, key) => {
    expect(parseCliConfig(content)).toEqual({ ok: false, key })
  })

  test('a key that is no plain identifier is refused without being echoed', () => {
    for (const content of ['{"sk-ant-secret value":1}', '{"env":{"sk-ant secret":"1"}}']) {
      const result = parseCliConfig(content)

      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('secret')
    }
  })

  test('a refusal never echoes a value', () => {
    const result = parseCliConfig('{"env":{"ANTHROPIC_API_KEY":"sk-ant-do-not-echo"}}')

    expect(JSON.stringify(result)).not.toContain('sk-ant-do-not-echo')
  })
})
