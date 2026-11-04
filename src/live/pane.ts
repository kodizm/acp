/**
 * tmux pane layer of tmuxd: one tmux session per Live pane, each running an interactive Claude CLI.
 *
 * Every call goes to tmux as an argv list, never through a shell, and user text only ever reaches tmux on stdin
 * (`load-buffer -`) or as a literal (`send-keys -l`). The tmux client runs with a minimal env because the server it
 * starts takes that env as its global environment, which every later pane inherits.
 *
 * Timings come from the spike on CLI 2.1.280 (`NUM` lines of the spike results), at twice the measured p95.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { MODEL_NAME, sanitizeCommand, sanitizePrompt } from './input.ts'
import type { PermissionMode } from './start-flags.ts'

export const LIVE_SOCKET = 'kodizm-live'

/** 2x `paste_enter_delay_ms_p95` (164 ms): keys sent sooner after a paste may not submit it. */
export const PASTE_ENTER_DELAY_MS = 328

/** How long each Enter of the ladder waits for its submit signal before the next Enter goes out. */
export const SUBMIT_WINDOWS_MS: readonly number[] = [328, 656, 1312, 2624]

/**
 * 2x the SessionStart p95 of the noisiest spike run (3.6 s; the recorded `sessionstart_ms_p95` is 1139 ms), rounded
 * up: a cold container start is slower than the spike host.
 */
export const SESSION_START_TIMEOUT_MS = 10_000

/** 2x `esc_detect_ms_p95` (207 ms): the composer clear has to land after the TUI has handled the Esc. */
export const CANCEL_CLEAR_DELAY_MS = 414

const PANE_ID = /^[A-Za-z0-9_-]{1,64}$/
const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

