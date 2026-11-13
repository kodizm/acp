import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { idleTimeoutMs } from '@/live/ctl.ts'
import {
  type CtlResult,
  DAEMON_VERSION,
  HEARTBEAT_INTERVAL_MS,
  LiveDaemon,
  type LiveDaemonOptions,
} from '@/live/daemon.ts'
import type { LiveEvent } from '@/live/events.ts'
import * as paneModule from '@/live/pane.ts'
import { paneAlive } from '@/live/pane.ts'
import type { Logger } from '@/util/logger.ts'
import pkg from '../../../package.json' with { type: 'json' }

// Runs the daemon in-process against a real tmux (socket kdz-test) and a stub CLI. The stub reads the pane's
// --settings file and runs its hook commands exactly as the CLI does (sh -c, payload on stdin, stdout as the
// decision), so every hook goes through the real `tmuxd hook` helper and the daemon's unix socket. Hook payload and
// transcript shapes follow what CLI 2.1.280 produced in a captured real session.
const SOCKET = 'kdz-test'
const PACKAGE_ROOT = join(import.meta.dir, '..', '..', '..')
const ENTRY = join(PACKAGE_ROOT, 'src', 'index.ts')
const API_KEY = 'kgw-FAKE0000000000000000000000'
const AUTH_TOKEN = 'plain-known-auth-value-42'

const STUB = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const dir = dirname(process.argv[1])
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'))
writeFileSync(join(dir, 'args.json'), JSON.stringify(args))
writeFileSync(join(dir, 'env.json'), JSON.stringify(process.env))
const resume = flag('--resume')
const sid = resume ?? crypto.randomUUID()
const transcript = join(process.env.HOME, '.claude', 'projects', 'stub', sid + '.jsonl')
mkdirSync(dirname(transcript), { recursive: true })
const now = () => new Date().toISOString()
const record = (value) => appendFileSync(transcript, JSON.stringify(value) + '\\n')
const usage = { input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }
const assistant = (id, block, stop) => record({
  type: 'assistant', isSidechain: false, timestamp: now(),
  message: { id, role: 'assistant', model: 'claude-stub', stop_reason: stop, content: [block], usage },
})
const apiError = (error, status, text) => record({
  type: 'assistant', isSidechain: false, isApiErrorMessage: true, error, apiErrorStatus: status, timestamp: now(),
  message: { model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
})
const marker = (text) => record({
  type: 'user', isSidechain: false, timestamp: now(), message: { role: 'user', content: [{ type: 'text', text }] },
})

async function hook(event, extra = {}) {
  const entry = settings.hooks?.[event]?.[0]?.hooks?.[0]
  if (entry === undefined) return ''
  const payload = { session_id: sid, transcript_path: transcript, cwd: process.cwd(), hook_event_name: event, ...extra }
  const child = Bun.spawn(['sh', '-c', entry.command], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const timer = setTimeout(() => child.kill(), entry.timeout * 1000)
  const out = await new Response(child.stdout).text()
  await child.exited
  clearTimeout(timer)
  return out
}

let running = false
let waitingHuman = null
let waitingEsc = null
let turn = 0

async function submit(prompt) {
  running = true
  turn += 1
  // A dialog that opens before the submit is confirmed: the daemon must stop pressing Enter.
  if (prompt.includes('PREDIALOG')) {
    await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pre' }, permission_suggestions: [] })
    return
  }
  const mid = 'msg_stub_' + turn
  const toolUseId = 'toolu_STUB' + turn
  await hook('UserPromptSubmit', { prompt, prompt_id: crypto.randomUUID(), permission_mode: 'default' })
  if (prompt.includes('TOOL')) {
    const input = { command: 'touch stub.txt' }
    assistant(mid, { type: 'tool_use', id: toolUseId, name: 'Bash', input }, 'tool_use')
    await hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: toolUseId })
    const out = await hook('PermissionRequest', { tool_name: 'Bash', tool_input: input, permission_suggestions: [] })
    appendFileSync(join(dir, 'decisions.log'), JSON.stringify(out) + '\\n')
    let behavior = out === '' ? '' : JSON.parse(out).hookSpecificOutput.decision.behavior
    if (behavior === '') {
      behavior = await new Promise((resolve) => { waitingHuman = resolve })
    }
    if (behavior === 'interrupted') {
      marker('[Request interrupted by user for tool use]')
      running = false
      return
    }
    if (behavior === 'allow') {
      await hook('PostToolUse', {
        tool_name: 'Bash', tool_input: input, tool_use_id: toolUseId, tool_response: { stdout: 'ran', stderr: '' },
      })
    }
    assistant(mid + 'b', { type: 'text', text: 'tool ' + behavior }, 'end_turn')
    await hook('Stop', { last_assistant_message: 'tool ' + behavior, stop_hook_active: false })
  } else if (prompt.includes('HANG')) {
    assistant(mid, { type: 'text', text: 'hanging' }, 'end_turn')
  } else if (prompt.includes('SLOW') || prompt.includes('MUTE')) {
    assistant(mid, { type: 'thinking', thinking: 'slow' }, null)
    await new Promise((resolve) => { waitingEsc = resolve })
    if (prompt.includes('SLOW') || prompt.includes('MUTE_MARK')) marker('[Request interrupted by user]')
  } else if (prompt.includes('APIERR_STOP') || prompt.includes('APIERR_META')) {
    apiError('rate_limit', 429, 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited')
    if (prompt.includes('APIERR_META')) {
      record({
        type: 'user', isSidechain: false, isMeta: true, timestamp: now(),
        message: { role: 'user', content: 'Caveat: the messages below were generated by the user.' },
      })
    }
    await hook('Stop', { last_assistant_message: '', stop_hook_active: false })
  } else if (prompt.includes('APIERR_USAGE')) {
    apiError('rate_limit', 429, "You've hit your session limit · resets 3pm")
    if (prompt.includes('APIERR_USAGE_HOOK')) {
      await hook('StopFailure', { error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: '' })
    }
  } else if (prompt.includes('APIERR_429')) {
    apiError('rate_limit', 429, 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited')
  } else if (prompt.includes('APIERR_401')) {
    apiError('authentication_failed', 401, 'Please run /login · API Error: 401 Invalid authentication credentials')
  } else if (prompt.includes('HOOK_AUTH')) {
    await hook('StopFailure', { error: 'authentication_failed', error_details: '401 Unauthorized', last_assistant_message: '' })
  } else if (prompt.includes('FAIL')) {
    await hook('StopFailure', { error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: '' })
  } else if (prompt.includes('BARE')) {
    await hook('Stop', { stop_hook_active: false })
  } else {
    assistant(mid, { type: 'thinking', thinking: 'thinking about ' + prompt }, 'end_turn')
    assistant(mid, {
      type: 'text',
      text: 'echo ' + prompt + ' key=' + process.env.ANTHROPIC_API_KEY + ' auth=' + process.env.ANTHROPIC_AUTH_TOKEN,
    }, 'end_turn')
    await hook('Stop', { last_assistant_message: 'done ' + process.env.ANTHROPIC_AUTH_TOKEN, stop_hook_active: false })
  }
  running = false
}

function onEnter(line) {
  if (waitingHuman !== null) {
    const resolve = waitingHuman
    waitingHuman = null
    resolve('allow')
    return
  }
  if (line.trim() === '' || running) return
  if (line.startsWith('/')) {
    appendFileSync(join(dir, 'commands.log'), line + '\\n')
    return
  }
  void submit(line)
}

function onEsc() {
  if (waitingHuman !== null) {
    const resolve = waitingHuman
    waitingHuman = null
    resolve('interrupted')
  }
  if (waitingEsc !== null) {
    const resolve = waitingEsc
    waitingEsc = null
    resolve()
  }
}

Bun.spawnSync(['stty', 'raw', '-echo'], { stdin: 'inherit' })
process.stdout.write('\\x1b[?2004h')
let buffer = ''
process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8').replaceAll('\\x1b[200~', '').replaceAll('\\x1b[201~', '')
  for (const char of text) {
    if (char === '\\x1b') { onEsc(); continue }
    if (char === '\\x15') { buffer = ''; continue }
    if (char === '\\r') { const line = buffer; buffer = ''; onEnter(line); continue }
    buffer += char
  }
})
await hook('SessionStart', { source: resume === undefined ? 'startup' : 'resume', model: 'claude-stub' })
`

type PermissionMode = 'pending' | 'fail' | 'hang' | 'auto'

class FakeIngest {
  public readonly events: LiveEvent[] = []
  public readonly bearers: string[] = []
  public readonly opened: Record<string, unknown>[] = []
  public lastSeq = 0
  public failEvents = 0
  public failOpens = 0
  public refuse: { status: number; code: string } | undefined
  /** Store a batch holding this event type, then answer it 410 session_closed: Laravel ended the session there. */
  public closeOn: string | undefined
  /** Answer 500 to every batch holding this event type, storing nothing, until it is cleared. */
  public holdOn: string | undefined
  public staleGen = false
  public permissionMode: PermissionMode = 'pending'
  public answer: Record<string, unknown> = {
    status: 'pending',
  }
  public polls = 0
  private server: ReturnType<typeof Bun.serve> | undefined

  public get url(): string {
    return `http://127.0.0.1:${this.server?.port}/mcp/internal/live`
  }

  public start(): void {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => this.handle(request),
    })
  }

  public stop(): void {
    this.server?.stop(true)
  }

  public types(): string[] {
    return this.events.map((event) => event.type)
  }

  public ofType(type: string): LiveEvent[] {
    return this.events.filter((event) => event.type === type)
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    this.bearers.push(request.headers.get('authorization') ?? '')

    if (request.method === 'POST' && path === '/mcp/internal/live/events') {
      return this.ingest((await request.json()) as { events: LiveEvent[] })
    }
    if (request.method === 'POST' && path === '/mcp/internal/live/permissions') {
      this.opened.push((await request.json()) as Record<string, unknown>)
      if (this.failOpens > 0) {
        this.failOpens -= 1

        return Response.json({ error: { code: 'unavailable', message: 'deploying' } }, { status: 503 })
      }
      if (this.permissionMode === 'fail') {
        return Response.json({ error: { code: 'server_error', message: 'boom' } }, { status: 500 })
      }
      if (this.permissionMode === 'hang') {
        return new Promise<Response>(() => {})
      }
      if (this.permissionMode === 'auto') {
        return Response.json({ id: null, status: 'allowed', optionId: 'allow' })
      }

      return Response.json({ id: '019e0000-0000-7000-8000-00000000f001', status: 'pending' }, { status: 201 })
    }
    if (request.method === 'GET' && path === '/mcp/internal/live/permissions/019e0000-0000-7000-8000-00000000f001') {
      this.polls += 1

      return Response.json({ id: '019e0000-0000-7000-8000-00000000f001', ...this.answer })
    }

    return Response.json({ error: { code: 'not_found', message: 'nope' } }, { status: 404 })
  }

  private ingest(body: { events: LiveEvent[] }): Response {
    if (this.failEvents > 0) {
      this.failEvents -= 1

      return Response.json({ error: { code: 'server_error', message: 'boom' } }, { status: 500 })
    }
    if (this.holdOn !== undefined && body.events.some((event) => event.type === this.holdOn)) {
      return Response.json({ error: { code: 'server_error', message: 'held' } }, { status: 500 })
    }
    if (this.staleGen) {
      return Response.json({ error: { code: 'stale_gen', message: 'stale', currentGen: 2 } }, { status: 409 })
    }
    if (this.refuse !== undefined) {
      return Response.json({ error: { code: this.refuse.code, message: 'refused' } }, { status: this.refuse.status })
    }

    let applied = 0
    let duplicates = 0
    for (const event of body.events) {
      if (event.seq <= this.lastSeq) {
        duplicates += 1
        continue
      }
      if (event.seq > this.lastSeq + 1) {
        return Response.json(
          { error: { code: 'seq_gap', message: 'gap', expectedSeq: this.lastSeq + 1 } },
          { status: 409 },
        )
      }
      this.events.push(event)
      this.lastSeq = event.seq
      applied += 1
    }
    if (this.closeOn !== undefined && body.events.some((event) => event.type === this.closeOn)) {
      return Response.json({ error: { code: 'session_closed', message: 'closed' } }, { status: 410 })
    }

    return Response.json({ ok: true, lastSeq: this.lastSeq, applied, duplicates })
  }
}

