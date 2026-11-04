/**
 * Hooks of a Live pane: the per-pane `--settings` file and the helper every hook command runs.
 *
 * Each hook is a command hook that runs `tmuxd hook <Event>`: the helper reads the CLI's JSON payload from stdin,
 * hands it to the daemon over its unix socket and exits. Only PermissionRequest waits for an answer, and its helper
 * prints a decision only when the daemon returns an explicit allow or deny. Every failure (no daemon, a closed socket,
 * a timeout, a malformed answer) prints nothing and exits 0, which leaves the CLI's dialog open for a human: an allow
 * is never a default.
 *
 * The settings file never carries the ingest token; hooks reach only the local daemon.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export const DEFAULT_BASE_SETTINGS_PATH = '/home/agent/.claude/kodizm-live-base.json'

/** CLI-side timeout of a reporting hook; the helper gives up well before it. */
export const HOOK_TIMEOUT_S = 10

/**
 * CLI-side timeout of the PermissionRequest hook. Larger than the permission row expiry (30 minutes by default), so
 * the row expires and the hook answers from Laravel before the CLI cancels the hook. The spike confirmed 2.1.280
 * accepts it.
 */
export const PERMISSION_HOOK_TIMEOUT_S = 3600

/** How long a reporting helper waits for the daemon's acknowledgement. */
export const HELPER_TIMEOUT_MS = 3_000

// The permission helper exits on its own a little before the CLI would kill it.
const PERMISSION_HELPER_TIMEOUT_MS = PERMISSION_HOOK_TIMEOUT_S * 1000 - 5_000

export interface PaneSettingsOptions {
  /** The image's base settings holding the deny list. A missing file fails the start: no pane runs without it. */
  basePath: string
  /** Runtime and script that run tmuxd, e.g. `[bun, /path/to/index.js]`. */
  helperArgv: readonly string[]
  socketPath: string
  paneId: string
  /** Rules of the session's tool policy, appended after the base file's own entries. */
  rules?: PermissionRules
}

/** CLI `permissions` rule strings, already translated from the canonical tool policy. */
export interface PermissionRules {
  allow: string[]
  deny: string[]
  ask: string[]
}

export interface HookHelperOptions {
  event: string
  paneId: string
  socketPath: string
  /** The CLI's stdin, the hook payload JSON. */
  input: string
  timeoutMs?: number
}

/** `unreachable`: nothing listens on the socket; every other reason means a daemon was there. */
export type SocketFailure = 'unreachable' | 'timeout' | 'closed' | 'malformed'

export class SocketRequestError extends Error {
  public readonly reason: SocketFailure

  public constructor(reason: SocketFailure, detail?: string) {
    super(detail === undefined ? `daemon socket ${reason}` : `daemon socket ${reason}: ${detail}`)
    this.name = 'SocketRequestError'
    this.reason = reason
  }
}

/**
 * The pane settings: the base file as it is (its deny list included), every hook pointing at the helper, and
 * `disableAllHooks: false` so nothing the base or a later layer sets can silence them. Hooks the base declares are
 * replaced, not merged: the daemon's hooks are the only ones a Live pane runs.
 *
 * With `rules`, each of `permissions.allow|deny|ask` is the base entries followed by the rule entries, deduped; every
 * other base `permissions` key (a `defaultMode` included) is kept, and no mode is ever written here.
 *
 * @throws when the base file is missing or does not hold a JSON object
 */
export async function buildPaneSettings(options: PaneSettingsOptions): Promise<Record<string, unknown>> {
  const base: unknown = JSON.parse(await readFile(options.basePath, 'utf8'))
  if (!isRecord(base)) {
    throw new Error(`${options.basePath} does not hold a JSON object`)
  }

  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: 'command',
              command: hookCommand(options, event),
              timeout: event === 'PermissionRequest' ? PERMISSION_HOOK_TIMEOUT_S : HOOK_TIMEOUT_S,
            },
          ],
        },
      ],
    ]),
  )

  const settings: Record<string, unknown> = {
    ...base,
    disableAllHooks: false,
    // CLI 2.1.318 defaults this on when flagSettings lacks the key; an unattended pane would sleep at a usage limit.
    autoContinueAtUsageLimit: false,
    hooks,
  }
  if (options.rules !== undefined) {
    settings.permissions = mergePermissions(base.permissions, options.rules)
  }

  return settings
}

