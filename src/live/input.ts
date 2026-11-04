/**
 * Input rules for a Live pane: what a caller may type into the Claude CLI TUI.
 *
 * Two channels, never mixed. The prompt channel carries text only; the TUI turns a leading `/` into a slash command
 * and a leading `!` into bash mode, so a prompt starting with either is rejected rather than escaped. Slash commands
 * come through the command channel, which accepts an allowlist and nothing else.
 *
 * The stripped set is what the spike on CLI 2.1.280 showed the TUI does not keep from a paste: ESC (which also
 * carries the bracketed paste end marker), the other C0 controls except LF, DEL and C1. A tab becomes four spaces,
 * which is what the TUI renders it as anyway.
 */

/**
 * Why a prompt or command was refused.
 */
export type InputRejectionReason = 'bash_mode' | 'slash_command' | 'empty' | 'unknown_command' | 'invalid_model_alias'

/**
 * Thrown for input the pane must not receive. The message never carries the input: a prompt may hold a secret.
 */
export class InputRejectedError extends Error {
  public readonly reason: InputRejectionReason

  public constructor(reason: InputRejectionReason) {
    super(`input rejected: ${reason}`)
    this.name = 'InputRejectedError'
    this.reason = reason
  }
}

const TAB_REPLACEMENT = '    '

const MODEL_ALIAS = /^[A-Za-z0-9._:-]{1,64}$/

const BARE_COMMANDS: ReadonlySet<string> = new Set(['/compact', '/clear'])

/**
 * Turn caller text into the exact bytes the pane is pasted.
 *
 * The leading-character check runs after stripping, so a control byte cannot hide a `/` or `!` in front of it.
 *
 * @throws {InputRejectedError} `bash_mode`, `slash_command`, or `empty` when nothing but blanks remains.
 */
export function sanitizePrompt(text: string): string {
  let sanitized = ''
  for (const char of text.replaceAll('\t', TAB_REPLACEMENT)) {
    if (!isStrippedControl(char.charCodeAt(0))) {
      sanitized += char
    }
  }
  const first = sanitized.trimStart().charAt(0)

  if (first === '') {
    throw new InputRejectedError('empty')
  }
  if (first === '!') {
    throw new InputRejectedError('bash_mode')
  }
  if (first === '/') {
    throw new InputRejectedError('slash_command')
  }

  return sanitized
}

// C0 except LF, then DEL and the C1 block. Every one is a single UTF-16 unit; an astral character starts with a
// surrogate, which is never in range.
function isStrippedControl(code: number): boolean {
  return (code <= 0x1f && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
}

/**
 * Check a slash command against the allowlist: `/compact`, `/clear` or `/model <alias>`.
 *
 * Surrounding whitespace is dropped; everything else has to match exactly, so no control byte, newline or second
 * command can ride along.
 *
 * @returns the canonical command text to type into the pane
 * @throws {InputRejectedError} `unknown_command`, or `invalid_model_alias` for a `/model` with a bad alias.
 */
export function sanitizeCommand(command: string): string {
  const trimmed = command.trim()

  if (BARE_COMMANDS.has(trimmed)) {
    return trimmed
  }
  if (trimmed !== '/model' && !trimmed.startsWith('/model ')) {
    throw new InputRejectedError('unknown_command')
  }

  const alias = trimmed.slice('/model '.length)
  if (!MODEL_ALIAS.test(alias)) {
    throw new InputRejectedError('invalid_model_alias')
  }

  return `/model ${alias}`
}