interface Fixture {
  dir: string
  cwd: string
  home: string
  stub: string
  settingsBase: string
  baseSettings: string
  socketPath: string
  ingest: FakeIngest
  daemon: LiveDaemon
  idle: { count: number }
  pane: string
}

let root = ''
let counter = 0
const fixtures: Fixture[] = []

function token(gen: number): string {
  const payload = Buffer.from(JSON.stringify({ audience: 'live', gen, sid: 'FAKE' })).toString('base64url')

  return `kdz-int-jwt.${payload}.FAKESIGNATURE${gen}${counter}`
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return true
    }
    await Bun.sleep(25)
  }

  return check()
}

async function alive(fx: Fixture): Promise<boolean> {
  return paneAlive({ id: fx.pane, socket: SOCKET })
}

async function readOrEmpty(path: string): Promise<string> {
  const file = Bun.file(path)

  return (await file.exists()) ? file.text() : ''
}

async function writeSecretFile(path: string, content: string, mode = 0o600): Promise<string> {
  await writeFile(path, content)
  await chmod(path, mode)

  return path
}

async function fixture(options: Partial<LiveDaemonOptions> = {}): Promise<Fixture> {
  counter += 1
  const dir = join(root, `c${counter}`)
  const cwd = join(dir, 'work')
  const home = join(dir, 'home')
  const settingsBase = join(dir, 'settings')
  for (const path of [cwd, home, settingsBase]) {
    await mkdir(path, { recursive: true })
  }

  const stub = join(dir, 'claude')
  await writeFile(stub, `#!${process.execPath}\n${STUB}`)
  await chmod(stub, 0o755)

  const baseSettings = join(dir, 'kodizm-live-base.json')
  await writeFile(baseSettings, JSON.stringify({ permissions: { deny: ['WebFetch', 'WebSearch'] } }))

  const ingest = new FakeIngest()
  ingest.start()

  const idle = { count: 0 }
  const socketPath = join(dir, 'd.sock')
  const daemon = new LiveDaemon({
    socketPath,
    tmuxSocket: SOCKET,
    claudeBin: stub,
    baseSettingsPath: baseSettings,
    helperArgv: [process.execPath, ENTRY],
    home,
    timings: {
      heartbeatMs: 60_000,
      watchdogQuietMs: 60_000,
      cancelTimeoutMs: 1_500,
      permissionPollMs: 100,
      ingestTimeoutMs: 1_000,
      monitorMs: 100,
      transcriptPollMs: 50,
      retryBaseMs: 20,
      retryMaxMs: 200,
    },
    onIdle: () => {
      idle.count += 1
    },
    ...options,
  })
  await daemon.listen()

  const fx = {
    dir,
    cwd,
    home,
    stub,
    settingsBase,
    baseSettings,
    socketPath,
    ingest,
    daemon,
    idle,
    pane: `kdz-live-${counter}`,
  }
  fixtures.push(fx)

  return fx
}

function envFile(fx: Fixture, gen = 1): string {
  return [
    `KODIZM_LIVE_INGEST_URL=${fx.ingest.url}`,
    `KODIZM_LIVE_TOKEN=${token(gen)}`,
    `KODIZM_LIVE_GEN=${gen}`,
    `ANTHROPIC_API_KEY=${API_KEY}`,
    `ANTHROPIC_AUTH_TOKEN=${AUTH_TOKEN}`,
    '',
  ].join('\n')
}

async function start(fx: Fixture, extra: Record<string, string> = {}): Promise<CtlResult> {
  const path = await writeSecretFile(join(fx.dir, 'live.env'), envFile(fx))

  return fx.daemon.ctl('start', {
    pane: fx.pane,
    cwd: fx.cwd,
    'settings-base': fx.settingsBase,
    'env-file': path,
    ...extra,
  })
}

async function prompt(fx: Fixture, text: string): Promise<CtlResult> {
  counter += 1
  const path = join(fx.dir, `prompt-${counter}.txt`)
  await writeFile(path, text)

  return fx.daemon.ctl('prompt', {
    pane: fx.pane,
    file: path,
  })
}

async function status(fx: Fixture): Promise<Record<string, unknown>> {
  return (await fx.daemon.ctl('status', { pane: fx.pane })).data ?? {}
}

async function turnClosed(fx: Fixture, count = 1): Promise<boolean> {
  return waitUntil(
    () => fx.ingest.ofType('turn_completed').length + fx.ingest.ofType('turn_failed').length >= count,
    8000,
  )
}

beforeAll(async () => {
  // /tmp keeps the unix socket path under the 104-byte macOS limit.
  root = await mkdtemp('/tmp/kdzd-')
})

afterEach(async () => {
  for (const fx of fixtures.splice(0)) {
    await fx.daemon.close()
    fx.ingest.stop()
  }
})

afterAll(async () => {
  Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'])
  await rm(root, { recursive: true, force: true })
})

describe('start', () => {
  test('launches the CLI with the pane settings, keeps the token out of the pane and deletes the env file', async () => {
    const fx = await fixture()

    const result = await start(fx)

    expect(result.ok).toBe(true)
    expect(result.code).toBe('ok')
    expect(result.data).toMatchObject({ pane: fx.pane, gen: 1, resumed: false })
    expect(typeof result.data?.pid).toBe('number')
    expect(typeof result.data?.claudeSessionId).toBe('string')
    expect(await Bun.file(join(fx.dir, 'live.env')).exists()).toBe(false)

    // 1. The CLI runs on the pane settings file alone: an empty source list loads no other settings file.
    const args = JSON.parse(await readFile(join(fx.dir, 'args.json'), 'utf8')) as string[]
    const settingsPath = args[args.indexOf('--settings') + 1] ?? ''
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(settingsPath.startsWith(fx.settingsBase)).toBe(true)
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600)
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(settings.permissions.deny).toEqual(['WebFetch', 'WebSearch'])
    expect(settings.disableAllHooks).toBe(false)

    // 2. The pane gets the auth env only; the ingest token, URL and gen never reach it or the settings file.
    const env = JSON.parse(await readFile(join(fx.dir, 'env.json'), 'utf8')) as Record<string, string>
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(AUTH_TOKEN)
    for (const name of ['KODIZM_LIVE_TOKEN', 'KODIZM_LIVE_INGEST_URL', 'KODIZM_LIVE_GEN']) {
      expect(env[name]).toBeUndefined()
    }
    expect(JSON.stringify(env)).not.toContain('kdz-int-jwt')
    expect(JSON.stringify(settings)).not.toContain('kdz-int-jwt')

    // 3. session_started opens the stream at seq 1 of gen 1, with the bearer from the env file.
    expect(await waitUntil(() => fx.ingest.events.length >= 1)).toBe(true)
    expect(fx.ingest.events[0]).toMatchObject({
      type: 'session_started',
      seq: 1,
      gen: 1,
      payload: {
        claudeSessionId: result.data?.claudeSessionId,
        model: 'claude-stub',
        source: 'startup',
      },
    })
    expect(fx.ingest.events[0]?.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(fx.ingest.bearers[0]).toStartWith('Bearer kdz-int-jwt.')
  }, 20_000)

  test('refuses an env file that is not 0600, missing flags, a second start of the pane and the pane cap', async () => {
    const fx = await fixture({ maxPanes: 1 })
    const loose = await writeSecretFile(join(fx.dir, 'loose.env'), envFile(fx), 0o644)

    const refusedMode = await fx.daemon.ctl('start', {
      pane: fx.pane,
      cwd: fx.cwd,
      'settings-base': fx.settingsBase,
      'env-file': loose,
    })
    expect(refusedMode).toMatchObject({ ok: false, code: 'usage_error' })

    expect(await fx.daemon.ctl('start', { pane: fx.pane })).toMatchObject({ ok: false, code: 'usage_error' })
    expect(await fx.daemon.ctl('start', { pane: 'bad pane!', cwd: fx.cwd })).toMatchObject({ code: 'usage_error' })

    expect((await start(fx)).ok).toBe(true)
    expect(await start(fx)).toMatchObject({ ok: false, code: 'pane_exists' })

    const other = await writeSecretFile(join(fx.dir, 'other.env'), envFile(fx))
    const capped = await fx.daemon.ctl('start', {
      pane: `${fx.pane}-b`,
      cwd: fx.cwd,
      'settings-base': fx.settingsBase,
      'env-file': other,
    })
    expect(capped).toMatchObject({ ok: false, code: 'pane_cap' })
    expect(await Bun.file(other).exists()).toBe(false)
  }, 20_000)

  test('launches the CLI on the --model it was given', async () => {
    const fx = await fixture()

    expect((await start(fx, { model: 'claude-opus-4-5[1m]' })).ok).toBe(true)

    const args = JSON.parse(await readFile(join(fx.dir, 'args.json'), 'utf8')) as string[]
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'claude-opus-4-5[1m]'])
  }, 20_000)

  test('a usage_error start leaves no env file behind, an invalid --model included', async () => {
    const fx = await fixture()
    const refusals: Array<Record<string, string>> = [
      { model: 'op us' },
      { model: '' },
      { model: `${'a'.repeat(65)}` },
      { cwd: 'relative/work' },
      { pane: 'bad pane!' },
      { 'settings-base': 'relative' },
    ]

    for (const extra of refusals) {
      expect(await start(fx, extra)).toMatchObject({ ok: false, code: 'usage_error' })
      expect(await Bun.file(join(fx.dir, 'live.env')).exists()).toBe(false)
    }
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
  }, 20_000)

  test('prompt and rotate-token delete their hand-off file when the pane does not run', async () => {
    const fx = await fixture()
    const promptFile = join(fx.dir, 'orphan-prompt.txt')
    const tokenFile = join(fx.dir, 'orphan-token')

    await writeFile(promptFile, 'a prompt that must not linger')
    expect(await fx.daemon.ctl('prompt', { pane: 'nobody', file: promptFile })).toMatchObject({
      code: 'pane_not_running',
    })
    expect(await Bun.file(promptFile).exists()).toBe(false)

    await writeFile(promptFile, 'a prompt without a pane flag')
    expect(await fx.daemon.ctl('prompt', { file: promptFile })).toMatchObject({ code: 'usage_error' })
    expect(await Bun.file(promptFile).exists()).toBe(false)

    await writeSecretFile(tokenFile, token(1))
    expect(await fx.daemon.ctl('rotate-token', { pane: 'nobody', 'token-file': tokenFile })).toMatchObject({
      code: 'pane_not_running',
    })
    expect(await Bun.file(tokenFile).exists()).toBe(false)

    await writeSecretFile(tokenFile, token(1))
    expect(await fx.daemon.ctl('rotate-token', { 'token-file': tokenFile })).toMatchObject({ code: 'usage_error' })
    expect(await Bun.file(tokenFile).exists()).toBe(false)
  })

  test('reports an unknown pane as not running and refuses an unknown verb', async () => {
    const fx = await fixture()

    expect(await fx.daemon.ctl('status', { pane: 'nobody' })).toEqual({
      ok: false,
      code: 'pane_not_running',
      data: {
        daemon_version: pkg.version,
        pane: 'nobody',
        running: false,
      },
    })
    expect(await fx.daemon.ctl('explode', {})).toMatchObject({ ok: false, code: 'usage_error' })
  })
})

const POLICY = JSON.stringify({
  allow: ['Bash:git status*'],
  deny: ['Bash:git push*', 'Read:/proc/**', 'WebFetch'],
})

interface Handoff {
  env: string
  policy: string
  prompt: string
  mcp: string
}

interface HandoffOverrides {
  policy?: string
  mcpMode?: number
  promptMode?: number
  /** Prefix of the file names, so concurrent starts of one fixture do not share files. */
  tag?: string
}

async function handoff(fx: Fixture, overrides: HandoffOverrides = {}): Promise<Handoff> {
  const tag = overrides.tag ?? ''

  return {
    env: await writeSecretFile(join(fx.dir, `${tag}live.env`), envFile(fx)),
    policy: await writeSecretFile(join(fx.dir, `${tag}policy.json`), overrides.policy ?? POLICY),
    prompt: await writeSecretFile(
      join(fx.dir, `${tag}system-prompt.md`),
      'You run as a test pane.',
      overrides.promptMode ?? 0o600,
    ),
    mcp: await writeSecretFile(
      join(fx.dir, `${tag}mcp.json`),
      JSON.stringify({ mcpServers: { kodizm: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }),
      overrides.mcpMode ?? 0o600,
    ),
  }
}

/** A logger that keeps every error line it gets, for asserting what a cleanup reported. */
function capturingLogger(): Logger & { errors: Array<{ message: string; meta: Record<string, unknown> }> } {
  const errors: Array<{ message: string; meta: Record<string, unknown> }> = []

  return {
    errors,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message, meta = {}) => {
      errors.push({ message, meta })
    },
  }
}

