import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InputRejectedError } from '@/live/input.ts'
import {
  type Pane,
  PaneError,
  cancelPane,
  createPane,
  deliverCommand,
  deliverPrompt,
  killPane,
  paneAlive,
  supportsPasteBufferS,
} from '@/live/pane.ts'

// Runs against a real tmux on its own socket. The pane program is a stub that records its argv and env, puts the pty
// in raw mode, turns bracketed paste on like the Claude TUI does, and copies every byte it receives to a file.
const SOCKET = 'kdz-test'
const BRACKET_OPEN = '\x1b[200~'
const BRACKET_CLOSE = '\x1b[201~'
const DAEMON_SECRET_NAME = 'KDZ_TEST_DAEMON_SECRET'

const STUB = `#!/bin/sh
dir="$(dirname "$0")"
printf '%s\\n' "$@" > "$dir/args"
env > "$dir/env"
stty raw -echo
printf '\\033[?2004h'
exec cat > "$dir/input"
`

let root = ''
let counter = 0
const created: Pane[] = []

interface Fixture {
  dir: string
  cwd: string
  home: string
  stub: string
}

function tmux(...args: string[]): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(['tmux', '-L', SOCKET, ...args])

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
  }
}

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return true
    }
    await Bun.sleep(25)
  }

  return check()
}

async function readOrEmpty(path: string): Promise<string> {
  const file = Bun.file(path)

  return (await file.exists()) ? file.text() : ''
}

async function fixture(stubBody = STUB): Promise<Fixture> {
  counter += 1
  const dir = join(root, `case-${counter}`)
  const cwd = join(dir, 'work')
  const home = join(dir, 'home')
  const stub = join(dir, 'stub.sh')
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(stub, stubBody)
  await chmod(stub, 0o755)

  return {
    dir,
    cwd,
    home,
    stub,
  }
}

async function launch(fx: Fixture, extra: Partial<Parameters<typeof createPane>[0]> = {}): Promise<Pane> {
  const pane = await createPane({
    id: `kdz-pane-${counter}`,
    cwd: fx.cwd,
    home: fx.home,
    settingsPath: join(fx.dir, 'settings.json'),
    claudeBin: fx.stub,
    socket: SOCKET,
    ...extra,
  })
  created.push(pane)

  return pane
}

async function launchReady(fx: Fixture, extra: Partial<Parameters<typeof createPane>[0]> = {}): Promise<Pane> {
  const pane = await launch(fx, extra)
  // The input file appears when `cat` starts, after `stty raw`: bytes sent earlier would go through a cooked pty.
  expect(await waitUntil(() => Bun.file(join(fx.dir, 'input')).exists())).toBe(true)

  return pane
}

async function envOf(fx: Fixture): Promise<Map<string, string>> {
  await waitUntil(async () => (await readOrEmpty(join(fx.dir, 'env'))) !== '')
  const lines = (await readOrEmpty(join(fx.dir, 'env'))).split('\n').filter((line) => line.includes('='))

  return new Map(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
}

// The stub writes one argument per line; the empty `--setting-sources` value is the blank line.
async function argsOf(fx: Fixture): Promise<string[]> {
  await waitUntil(async () => (await readOrEmpty(join(fx.dir, 'args'))) !== '')

  return (await readOrEmpty(join(fx.dir, 'args'))).slice(0, -1).split('\n')
}

const confirmOnCarriageReturn =
  (fx: Fixture, count = 1) =>
  async (timeoutMs: number) =>
    waitUntil(async () => (await readOrEmpty(join(fx.dir, 'input'))).split('\r').length - 1 >= count, timeoutMs)

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'kdz-pane-test-')))
})

afterEach(async () => {
  for (const pane of created.splice(0)) {
    await killPane(pane)
  }
})

afterAll(async () => {
  tmux('kill-server')
  await rm(root, { recursive: true, force: true })
})

describe('supportsPasteBufferS', () => {
  const cases: ReadonlyArray<[string, boolean]> = [
    ['tmux 3.5a', false],
    ['tmux 3.6', false],
    ['tmux 3.6b', false],
    ['tmux 3.7', true],
    ['tmux 3.7c', true],
    ['tmux 3.8', true],
    ['tmux next-3.9', true],
    ['tmux 4.0', true],
    ['tmux 10.1', true],
    ['tmux 2.9a', false],
    ['tmux 3.5a\n', false],
    ['tmux master', false],
    ['tmux', false],
    ['', false],
    ['garbage', false],
    ['3.8', false],
  ]

  for (const [output, expected] of cases) {
    test(`${JSON.stringify(output)} -> ${expected}`, () => {
      expect(supportsPasteBufferS(output)).toBe(expected)
    })
  }
})