function mergePermissions(base: unknown, rules: PermissionRules): Record<string, unknown> {
  const permissions = isRecord(base) ? base : {}
  const merge = (list: keyof PermissionRules): string[] => {
    const own = permissions[list]
    const entries = Array.isArray(own) ? own.filter((entry) => typeof entry === 'string') : []

    return [...new Set([...entries, ...rules[list]])]
  }

  return {
    ...permissions,
    allow: merge('allow'),
    deny: merge('deny'),
    ask: merge('ask'),
  }
}

/**
 * Write the pane settings with mode 0600. The rename keeps the CLI from reading a half-written file.
 */
export async function writePaneSettings(path: string, options: PaneSettingsOptions): Promise<void> {
  const settings = await buildPaneSettings(options)
  const staging = `${path}.${process.pid}.tmp`

  await writeFile(staging, JSON.stringify(settings, null, 2), { mode: 0o600 })
  await rename(staging, path)
}

/**
 * Run one hook: forward the payload, return what the hook prints on stdout. Empty unless the event is a
 * PermissionRequest and the daemon answered explicitly.
 */
export async function runHookHelper(options: HookHelperOptions): Promise<string> {
  const payload = parseObject(options.input)
  if (payload === null) {
    return ''
  }

  const blocking = options.event === 'PermissionRequest'
  const timeoutMs = options.timeoutMs ?? (blocking ? PERMISSION_HELPER_TIMEOUT_MS : HELPER_TIMEOUT_MS)

  let response: unknown
  try {
    response = await socketRequest(
      options.socketPath,
      {
        kind: 'hook',
        pane: options.paneId,
        event: options.event,
        payload,
      },
      timeoutMs,
    )
  } catch (error) {
    // Fail closed on purpose: no answer leaves the dialog to a human.
    if (error instanceof SocketRequestError) {
      process.stderr.write(`${JSON.stringify({ level: 'warn', message: error.message, event: options.event })}\n`)

      return ''
    }
    throw error
  }

  return blocking && isRecord(response) ? hookDecisionOutput(response.decision) : ''
}

/**
 * The PermissionRequest hook output for an explicit `allow` or `deny`; an empty string for anything else.
 */
export function hookDecisionOutput(decision: unknown): string {
  if (!isRecord(decision) || (decision.behavior !== 'allow' && decision.behavior !== 'deny')) {
    return ''
  }

  const answer: Record<string, string> = {
    behavior: decision.behavior,
  }
  if (decision.behavior === 'deny' && typeof decision.message === 'string') {
    answer.message = decision.message
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: answer,
    },
  })
}

/**
 * Send one JSON line to the daemon socket and resolve with the one JSON line it answers.
 *
 * @throws {SocketRequestError} on a connection error, a close before the answer, a timeout or an answer that is not
 *   JSON
 */
export function socketRequest(path: string, message: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let buffer = ''
    let settled = false

    const finish = (outcome: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      outcome()
    }
    const timer = setTimeout(() => finish(() => reject(new SocketRequestError('timeout'))), timeoutMs)
    let connected = false

    socket.on('connect', () => {
      connected = true
      socket.write(`${JSON.stringify(message)}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      const answer = parseJson(buffer.slice(0, newline))
      finish(() => (answer === undefined ? reject(new SocketRequestError('malformed')) : resolve(answer.value)))
    })
    socket.on('error', (error) =>
      finish(() => reject(new SocketRequestError(connected ? 'closed' : 'unreachable', error.message))),
    )
    socket.on('close', () => finish(() => reject(new SocketRequestError(connected ? 'closed' : 'unreachable'))))
  })
}

/**
 * Quote one argument for `sh -c`, the way the CLI runs a command hook.
 */
export function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", "'\\''")}'`
}

function hookCommand(options: PaneSettingsOptions, event: HookEvent): string {
  return [...options.helperArgv, 'tmuxd', 'hook', event, '--pane', options.paneId, '--socket', options.socketPath]
    .map(shellQuote)
    .join(' ')
}

function parseObject(text: string): Record<string, unknown> | null {
  const parsed = parseJson(text)

  return parsed !== undefined && isRecord(parsed.value) ? parsed.value : null
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