function startArgs(fx: Fixture, files: Handoff, extra: Record<string, string> = {}): Record<string, string> {
  return {
    pane: fx.pane,
    cwd: fx.cwd,
    'settings-base': fx.settingsBase,
    'env-file': files.env,
    'tool-policy': files.policy,
    'system-prompt-file': files.prompt,
    'mcp-config': files.mcp,
    ...extra,
  }
}

async function remaining(paths: readonly string[]): Promise<string[]> {
  const left: string[] = []
  for (const path of paths) {
    if (await Bun.file(path).exists()) {
      left.push(path)
    }
  }

  return left
}

/** The four hand-off paths a start names, as it named them. */
function namedFiles(args: Record<string, string>): string[] {
  return ['env-file', 'tool-policy', 'system-prompt-file', 'mcp-config'].flatMap((flag) => args[flag] ?? [])
}

async function paneSettings(fx: Fixture, pane = fx.pane): Promise<{ permissions: Record<string, string[]> }> {
  return JSON.parse(await readFile(join(fx.settingsBase, `${pane}.settings.json`), 'utf8'))
}

async function stubArgs(fx: Fixture): Promise<string[]> {
  return JSON.parse(await readFile(join(fx.dir, 'args.json'), 'utf8')) as string[]
}

describe('start contract v2', () => {
  test('every reply carries the daemon version first: start, status, refusals and not running', async () => {
    expect(DAEMON_VERSION).toBe(pkg.version)
    const fx = await fixture()

    const started = await start(fx)
    expect(started.data?.daemon_version).toBe(pkg.version)
    expect(Object.keys(started.data ?? {})[0]).toBe('daemon_version')

    expect((await status(fx)).daemon_version).toBe(pkg.version)
    expect((await start(fx)).data).toEqual({ daemon_version: pkg.version })
    expect((await fx.daemon.ctl('explode', {})).data).toEqual({ daemon_version: pkg.version })
    expect((await fx.daemon.ctl('status', { pane: 'nobody' })).data?.daemon_version).toBe(pkg.version)
  }, 20_000)

  test('a usage_error start removes all four hand-off files', async () => {
    const fx = await fixture()
    const cases: Array<{ extra: Record<string, string> } & HandoffOverrides> = [
      { extra: { bogus: '1' } },
      { extra: { 'permission-mode': 'yolo' } },
      { extra: {}, policy: 'not json' },
      { extra: {}, mcpMode: 0o644 },
      { extra: {}, promptMode: 0o644 },
    ]

    for (const { extra, ...overrides } of cases) {
      const files = await handoff(fx, overrides)
      expect(await fx.daemon.ctl('start', startArgs(fx, files, extra))).toMatchObject({
        ok: false,
        code: 'usage_error',
      })
      expect(await remaining(Object.values(files))).toEqual([])
    }
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
  }, 20_000)

  test('relative extra paths and a symlinked hand-off file are usage_error and remove every absolute file', async () => {
    const fx = await fixture()
    // 1. A relative path is never unlinked; the three absolute files the start named are.
    for (const flag of ['tool-policy', 'system-prompt-file', 'mcp-config']) {
      const files = await handoff(fx)
      const args = startArgs(fx, files, { [flag]: 'relative/file' })
      expect(await fx.daemon.ctl('start', args)).toMatchObject({
        code: 'usage_error',
      })
      expect(await remaining(namedFiles(args).filter((path) => path !== 'relative/file'))).toEqual([])
    }

    // 2. Each target is a valid 0600 file on its own: only the link makes the start fail.
    for (const [flag, content] of [
      ['mcp-config', '{"mcpServers":{}}'],
      ['tool-policy', POLICY],
      ['env-file', envFile(fx)],
      ['system-prompt-file', 'You run as a test pane.'],
    ] as const) {
      const files = await handoff(fx)
      const target = await writeSecretFile(join(fx.dir, `target-${flag}`), content)
      const link = join(fx.dir, `link-${flag}`)
      await symlink(target, link)
      const args = startArgs(fx, files, { [flag]: link })
      expect(await fx.daemon.ctl('start', args)).toMatchObject({
        code: 'usage_error',
      })
      expect(namedFiles(args)).toContain(link)
      expect(await remaining(namedFiles(args))).toEqual([])
    }
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
  }, 20_000)

  test('a start whose cwd does not exist fails at launch and removes all four hand-off files', async () => {
    const fx = await fixture()
    const files = await handoff(fx)

    expect(await fx.daemon.ctl('start', startArgs(fx, files, { cwd: join(fx.dir, 'missing') }))).toMatchObject({
      ok: false,
      code: 'usage_error',
    })

    expect(await remaining(Object.values(files))).toEqual([])
    expect(await status(fx)).toMatchObject({ running: false })
  }, 20_000)

  test('a refused start whose tool-policy is a directory still removes the other files and logs the flag', async () => {
    const logger = capturingLogger()
    const fx = await fixture({ logger })
    const files = await handoff(fx)
    const directory = join(fx.dir, 'policy-dir')
    await mkdir(directory)

    expect(await fx.daemon.ctl('start', startArgs(fx, files, { 'tool-policy': directory }))).toMatchObject({
      ok: false,
      code: 'usage_error',
    })

    expect(await remaining([files.env, files.prompt, files.mcp])).toEqual([])
    const failure = logger.errors.find((entry) => entry.meta.flag === 'tool-policy')
    expect(failure?.meta.code).toBeString()
    expect(JSON.stringify(logger.errors)).not.toContain(directory)
  }, 20_000)

  test('concurrent starts of one pane id give exactly one ok and one pane_exists', async () => {
    const fx = await fixture()
    const first = await handoff(fx, { tag: 'a-' })
    const second = await handoff(fx, { tag: 'b-' })

    const results = await Promise.all([
      fx.daemon.ctl('start', startArgs(fx, first)),
      fx.daemon.ctl('start', startArgs(fx, second)),
    ])

    expect(results.map((result) => result.code).sort()).toEqual(['ok', 'pane_exists'])
    expect(await status(fx)).toMatchObject({ running: true })
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(true)
  }, 20_000)

  test('concurrent starts past the pane cap give exactly one ok and one pane_cap', async () => {
    const fx = await fixture({ maxPanes: 1 })
    const first = await handoff(fx, { tag: 'a-' })
    const second = await handoff(fx, { tag: 'b-' })

    const results = await Promise.all([
      fx.daemon.ctl('start', startArgs(fx, first)),
      fx.daemon.ctl('start', startArgs(fx, second, { pane: `${fx.pane}-b` })),
    ])

    expect(results.map((result) => result.code).sort()).toEqual(['ok', 'pane_cap'])
  }, 20_000)

  test('a start whose pid lookup fails kills the pane, frees its slot and removes all four files', async () => {
    const fx = await fixture({ maxPanes: 1 })
    const files = await handoff(fx)
    const spawn = Bun.spawn.bind(Bun)
    const spy = spyOn(Bun, 'spawn').mockImplementation(((
      command: string[],
      options?: Bun.SpawnOptions.OptionsObject,
    ) => {
      if (command.includes('display-message')) {
        throw Object.assign(new Error('spawn failed'), { code: 'EAGAIN' })
      }

      return spawn(command, options)
    }) as typeof Bun.spawn)

    let result: CtlResult
    try {
      result = await fx.daemon.ctl('start', startArgs(fx, files))
    } finally {
      spy.mockRestore()
    }

    expect(result).toMatchObject({ ok: false, code: 'usage_error' })
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
    expect(await status(fx)).toMatchObject({ running: false })
    expect(await remaining(Object.values(files))).toEqual([])
    expect((await start(fx, { pane: `${fx.pane}-next` })).ok).toBe(true)
  }, 20_000)

  test('an mcp-config reached through a symlinked parent is denied under the given and the real path', async () => {
    const fx = await fixture()
    const files = await handoff(fx)
    const realDir = join(fx.dir, 'handoff-real')
    const linkedDir = join(fx.dir, 'handoff-link')
    await mkdir(realDir)
    await symlink(realDir, linkedDir)
    await writeSecretFile(join(realDir, 'mcp.json'), '{"mcpServers":{}}')
    const given = join(linkedDir, 'mcp.json')
    const real = await realpath(given)
    expect(real).not.toBe(given)

    expect((await fx.daemon.ctl('start', startArgs(fx, files, { 'mcp-config': given }))).ok).toBe(true)

    const deny = (await paneSettings(fx)).permissions.deny ?? []
    expect(deny).toContain(`Read(/${given})`)
    expect(deny).toContain(`Read(/${real})`)
    expect(deny.filter((rule) => rule === `Read(/${real})`)).toHaveLength(1)
  }, 20_000)

  test('pane_exists and pane_cap refusals remove all four hand-off files', async () => {
    const fx = await fixture({ maxPanes: 1 })
    expect((await start(fx)).ok).toBe(true)

    const again = await handoff(fx)
    expect(await fx.daemon.ctl('start', startArgs(fx, again))).toMatchObject({ code: 'pane_exists' })
    expect(await remaining(Object.values(again))).toEqual([])

    const capped = await handoff(fx)
    expect(await fx.daemon.ctl('start', startArgs(fx, capped, { pane: `${fx.pane}-b` }))).toMatchObject({
      code: 'pane_cap',
    })
    expect(await remaining(Object.values(capped))).toEqual([])
  }, 20_000)

  test('a features file narrows the tool surface and the env, and is removed with the other hand-off files', async () => {
    const fx = await fixture()
    const features = await writeSecretFile(
      join(fx.dir, 'features.json'),
      JSON.stringify({ todos: false, scheduling: false, autoMemory: false, tools: ['Bash', 'Read'] }),
    )

    expect((await fx.daemon.ctl('start', startArgs(fx, await handoff(fx), { features }))).ok).toBe(true)
    expect(await Bun.file(features).exists()).toBe(false)

    const args = await stubArgs(fx)
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash,Read')
    const removed = (args[args.indexOf('--disallowedTools') + 1] ?? '').split(',')
    expect(removed).toEqual(expect.arrayContaining(['TodoWrite', 'TaskCreate', 'Monitor', 'CronCreate']))
    expect(removed).not.toContain('Agent')

    const env = JSON.parse(await readFile(join(fx.dir, 'env.json'), 'utf8')) as Record<string, string>
    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY)
  }, 20_000)

  test('a start without a features file offers the CLI its whole tool set', async () => {
    const fx = await fixture()

    expect((await fx.daemon.ctl('start', startArgs(fx, await handoff(fx)))).ok).toBe(true)

    const args = await stubArgs(fx)
    expect(args).not.toContain('--tools')
    expect(args).not.toContain('--disallowedTools')
  }, 20_000)

  test('a plugin dir and the project setting source reach the CLI, and the plugin dir is never unlinked', async () => {
    const fx = await fixture()
    const files = await handoff(fx)
    const extra = { 'plugin-dir': '/opt/kodizm/plugins/live-1', 'setting-sources': 'project' }

    expect((await fx.daemon.ctl('start', startArgs(fx, files, extra))).ok).toBe(true)

    const args = await stubArgs(fx)
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project')
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe('/opt/kodizm/plugins/live-1')
    expect(await remaining(Object.values(files))).toEqual([files.mcp])
  }, 20_000)

  test('a plugin dir outside the plugin root or a source other than project is a usage_error', async () => {
    const fx = await fixture()
    const bad: Array<Record<string, string>> = [
      { 'plugin-dir': '/opt/kodizm/plugins/../etc' },
      { 'plugin-dir': '/opt/kodizm/pluginsx/a' },
      { 'plugin-dir': 'plugins/live-1' },
      { 'plugin-dir': '/opt/kodizm/plugins/' },
      { 'setting-sources': 'user' },
    ]

    for (const extra of bad) {
      const files = await handoff(fx)

      expect(await fx.daemon.ctl('start', startArgs(fx, files, extra))).toMatchObject({
        ok: false,
        code: 'usage_error',
      })
      expect(await remaining(Object.values(files))).toEqual([])
    }
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
  }, 30_000)

  test('a bad features file is a usage_error that starts no pane and removes every hand-off file', async () => {
    const fx = await fixture()
    const contents = ['not json', '{"tools":[]}', '{"tools":["-x"]}', '{"simple":true}']

    for (const content of contents) {
      const files = await handoff(fx)
      const features = await writeSecretFile(join(fx.dir, 'features.json'), content)

      expect(await fx.daemon.ctl('start', startArgs(fx, files, { features }))).toMatchObject({
        ok: false,
        code: 'usage_error',
      })
      expect(await remaining([...Object.values(files), features])).toEqual([])
    }

    const loose = await writeSecretFile(join(fx.dir, 'loose.json'), '{}', 0o644)
    expect(await fx.daemon.ctl('start', startArgs(fx, await handoff(fx), { features: loose }))).toMatchObject({
      code: 'usage_error',
    })
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
  }, 30_000)

  test('the system prompt mode hands the prompt file over as the replacing prompt', async () => {
    const fx = await fixture()
    const files = await handoff(fx)

    expect((await fx.daemon.ctl('start', startArgs(fx, files, { 'prompt-mode': 'system' }))).ok).toBe(true)

    const args = await stubArgs(fx)
    expect(args[args.indexOf('--system-prompt-file') + 1]).toBe(files.prompt)
    expect(args).not.toContain('--append-system-prompt-file')
    expect(await remaining(Object.values(files))).toEqual([files.mcp])
  }, 20_000)

  test('the agent prompt mode runs the plugin agent with no prompt file flag', async () => {
    const fx = await fixture()
    const { 'system-prompt-file': _prompt, ...args } = startArgs(fx, await handoff(fx), {
      'prompt-mode': 'agent',
      agent: 'kodizm-review:reviewer',
      'plugin-dir': '/opt/kodizm/plugins/live-1',
    })

    expect((await fx.daemon.ctl('start', args)).ok).toBe(true)

    const argv = await stubArgs(fx)
    expect(argv[argv.indexOf('--agent') + 1]).toBe('kodizm-review:reviewer')
    expect(argv[argv.indexOf('--plugin-dir') + 1]).toBe('/opt/kodizm/plugins/live-1')
    expect(argv).not.toContain('--system-prompt-file')
    expect(argv).not.toContain('--append-system-prompt-file')
  }, 20_000)

  test('an agent start missing its agent or plugin dir, or carrying a prompt file, is a usage_error', async () => {
    const fx = await fixture()
    const agentExtra = {
      'prompt-mode': 'agent',
      agent: 'kodizm-review:reviewer',
      'plugin-dir': '/opt/kodizm/plugins/live-1',
    }
    const cases: Array<{ drop: string[]; extra: Record<string, string> }> = [
      { drop: ['system-prompt-file', 'agent'], extra: agentExtra },
      { drop: ['system-prompt-file', 'plugin-dir'], extra: agentExtra },
      { drop: [], extra: agentExtra },
      { drop: ['prompt-mode'], extra: agentExtra },
      { drop: [], extra: { ...agentExtra, 'prompt-mode': 'system' } },
      { drop: [], extra: { 'prompt-mode': 'replace' } },
    ]

    for (const { drop, extra } of cases) {
      const files = await handoff(fx)
      const args = Object.fromEntries(
        Object.entries(startArgs(fx, files, extra)).filter(([flag]) => !drop.includes(flag)),
      )

      expect(await fx.daemon.ctl('start', args)).toMatchObject({ ok: false, code: 'usage_error' })
      expect(await remaining(namedFiles(args))).toEqual([])
    }
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
  }, 30_000)

  test('a cli config unions its denied tools with the features, adds its switches and is removed', async () => {
    const fx = await fixture()
    const features = await writeSecretFile(
      join(fx.dir, 'features.json'),
      JSON.stringify({ todos: false, scheduling: false }),
    )
    const cliConfig = await writeSecretFile(
      join(fx.dir, 'cli-config.json'),
      JSON.stringify({
        disallowedTools: ['Monitor', 'Write', 'TodoWrite', 'Write'],
        env: {
          CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
          CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
        },
        disableSlashCommands: true,
      }),
    )
    const files = await handoff(fx)

    const result = await fx.daemon.ctl('start', startArgs(fx, files, { features, 'cli-config-file': cliConfig }))
    expect(result.ok).toBe(true)
    expect(await remaining([...Object.values(files), features, cliConfig])).toEqual([files.mcp])

    // 1. The feature removals come first, then the config's own, each name once.
    const args = await stubArgs(fx)
    const fromFeatures = (args[args.indexOf('--disallowedTools') + 1] ?? '').split(',')
    expect(fromFeatures).toEqual([
      'TodoWrite',
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
      'Monitor',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'RemoteTrigger',
      'Write',
    ])
    expect(args).toContain('--disable-slash-commands')

    // 2. The switches join the feature env; auth and home stay the daemon's.
    const env = JSON.parse(await readFile(join(fx.dir, 'env.json'), 'utf8')) as Record<string, string>
    expect(env.CLAUDE_CODE_DISABLE_WORKFLOWS).toBe('1')
    expect(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe('false')
    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe('1')
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY)
    expect(env.HOME).toBe(fx.home)
    expect(env.KODIZM_LIVE_TOKEN).toBeUndefined()
  }, 20_000)

  test('a cli config alone denies its tools, and one without the switch keeps slash commands', async () => {
    const fx = await fixture()
    const cliConfig = await writeSecretFile(
      join(fx.dir, 'cli-config.json'),
      JSON.stringify({ disallowedTools: ['Monitor'], disableSlashCommands: false }),
    )

    const result = await fx.daemon.ctl('start', startArgs(fx, await handoff(fx), { 'cli-config-file': cliConfig }))
    expect(result.ok).toBe(true)

    const args = await stubArgs(fx)
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Monitor')
    expect(args).not.toContain('--tools')
    expect(args).not.toContain('--disable-slash-commands')
  }, 20_000)

  test('a bad cli config is a usage_error naming the key, never the value, and removes every file', async () => {
    const fx = await fixture()
    const cases: Array<[string, string | undefined]> = [
      ['not json', undefined],
      ['{"settings":{"model":"x"}}', 'settings'],
      ['{"disallowedTools":["Bash(rm *)"]}', 'disallowedTools'],
      ['{"env":{"ANTHROPIC_BASE_URL":"https://do-not-echo.example"}}', 'env.ANTHROPIC_BASE_URL'],
      ['{"env":{"HOME":"/do-not-echo"}}', 'env.HOME'],
      ['{"env":{"PATH":"/do-not-echo"}}', 'env.PATH'],
      ['{"env":{"CLAUDE_CODE_DISABLE_WORKFLOWS":"do-not-echo"}}', 'env.CLAUDE_CODE_DISABLE_WORKFLOWS'],
      ['{"disableSlashCommands":"yes"}', 'disableSlashCommands'],
    ]

    for (const [content, key] of cases) {
      const files = await handoff(fx)
      const cliConfig = await writeSecretFile(join(fx.dir, 'cli-config.json'), content)

      const result = await fx.daemon.ctl('start', startArgs(fx, files, { 'cli-config-file': cliConfig }))
      expect(result).toMatchObject({ ok: false, code: 'usage_error' })
      expect(result.data?.cli_config_key).toBe(key)
      expect(JSON.stringify(result)).not.toContain('do-not-echo')
      expect(await remaining([...Object.values(files), cliConfig])).toEqual([])
    }

    // A config readable by others or named by a relative path is refused like any other hand-off file.
    const loose = await writeSecretFile(join(fx.dir, 'loose.json'), '{}', 0o644)
    const looseFiles = await handoff(fx)
    expect(await fx.daemon.ctl('start', startArgs(fx, looseFiles, { 'cli-config-file': loose }))).toMatchObject({
      code: 'usage_error',
    })
    expect(await remaining([...Object.values(looseFiles), loose])).toEqual([])
    const relativeFiles = await handoff(fx)
    expect(
      await fx.daemon.ctl('start', startArgs(fx, relativeFiles, { 'cli-config-file': 'cli-config.json' })),
    ).toMatchObject({ code: 'usage_error' })
    expect(await remaining(Object.values(relativeFiles))).toEqual([])
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
  }, 40_000)

  test('a started pane keeps only its mcp-config, launches on the extras and drops the file on stop', async () => {
    const fx = await fixture()
    const files = await handoff(fx)

    expect((await fx.daemon.ctl('start', startArgs(fx, files))).ok).toBe(true)
    expect(await remaining(Object.values(files))).toEqual([files.mcp])

    // 1. The CLI got the extras as paths only, the strict flag right behind the config.
    const args = await stubArgs(fx)
    const at = args.indexOf('--mcp-config')
    expect(args.slice(at, at + 3)).toEqual(['--mcp-config', files.mcp, '--strict-mcp-config'])
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe(files.prompt)
    expect(args).not.toContain('--permission-mode')

    // 2. The policy lands after the base deny, and the pane may not read its own bearer file under either spelling
    // (on macOS /tmp is /private/tmp, elsewhere both are one path).
    const settings = await paneSettings(fx)
    expect(settings.permissions.deny).toEqual([
      'WebFetch',
      'WebSearch',
      'Bash(git push*)',
      'Read(//proc/**)',
      ...[...new Set([files.mcp, await realpath(files.mcp)])].map((path) => `Read(/${path})`),
    ])
    expect(settings.permissions.allow).toEqual(['Bash(git status:*)'])

    expect((await fx.daemon.ctl('stop', { pane: fx.pane })).ok).toBe(true)
    expect(await remaining([files.mcp])).toEqual([])
  }, 20_000)

  test('the mcp-config is removed when the pane dies on its own', async () => {
    const fx = await fixture()
    const files = await handoff(fx)
    expect((await fx.daemon.ctl('start', startArgs(fx, files))).ok).toBe(true)

    Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-session', '-t', `=${fx.pane}`])

    expect(await waitUntil(() => fx.ingest.ofType('process_died').length === 1)).toBe(true)
    expect(await remaining([files.mcp])).toEqual([])
  }, 20_000)

  test('the mcp-config is removed when the daemon closes with the pane still running', async () => {
    const fx = await fixture()
    const files = await handoff(fx)
    expect((await fx.daemon.ctl('start', startArgs(fx, files))).ok).toBe(true)

    await fx.daemon.close()

    expect(await remaining([files.mcp])).toEqual([])
  }, 20_000)

  test('dontAsk denies a permission request at once: no dialog, no event, no ingest call', async () => {
    const fx = await fixture()
    const files = await handoff(fx)
    expect((await fx.daemon.ctl('start', startArgs(fx, files, { 'permission-mode': 'dontAsk' }))).ok).toBe(true)

    const args = await stubArgs(fx)
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'dontAsk',
    ])
    expect((await paneSettings(fx)).permissions.deny).toContain('EnterPlanMode')

    await prompt(fx, 'run the TOOL')
    expect(await turnClosed(fx)).toBe(true)

    const [decision] = (await readOrEmpty(join(fx.dir, 'decisions.log'))).trim().split('\n')
    const output = JSON.parse(JSON.parse(decision ?? '""')).hookSpecificOutput.decision
    expect(output.behavior).toBe('deny')
    expect(output.message).toContain('unattended')
    expect(fx.ingest.opened).toHaveLength(0)
    expect(fx.ingest.ofType('permission_request')).toHaveLength(0)
    expect(await status(fx)).toMatchObject({ dialogOpen: false, busy: false })
  }, 20_000)

  test('an explicit default mode still opens the permission in the ingest', async () => {
    const fx = await fixture()
    fx.ingest.permissionMode = 'auto'
    const files = await handoff(fx)
    expect((await fx.daemon.ctl('start', startArgs(fx, files, { 'permission-mode': 'default' }))).ok).toBe(true)
    expect((await paneSettings(fx)).permissions.deny).not.toContain('EnterPlanMode')

    await prompt(fx, 'run the TOOL')
    expect(await turnClosed(fx)).toBe(true)

    expect(fx.ingest.opened).toHaveLength(1)
    expect(fx.ingest.ofType('permission_request')).toHaveLength(1)
    expect(await readOrEmpty(join(fx.dir, 'decisions.log'))).toContain('allow')
  }, 20_000)
})

