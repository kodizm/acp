import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { type Server, type Socket, createServer } from 'node:net'
import { join } from 'node:path'

import {
  HOOK_EVENTS,
  HOOK_TIMEOUT_S,
  PERMISSION_HOOK_TIMEOUT_S,
  buildPaneSettings,
  hookDecisionOutput,
  runHookHelper,
  shellQuote,
  writePaneSettings,
} from '@/live/hooks.ts'

const PACKAGE_ROOT = join(import.meta.dir, '..', '..', '..')
const ENTRY = join(PACKAGE_ROOT, 'src', 'index.ts')

let root = ''
let counter = 0

beforeAll(async () => {
  // /tmp keeps socket paths under the 104-byte macOS limit.
  root = await mkdtemp('/tmp/kdz-hooks-')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function baseFile(content: unknown): Promise<string> {
  counter += 1
  const path = join(root, `base-${counter}.json`)
  await writeFile(path, JSON.stringify(content))

  return path
}

type Responder = (request: Record<string, unknown>, socket: Socket) => void

async function fakeDaemon(
  respond: Responder,
): Promise<{ path: string; seen: Record<string, unknown>[]; server: Server }> {
  counter += 1
  const path = join(root, `d-${counter}.sock`)
  const seen: Record<string, unknown>[] = []
  const server = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        seen.push(request)
        respond(request, socket)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))

  return {
    path,
    seen,
    server,
  }
}

const reply = (body: unknown) => (_request: Record<string, unknown>, socket: Socket) => {
  socket.end(`${JSON.stringify(body)}\n`)
}

describe('buildPaneSettings', () => {
  test('keeps the base deny list, re-enables hooks and registers every event', async () => {
    const basePath = await baseFile({
      permissions: {
        deny: ['WebFetch', 'WebSearch'],
      },
      disableAllHooks: true,
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'image-hook',
              },
            ],
          },
        ],
      },
    })

    const settings = await buildPaneSettings({
      basePath,
      helperArgv: ['/usr/local/bin/bun', '/opt/kodizm acp/index.js'],
      socketPath: '/run/kodizm-live/tmuxd.sock',
      paneId: 'live-019e0000',
    })

    expect(settings.permissions).toEqual({ deny: ['WebFetch', 'WebSearch'] })
    expect(settings.disableAllHooks).toBe(false)

    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort())
    for (const event of HOOK_EVENTS) {
      const [entry] = hooks[event]?.[0]?.hooks ?? []
      expect(entry?.type).toBe('command')
      const expected = [
        "'/usr/local/bin/bun' '/opt/kodizm acp/index.js' 'tmuxd' 'hook'",
        `'${event}' '--pane' 'live-019e0000' '--socket' '/run/kodizm-live/tmuxd.sock'`,
      ]
      expect(entry?.command).toBe(expected.join(' '))
      expect(entry?.timeout).toBe(event === 'PermissionRequest' ? PERMISSION_HOOK_TIMEOUT_S : HOOK_TIMEOUT_S)
    }
  })

  test('outlives the default permission row expiry of 30 minutes', () => {
    expect(PERMISSION_HOOK_TIMEOUT_S).toBeGreaterThan(30 * 60)
  })

  test('fails closed when the base file with the deny list is missing or not an object', async () => {
    const options = {
      helperArgv: ['bun'],
      socketPath: '/s',
      paneId: 'p',
    }

    await expect(buildPaneSettings({ ...options, basePath: join(root, 'absent.json') })).rejects.toThrow()
    await expect(buildPaneSettings({ ...options, basePath: await baseFile([1, 2]) })).rejects.toThrow()
  })

  describe('with permission rules', () => {
    const options = {
      helperArgv: ['bun'],
      socketPath: '/s',
      paneId: 'p',
    }

    test('keeps the base deny list and appends the rule deny entries', async () => {
      const settings = await buildPaneSettings({
        ...options,
        basePath: await baseFile({ permissions: { deny: ['WebFetch'] }, model: 'opus' }),
        rules: {
          allow: ['Read'],
          deny: ['Read(//proc/**)'],
          ask: ['Bash(git push*)'],
        },
      })

      expect(settings.permissions).toEqual({
        allow: ['Read'],
        deny: ['WebFetch', 'Read(//proc/**)'],
        ask: ['Bash(git push*)'],
      })
      expect(settings.model).toBe('opus')
    })

    test('removes a rule entry the base already holds', async () => {
      const settings = await buildPaneSettings({
        ...options,
        basePath: await baseFile({ permissions: { deny: ['WebFetch', 'WebSearch'], allow: ['Read'] } }),
        rules: {
          allow: ['Read', 'Grep'],
          deny: ['WebSearch', 'Bash'],
          ask: [],
        },
      })

      expect(settings.permissions).toEqual({
        allow: ['Read', 'Grep'],
        deny: ['WebFetch', 'WebSearch', 'Bash'],
        ask: [],
      })
    })

    test('creates the permissions key when the base has none', async () => {
      const settings = await buildPaneSettings({
        ...options,
        basePath: await baseFile({ model: 'opus' }),
        rules: {
          allow: [],
          deny: ['Edit(//etc/**)'],
          ask: [],
        },
      })

      expect(settings.permissions).toEqual({
        allow: [],
        deny: ['Edit(//etc/**)'],
        ask: [],
      })
    })

    test('keeps a base defaultMode and never writes one itself', async () => {
      const withMode = await buildPaneSettings({
        ...options,
        basePath: await baseFile({ permissions: { defaultMode: 'acceptEdits' } }),
        rules: {
          allow: ['Read'],
          deny: ['Bash'],
          ask: ['Edit'],
        },
      })
      const withoutMode = await buildPaneSettings({
        ...options,
        basePath: await baseFile({}),
        rules: {
          allow: ['Read'],
          deny: [],
          ask: [],
        },
      })

      expect(withMode.permissions).toEqual({
        defaultMode: 'acceptEdits',
        allow: ['Read'],
        deny: ['Bash'],
        ask: ['Edit'],
      })
      expect(withoutMode.permissions).not.toHaveProperty('defaultMode')
    })

    test('gives the base permissions unchanged without rules', async () => {
      const base = {
        permissions: {
          deny: ['WebFetch'],
          defaultMode: 'acceptEdits',
        },
        model: 'opus',
      }
      const settings = await buildPaneSettings({ ...options, basePath: await baseFile(base) })
      const bare = await buildPaneSettings({ ...options, basePath: await baseFile({}) })

      expect(settings.permissions).toEqual(base.permissions)
      expect(settings.model).toBe('opus')
      expect(bare).not.toHaveProperty('permissions')
    })
  })

  test('writePaneSettings writes the file with mode 0600', async () => {
    const path = join(root, 'pane.settings.json')
    await writePaneSettings(path, {
      basePath: await baseFile({ permissions: { deny: [] } }),
      helperArgv: ['bun'],
      socketPath: '/s',
      paneId: 'p',
    })

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await Bun.file(path).text()).disableAllHooks).toBe(false)
  })
})

