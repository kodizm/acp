/**
 * The `tmuxd` command line: `ctl` verbs for Laravel, the `hook` helper for the pane settings, and the `daemon` itself.
 *
 * This subcommand is not an ACP server. A ctl verb writes exactly one JSON line `{ok, code, data?}` to stdout and
 * exits with the code `live-ctl.v1.json` maps it to; the hook helper writes a decision or nothing. Diagnostics go to
 * stderr and never carry the token or an env value.
 */

import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createLogger } from '../util/logger.ts'
import {
  type CtlCode,
  type CtlResult,
  DAEMON_VERSION,
  DEFAULT_MAX_PANES,
  LiveDaemon,
  defaultSocketPath,
  exitCodeFor,
  removeHandoffFiles,
} from './daemon.ts'
import { DEFAULT_BASE_SETTINGS_PATH, SocketRequestError, runHookHelper, socketRequest } from './hooks.ts'
import { LIVE_SOCKET } from './pane.ts'
import { START_FILE_FLAGS, parseStartExtras } from './start-flags.ts'

export const USAGE = `Usage: kodizm-acp tmuxd <command>

Commands:
  ctl <verb> [flags]                         Drive a Live pane through the daemon; prints one JSON line.
                                             Verbs: start, prompt, command, cancel, stop, rotate-token, status.
                                             start also takes --permission-mode default|dontAsk, --one-shot 0|1,
                                             --deadline-seconds N, --retain-failed-seconds N and
                                             --mcp-config/--tool-policy/--system-prompt-file PATH.
  hook <Event> --pane <id> --socket <path>   Hook helper the pane settings run; reads the payload on stdin.
  daemon                                     Run the daemon in the foreground; ctl start spawns it detached.

Environment:
  KODIZM_TMUXD_SOCKET        daemon socket (default: $XDG_RUNTIME_DIR or the temp dir, kodizm-live-<uid>/tmuxd.sock)
  KODIZM_TMUXD_TMUX_SOCKET   tmux socket name (default: ${LIVE_SOCKET})
  KODIZM_TMUXD_MAX_PANES     panes per daemon (default: ${DEFAULT_MAX_PANES})
  KODIZM_TMUXD_IDLE_TIMEOUT_SECONDS
                             end a pane with no turn, dialog or activity for N seconds (default: off)
  KODIZM_LIVE_BASE_SETTINGS  base settings with the deny list (default: ${DEFAULT_BASE_SETTINGS_PATH})
  CLAUDE_CODE_PATH           claude binary (default: claude on PATH)
`

const VERBS: ReadonlySet<string> = new Set(['start', 'prompt', 'command', 'cancel', 'stop', 'rotate-token', 'status'])

// Flags naming a file: resolved against the caller's cwd, because the detached daemon has its own.
const PATH_FLAGS: ReadonlySet<string> = new Set([
  'settings-base',
  'env-file',
  'file',
  'token-file',
  'mcp-config',
  'tool-policy',
  'system-prompt-file',
])

// The files Laravel hands each verb (token, auth env, prompt text, start config): the daemon deletes them once read,
// ctl itself when no daemon gets to read them. A Map, because a verb like `constructor` is looked up here.
const HANDOFF_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['start', START_FILE_FLAGS],
  ['prompt', ['file']],
  ['rotate-token', ['token-file']],
])

/** A start waits for SessionStart (10 s) and the settings write; a prompt for up to four Enters. */
const CTL_TIMEOUT_MS = 60_000

const DAEMON_BOOT_MS = 5_000

const STDIN_TIMEOUT_MS = 2_000

/**
 * Run `tmuxd <args>` and resolve with the process exit code.
 */
export async function runTmuxd(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args

  switch (command) {
    case 'ctl':
      return runCtl(rest)
    case 'hook':
      return runHook(rest)
    case 'daemon':
      return runDaemon()
    case undefined:
    case '--help':
    case 'help':
      process.stdout.write(USAGE)

      return 0
    default:
      process.stderr.write(USAGE)

      return 2
  }
}

async function runCtl(args: readonly string[]): Promise<number> {
  const [verb, ...rest] = args
  const flags = parseFlags(rest)
  if (
    verb === undefined ||
    !VERBS.has(verb) ||
    flags === null ||
    (verb === 'start' && parseStartExtras(flags) === null)
  ) {
    await discardHandoff(verb, rest)

    return print(ctlMade('usage_error'))
  }

  const socketPath = socketPathFromEnv()
  const message = {
    kind: 'ctl',
    verb,
    args: flags,
  }

  try {
    return print(await ask(socketPath, message, verb === 'start'))
  } catch (error) {
    if (!(error instanceof SocketRequestError)) {
      throw error
    }
    process.stderr.write(`${JSON.stringify({ level: 'warn', message: error.message, verb })}\n`)

    // A daemon that timed out may still read its file; one never reached will not.
    if (error.reason === 'unreachable') {
      await discardHandoff(verb, rest)
    }

    return print(
      error.reason === 'unreachable'
        ? ctlMade('pane_not_running', { pane: flags.pane, running: false })
        : ctlMade('timeout'),
    )
  }
}

async function ask(socketPath: string, message: unknown, spawnIfMissing: boolean): Promise<CtlResult> {
  try {
    return toResult(await socketRequest(socketPath, message, CTL_TIMEOUT_MS))
  } catch (error) {
    if (!spawnIfMissing || !(error instanceof SocketRequestError) || error.reason !== 'unreachable') {
      throw error
    }
  }

  // Only start brings a daemon up; a second concurrent spawn finds the socket taken and exits.
  spawnDaemon()
  const deadline = Date.now() + DAEMON_BOOT_MS
  for (;;) {
    try {
      return toResult(await socketRequest(socketPath, message, CTL_TIMEOUT_MS))
    } catch (error) {
      if (!(error instanceof SocketRequestError) || error.reason !== 'unreachable' || Date.now() > deadline) {
        throw error
      }
      await Bun.sleep(50)
    }
  }
}