describe('events', () => {
  test('a turn streams in seq order with one gen, de-duplicated usage and every planted secret redacted', async () => {
    const fx = await fixture()
    // Two failed pushes first: the retry has to keep the order and lose nothing.
    fx.ingest.failEvents = 2
    await start(fx)

    const result = await prompt(fx, 'hello there')
    expect(result.ok).toBe(true)
    expect(typeof result.data?.promptId).toBe('string')
    expect(result.data?.bytes).toBe(11)
    expect(await turnClosed(fx)).toBe(true)

    const types = fx.ingest.types()
    expect(types[0]).toBe('session_started')
    expect(types.indexOf('turn_started')).toBeLessThan(types.indexOf('turn_completed'))
    expect(types).toContain('thinking_chunk')
    expect(types).toContain('output_chunk')
    expect(fx.ingest.ofType('usage')).toHaveLength(1)
    expect(fx.ingest.ofType('usage')[0]?.payload).toEqual({
      inputTokens: 7,
      outputTokens: 11,
      cacheReadTokens: 100,
      cacheCreationTokens: 5,
    })
    expect(fx.ingest.ofType('turn_started')[0]?.payload.promptId).toBe(result.data?.promptId)
    expect(fx.ingest.ofType('turn_completed')[0]?.payload).toEqual({
      stopReason: 'end_turn',
      lastAssistantMessage: 'done [REDACTED]',
    })

    // 1. Strictly increasing from 1 by exactly 1, one gen throughout.
    expect(fx.ingest.events.map((event) => event.seq)).toEqual(fx.ingest.events.map((_event, index) => index + 1))
    expect(new Set(fx.ingest.events.map((event) => event.gen))).toEqual(new Set([1]))

    // 2. Neither the injected values nor the token reached the ingest.
    const wire = JSON.stringify(fx.ingest.events)
    expect(wire).not.toContain(API_KEY)
    expect(wire).not.toContain(AUTH_TOKEN)
    expect(wire).not.toContain('kdz-int-jwt')
    expect(fx.ingest.ofType('output_chunk')[0]?.payload.text).toBe('echo hello there key=[REDACTED] auth=[REDACTED]')
  }, 20_000)

  test('emits a heartbeat on the interval while the pane lives, and the production interval is 20 s', async () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(20_000)

    const fx = await fixture()
    fx.daemon.setTimings({ heartbeatMs: 200 })
    await start(fx)

    expect(await waitUntil(() => fx.ingest.ofType('heartbeat').length >= 3, 4000)).toBe(true)
    expect(fx.ingest.ofType('heartbeat')[0]?.payload).toEqual({})
  }, 20_000)

  test('StopFailure fails the turn with a SessionFailureReason value', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'please FAIL')
    expect(await turnClosed(fx)).toBe(true)

    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toEqual({
      reason: 'rate_limit',
      detail: 'StopFailure rate_limit: 429 Too Many Requests',
    })
  }, 20_000)

  test('a pane that dies on its own reports session_ended crashed and process_died, then the daemon goes idle', async () => {
    const fx = await fixture()
    await start(fx)

    Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-session', '-t', `=${fx.pane}`])

    expect(await waitUntil(() => fx.ingest.ofType('process_died').length === 1)).toBe(true)
    const types = fx.ingest.types()
    expect(types.slice(-2)).toEqual(['session_ended', 'process_died'])
    expect(fx.ingest.ofType('session_ended')[0]?.payload).toEqual({ reason: 'crashed' })
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
  }, 20_000)

  test('a 409 stale_gen stops pushing, closes the pane and idles the daemon', async () => {
    const fx = await fixture()
    await start(fx)
    expect(await waitUntil(() => fx.ingest.events.length >= 1)).toBe(true)

    fx.ingest.staleGen = true
    await prompt(fx, 'hello')

    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
    expect((await fx.daemon.ctl('status', { pane: fx.pane })).code).toBe('pane_not_running')
  }, 20_000)

  for (const refusal of [
    { status: 410, code: 'session_closed' },
    { status: 422, code: 'validation_failed' },
  ]) {
    test(`a ${refusal.status} ${refusal.code} ends the stream instead of retrying it for ever`, async () => {
      const fx = await fixture()
      await start(fx)
      expect(await waitUntil(() => fx.ingest.events.length >= 1)).toBe(true)

      fx.ingest.refuse = refusal
      await prompt(fx, 'hello')

      expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
      expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
    }, 20_000)
  }

  test('a 410 expired_token is retried and the events arrive once the token is accepted again', async () => {
    const fx = await fixture()
    await start(fx)
    expect(await waitUntil(() => fx.ingest.events.length >= 1)).toBe(true)
    const before = fx.ingest.events.length

    fx.ingest.refuse = { status: 410, code: 'expired_token' }
    await prompt(fx, 'hello')
    await Bun.sleep(600)
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(true)

    fx.ingest.refuse = undefined
    expect(await waitUntil(() => fx.ingest.events.length > before)).toBe(true)
  }, 20_000)
})