// Variables a parent Claude session would set; inherited, they override the pane's own session and transcript.
const DROPPED_ENV: ReadonlySet<string> = new Set(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION'])

// `paste-buffer -S` arrived in tmux 3.7; the image's Debian 13 ships 3.5a, which refuses the flag.
const PASTE_S_SINCE: readonly [number, number] = [3, 7]

export type PaneFailureReason =
  | 'invalid_pane_id'
  | 'invalid_resume_id'
  | 'invalid_model'
  | 'tmux_failed'
  | 'start_timeout'
  | 'not_submitted'
  | 'pane_dead'

export class PaneError extends Error {
  public readonly reason: PaneFailureReason

  public constructor(reason: PaneFailureReason, detail?: string) {
    super(detail === undefined ? `pane ${reason}` : `pane ${reason}: ${detail}`)
    this.name = 'PaneError'
    this.reason = reason
  }
}

/**
 * Waits for a daemon-side signal (a hook event). Resolves true once it arrived within `timeoutMs`, false otherwise.
 */
export type ConfirmSignal = (timeoutMs: number) => Promise<boolean>

/** `aborted`: `abortIf` turned true before the submit signal; the text may still sit in the composer. */
export type DeliveryOutcome = 'submitted' | 'aborted'

export interface Pane {
  /** tmux session name; also the prefix of the pane's paste buffers. */
  readonly id: string
  readonly socket: string
}

export interface CreatePaneOptions {
  /** Matches `^[A-Za-z0-9_-]{1,64}$`, so tmux cannot read it as a `session:window.pane` target. */
  id: string
  cwd: string
  home: string
  settingsPath: string
  /**
   * The only variables the pane gets besides HOME, CI and TERM. PATH falls back to the daemon's PATH. Never put the
   * ingest token or a daemon secret here: the CLI and every tool the model runs can read this env.
   */
  env?: Readonly<Record<string, string>>
  resumeSessionId?: string
  /** Matches {@link MODEL_NAME} and does not start with `-`, so the CLI cannot read it as an option. */
  model?: string
  /** Absolute path of an MCP config file; the pane then loads that file's servers and no others. */
  mcpConfig?: string
  /** Absolute path of a file the CLI appends to its system prompt; only the path ever reaches argv. */
  systemPromptFile?: string
  permissionMode?: PermissionMode
  claudeBin?: string
  socket?: string
  /** Called with {@link SESSION_START_TIMEOUT_MS}; on false the pane is killed and `start_timeout` thrown. */
  confirmStarted?: ConfirmSignal
}

let bufferSequence = 0

// The tail of the seedTrust chain: settles once the last queued seed did, whatever its outcome.
let seeding: Promise<void> = Promise.resolve()

// Keyed by the tmux binary path: the answer of `tmux -V` cannot change while the process runs.
const pasteSFlags = new Map<string, Promise<boolean>>()

/**
 * Whether `tmux -V` output names a tmux with `paste-buffer -S` (3.7 or later). `next-3.9` is a development build
 * ahead of 3.9; anything unreadable counts as an old tmux, which pastes fine without the flag.
 */
export function supportsPasteBufferS(versionOutput: string): boolean {
  const match = /^tmux (?:next-)?(\d+)\.(\d+)[a-z]?$/.exec(versionOutput.trim())
  if (match === null) {
    return false
  }

  const major = Number(match[1])
  const minor = Number(match[2])

  return major > PASTE_S_SINCE[0] || (major === PASTE_S_SINCE[0] && minor >= PASTE_S_SINCE[1])
}

/**
 * Start the CLI in a new detached tmux session.
 *
 * @throws {PaneError} `invalid_pane_id`, `invalid_resume_id`, `invalid_model`, `tmux_failed` (an existing id
 *   included) or `start_timeout`.
 */
export async function createPane(options: CreatePaneOptions): Promise<Pane> {
  const pane: Pane = {
    id: options.id,
    socket: options.socket ?? LIVE_SOCKET,
  }

  // 1. These values end up in tmux and CLI argv: the id could be read as a target, the others as an option.
  if (!PANE_ID.test(pane.id)) {
    throw new PaneError('invalid_pane_id')
  }
  if (options.resumeSessionId !== undefined && !RESUME_ID.test(options.resumeSessionId)) {
    throw new PaneError('invalid_resume_id')
  }
  if (options.model !== undefined && (!MODEL_NAME.test(options.model) || options.model.startsWith('-'))) {
    throw new PaneError('invalid_model')
  }

  // 2. Without trust and onboarding the CLI opens a dialog that withholds every hook and defaults to exit.
  const env = paneEnv(options)
  const cwd = await realpath(options.cwd)
  await seedTrust(
    env.CLAUDE_CONFIG_DIR === undefined ? [env.HOME] : [env.HOME, env.CLAUDE_CONFIG_DIR],
    await trustRoots(cwd),
    approvedKeySuffix(options.env?.ANTHROPIC_API_KEY),
  )

  // 3. tmux overwrites TERM from default-terminal and PATH from the client, so neither goes through -e.
  const { PATH: path, TERM: term, ...sessionEnv } = env
  const created = await run(
    pane.socket,
    [
      'start-server',
      ';',
      'set-option',
      '-g',
      'default-terminal',
      term,
      ';',
      'new-session',
      '-d',
      '-s',
      pane.id,
      '-x',
      '200',
      '-y',
      '50',
      '-c',
      cwd,
      ...Object.entries(sessionEnv).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
      '--',
      ...launchArgv(options),
    ],
    { path },
  )
  if (created.exitCode !== 0) {
    throw new PaneError('tmux_failed', created.stderr)
  }

  // 4. A pane that never reports SessionStart is useless to the daemon; it must not linger.
  if (options.confirmStarted !== undefined && !(await options.confirmStarted(SESSION_START_TIMEOUT_MS))) {
    await killPane(pane)
    throw new PaneError('start_timeout')
  }

  return pane
}

/**
 * Paste a prompt and submit it.
 *
 * The text is sanitised here, so no caller can skip it. It is pasted as one bracketed paste (`-r` keeps LF; on tmux
 * 3.7 and later `-S` keeps control bytes from turning into caret text, and older tmux does not rewrite them at all),
 * then Enter goes separately. Enter is re-sent on the {@link SUBMIT_WINDOWS_MS} ladder until `confirmSubmitted`
 * sees the submit signal. The caller must make sure no permission dialog is open when it calls, and passes
 * `abortIf` for one that opens meanwhile: it is asked before every Enter, because Enter would answer the dialog.
 *
 * @throws {InputRejectedError} for text the prompt channel refuses; nothing is sent then.
 * @throws {PaneError} `pane_dead`, `tmux_failed` or `not_submitted`.
 */
export async function deliverPrompt(
  pane: Pane,
  text: string,
  confirmSubmitted: ConfirmSignal,
  abortIf?: () => boolean,
): Promise<DeliveryOutcome> {
  const payload = sanitizePrompt(text)

  // 1. The buffer is named per delivery so two panes, or two deliveries, never paste each other's text.
  bufferSequence += 1
  const buffer = `${pane.id}-${bufferSequence}`
  await runOnPane(pane, ['load-buffer', '-b', buffer, '-'], new TextEncoder().encode(payload))

  // 2. `-d` deletes the buffer once pasted; a failed paste leaves it, so it is deleted by hand.
  const flags = (await pasteKeepsControlBytes()) ? ['-p', '-d', '-r', '-S'] : ['-p', '-d', '-r']
  const pasted = await run(pane.socket, ['paste-buffer', ...flags, '-b', buffer, '-t', paneTarget(pane)])
  if (pasted.exitCode !== 0) {
    await run(pane.socket, ['delete-buffer', '-b', buffer])
    await failOnPane(pane, pasted.stderr)
  }

  // 3. The signal, not the delay, decides: a late Enter after a submit only hits an empty composer.
  await Bun.sleep(PASTE_ENTER_DELAY_MS)
  for (const windowMs of SUBMIT_WINDOWS_MS) {
    // 4. A dialog after a late submit signal is the turn's own: the prompt went in, so that is no abort.
    if (abortIf?.() === true) {
      return (await confirmSubmitted(0)) ? 'submitted' : 'aborted'
    }
    await runOnPane(pane, ['send-keys', '-t', paneTarget(pane), 'Enter'])
    if (await confirmSubmitted(windowMs)) {
      return 'submitted'
    }
  }

  throw new PaneError('not_submitted')
}

/**
 * Type an allowlisted slash command and submit it.
 *
 * Typed with `send-keys -l`, never pasted: the TUI sends a slash command inside a paste as plain text.
 *
 * @throws {InputRejectedError} for a command outside the allowlist; nothing is sent then.
 * @throws {PaneError} `pane_dead` or `tmux_failed`.
 */
export async function deliverCommand(pane: Pane, command: string): Promise<void> {
  const typed = sanitizeCommand(command)

  await runOnPane(pane, ['send-keys', '-t', paneTarget(pane), '-l', '--', typed])
  await Bun.sleep(PASTE_ENTER_DELAY_MS)
  await runOnPane(pane, ['send-keys', '-t', paneTarget(pane), 'Enter'])
}

/**
 * Interrupt the running turn: Esc, then C-u to clear the prompt the TUI may restore into the composer.
 *
 * Only for a busy pane. On an idle pane the Esc is pending when C-u arrives and swallows it. Esc fires no hook, so
 * the caller detects the cancel from the transcript.
 *
 * @throws {PaneError} `pane_dead` or `tmux_failed`.
 */
export async function cancelPane(pane: Pane): Promise<void> {
  await runOnPane(pane, ['send-keys', '-t', paneTarget(pane), 'Escape'])
  await Bun.sleep(CANCEL_CLEAR_DELAY_MS)
  await runOnPane(pane, ['send-keys', '-t', paneTarget(pane), 'C-u'])
}

/**
 * True while the CLI runs: its exit closes the tmux session. False as well when no tmux server is up.
 */
export async function paneAlive(pane: Pane): Promise<boolean> {
  return (await run(pane.socket, ['has-session', '-t', sessionTarget(pane)])).exitCode === 0
}

/**
 * Kill the pane. A pane already gone counts as killed. The tmux server exits on its own with its last session.
 *
 * @throws {PaneError} `tmux_failed` when the session survives.
 */
export async function killPane(pane: Pane): Promise<void> {
  const result = await run(pane.socket, ['kill-session', '-t', sessionTarget(pane)])
  if (result.exitCode !== 0 && (await paneAlive(pane))) {
    throw new PaneError('tmux_failed', result.stderr)
  }
}

type PaneEnv = Record<string, string> & {
  PATH: string
  HOME: string
  TERM: string
}

function paneEnv(options: CreatePaneOptions): PaneEnv {
  const env: Record<string, string> & { PATH: string } = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (!DROPPED_ENV.has(name)) {
      env[name] = value
    }
  }

  return {
    ...env,
    HOME: options.home,
    CI: '1',
    TERM: 'xterm-256color',
    // A background task outlives the turn that started it, which a one-shot pane cannot allow; no caller overrides it.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  }
}

function launchArgv(options: CreatePaneOptions): string[] {
  // An empty `--setting-sources` loads no source but the `--settings` file (CLI 2.1.280). That keeps the repository's
  // settings out, so a repo `disableAllHooks` cannot silence the hooks the daemon depends on, and keeps the user file
  // out too: its clone guards (`Edit` denies on /workspace/.default and .repos) would block a main-checkout pane, and
  // the pane file already carries everything else the user file holds.
  const argv = [options.claudeBin ?? 'claude', '--settings', options.settingsPath, '--setting-sources', '']
  if (options.permissionMode !== undefined) {
    argv.push('--permission-mode', options.permissionMode)
  }
  if (options.mcpConfig !== undefined) {
    // `--mcp-config` takes any number of values, so the strict flag has to follow the path directly.
    argv.push('--mcp-config', options.mcpConfig, '--strict-mcp-config')
  }
  if (options.systemPromptFile !== undefined) {
    argv.push('--append-system-prompt-file', options.systemPromptFile)
  }
  if (options.model !== undefined) {
    argv.push('--model', options.model)
  }
  if (options.resumeSessionId !== undefined) {
    argv.push('--resume', options.resumeSessionId)
  }

  return argv
}

/**
 * The directories the CLI may ask to trust: the working directory, the repository root above it, and for a linked
 * worktree the main checkout. A missing `.git`, gitdir or commondir adds no root; any other read error
 * propagates. Reads files only, never runs git.
 */
async function trustRoots(cwd: string): Promise<string[]> {
  const roots = new Set([cwd])
  const repository = await findGitEntry(cwd)
  if (repository === null) {
    return [...roots]
  }

  roots.add(repository.root)
  if (repository.isFile) {
    const main = await worktreeMainRoot(repository.root)
    if (main !== null) {
      roots.add(main)
    }
  }

  return [...roots]
}

/** The nearest directory at or above `start` that holds a `.git` entry. */
async function findGitEntry(start: string): Promise<{ root: string; isFile: boolean } | null> {
  let dir = start
  while (true) {
    const entry = await statIfPresent(join(dir, '.git'))
    if (entry !== null) {
      return {
        root: dir,
        isFile: entry.isFile(),
      }
    }

    const parent = dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

/**
 * The main checkout of the linked worktree rooted at `root`: its `.git` file names the worktree's git dir, whose
 * `commondir` points at the main `.git`.
 */
async function worktreeMainRoot(root: string): Promise<string | null> {
  const gitfile = await readTextIfPresent(join(root, '.git'))
  const target = gitfile === null ? undefined : /^gitdir:\s*(.+?)\s*$/m.exec(gitfile)?.[1]
  if (target === undefined) {
    return null
  }

  const gitdir = resolve(root, target)
  const commondir = await readTextIfPresent(join(gitdir, 'commondir'))
  if (commondir === null) {
    return null
  }

  return realpathIfPresent(dirname(resolve(gitdir, commondir.trim())))
}

async function statIfPresent(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path)
  } catch (error) {
    if (isAbsent(error)) {
      return null
    }

    throw error
  }
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsent(error)) {
      return null
    }

    throw error
  }
}