describe('createPane', () => {
  test('passes --model as its own argv element', async () => {
    const fx = await fixture()
    await launchReady(fx, { model: 'claude-opus-4-5[1m]' })

    const args = (await readOrEmpty(join(fx.dir, 'args'))).trim().split('\n')
    expect(args.slice(-2)).toEqual(['--model', 'claude-opus-4-5[1m]'])
  })

  for (const model of ['op us', '--dangerously-skip-permissions', '', 'a'.repeat(65), 'opus;id']) {
    test(`rejects the model ${JSON.stringify(model)} before tmux runs`, async () => {
      const fx = await fixture()

      await expect(launch(fx, { model })).rejects.toMatchObject({ reason: 'invalid_model' })
      expect(tmux('has-session', '-t', `=kdz-pane-${counter}`).exitCode).not.toBe(0)
    })
  }

  test('launches the program with --settings and the setting source restriction', async () => {
    const fx = await fixture()
    await launchReady(fx)

    // The stub prints one argument per line, so the empty source list is the blank line at the end.
    const args = await readOrEmpty(join(fx.dir, 'args'))
    expect(args).toBe(`--settings\n${join(fx.dir, 'settings.json')}\n--setting-sources\n\n`)
  })

  test('passes --resume with the session id', async () => {
    const fx = await fixture()
    await launchReady(fx, { resumeSessionId: '0b7f6a3e-1d2c-4f5a-9e8d-7c6b5a4f3e2d' })

    const args = (await readOrEmpty(join(fx.dir, 'args'))).trim().split('\n')
    expect(args.slice(-2)).toEqual(['--resume', '0b7f6a3e-1d2c-4f5a-9e8d-7c6b5a4f3e2d'])
  })

  test('gives the pane an explicit minimal env and none of the daemon env', async () => {
    const fx = await fixture()
    process.env[DAEMON_SECRET_NAME] = 'daemon-only-value'
    try {
      await launchReady(fx, {
        env: {
          CLAUDE_CODE_FAKE_FLAG: '1',
          CLAUDE_CODE_SESSION_ID: 'parent-session',
          CLAUDE_CODE_CHILD_SESSION: '1',
          PATH: '/usr/bin:/bin',
        },
      })
    } finally {
      delete process.env[DAEMON_SECRET_NAME]
    }

    const env = await envOf(fx)
    expect(env.get('HOME')).toBe(fx.home)
    expect(env.get('PATH')).toBe('/usr/bin:/bin')
    expect(env.get('TERM')).toBe('xterm-256color')
    expect(env.get('CI')).toBe('1')
    expect(env.get('CLAUDE_CODE_FAKE_FLAG')).toBe('1')
    expect(env.has('CLAUDE_CODE_SESSION_ID')).toBe(false)
    expect(env.has('CLAUDE_CODE_CHILD_SESSION')).toBe(false)
    expect(env.has(DAEMON_SECRET_NAME)).toBe(false)
  })

  test('pre-seeds onboarding and trust by realpath, keeping existing config', async () => {
    const fx = await fixture()
    const linked = join(fx.dir, 'linked-work')
    await symlink(fx.cwd, linked)
    await writeFile(
      join(fx.home, '.claude.json'),
      JSON.stringify({
        theme: 'light',
        oauthAccount: {
          emailAddress: 'kept@example.invalid',
        },
      }),
    )
    const configDir = join(fx.dir, 'config')

    await launchReady(fx, {
      cwd: linked,
      env: {
        CLAUDE_CONFIG_DIR: configDir,
      },
    })

    for (const dir of [fx.home, configDir]) {
      const config = JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8'))
      expect(config.hasCompletedOnboarding).toBe(true)
      expect(config.projects[fx.cwd].hasTrustDialogAccepted).toBe(true)
      expect(config.projects[linked]).toBeUndefined()
    }
    const home = JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf8'))
    expect(home.theme).toBe('light')
    expect(home.oauthAccount.emailAddress).toBe('kept@example.invalid')
  })

  test('adds the mcp config pair, the system prompt path and the permission mode in order before the model', async () => {
    const fx = await fixture()
    await launchReady(fx, {
      mcpConfig: '/hand-off/mcp.json',
      systemPromptFile: '/hand-off/prompt.md',
      permissionMode: 'dontAsk',
      model: 'opus',
      resumeSessionId: '0b7f6a3e-1d2c-4f5a-9e8d-7c6b5a4f3e2d',
    })

    expect((await argsOf(fx)).slice(4)).toEqual([
      '--permission-mode',
      'dontAsk',
      '--mcp-config',
      '/hand-off/mcp.json',
      '--strict-mcp-config',
      '--append-system-prompt-file',
      '/hand-off/prompt.md',
      '--model',
      'opus',
      '--resume',
      '0b7f6a3e-1d2c-4f5a-9e8d-7c6b5a4f3e2d',
    ])
  })

  test('adds the permission mode only when one is given', async () => {
    const withMode = await fixture()
    await launchReady(withMode, { permissionMode: 'default' })
    const without = await fixture()
    await launchReady(without, { id: 'kdz-pane-without-mode' })

    expect((await argsOf(withMode)).slice(4)).toEqual(['--permission-mode', 'default'])
    expect(await argsOf(without)).not.toContain('--permission-mode')
  })

  test('adds neither mcp flags nor a system prompt flag when the options are absent', async () => {
    const fx = await fixture()
    await launchReady(fx)

    const args = await argsOf(fx)
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--strict-mcp-config')
    expect(args).not.toContain('--append-system-prompt-file')
  })

  test('disables background tasks even when the env asks otherwise', async () => {
    const fx = await fixture()
    await launchReady(fx, { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } })

    expect((await envOf(fx)).get('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS')).toBe('1')
  })

  test('disables background tasks when the env does not mention them', async () => {
    const fx = await fixture()
    await launchReady(fx)

    expect((await envOf(fx)).get('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS')).toBe('1')
  })

  test('trusts the working directory and the git root above it', async () => {
    const fx = await fixture()
    await mkdir(join(fx.dir, '.git'))
    const nested = join(fx.cwd, 'packages', 'app')
    await mkdir(nested, { recursive: true })

    await launchReady(fx, { cwd: nested })

    const config = JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf8'))
    for (const path of [nested, fx.dir]) {
      expect(config.projects[path].hasTrustDialogAccepted).toBe(true)
      expect(config.projects[path].hasCompletedProjectOnboarding).toBe(true)
    }
    expect(Object.keys(config.projects).sort()).toEqual([fx.dir, nested].sort())
  })

  test('trusts the main checkout of a worktree, with a relative gitdir', async () => {
    const fx = await fixture()
    const main = join(fx.dir, 'main')
    const worktree = join(fx.dir, 'wt')
    const gitdir = join(main, '.git', 'worktrees', 'wt')
    await mkdir(gitdir, { recursive: true })
    await writeFile(join(gitdir, 'commondir'), '../..\n')
    await mkdir(join(worktree, 'src'), { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: ../main/.git/worktrees/wt\n')

    await launchReady(fx, { cwd: join(worktree, 'src') })

    const config = JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf8'))
    expect(Object.keys(config.projects).sort()).toEqual([main, join(worktree, 'src'), worktree].sort())
    expect(config.projects[main].hasTrustDialogAccepted).toBe(true)
  })

  test('trusts the main checkout of a worktree, with an absolute gitdir', async () => {
    const fx = await fixture()
    const main = join(fx.dir, 'main')
    const worktree = join(fx.dir, 'wt')
    const gitdir = join(main, '.git', 'worktrees', 'wt')
    await mkdir(gitdir, { recursive: true })
    await writeFile(join(gitdir, 'commondir'), '../..')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), `gitdir: ${gitdir}`)

    await launchReady(fx, { cwd: worktree })

    const config = JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf8'))
    expect(Object.keys(config.projects).sort()).toEqual([main, worktree].sort())
  })

  test('adds no extra root for a gitfile whose gitdir has no commondir', async () => {
    const fx = await fixture()
    const worktree = join(fx.dir, 'wt')
    await mkdir(join(fx.dir, 'modules'), { recursive: true })
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: ../modules\n')

    await launchReady(fx, { cwd: worktree })

    const config = JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf8'))
    expect(Object.keys(config.projects)).toEqual([worktree])
  })

  test('approves the last 20 characters of the api key, keeping the rejected list', async () => {
    const fx = await fixture()
    await writeFile(
      join(fx.home, '.claude.json'),
      JSON.stringify({
        customApiKeyResponses: {
          approved: ['earlier-suffix'],
          rejected: ['refused-suffix'],
        },
      }),
    )

    await launchReady(fx, { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-prefix-0123456789ABCDEFGHIJ' } })

    const config = JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf8'))
    expect(config.customApiKeyResponses).toEqual({
      approved: ['earlier-suffix', '0123456789ABCDEFGHIJ'],
      rejected: ['refused-suffix'],
    })
  })

  test('creates the key responses when the config has none, and does not duplicate on a repeated start', async () => {
    const fx = await fixture()
    const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-prefix-0123456789ABCDEFGHIJ' }

    const first = await launchReady(fx, { env })
    await killPane(first)
    await launchReady(fx, { env, id: 'kdz-pane-again' })

    const config = JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf8'))
    expect(config.customApiKeyResponses).toEqual({
      approved: ['0123456789ABCDEFGHIJ'],
      rejected: [],
    })
  })

  test('leaves the key responses alone without an api key', async () => {
    const withExisting = await fixture()
    const existing = { approved: ['kept'], rejected: ['also-kept'] }
    await writeFile(join(withExisting.home, '.claude.json'), JSON.stringify({ customApiKeyResponses: existing }))
    const bare = await fixture()

    await launchReady(withExisting, { env: { ANTHROPIC_API_KEY: '' }, id: 'kdz-pane-existing' })
    await launchReady(bare)

    const kept = JSON.parse(await readFile(join(withExisting.home, '.claude.json'), 'utf8'))
    const created = JSON.parse(await readFile(join(bare.home, '.claude.json'), 'utf8'))
    expect(kept.customApiKeyResponses).toEqual(existing)
    expect(created.customApiKeyResponses).toBeUndefined()
  })

  test('rejects a pane id tmux could misread as a target', async () => {
    const fx = await fixture()
    const attempt = createPane({
      id: 'bad:id.0',
      cwd: fx.cwd,
      home: fx.home,
      settingsPath: join(fx.dir, 'settings.json'),
      claudeBin: fx.stub,
      socket: SOCKET,
    })

    await expect(attempt).rejects.toMatchObject({ reason: 'invalid_pane_id' })
  })

  test('rejects a resume id that could become an option', async () => {
    const fx = await fixture()

    await expect(launch(fx, { resumeSessionId: '--dangerously-skip-permissions' })).rejects.toMatchObject({
      reason: 'invalid_resume_id',
    })
  })

  test('kills the pane and throws when the start signal never arrives', async () => {
    const fx = await fixture()
    const seen: number[] = []

    const attempt = launch(fx, {
      confirmStarted: async (timeoutMs) => {
        seen.push(timeoutMs)
        return false
      },
    })

    await expect(attempt).rejects.toMatchObject({ reason: 'start_timeout' })
    expect(seen).toEqual([10_000])
    expect(tmux('has-session', '-t', `=kdz-pane-${counter}`).exitCode).not.toBe(0)
  })

  test('refuses a second pane with the same id', async () => {
    const fx = await fixture()
    await launchReady(fx)

    await expect(launch(fx)).rejects.toBeInstanceOf(PaneError)
  })
})

describe('deliverPrompt', () => {
  test('pastes a multi-line text byte-exact inside bracketed paste, then one Enter', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)
    const text = 'first line\nsecond line: çğıöşü 漢字 🙂\n  indented !not-bash /not-slash\nC-c literal'

    expect(await deliverPrompt(pane, text, confirmOnCarriageReturn(fx))).toBe('submitted')

    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe(`${BRACKET_OPEN}${text}${BRACKET_CLOSE}\r`)
  })

  test('stops the Enter ladder once abortIf turns true and reports the abort', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)
    let checks = 0

    const outcome = await deliverPrompt(
      pane,
      'hello',
      async () => false,
      () => {
        checks += 1
        return checks === 2
      },
    )

    expect(outcome).toBe('aborted')
    expect(checks).toBe(2)
    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe(`${BRACKET_OPEN}hello${BRACKET_CLOSE}\r`)
  })

  test('sends no Enter at all when abortIf is true from the start', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)

    expect(
      await deliverPrompt(
        pane,
        'hello',
        async () => false,
        () => true,
      ),
    ).toBe('aborted')
    await Bun.sleep(100)
    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe(`${BRACKET_OPEN}hello${BRACKET_CLOSE}`)
  })

  test('reports submitted when the submit signal already fired as abortIf turns true', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)
    const windows: number[] = []

    const outcome = await deliverPrompt(
      pane,
      'hello',
      async (timeoutMs) => {
        windows.push(timeoutMs)
        return timeoutMs === 0
      },
      () => windows.length > 0,
    )

    expect(outcome).toBe('submitted')
    expect(windows).toEqual([328, 0])
  })

  test('pastes the sanitised bytes, not the raw ones', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)

    await deliverPrompt(pane, `a\x1b${BRACKET_CLOSE}\x03\u009bb\tc`, confirmOnCarriageReturn(fx))

    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe(`${BRACKET_OPEN}a[201~b    c${BRACKET_CLOSE}\r`)
  })

  test('re-sends Enter on the ladder until the submit signal arrives', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)
    const windows: number[] = []
    let calls = 0

    await deliverPrompt(pane, 'hello', async (timeoutMs) => {
      windows.push(timeoutMs)
      calls += 1
      return calls === 3
    })

    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe(`${BRACKET_OPEN}hello${BRACKET_CLOSE}\r\r\r`)
    expect(windows).toEqual([328, 656, 1312])
  })

  test('throws not_submitted when the ladder runs out', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)

    await expect(deliverPrompt(pane, 'hello', async () => false)).rejects.toMatchObject({ reason: 'not_submitted' })
    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe(`${BRACKET_OPEN}hello${BRACKET_CLOSE}\r\r\r\r`)
  })

  test('rejects a slash command before touching the pane', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)

    await expect(deliverPrompt(pane, ' /clear', async () => true)).rejects.toBeInstanceOf(InputRejectedError)
    await Bun.sleep(100)
    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe('')
  })

  test('leaves no paste buffer behind', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)

    await deliverPrompt(pane, 'buffered', confirmOnCarriageReturn(fx))

    expect(tmux('list-buffers').stdout).toBe('')
  })

  test('throws pane_dead for a pane whose program exited', async () => {
    const fx = await fixture('#!/bin/sh\nexit 0\n')
    const pane = await launch(fx)
    await waitUntil(async () => !(await paneAlive(pane)))

    await expect(deliverPrompt(pane, 'hello', async () => true)).rejects.toMatchObject({ reason: 'pane_dead' })
  })
})

