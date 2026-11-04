import { describe, expect, test } from 'bun:test'

import { InputRejectedError, type InputRejectionReason, sanitizeCommand, sanitizePrompt } from '@/live/input.ts'

function rejectionOf(run: () => unknown): InputRejectionReason | null {
  try {
    run()
  } catch (error) {
    if (error instanceof InputRejectedError) {
      return error.reason
    }
    throw error
  }

  return null
}

describe('sanitizePrompt, stripped bytes', () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    ['ESC', 'a\x1bb', 'ab'],
    ['bracketed paste end marker', 'before\x1b[201~after', 'before[201~after'],
    ['C1 CSI U+009B', 'a\u009b2Jb', 'a2Jb'],
    ['C1 range bounds', 'a\u0080b\u009fc', 'abc'],
    ['ETX 0x03', 'stop\x03here', 'stophere'],
    ['NUL', 'a\x00b', 'ab'],
    ['DEL', 'a\x7fb', 'ab'],
    ['CR of a CRLF', 'one\r\ntwo', 'one\ntwo'],
    ['vertical tab and form feed', 'a\x0bb\x0cc', 'abc'],
  ]

  for (const [label, input, expected] of cases) {
    test(label, () => {
      expect(sanitizePrompt(input)).toBe(expected)
    })
  }
})

describe('sanitizePrompt, kept bytes', () => {
  test('keeps LF, unicode and a literal C-c byte-exact', () => {
    const text = 'line one\nline two: çğıöşü 漢字 🙂\nC-c literal ^C'
    expect(sanitizePrompt(text)).toBe(text)
  })

  test('maps a tab to four spaces, which is what the TUI does with it', () => {
    expect(sanitizePrompt('a\tb')).toBe('a    b')
  })

  test('accepts a ! or / that is not the first non-blank character', () => {
    expect(sanitizePrompt('run !ls and read /etc/hosts')).toBe('run !ls and read /etc/hosts')
  })

  test('keeps a long payload intact', () => {
    const text = 'x'.repeat(52_000)
    expect(sanitizePrompt(text)).toBe(text)
  })
})

describe('sanitizePrompt, rejected prompts', () => {
  const cases: ReadonlyArray<[string, string, InputRejectionReason]> = [
    ['leading !', '!rm -rf /', 'bash_mode'],
    ['leading space then !', '  !id', 'bash_mode'],
    ['leading newline and tab then !', '\n\t!id', 'bash_mode'],
    ['leading /', '/clear', 'slash_command'],
    ['leading space then /', ' /model opus', 'slash_command'],
    ['a / revealed by stripping a control byte', '\x1b/compact', 'slash_command'],
    ['a ! revealed by stripping C1', '\u009b!id', 'bash_mode'],
    ['empty prompt', '', 'empty'],
    ['only blanks and control bytes', ' \n\x1b\x03\t', 'empty'],
  ]

  for (const [label, input, reason] of cases) {
    test(label, () => {
      expect(rejectionOf(() => sanitizePrompt(input))).toBe(reason)
    })
  }

  test('the rejection message never echoes the prompt', () => {
    try {
      sanitizePrompt('!secret-value-here')
    } catch (error) {
      expect(String(error)).not.toContain('secret-value-here')
      return
    }
    throw new Error('expected a rejection')
  })
})

describe('sanitizeCommand', () => {
  const accepted: ReadonlyArray<[string, string]> = [
    ['/compact', '/compact'],
    ['/clear', '/clear'],
    ['/model opus', '/model opus'],
    ['/model claude-sonnet-4.5:1m_x', '/model claude-sonnet-4.5:1m_x'],
    ['/model claude-opus-4-5[1m]', '/model claude-opus-4-5[1m]'],
    ['  /clear\n', '/clear'],
  ]

  for (const [input, expected] of accepted) {
    test(`accepts ${JSON.stringify(input)}`, () => {
      expect(sanitizeCommand(input)).toBe(expected)
    })
  }

  const rejected: ReadonlyArray<[string, InputRejectionReason]> = [
    ['/compact now', 'unknown_command'],
    ['/login', 'unknown_command'],
    ['!id', 'unknown_command'],
    ['compact', 'unknown_command'],
    ['/clear\x1b[201~', 'unknown_command'],
    ['/clear\n/login', 'unknown_command'],
    ['/model', 'invalid_model_alias'],
    ['/model ', 'invalid_model_alias'],
    ['/model opus; rm -rf /', 'invalid_model_alias'],
    ['/model opus\nsonnet', 'invalid_model_alias'],
    ['/model op\x1bus', 'invalid_model_alias'],
    ['/model opus{1m}', 'invalid_model_alias'],
    ['/model opus/1m', 'invalid_model_alias'],
    [`/model ${'a'.repeat(65)}`, 'invalid_model_alias'],
  ]

  for (const [input, reason] of rejected) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      expect(rejectionOf(() => sanitizeCommand(input))).toBe(reason)
    })
  }

  test('accepts a 64 character alias', () => {
    const command = `/model ${'a'.repeat(64)}`
    expect(sanitizeCommand(command)).toBe(command)
  })
})