async function realpathIfPresent(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isAbsent(error)) {
      return null
    }

    throw error
  }
}

function isAbsent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** What the CLI keeps in `customApiKeyResponses.approved` for a key: its last 20 characters. */
function approvedKeySuffix(apiKey: string | undefined): string | undefined {
  return apiKey === undefined || apiKey === '' ? undefined : apiKey.slice(-20)
}

function approveKey(current: unknown, suffix: string): Record<string, unknown> {
  const responses = isRecord(current) ? current : {}
  const approved = stringList(responses.approved)

  return {
    ...responses,
    approved: approved.includes(suffix) ? approved : [...approved, suffix],
    rejected: stringList(responses.rejected),
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Seed the `.claude.json` files one start after the other. Every pane of a daemon shares a home, so two concurrent
 * read-modify-writes would drop each other's roots. A failed seed rejects for its own caller only; the next one runs.
 */
function seedTrust(dirs: readonly string[], roots: readonly string[], keySuffix: string | undefined): Promise<void> {
  const seeded = seeding.then(() => writeTrust(dirs, roots, keySuffix))
  seeding = seeded.catch(() => undefined)

  return seeded
}

/**
 * Mark onboarding done and every root trusted in each `.claude.json`, and approve the API key suffix so the CLI does
 * not ask about the key, keeping whatever else the file holds. The trust entries are keyed by realpath: macOS `/tmp`
 * is `/private/tmp`.
 */
async function writeTrust(
  dirs: readonly string[],
  roots: readonly string[],
  keySuffix: string | undefined,
): Promise<void> {
  for (const dir of dirs) {
    const path = join(dir, '.claude.json')
    const config = await readConfig(path)
    const projects = isRecord(config.projects) ? config.projects : {}

    for (const root of roots) {
      const project = isRecord(projects[root]) ? projects[root] : {}

      projects[root] = {
        allowedTools: [],
        ...project,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      }
    }
    const seeded = {
      theme: 'dark',
      ...config,
      hasCompletedOnboarding: true,
      projects,
      ...(keySuffix === undefined
        ? {}
        : { customApiKeyResponses: approveKey(config.customApiKeyResponses, keySuffix) }),
    }

    // The CLI reads this file at start; a rename keeps it from seeing a half-written one.
    await mkdir(dir, { recursive: true })
    const staging = `${path}.${randomUUID()}.tmp`
    await writeFile(staging, JSON.stringify(seeded, null, 2), { mode: 0o600 })
    await rename(staging, path)
  }
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    return {}
  }

  const config: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(config)) {
    throw new Error(`${path} does not hold a JSON object`)
  }

  return config
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `=` makes tmux match the session name exactly; without it `has-session -t abc` also finds `abcdef`.
function sessionTarget(pane: Pane): string {
  return `=${pane.id}`
}

function paneTarget(pane: Pane): string {
  return `=${pane.id}:`
}

interface TmuxResult {
  exitCode: number
  stderr: string
}

interface RunOptions {
  stdin?: Uint8Array
  /** tmux gives a new session the PATH of the client that creates it and ignores `-e PATH=`. */
  path?: string
}

// Resolved on the daemon's PATH: the client PATH may be the pane's, which need not contain tmux.
function tmuxBinary(): string {
  const binary = Bun.which('tmux')
  if (binary === null) {
    throw new PaneError('tmux_failed', 'tmux is not on PATH')
  }

  return binary
}

/** Asked once per tmux binary: whether this tmux takes `paste-buffer -S`. */
function pasteKeepsControlBytes(): Promise<boolean> {
  const binary = tmuxBinary()
  let known = pasteSFlags.get(binary)
  if (known === undefined) {
    known = tmuxVersion(binary).then(supportsPasteBufferS)
    pasteSFlags.set(binary, known)
  }

  return known
}

async function tmuxVersion(binary: string): Promise<string> {
  const child = Bun.spawn([binary, '-V'], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()])

  return exitCode === 0 ? output : ''
}

