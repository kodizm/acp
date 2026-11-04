import { describe, expect, test } from 'bun:test'

import { START_FILE_FLAGS, START_FLAGS, parseStartExtras } from '@/live/start-flags.ts'

const BASE_ARGS: Readonly<Record<string, string>> = {
  pane: 'p1',
  cwd: '/work',
  'settings-base': '/etc/settings.json',
}

describe('START_FLAGS', () => {
  test('holds exactly the thirteen start flag names', () => {
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
        'permission-mode',
        'one-shot',
        'deadline-seconds',
        'retain-failed-seconds',
      ].sort(),
    )
  })

  test('file flags are the four hand-off files, all known start flags', () => {
    expect([...START_FILE_FLAGS]).toEqual(['env-file', 'tool-policy', 'system-prompt-file', 'mcp-config'])
    for (const flag of START_FILE_FLAGS) {
      expect(START_FLAGS.has(flag)).toBe(true)
    }
  })
})

describe('parseStartExtras, defaults', () => {
  test('absent optional flags give undefined, false, undefined and 0', () => {
    expect(parseStartExtras(BASE_ARGS)).toEqual({
      permissionMode: undefined,
      oneShot: false,
      deadlineSeconds: undefined,
      retainFailedSeconds: 0,
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
    }

    expect(parseStartExtras(args)).toEqual({
      permissionMode: 'dontAsk',
      oneShot: true,
      deadlineSeconds: 600,
      retainFailedSeconds: 90,
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

describe('parseStartExtras, unknown keys', () => {
  test('rejects a key outside the start flags', () => {
    expect(parseStartExtras({ ...BASE_ARGS, bogus: 'x' })).toBeNull()
  })

  test('rejects a flag that belongs to another ctl command', () => {
    expect(parseStartExtras({ ...BASE_ARGS, 'token-file': '/tmp/t' })).toBeNull()
  })
})