describe('last assistant message', () => {
  const MESSAGE_FILE = 'last-assistant-message.txt'

  test('a normal turn persists the redacted message at 0600 and the event carries the same string', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'hello there')
    expect(await turnClosed(fx)).toBe(true)

    const path = join(fx.settingsBase, MESSAGE_FILE)
    const persisted = await readFile(path, 'utf8')
    expect(persisted).toBe('done [REDACTED]')
    expect(persisted).not.toContain(AUTH_TOKEN)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(fx.ingest.ofType('turn_completed')[0]?.payload.lastAssistantMessage).toBe(persisted)
    expect((await readdir(fx.settingsBase)).filter((name) => name.includes(MESSAGE_FILE))).toEqual([MESSAGE_FILE])
  }, 20_000)

  test('a leftover temp path next to the file does not block the persist', async () => {
    const fx = await fixture()
    await mkdir(join(fx.settingsBase, `${MESSAGE_FILE}.tmp`))
    await start(fx)

    await prompt(fx, 'hello there')
    expect(await turnClosed(fx)).toBe(true)

    expect(await readFile(join(fx.settingsBase, MESSAGE_FILE), 'utf8')).toBe('done [REDACTED]')
    expect((await readdir(fx.settingsBase)).filter((name) => name.includes(MESSAGE_FILE)).sort()).toEqual([
      MESSAGE_FILE,
      `${MESSAGE_FILE}.tmp`,
    ])
  }, 20_000)

  test('an interrupted turn carries a string, empty when the model wrote no text', async () => {
    const fx = await fixture()
    await start(fx)
    await prompt(fx, 'SLOW work')
    await fx.daemon.ctl('cancel', { pane: fx.pane })

    expect(fx.ingest.ofType('turn_completed')[0]?.payload).toEqual({
      stopReason: 'interrupted',
      lastAssistantMessage: '',
    })
    expect(await readFile(join(fx.settingsBase, MESSAGE_FILE), 'utf8')).toBe('')
  }, 20_000)

  test('a watchdog turn carries the last text the transcript held', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ watchdogQuietMs: 600 })
    await start(fx)

    await prompt(fx, 'HANG please')
    expect(await turnClosed(fx)).toBe(true)

    expect(fx.ingest.ofType('turn_completed')[0]?.payload).toEqual({
      stopReason: 'watchdog',
      lastAssistantMessage: 'hanging',
    })
    expect(await readFile(join(fx.settingsBase, MESSAGE_FILE), 'utf8')).toBe('hanging')
  }, 20_000)

  test('a prompt with no assistant text gives an empty string', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'BARE turn')
    expect(await turnClosed(fx)).toBe(true)

    expect(fx.ingest.ofType('turn_completed')[0]?.payload).toEqual({ stopReason: 'end_turn', lastAssistantMessage: '' })
    expect(await readFile(join(fx.settingsBase, MESSAGE_FILE), 'utf8')).toBe('')
  }, 20_000)
})

describe('api error', () => {
  const closes = (fx: Fixture) => fx.ingest.ofType('turn_completed').length + fx.ingest.ofType('turn_failed').length

  test('api error: a usage limit record fails the turn at once with usage_limit', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'APIERR_USAGE please')
    expect(await turnClosed(fx)).toBe(true)
    await Bun.sleep(400)

    expect(fx.ingest.ofType('turn_failed')).toHaveLength(1)
    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toMatchObject({ reason: 'usage_limit' })
    expect(fx.ingest.ofType('turn_completed')).toHaveLength(0)
    expect(fx.ingest.ofType('output_chunk')[0]?.payload).toMatchObject({
      text: "You've hit your session limit · resets 3pm",
    })
  }, 20_000)

  test('api error: a StopFailure after the usage limit record adds no second end', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'APIERR_USAGE_HOOK please')
    expect(await turnClosed(fx)).toBe(true)
    await Bun.sleep(400)

    expect(closes(fx)).toBe(1)
    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toMatchObject({ reason: 'usage_limit' })
  }, 20_000)

  test('api error: a plain 429 is reported as rate_limit when the watchdog ends the turn', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ watchdogQuietMs: 200 })
    await start(fx)

    await prompt(fx, 'APIERR_429 please')
    expect(await turnClosed(fx)).toBe(true)
    await Bun.sleep(400)

    expect(closes(fx)).toBe(1)
    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toMatchObject({ reason: 'rate_limit' })
  }, 20_000)

  test('api error: a 401 record is reported as auth_error when the watchdog ends the turn', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ watchdogQuietMs: 200 })
    await start(fx)

    await prompt(fx, 'APIERR_401 please')
    expect(await turnClosed(fx)).toBe(true)

    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toMatchObject({ reason: 'auth_error' })
    expect(fx.ingest.ofType('turn_completed')).toHaveLength(0)
  }, 20_000)

  test('api error: a StopFailure alone keeps its own reason table', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'please FAIL')
    expect(await turnClosed(fx)).toBe(true)
    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toMatchObject({ reason: 'rate_limit' })

    await prompt(fx, 'HOOK_AUTH please')
    expect(await turnClosed(fx, 2)).toBe(true)
    expect(fx.ingest.ofType('turn_failed')[1]?.payload).toMatchObject({ reason: 'auth_error' })
  }, 20_000)

  test('api error: a Stop after a 429 record fails the turn with the latched reason', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'APIERR_STOP please')
    expect(await turnClosed(fx)).toBe(true)
    await Bun.sleep(300)

    expect(closes(fx)).toBe(1)
    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toMatchObject({ reason: 'rate_limit' })
    expect(fx.ingest.ofType('turn_completed')).toHaveLength(0)
  }, 20_000)

  test('api error: a meta user record after the error keeps the latch', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'APIERR_META please')
    expect(await turnClosed(fx)).toBe(true)

    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toMatchObject({ reason: 'rate_limit' })
    expect(fx.ingest.ofType('turn_completed')).toHaveLength(0)
  }, 20_000)

  test('api error: a normal turn still completes with end_turn', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'hello')
    expect(await turnClosed(fx)).toBe(true)

    expect(fx.ingest.ofType('turn_completed')[0]?.payload).toMatchObject({ stopReason: 'end_turn' })
    expect(fx.ingest.ofType('turn_failed')).toHaveLength(0)
  }, 20_000)
})