async function run(socket: string, args: readonly string[], options: RunOptions = {}): Promise<TmuxResult> {
  // 1. The binary on the daemon's PATH, whatever PATH the client gets.
  const binary = tmuxBinary()

  // 2. Only PATH and TMUX_TMPDIR (where the socket lives) reach the client, and so the server's global env.
  const env: Record<string, string> = {
    PATH: options.path ?? process.env.PATH ?? '/usr/bin:/bin',
  }
  if (process.env.TMUX_TMPDIR !== undefined) {
    env.TMUX_TMPDIR = process.env.TMUX_TMPDIR
  }

  // 3. stdout stays ignored: this process's stdout carries ACP frames.
  const child = Bun.spawn([binary, '-L', socket, '-f', '/dev/null', ...args], {
    env,
    stdin: options.stdin ?? 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

  return {
    exitCode,
    stderr: stderr.trim(),
  }
}

async function runOnPane(pane: Pane, args: readonly string[], stdin?: Uint8Array): Promise<void> {
  const result = await run(pane.socket, args, { stdin })
  if (result.exitCode !== 0) {
    await failOnPane(pane, result.stderr)
  }
}

async function failOnPane(pane: Pane, stderr: string): Promise<never> {
  if (!(await paneAlive(pane))) {
    throw new PaneError('pane_dead')
  }

  throw new PaneError('tmux_failed', stderr)
}