describe('deliverCommand', () => {
  test('types an allowlisted command literally, then Enter', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)

    await deliverCommand(pane, '/model claude-opus-4.5')

    await waitUntil(async () => (await readOrEmpty(join(fx.dir, 'input'))).endsWith('\r'))
    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe('/model claude-opus-4.5\r')
  })

  test('rejects a command outside the allowlist before touching the pane', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)

    await expect(deliverCommand(pane, '/login')).rejects.toBeInstanceOf(InputRejectedError)
    await Bun.sleep(100)
    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe('')
  })
})

describe('cancelPane, paneAlive, killPane', () => {
  test('cancel sends Esc and then clears the composer', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)

    await cancelPane(pane)

    await waitUntil(async () => (await readOrEmpty(join(fx.dir, 'input'))).length >= 2)
    expect(await readOrEmpty(join(fx.dir, 'input'))).toBe('\x1b\x15')
  })

  test('liveness follows the pane, and killing the last pane leaves no server', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)
    expect(await paneAlive(pane)).toBe(true)

    await killPane(pane)

    expect(await paneAlive(pane)).toBe(false)
    expect(await waitUntil(() => tmux('ls').exitCode !== 0)).toBe(true)
  })

  test('liveness matches the pane id exactly, not as a prefix', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)

    expect(await paneAlive({ ...pane, id: pane.id.slice(0, -1) })).toBe(false)
  })

  test('killing a pane that is already gone is a no-op', async () => {
    const fx = await fixture()
    const pane = await launchReady(fx)
    await killPane(pane)

    await killPane(pane)

    expect(await paneAlive(pane)).toBe(false)
  })
})