describe('delivery guard and turn end', () => {
  test('refuses a prompt while a turn runs, and the watchdog closes a turn whose Stop never came', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ watchdogQuietMs: 600 })
    await start(fx)

    expect((await prompt(fx, 'HANG please')).ok).toBe(true)
    expect(await status(fx)).toMatchObject({ busy: true })
    expect(await prompt(fx, 'second')).toMatchObject({ ok: false, code: 'busy' })

    expect(await turnClosed(fx)).toBe(true)
    expect(fx.ingest.ofType('turn_completed')[0]?.payload).toEqual({
      stopReason: 'watchdog',
      lastAssistantMessage: 'hanging',
    })
    expect(await status(fx)).toMatchObject({ busy: false })
  }, 20_000)

  test('a dialog that opens during the Enter ladder stops it with dialog_open', async () => {
    const fx = await fixture()
    await start(fx)

    expect(await prompt(fx, 'PREDIALOG now')).toEqual({
      ok: false,
      code: 'dialog_open',
      data: {
        daemon_version: pkg.version,
      },
    })
    expect(await status(fx)).toMatchObject({ dialogOpen: true, busy: false })
    expect(fx.ingest.ofType('turn_started')).toHaveLength(0)
  }, 20_000)

  test('rejects a prompt the sanitiser refuses and sends nothing', async () => {
    const fx = await fixture()
    await start(fx)

    expect(await prompt(fx, '  /clear')).toEqual({
      ok: false,
      code: 'prompt_rejected',
      data: {
        daemon_version: pkg.version,
        rule: 'leading_slash',
      },
    })
    expect(await prompt(fx, '!rm -rf .')).toMatchObject({ code: 'prompt_rejected', data: { rule: 'leading_bang' } })
    expect(fx.ingest.ofType('turn_started')).toHaveLength(0)
  }, 20_000)

  test('cancel closes the turn on the transcript marker', async () => {
    const fx = await fixture()
    await start(fx)
    await prompt(fx, 'SLOW work')
    expect(await status(fx)).toMatchObject({ busy: true })

    expect(await fx.daemon.ctl('cancel', { pane: fx.pane })).toEqual({
      ok: true,
      code: 'ok',
      data: {
        daemon_version: pkg.version,
        wasBusy: true,
        detectedBy: 'transcript_marker',
      },
    })
    expect(fx.ingest.ofType('turn_completed')[0]?.payload).toMatchObject({ stopReason: 'interrupted' })
  }, 20_000)

  test('cancel closes the turn on its timeout when the Esc left no marker, and is a no-op when idle', async () => {
    const fx = await fixture()
    await start(fx)

    expect(await fx.daemon.ctl('cancel', { pane: fx.pane })).toEqual({
      ok: true,
      code: 'ok',
      data: {
        daemon_version: pkg.version,
        wasBusy: false,
      },
    })

    await prompt(fx, 'MUTE work')
    expect(await fx.daemon.ctl('cancel', { pane: fx.pane })).toMatchObject({
      ok: true,
      data: {
        wasBusy: true,
        detectedBy: 'timeout',
      },
    })
    expect(await turnClosed(fx)).toBe(true)
    expect(await status(fx)).toMatchObject({ busy: false })
  }, 20_000)

  test('command types an allowlisted slash command and refuses bad flags', async () => {
    const fx = await fixture()
    await start(fx)

    expect(await fx.daemon.ctl('command', { pane: fx.pane, name: 'compact' })).toEqual({
      ok: true,
      code: 'ok',
      data: {
        daemon_version: pkg.version,
        name: 'compact',
      },
    })
    expect(await fx.daemon.ctl('command', { pane: fx.pane, name: 'model', arg: 'opus' })).toMatchObject({
      ok: true,
      data: {
        name: 'model',
        arg: 'opus',
      },
    })
    expect(await waitUntil(async () => (await readOrEmpty(join(fx.dir, 'commands.log'))).includes('/model'))).toBe(true)
    expect(await readOrEmpty(join(fx.dir, 'commands.log'))).toBe('/compact\n/model opus\n')

    const refused: Array<Record<string, string>> = [
      { name: 'model' },
      { name: 'clear', arg: 'x' },
      { name: 'exit' },
      { name: 'model', arg: 'op us' },
    ]
    for (const args of refused) {
      expect(await fx.daemon.ctl('command', { pane: fx.pane, ...args })).toMatchObject({ code: 'usage_error' })
    }
    expect(await fx.daemon.ctl('command', { pane: 'nobody', name: 'compact' })).toMatchObject({
      code: 'pane_not_running',
    })
  }, 20_000)
})

describe('permissions', () => {
  test('an operator allow reaches the hook as allow, correlated to the tool call of the PreToolUse', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'run the TOOL')
    expect(await waitUntil(() => fx.ingest.polls >= 2)).toBe(true)
    expect(await status(fx)).toMatchObject({ dialogOpen: true })
    expect(await prompt(fx, 'sneaky')).toMatchObject({ ok: false, code: 'dialog_open' })

    fx.ingest.answer = { status: 'allowed', optionId: 'allow' }
    expect(await turnClosed(fx)).toBe(true)

    const [decision] = (await readOrEmpty(join(fx.dir, 'decisions.log'))).trim().split('\n')
    expect(JSON.parse(JSON.parse(decision ?? '""'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
        },
      },
    })
    expect(fx.ingest.opened[0]).toEqual({
      gen: 1,
      toolCallId: 'toolu_STUB1',
      title: 'Bash: touch stub.txt',
      kind: 'execute',
      rawInput: {
        command: 'touch stub.txt',
      },
      options: [
        {
          optionId: 'allow',
          kind: 'allow_once',
        },
        {
          optionId: 'deny',
          kind: 'reject_once',
        },
      ],
    })
    expect(fx.ingest.ofType('permission_request')[0]?.payload.toolCallId).toBe('toolu_STUB1')
    expect(fx.ingest.ofType('tool_call_begin')[0]?.payload).toEqual({
      toolCallId: 'toolu_STUB1',
      name: 'Bash',
      input: {
        command: 'touch stub.txt',
      },
    })
    expect(fx.ingest.ofType('tool_call_end')[0]?.payload).toEqual({
      toolCallId: 'toolu_STUB1',
      status: 'completed',
      output: 'ran',
    })
    expect(await status(fx)).toMatchObject({ dialogOpen: false, busy: false })
  }, 20_000)

  test('an operator deny reaches the hook with its message and the unrun tool call ends failed', async () => {
    const fx = await fixture()
    fx.ingest.answer = { status: 'denied', optionId: 'deny', message: 'Denied by the operator.' }
    await start(fx)

    await prompt(fx, 'run the TOOL')
    expect(await turnClosed(fx)).toBe(true)

    const [decision] = (await readOrEmpty(join(fx.dir, 'decisions.log'))).trim().split('\n')
    expect(JSON.parse(JSON.parse(decision ?? '""')).hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'Denied by the operator.',
    })
    expect(fx.ingest.ofType('tool_call_end')[0]?.payload).toMatchObject({ toolCallId: 'toolu_STUB1', status: 'failed' })
  }, 20_000)

  test('an auto-approved request answers allow without polling', async () => {
    const fx = await fixture()
    fx.ingest.permissionMode = 'auto'
    await start(fx)

    await prompt(fx, 'run the TOOL')
    expect(await turnClosed(fx)).toBe(true)

    expect(fx.ingest.polls).toBe(0)
    expect(await readOrEmpty(join(fx.dir, 'decisions.log'))).toContain('allow')
  }, 20_000)

  test('a transient open failure is retried and the answer still reaches the hook', async () => {
    const fx = await fixture()
    fx.ingest.permissionMode = 'auto'
    fx.ingest.failOpens = 2
    fx.daemon.setTimings({ retryBaseMs: 20, retryMaxMs: 50, permissionOpenRetryMs: 10_000 })
    await start(fx)

    await prompt(fx, 'run the TOOL')
    expect(await turnClosed(fx)).toBe(true)

    expect(fx.ingest.opened.length).toBe(3)
    expect(await readOrEmpty(join(fx.dir, 'decisions.log'))).toContain('allow')
  }, 20_000)

  for (const mode of ['fail', 'hang'] as const) {
    test(`a ${mode === 'fail' ? 'failed (500)' : 'timed-out'} open prints no decision and the dialog stays open`, async () => {
      const fx = await fixture()
      fx.ingest.permissionMode = mode
      fx.daemon.setTimings({ ingestTimeoutMs: 300, permissionOpenRetryMs: 0 })
      await start(fx)

      await prompt(fx, 'run the TOOL')
      expect(await waitUntil(async () => (await readOrEmpty(join(fx.dir, 'decisions.log'))) !== '')).toBe(true)

      // 1. The hook helper printed nothing: the dialog is left to a human.
      expect(await readOrEmpty(join(fx.dir, 'decisions.log'))).toBe('""\n')
      expect(fx.ingest.polls).toBe(0)

      // 2. The guard still treats the dialog as open: a pasted Enter would answer it.
      expect(await status(fx)).toMatchObject({ dialogOpen: true })
      expect(await prompt(fx, 'sneaky')).toMatchObject({ ok: false, code: 'dialog_open' })

      // 3. Esc closes a dialog without a hook, so cancel clears the state itself.
      expect((await fx.daemon.ctl('cancel', { pane: fx.pane })).ok).toBe(true)
      expect(await status(fx)).toMatchObject({ dialogOpen: false, busy: false })
    }, 20_000)
  }
})

describe('rotate-token', () => {
  test('swaps the bearer for the next push and deletes the file', async () => {
    const fx = await fixture()
    await start(fx)
    expect(await waitUntil(() => fx.ingest.events.length >= 1)).toBe(true)

    const fresh = token(1)
    const path = await writeSecretFile(join(fx.dir, 'token'), `${fresh}\n`)
    expect(await fx.daemon.ctl('rotate-token', { pane: fx.pane, 'token-file': path })).toEqual({
      ok: true,
      code: 'ok',
      data: {
        daemon_version: pkg.version,
        gen: 1,
      },
    })
    expect(await Bun.file(path).exists()).toBe(false)

    await prompt(fx, 'after rotation')
    expect(await turnClosed(fx)).toBe(true)
    expect(fx.ingest.bearers.at(-1)).toBe(`Bearer ${fresh}`)
  }, 20_000)

  test('refuses a token of another gen and a file that is not 0600', async () => {
    const fx = await fixture()
    await start(fx)

    const otherGen = await writeSecretFile(join(fx.dir, 'gen2'), token(2))
    const loose = await writeSecretFile(join(fx.dir, 'loose'), token(1), 0o644)

    expect(await fx.daemon.ctl('rotate-token', { pane: fx.pane, 'token-file': otherGen })).toMatchObject({
      ok: false,
      code: 'usage_error',
    })
    expect(await fx.daemon.ctl('rotate-token', { pane: fx.pane, 'token-file': loose })).toMatchObject({
      ok: false,
      code: 'usage_error',
    })
  }, 20_000)
})

describe('stop', () => {
  test('kills the pane, emits session_ended stopped last and idles the daemon', async () => {
    const fx = await fixture()
    const started = await start(fx)

    expect(await fx.daemon.ctl('stop', { pane: fx.pane })).toEqual({
      ok: true,
      code: 'ok',
      data: {
        daemon_version: pkg.version,
        claudeSessionId: started.data?.claudeSessionId,
      },
    })

    expect(fx.ingest.events.at(-1)).toMatchObject({ type: 'session_ended', payload: { reason: 'stopped' } })
    expect(await paneAlive({ id: fx.pane, socket: SOCKET })).toBe(false)
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    await Bun.sleep(300)
    expect(fx.ingest.ofType('process_died')).toHaveLength(0)
  }, 20_000)
})