async function runHook(args: readonly string[]): Promise<number> {
  const [event, ...rest] = args
  const flags = parseFlags(rest)

  // Every failure exits 0 with nothing on stdout: the CLI then keeps its dialog for a human.
  try {
    if (event === undefined || flags?.pane === undefined || flags.socket === undefined) {
      return 0
    }

    const output = await runHookHelper({
      event,
      paneId: flags.pane,
      socketPath: flags.socket,
      input: await readStdin(),
    })
    if (output !== '') {
      process.stdout.write(output)
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        message: 'tmuxd hook failed',
        event,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    )
  }

  return 0
}

async function runDaemon(): Promise<number> {
  const env = process.env
  const maxPanes = Number(env.KODIZM_TMUXD_MAX_PANES)
  let shutdown: () => void = () => {}
  const stopped = new Promise<void>((resolveStopped) => {
    shutdown = resolveStopped
  })

  const daemon = new LiveDaemon({
    socketPath: socketPathFromEnv(),
    helperArgv: [process.execPath, process.argv[1] ?? ''],
    home: env.HOME ?? homedir(),
    tmuxSocket: env.KODIZM_TMUXD_TMUX_SOCKET ?? LIVE_SOCKET,
    claudeBin: env.CLAUDE_CODE_PATH,
    baseSettingsPath: env.KODIZM_LIVE_BASE_SETTINGS ?? DEFAULT_BASE_SETTINGS_PATH,
    maxPanes: Number.isInteger(maxPanes) && maxPanes > 0 ? maxPanes : DEFAULT_MAX_PANES,
    logger: createLogger({ env }),
    timings: { idleTimeoutMs: idleTimeoutMs(env) },
    onIdle: () => void daemon.close().then(shutdown),
  })
  await daemon.listen()

  // The last pane leaves through onIdle; a signal tears the panes down the same way.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void daemon.close().then(shutdown))
  }
  await stopped

  return 0
}

/**
 * The idle timeout in ms from `KODIZM_TMUXD_IDLE_TIMEOUT_SECONDS`: a positive integer of seconds, anything else is 0
 * (off), so a typo never ends a pane early.
 */
export function idleTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const seconds = env.KODIZM_TMUXD_IDLE_TIMEOUT_SECONDS

  return seconds !== undefined && /^[1-9]\d*$/.test(seconds) ? Number(seconds) * 1000 : 0
}

/**
 * Start `tmuxd daemon` detached from the caller: its own session, stdio closed, outliving the exec that started it.
 */
function spawnDaemon(): void {
  const child = spawn(process.execPath, [process.argv[1] ?? '', 'tmuxd', 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}

function socketPathFromEnv(): string {
  return process.env.KODIZM_TMUXD_SOCKET ?? defaultSocketPath(process.env, tmpdir())
}

/**
 * `--name value` pairs. Null for anything else: a bare word, a repeated flag or a flag without a value.
 */
function parseFlags(args: readonly string[]): Record<string, string> | null {
  const flags: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? ''
    const value = args[index + 1]
    const name = flag.slice(2)
    if (!flag.startsWith('--') || name === '' || value === undefined || name in flags) {
      return null
    }
    flags[name] = PATH_FLAGS.has(name) ? resolve(value) : value
  }

  return flags
}

/**
 * Delete the hand-off file of a verb no daemon will read. Scans the raw args, so a malformed flag list still gives
 * up its file. A file that cannot be removed goes to stderr by flag and errno code; the reply line still follows.
 */
async function discardHandoff(verb: string | undefined, args: readonly string[]): Promise<void> {
  const flags = verb === undefined ? undefined : HANDOFF_FLAGS.get(verb)
  if (flags === undefined) {
    return
  }

  const files: Array<[string, string]> = []
  for (let index = 0; index < args.length - 1; index += 1) {
    const value = args[index + 1]
    const flag = flags.find((name) => args[index] === `--${name}`)
    if (value !== undefined && flag !== undefined) {
      files.push([flag, resolve(value)])
    }
  }

  for (const failure of await removeHandoffFiles(files)) {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', message: 'tmuxd ctl could not remove a hand-off file', ...failure })}\n`,
    )
  }
}

/**
 * A result ctl itself made, stamped with the version of this build. A daemon reply never passes through here: it is
 * printed as received, so an older daemon's reply stays without the key.
 */
function ctlMade(code: CtlCode, data: Record<string, unknown> = {}): CtlResult {
  return {
    ok: false,
    code,
    data: {
      daemon_version: DAEMON_VERSION,
      ...data,
    },
  }
}

function toResult(response: unknown): CtlResult {
  const code = typeof response === 'object' && response !== null ? (response as CtlResult).code : undefined
  // A code outside the contract maps to no exit code.
  if (typeof code !== 'string' || typeof exitCodeFor(code as CtlCode) !== 'number') {
    throw new SocketRequestError('malformed')
  }

  return response as CtlResult
}

function print(result: CtlResult): number {
  process.stdout.write(`${JSON.stringify(result)}\n`)

  return exitCodeFor(result.code)
}

async function readStdin(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(''), STDIN_TIMEOUT_MS)
  })
  const input = await Promise.race([Bun.stdin.text(), timeout])
  clearTimeout(timer)

  return input
}