describe('shellQuote', () => {
  test('wraps in single quotes and escapes embedded ones', () => {
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`)
  })
})

describe('hookDecisionOutput', () => {
  test('prints the hook JSON for an explicit allow or deny', () => {
    expect(JSON.parse(hookDecisionOutput({ behavior: 'allow' }))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
        },
      },
    })
    expect(JSON.parse(hookDecisionOutput({ behavior: 'deny', message: 'Denied by the operator.' }))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: 'Denied by the operator.',
        },
      },
    })
  })

  test('prints nothing for anything that is not an explicit answer', () => {
    for (const decision of [undefined, null, {}, { behavior: 'ask' }, { behavior: 'ALLOW' }, 'allow', []]) {
      expect(hookDecisionOutput(decision)).toBe('')
    }
  })
})

describe('runHookHelper', () => {
  test('forwards the hook payload to the daemon and prints nothing for a plain event', async () => {
    const daemon = await fakeDaemon(reply({ ok: true }))

    const output = await runHookHelper({
      event: 'Stop',
      paneId: 'p1',
      socketPath: daemon.path,
      input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'done' }),
    })

    expect(output).toBe('')
    expect(daemon.seen).toEqual([
      {
        kind: 'hook',
        pane: 'p1',
        event: 'Stop',
        payload: {
          hook_event_name: 'Stop',
          last_assistant_message: 'done',
        },
      },
    ])
    daemon.server.close()
  })

  test('prints the decision the daemon returns for a PermissionRequest', async () => {
    const daemon = await fakeDaemon(reply({ ok: true, decision: { behavior: 'deny', message: 'No.' } }))

    const output = await runHookHelper({
      event: 'PermissionRequest',
      paneId: 'p1',
      socketPath: daemon.path,
      input: '{"tool_name":"Bash"}',
    })

    expect(JSON.parse(output).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'No.' })
    daemon.server.close()
  })

  test('prints nothing when the daemon closes without an answer, answers garbage or never answers', async () => {
    const closes = await fakeDaemon((_request, socket) => socket.end())
    const garbage = await fakeDaemon((_request, socket) => socket.end('{"decision":{"behavior":"allow"\n'))
    const silent = await fakeDaemon(() => {})

    for (const daemon of [closes, garbage, silent]) {
      const output = await runHookHelper({
        event: 'PermissionRequest',
        paneId: 'p1',
        socketPath: daemon.path,
        input: '{}',
        timeoutMs: 300,
      })
      expect(output).toBe('')
      daemon.server.close()
    }
  })

  test('prints nothing and contacts nobody for input that is not a JSON object', async () => {
    const daemon = await fakeDaemon(reply({ ok: true, decision: { behavior: 'allow' } }))

    for (const input of ['', 'not json', '[1]']) {
      expect(await runHookHelper({ event: 'PermissionRequest', paneId: 'p', socketPath: daemon.path, input })).toBe('')
    }
    expect(daemon.seen).toEqual([])
    daemon.server.close()
  })

  test('the tmuxd hook subcommand exits 0 with empty stdout when no daemon listens', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        ENTRY,
        'tmuxd',
        'hook',
        'PermissionRequest',
        '--pane',
        'p1',
        '--socket',
        join(root, 'nobody.sock'),
      ],
      {
        stdin: new TextEncoder().encode('{"tool_name":"Bash"}'),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe('')
  })
})