describe('lifecycle', () => {
  test('a one-shot pane closes once turn_completed was acknowledged, session_ended stopped last', async () => {
    const fx = await fixture()
    await start(fx, { 'one-shot': '1' })

    expect((await prompt(fx, 'hello there')).ok).toBe(true)

    expect(await waitUntil(async () => !(await alive(fx)), 5000)).toBe(true)
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    expect(fx.ingest.types().slice(-2)).toEqual(['turn_completed', 'session_ended'])
    expect(fx.ingest.events.at(-1)?.payload).toEqual({ reason: 'stopped' })
    expect((await status(fx)).running).toBe(false)
  }, 20_000)

  test('a pane without one-shot stays after turn_completed', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'hello there')
    expect(await turnClosed(fx)).toBe(true)
    await Bun.sleep(300)

    expect(await alive(fx)).toBe(true)
    expect(fx.ingest.ofType('session_ended')).toHaveLength(0)
    expect(fx.idle.count).toBe(0)
  }, 20_000)

  test('the deadline fails the turn, presses Esc and leaves no interrupted turn behind', async () => {
    const fx = await fixture()
    // The MUTE turn writes no marker on Esc, so the prompt refusal lifts on the cancel timeout, here at once.
    fx.daemon.setTimings({ secondMs: 20, cancelTimeoutMs: 1 })
    await start(fx, { 'deadline-seconds': '10' })

    expect((await prompt(fx, 'MUTE work')).ok).toBe(true)
    expect(await turnClosed(fx)).toBe(true)
    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toEqual({
      reason: 'deadline',
      detail: 'The turn ran longer than 10 seconds.',
    })

    // The stub's MUTE turn only ends on Esc: a next prompt that runs proves the Esc reached it.
    fx.daemon.setTimings({ secondMs: 60_000 })
    expect(await waitUntil(async () => (await status(fx)).busy === false)).toBe(true)
    expect((await prompt(fx, 'hello again')).ok).toBe(true)
    expect(await turnClosed(fx, 2)).toBe(true)

    expect(fx.ingest.ofType('turn_completed').map((event) => event.payload.stopReason)).toEqual(['end_turn'])
    expect(await alive(fx)).toBe(true)
  }, 20_000)

  test('a one-shot pane with no retention closes at once after turn_failed', async () => {
    const fx = await fixture()
    await start(fx, { 'one-shot': '1', 'retain-failed-seconds': '0' })

    await prompt(fx, 'please FAIL')

    expect(await waitUntil(async () => !(await alive(fx)), 5000)).toBe(true)
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    expect(fx.ingest.types().slice(-2)).toEqual(['turn_failed', 'session_ended'])
    expect(fx.ingest.events.at(-1)?.payload).toEqual({ reason: 'stopped' })
  }, 20_000)

  test('a retained failed pane stays, refuses prompts as busy and beats no more until the retention ends', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ secondMs: 50, heartbeatMs: 50 })
    await start(fx, { 'retain-failed-seconds': '16' })

    await prompt(fx, 'please FAIL')
    expect(await waitUntil(() => fx.ingest.ofType('turn_failed').length === 1)).toBe(true)
    const failedSeq = fx.ingest.ofType('turn_failed')[0]?.seq ?? 0

    expect(await prompt(fx, 'second')).toMatchObject({ ok: false, code: 'busy' })
    await Bun.sleep(300)
    expect(await alive(fx)).toBe(true)
    expect(fx.ingest.ofType('heartbeat').filter((event) => event.seq > failedSeq)).toHaveLength(0)

    expect(await waitUntil(async () => !(await alive(fx)), 5000)).toBe(true)
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    expect(fx.ingest.types().slice(-2)).toEqual(['turn_failed', 'session_ended'])
    expect(fx.ingest.events.at(-1)?.payload).toEqual({ reason: 'stopped' })
  }, 20_000)

  test('a retained failed pane survives an ingest 410 and still ends when the retention runs out', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ secondMs: 50 })
    await start(fx, { 'retain-failed-seconds': '16' })
    expect(await waitUntil(() => fx.ingest.events.length >= 1)).toBe(true)

    fx.ingest.closeOn = 'turn_failed'
    await prompt(fx, 'please FAIL')
    expect(await waitUntil(() => fx.ingest.ofType('turn_failed').length === 1)).toBe(true)

    await Bun.sleep(300)
    expect(await alive(fx)).toBe(true)
    expect(fx.idle.count).toBe(0)

    expect(await waitUntil(async () => !(await alive(fx)), 5000)).toBe(true)
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
  }, 20_000)

  test('a pane started without lifecycle flags survives a failed turn', async () => {
    const fx = await fixture()
    await start(fx)

    await prompt(fx, 'please FAIL')
    expect(await turnClosed(fx)).toBe(true)
    await Bun.sleep(300)

    expect(await alive(fx)).toBe(true)
    expect(fx.ingest.ofType('session_ended')).toHaveLength(0)
    expect(fx.idle.count).toBe(0)
    expect((await prompt(fx, 'hello there')).ok).toBe(true)
  }, 20_000)

  test('a one-shot pane refuses a prompt as busy from the tick its turn closed', async () => {
    const fx = await fixture()
    fx.ingest.holdOn = 'turn_completed'
    await start(fx, { 'one-shot': '1' })

    expect((await prompt(fx, 'hello there')).ok).toBe(true)
    expect(await waitUntil(async () => (await status(fx)).busy === false)).toBe(true)
    expect(await prompt(fx, 'second')).toMatchObject({ ok: false, code: 'busy' })

    fx.ingest.holdOn = undefined
    expect(await waitUntil(async () => !(await alive(fx)), 5000)).toBe(true)
  }, 20_000)

  test('a one-shot pane whose turn event is never acknowledged ends after deliveryDrainMs', async () => {
    const fx = await fixture()
    fx.ingest.holdOn = 'turn_completed'
    fx.daemon.setTimings({ deliveryDrainMs: 400 })
    await start(fx, { 'one-shot': '1' })

    expect((await prompt(fx, 'hello there')).ok).toBe(true)
    expect(await waitUntil(async () => (await status(fx)).busy === false)).toBe(true)
    await Bun.sleep(150)
    expect(await alive(fx)).toBe(true)
    expect(await waitUntil(async () => !(await alive(fx)), 1500)).toBe(true)

    fx.ingest.holdOn = undefined
    expect(await waitUntil(() => fx.ingest.ofType('session_ended').length === 1)).toBe(true)
  }, 20_000)

  test('a ctl stop while the one-shot end is draining joins it and reports one session_ended', async () => {
    const fx = await fixture()
    fx.ingest.holdOn = 'session_ended'
    await start(fx, { 'one-shot': '1' })

    expect((await prompt(fx, 'hello there')).ok).toBe(true)
    expect(await waitUntil(async () => !(await alive(fx)), 5000)).toBe(true)

    const stopping = fx.daemon.ctl('stop', { pane: fx.pane })
    await Bun.sleep(200)
    fx.ingest.holdOn = undefined

    expect(await stopping).toMatchObject({ ok: true, code: 'ok' })
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    await Bun.sleep(200)
    expect(fx.ingest.ofType('session_ended')).toHaveLength(1)
  }, 20_000)

  test('a ctl stop racing the idle end reports one session_ended', async () => {
    const fx = await fixture()
    await start(fx)
    expect(await waitUntil(() => fx.ingest.events.length >= 1)).toBe(true)
    fx.ingest.holdOn = 'session_ended'

    // 1. A monitor tick that found the pane alive is parked past its probe while the stop kills the pane; the pid
    // probe is told the process lives, as it did when the tick looked.
    let parked = false
    const probe = paneModule.paneAlive
    const signal = process.kill.bind(process)
    const aliveSpy = spyOn(paneModule, 'paneAlive').mockImplementation(async (pane) => {
      const result = await probe(pane)
      parked = true
      await Bun.sleep(300)

      return result
    })
    const killSpy = spyOn(process, 'kill').mockImplementation(((pid: number, code?: string | number) =>
      code === 0 ? true : signal(pid, code)) as typeof process.kill)

    try {
      fx.daemon.setTimings({ idleTimeoutMs: 1 })
      parked = false
      expect(await waitUntil(() => parked, 2000)).toBe(true)
      const stopping = fx.daemon.ctl('stop', { pane: fx.pane })
      // Held past the parked tick's own end, so a second report would still be queued behind the first.
      await Bun.sleep(1_500)
      fx.ingest.holdOn = undefined
      expect((await stopping).ok).toBe(true)
    } finally {
      aliveSpy.mockRestore()
      killSpy.mockRestore()
    }

    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    await Bun.sleep(300)
    expect(fx.ingest.ofType('session_ended')).toHaveLength(1)
  }, 20_000)

  test('a kill that fails in the daemon own end is logged, still reported and frees the pane', async () => {
    const logger = capturingLogger()
    const fx = await fixture({ logger })
    await start(fx)
    const spawn = Bun.spawn.bind(Bun)
    type Options = Bun.SpawnOptions.OptionsObject<
      Bun.SpawnOptions.Writable,
      Bun.SpawnOptions.Readable,
      Bun.SpawnOptions.Readable
    >
    const spy = spyOn(Bun, 'spawn').mockImplementation(((command: string[], options?: Options) =>
      spawn(command.includes('kill-session') ? ['/bin/sh', '-c', 'exit 1'] : command, options)) as typeof Bun.spawn)

    try {
      fx.daemon.setTimings({ idleTimeoutMs: 100 })
      expect(await waitUntil(() => fx.ingest.ofType('session_ended').length === 1)).toBe(true)
    } finally {
      spy.mockRestore()
    }

    expect(fx.ingest.ofType('session_ended')[0]?.payload).toEqual({ reason: 'idle_timeout' })
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    expect((await status(fx)).running).toBe(false)
    expect(logger.errors.map((entry) => entry.message)).toContain('tmuxd could not kill a pane')
    expect(await alive(fx)).toBe(true)
    Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-session', '-t', `=${fx.pane}`])
  }, 20_000)

  test('the deadline refuses a prompt as busy until its Esc landed', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ secondMs: 20, cancelTimeoutMs: 1_000 })
    await start(fx, { 'deadline-seconds': '10' })

    expect((await prompt(fx, 'MUTE work')).ok).toBe(true)
    expect(await waitUntil(() => fx.ingest.ofType('turn_failed').length === 1)).toBe(true)
    expect(await prompt(fx, 'too early')).toMatchObject({ ok: false, code: 'busy' })

    // The MUTE turn writes no marker: the cancel timeout lifts the refusal.
    fx.daemon.setTimings({ secondMs: 60_000 })
    expect(await waitUntil(async () => (await prompt(fx, 'hello again')).ok, 4000)).toBe(true)
    expect(await turnClosed(fx, 2)).toBe(true)
    expect(fx.ingest.ofType('turn_completed').map((event) => event.payload.stopReason)).toEqual(['end_turn'])
  }, 20_000)

  test('the deadline Esc marker lifts the refusal and closes no later turn', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ secondMs: 20, cancelTimeoutMs: 10_000 })
    await start(fx, { 'deadline-seconds': '10' })

    expect((await prompt(fx, 'MUTE_MARK work')).ok).toBe(true)
    expect(await waitUntil(() => fx.ingest.ofType('turn_failed').length === 1)).toBe(true)

    // Accepted well inside the 10 s cancel timeout: the marker, not the timer, ended the refusal.
    fx.daemon.setTimings({ secondMs: 60_000 })
    expect(await waitUntil(async () => (await prompt(fx, 'hello again')).ok, 4000)).toBe(true)
    expect(await turnClosed(fx, 2)).toBe(true)
    await Bun.sleep(300)

    expect(fx.ingest.ofType('turn_completed').map((event) => event.payload.stopReason)).toEqual(['end_turn'])
    expect(fx.ingest.ofType('turn_failed')).toHaveLength(1)
  }, 20_000)

  test('a one-shot pane ends after the deadline fails its turn', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ secondMs: 20, cancelTimeoutMs: 100 })
    await start(fx, { 'one-shot': '1', 'deadline-seconds': '10' })

    expect((await prompt(fx, 'MUTE work')).ok).toBe(true)

    expect(await waitUntil(async () => !(await alive(fx)), 5000)).toBe(true)
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    expect(fx.ingest.types().slice(-2)).toEqual(['turn_failed', 'session_ended'])
    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toMatchObject({ reason: 'deadline' })
    expect(fx.ingest.events.at(-1)?.payload).toEqual({ reason: 'stopped' })
  }, 20_000)

  test('a one-shot pane ends after a usage limit fails its turn', async () => {
    const fx = await fixture()
    await start(fx, { 'one-shot': '1' })

    expect((await prompt(fx, 'APIERR_USAGE please')).ok).toBe(true)

    expect(await waitUntil(async () => !(await alive(fx)), 5000)).toBe(true)
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    expect(fx.ingest.types().slice(-2)).toEqual(['turn_failed', 'session_ended'])
    expect(fx.ingest.ofType('turn_failed')[0]?.payload).toMatchObject({ reason: 'usage_limit' })
  }, 20_000)

  test('the deadline does not fire after a turn that closed in time', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ secondMs: 20 })
    await start(fx, { 'deadline-seconds': '10' })

    expect((await prompt(fx, 'hello there')).ok).toBe(true)
    expect(await turnClosed(fx)).toBe(true)
    await Bun.sleep(500)

    expect(fx.ingest.ofType('turn_failed')).toHaveLength(0)
    expect(fx.ingest.ofType('turn_completed').map((event) => event.payload.stopReason)).toEqual(['end_turn'])
    expect((await prompt(fx, 'hello again')).ok).toBe(true)
  }, 20_000)
})

describe('idle timeout', () => {
  test('a quiet pane ends with session_ended idle_timeout and is gone', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ idleTimeoutMs: 300 })
    await start(fx)

    expect(await waitUntil(() => fx.ingest.ofType('session_ended').length === 1)).toBe(true)

    expect(fx.ingest.events.at(-1)).toMatchObject({ type: 'session_ended', payload: { reason: 'idle_timeout' } })
    expect(await alive(fx)).toBe(false)
    expect(await waitUntil(() => fx.idle.count === 1)).toBe(true)
    expect((await status(fx)).running).toBe(false)
    expect(fx.ingest.ofType('process_died')).toHaveLength(0)
  }, 20_000)

  test('a pane with a running turn is not ended', async () => {
    const fx = await fixture()
    await start(fx)
    expect((await prompt(fx, 'MUTE work')).ok).toBe(true)

    fx.daemon.setTimings({ idleTimeoutMs: 300 })
    await Bun.sleep(900)

    expect(await alive(fx)).toBe(true)
    expect(fx.ingest.ofType('session_ended')).toHaveLength(0)
  }, 20_000)

  test('a pane with an open dialog is not ended', async () => {
    const fx = await fixture()
    await start(fx)
    await prompt(fx, 'run the TOOL')
    expect(await waitUntil(() => fx.ingest.polls >= 2)).toBe(true)
    expect(await status(fx)).toMatchObject({ dialogOpen: true })

    fx.daemon.setTimings({ idleTimeoutMs: 300 })
    await Bun.sleep(900)

    expect(await alive(fx)).toBe(true)
    expect(fx.ingest.ofType('session_ended')).toHaveLength(0)
  }, 20_000)

  test('the idle clock starts at the end of a turn the deadline closed', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ secondMs: 20, cancelTimeoutMs: 100 })
    await start(fx, { 'deadline-seconds': '40' })
    expect((await prompt(fx, 'MUTE work')).ok).toBe(true)

    // The last transcript record is older than the timeout by the time the deadline closes the turn.
    fx.daemon.setTimings({ idleTimeoutMs: 600 })
    expect(await waitUntil(() => fx.ingest.ofType('turn_failed').length === 1)).toBe(true)
    await Bun.sleep(250)
    expect(fx.ingest.ofType('session_ended')).toHaveLength(0)

    expect(await waitUntil(() => fx.ingest.ofType('session_ended').length === 1)).toBe(true)
    expect(fx.ingest.events.at(-1)?.payload).toEqual({ reason: 'idle_timeout' })
  }, 20_000)

  test('a retaining pane is ended by its retention, not by the idle timeout', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ secondMs: 50 })
    await start(fx, { 'retain-failed-seconds': '16' })

    await prompt(fx, 'please FAIL')
    expect(await waitUntil(() => fx.ingest.ofType('turn_failed').length === 1)).toBe(true)
    fx.daemon.setTimings({ idleTimeoutMs: 100 })
    await Bun.sleep(400)
    expect(await alive(fx)).toBe(true)
    expect(fx.ingest.ofType('session_ended')).toHaveLength(0)

    expect(await waitUntil(() => fx.ingest.ofType('session_ended').length === 1)).toBe(true)
    expect(fx.ingest.ofType('session_ended')[0]?.payload).toEqual({ reason: 'stopped' })
  }, 20_000)

  test('a timeout of 0 never ends a pane', async () => {
    const fx = await fixture()
    fx.daemon.setTimings({ idleTimeoutMs: 0 })
    await start(fx)

    await Bun.sleep(900)

    expect(await alive(fx)).toBe(true)
    expect(fx.ingest.ofType('session_ended')).toHaveLength(0)
  }, 20_000)
})

describe('idleTimeoutMs', () => {
  test.each([
    ['90', 90_000],
    ['1', 1_000],
    ['0', 0],
    ['-5', 0],
    ['abc', 0],
    ['1.5', 0],
    ['', 0],
    [undefined, 0],
  ])('reads %p seconds as %p ms', (value, expected) => {
    expect(idleTimeoutMs({ KODIZM_TMUXD_IDLE_TIMEOUT_SECONDS: value })).toBe(expected)
  })
})

describe('tmuxd command line', () => {
  function cli(args: string[], env: Record<string, string> = {}, cwd?: string) {
    return Bun.spawnSync([process.execPath, ENTRY, 'tmuxd', ...args], {
      env: {
        ...process.env,
        ...env,
      },
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }

  test('--help names ctl, and an unknown verb is a usage_error line with exit 2', () => {
    expect(cli(['--help']).stdout.toString()).toContain('ctl')

    const result = cli(['ctl', 'explode'])
    expect(result.exitCode).toBe(2)
    expect(result.stdout.toString()).toBe(
      `{"ok":false,"code":"usage_error","data":{"daemon_version":"${pkg.version}"}}\n`,
    )
  })

  test('a ctl verb against no daemon reports pane_not_running', () => {
    const result = cli(['ctl', 'status', '--pane', 'x'], { KODIZM_TMUXD_SOCKET: join(root, 'none.sock') })

    expect(result.exitCode).toBe(4)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      ok: false,
      code: 'pane_not_running',
      data: {
        daemon_version: pkg.version,
        pane: 'x',
        running: false,
      },
    })
  })

  describe('start validation before any daemon is asked', () => {
    async function handoffFiles(): Promise<Record<string, string>> {
      const dir = await mkdtemp(join(root, 'handoff-'))

      return {
        'env-file': await writeSecretFile(join(dir, 'live.env'), 'KODIZM_LIVE_TOKEN=kdz-int-jwt.FAKE.FAKE\n'),
        'tool-policy': await writeSecretFile(join(dir, 'policy.json'), '{}'),
        'system-prompt-file': await writeSecretFile(join(dir, 'system-prompt.md'), 'You run as a test pane.'),
        'mcp-config': await writeSecretFile(join(dir, 'mcp.json'), '{"mcpServers":{}}'),
      }
    }

    // Short, because a unix socket path is capped near 104 bytes on macOS.
    function shortId(): string {
      return crypto.randomUUID().slice(0, 8)
    }

    function fileArgs(files: Record<string, string>): string[] {
      return Object.entries(files).flatMap(([flag, path]) => [`--${flag}`, path])
    }

    const cases: Array<[string, string[]]> = [
      ['an unknown flag', ['--bogus', 'x']],
      ['a bare flag without a value', ['--one-shot']],
      ['a bad permission mode', ['--permission-mode', 'nope']],
    ]

    for (const [label, extra] of cases) {
      test(`ctl start with ${label} is a usage_error, spawns no daemon and deletes all four hand-off files`, async () => {
        const files = await handoffFiles()
        const socketPath = join(root, `${shortId()}.sock`)

        const result = cli(['ctl', 'start', '--pane', 'p', ...fileArgs(files), ...extra], {
          KODIZM_TMUXD_SOCKET: socketPath,
        })

        expect(result.exitCode).toBe(2)
        expect(JSON.parse(result.stdout.toString())).toEqual({
          ok: false,
          code: 'usage_error',
          data: { daemon_version: pkg.version },
        })
        for (const path of Object.values(files)) {
          expect(await Bun.file(path).exists()).toBe(false)
        }
        expect(await Bun.file(socketPath).exists()).toBe(false)
      })
    }

    test('ctl start with a directory as one hand-off path still deletes the other three and prints the reply', async () => {
      const files = await handoffFiles()
      const directory = await mkdtemp(join(root, 'policy-dir-'))
      const socketPath = join(root, `${shortId()}.sock`)

      const result = cli(
        ['ctl', 'start', '--pane', 'p', ...fileArgs({ ...files, 'tool-policy': directory }), '--bogus', 'x'],
        { KODIZM_TMUXD_SOCKET: socketPath },
      )

      expect(result.exitCode).toBe(2)
      expect(JSON.parse(result.stdout.toString())).toEqual({
        ok: false,
        code: 'usage_error',
        data: { daemon_version: pkg.version },
      })
      for (const flag of ['env-file', 'system-prompt-file', 'mcp-config']) {
        expect(await Bun.file(files[flag] ?? '').exists()).toBe(false)
      }
      const stderr = result.stderr.toString()
      expect(stderr).toContain('"flag":"tool-policy"')
      expect(stderr).not.toContain(directory)
      expect(await Bun.file(socketPath).exists()).toBe(false)
    })

    test('a relative path flag is resolved against the caller cwd before removal', async () => {
      const dir = await mkdtemp(join(root, 'relative-'))
      const policy = await writeSecretFile(join(dir, 'policy.json'), '{}')
      const socketPath = join(root, `${shortId()}.sock`)

      const result = cli(
        ['ctl', 'start', '--pane', 'p', '--tool-policy', 'policy.json', '--bogus', 'x'],
        { KODIZM_TMUXD_SOCKET: socketPath },
        dir,
      )

      expect(result.exitCode).toBe(2)
      expect(await Bun.file(policy).exists()).toBe(false)
      expect(await Bun.file(socketPath).exists()).toBe(false)
    })

    test('a verb that is an Object.prototype name is a clean usage_error line, not a crash', () => {
      const socketPath = join(root, `${shortId()}.sock`)

      const result = cli(['ctl', 'constructor', '--pane', 'p'], { KODIZM_TMUXD_SOCKET: socketPath })

      expect(result.exitCode).toBe(2)
      expect(result.stdout.toString()).toBe(
        `{"ok":false,"code":"usage_error","data":{"daemon_version":"${pkg.version}"}}\n`,
      )
      expect(result.stderr.toString()).toBe('')
    })

    test('ctl status with no daemon exits 4 with daemon_version and spawns nothing', () => {
      const socketPath = join(root, `${shortId()}.sock`)

      const result = cli(['ctl', 'status', '--pane', 'p'], { KODIZM_TMUXD_SOCKET: socketPath })

      expect(result.exitCode).toBe(4)
      expect(JSON.parse(result.stdout.toString())).toEqual({
        ok: false,
        code: 'pane_not_running',
        data: {
          daemon_version: pkg.version,
          pane: 'p',
          running: false,
        },
      })
      expect(Object.keys(JSON.parse(result.stdout.toString()).data)[0]).toBe('daemon_version')
    })
  })

  test('a ctl verb against no daemon deletes its hand-off file', async () => {
    const env = { KODIZM_TMUXD_SOCKET: join(root, 'none.sock') }
    const dir = await mkdtemp(join(root, 'handoff-'))
    const promptFile = join(dir, 'prompt.txt')
    const tokenFile = join(dir, 'token')

    await writeFile(promptFile, 'a prompt that must not linger')
    expect(cli(['ctl', 'prompt', '--pane', 'x', '--file', promptFile], env).exitCode).toBe(4)
    expect(await Bun.file(promptFile).exists()).toBe(false)

    await writeSecretFile(tokenFile, token(1))
    expect(cli(['ctl', 'rotate-token', '--pane', 'x', '--token-file', tokenFile], env).exitCode).toBe(4)
    expect(await Bun.file(tokenFile).exists()).toBe(false)
  })

  test('a ctl usage_error before the daemon is asked still deletes the hand-off file', async () => {
    const dir = await mkdtemp(join(root, 'handoff-'))
    const envPath = join(dir, 'live.env')
    await writeSecretFile(envPath, 'KODIZM_LIVE_TOKEN=kdz-int-jwt.FAKE.FAKE\n')

    const result = cli(['ctl', 'start', '--env-file', envPath, '--pane', 'x', '--pane', 'y'], {
      KODIZM_TMUXD_SOCKET: join(root, 'none.sock'),
    })

    expect(result.exitCode).toBe(2)
    expect(await Bun.file(envPath).exists()).toBe(false)
  })

  test('ctl start spawns the detached daemon, ctl stop ends it, and stdout carries one JSON line each', async () => {
    const fx = await fixture()
    const socketPath = join(fx.dir, 'cli.sock')
    const env = {
      KODIZM_TMUXD_SOCKET: socketPath,
      KODIZM_TMUXD_TMUX_SOCKET: SOCKET,
      KODIZM_LIVE_BASE_SETTINGS: fx.baseSettings,
      CLAUDE_CODE_PATH: fx.stub,
      HOME: fx.home,
    }
    const envPath = await writeSecretFile(join(fx.dir, 'cli.env'), envFile(fx))
    const pane = `${fx.pane}-cli`

    const started = cli(
      ['ctl', 'start', '--pane', pane, '--cwd', fx.cwd, '--settings-base', fx.settingsBase, '--env-file', envPath],
      env,
    )
    const lines = started.stdout.toString().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ok: true, code: 'ok', data: { pane, gen: 1 } })
    expect(started.exitCode).toBe(0)

    const running = cli(['ctl', 'status', '--pane', pane], env)
    expect(JSON.parse(running.stdout.toString())).toMatchObject({ ok: true, data: { running: true, busy: false } })

    const stopped = cli(['ctl', 'stop', '--pane', pane], env)
    expect(stopped.exitCode).toBe(0)
    expect(await waitUntil(async () => !(await Bun.file(socketPath).exists()))).toBe(true)
  }, 30_000)
})
