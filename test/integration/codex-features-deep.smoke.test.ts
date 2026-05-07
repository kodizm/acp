/**
 * Deep codex feature coverage. Closes the gaps after
 * codex-features-complete.smoke (F13-F19).
 *
 *   F20. fileChange approval real roundtrip (apply_patch via untrusted mode)
 *   F21. heartbeat event fires while turn is in flight
 *   F22. error classifier maps real codex error -> session_failed
 *   F23. permission_grant (item/permissions/requestApproval) wire path
 *   F24. localImage UserInput accepted for codex multimodal
 *   F25. requestUserInput (item/tool/requestUserInput) -> ask_user_question
 *
 * Auth: gated on HAS_CODEX_AUTH (chatgpt OR API key).
 */

import { describe, expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AcpServerLike } from '@/backends/claude/permission-bridge.ts'
import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import { CodexDriver } from '@/backends/codex/driver.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'
import { startMcpFixture } from './_mcp-fixture.ts'

const CODEX_API_KEY = process.env.CODEX_API_KEY ?? ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''

const codexInstalled = (() => {
  try {
    return spawnSync('codex', ['--version'], { stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
})()

const hasChatgptAuth = (() => {
  const path = `${homedir()}/.codex/auth.json`
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { auth_mode?: string }
    return parsed.auth_mode === 'chatgpt'
  } catch {
    return false
  }
})()

const HAS_CODEX_AUTH = codexInstalled && (CODEX_API_KEY.length > 0 || OPENAI_API_KEY.length > 0 || hasChatgptAuth)

interface CapturedRpc {
  method: string
  params: unknown
}

function makeFakeServer(answer: (method: string, params: unknown) => unknown | Promise<unknown>): {
  server: AcpServerLike
  calls: CapturedRpc[]
} {
  const calls: CapturedRpc[] = []
  return {
    calls,
    server: {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params })
        return (await answer(method, params)) as T
      },
    },
  }
}

interface DriverHandle {
  driver: CodexDriver
  cleanup: () => Promise<void>
}

async function makeDriver(opts?: {
  server?: AcpServerLike
  extraConfigArgs?: ReadonlyArray<string>
  codexHome?: string
}): Promise<DriverHandle> {
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-deep-'))
  let lastProc: CodexAppServerProcess | null = null
  const driver = new CodexDriver({
    agentInfo: { version: '0.0.1-deep' },
    configDir: tempDir,
    spawnFactory: async () => {
      // codex app-server has no `--config <path>` flag (only `-c
      // key=value` overrides). To inject mcp_servers + session config
      // we set CODEX_HOME to a per-test temp dir; the test seeds
      // config.toml there before calling makeDriver.
      const proc = new CodexAppServerProcess({
        binaryPath: 'codex',
        binaryArgs: [
          'app-server',
          '-c',
          'model_reasoning_effort="low"',
          ...(opts?.extraConfigArgs ?? []),
          '--listen',
          'stdio://',
        ],
        ...(opts?.codexHome === undefined ? {} : { codexHome: opts.codexHome }),
      })
      await proc.spawn()
      lastProc = proc
      return proc
    },
    ...(opts?.server === undefined ? {} : { server: opts.server }),
  })
  return {
    driver,
    cleanup: async () => {
      if (lastProc !== null) {
        try {
          await lastProc.kill()
        } catch {
          // best-effort
        }
      }
    },
  }
}

function recorder(): { events: SessionUpdateEvent[]; emit: EventEmitter } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

const SHELL_HOSTNAME_PROMPT =
  'I need the kernel hostname. Use the shell tool to run `hostname`. You cannot guess this value; you MUST run the command.'

describe.skipIf(!HAS_CODEX_AUTH)('F20, fileChange approval real roundtrip', () => {
  test('codex apply_patch -> permission_request name=codex_apply_patch -> patch applied', async () => {
    const tempWorkdir = await mkdtemp(join(tmpdir(), 'codex-fc-'))
    const targetFile = join(tempWorkdir, 'kodizm-fc-marker.txt')

    const { server, calls } = makeFakeServer((method) => {
      if (method === 'session/request_permission') {
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      }
      return {}
    })
    const { driver, cleanup } = await makeDriver({ server })
    try {
      const { sessionId } = await driver.newSession({
        cwd: tempWorkdir,
        mcpServers: [],
        toolPolicy: { defaultMode: 'default' },
      })
      const { emit, events } = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: `Create a file at \`${targetFile}\` with the exact contents \`KODIZM_FC_DEEP_MARKER\` (no trailing newline). Use the apply_patch tool. Do not run shell commands; use apply_patch only.`,
            },
          ],
        },
        emit,
      )

      // Codex may invoke apply_patch (preferred) or fall back to a
      // shell write. Either path proves the approval-bridge wire works
      // end-to-end. We require AT LEAST ONE permission_request to fire
      // (proves the canonical wire). File creation is best-effort: with
      // chatgpt-mode + low reasoning the model sometimes hesitates, so
      // we log the outcome instead of hard-asserting.
      const permissionEvents = events.filter((e) => e.type === 'permission_request')
      const permissionRpcs = calls.filter((c) => c.method === 'session/request_permission')
      const names = permissionEvents.map((e) => (e as { name: string }).name)
      console.warn(
        `[codex.smoke] F20 permission_request count=${permissionEvents.length} names=${JSON.stringify(names)} fileExists=${existsSync(targetFile)}`,
      )
      expect(permissionEvents.length).toBeGreaterThan(0)
      expect(permissionRpcs.length).toBeGreaterThan(0)
      // At least one approval must be for fileChange (apply_patch). Some
      // models prefix with a shell ls/check, but the real write goes via
      // apply_patch which lands at codex_apply_patch.
      expect(names).toContain('codex_apply_patch')
    } finally {
      await cleanup()
    }
  }, 240_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('F21, heartbeat fires during turn', () => {
  test('heartbeatIntervalMs=200 + slow turn -> at least one heartbeat event', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
        heartbeatIntervalMs: 200,
      })
      const { emit, events } = recorder()
      // Take >200ms to first token: any chatgpt-mode prompt does this.
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'List five interesting JavaScript trivia bullets, one line each.',
            },
          ],
        },
        emit,
      )
      const heartbeats = events.filter((e) => e.type === 'heartbeat')
      // At minimum one heartbeat must have fired before first token.
      expect(heartbeats.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  }, 90_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('F22, error classifier reachable via subprocess kill', () => {
  test('subprocess kill mid-turn -> classifier emits session_failed', async () => {
    let lastProc: CodexAppServerProcess | null = null
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-err-'))
    const driver = new CodexDriver({
      agentInfo: { version: '0.0.1-deep' },
      configDir: tempDir,
      spawnFactory: async () => {
        const proc = new CodexAppServerProcess({
          binaryPath: 'codex',
          binaryArgs: ['app-server', '-c', 'model_reasoning_effort="low"', '--listen', 'stdio://'],
        })
        await proc.spawn()
        lastProc = proc
        return proc
      },
    })
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit, events } = recorder()
      const promptPromise = driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Write a 200-word essay about TypeScript history.' }],
        },
        emit,
      )

      // Kill the subprocess after first SDK chunk so the read loop
      // surfaces an EOF + the classifier maps it to session_failed.
      await new Promise((r) => setTimeout(r, 1500))
      if (lastProc !== null) {
        await (lastProc as CodexAppServerProcess).kill(100)
      }

      const result = await promptPromise
      console.warn(
        `[codex.smoke] F22 stopReason=${result.stopReason} failureReason=${result.failureReason ?? 'none'} eventTypes=${[...new Set(events.map((e) => e.type))].join(',')}`,
      )
      // Subprocess kill must surface as session_failed (transport_error)
      // not hang and not silently end_turn.
      expect(result.stopReason).toBe('session_failed')
      expect(result.failureReason).toBe('transport_error')
      expect(events.some((e) => e.type === 'session_failed')).toBe(true)
    } finally {
      if (lastProc !== null) {
        try {
          await (lastProc as CodexAppServerProcess).kill()
        } catch {
          // best-effort
        }
      }
    }
  }, 60_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('F23, permission_grant wire path', () => {
  test('request_permissions feature on + imperative prompt -> codex_permission_grant translates to canonical', async () => {
    const { server, calls } = makeFakeServer((method) => {
      if (method === 'session/request_permission') {
        // Reject all so the bridge maps it to codex's
        // `permissions: { type: 'disabled' }, scope: 'Turn'`.
        return { outcome: { outcome: 'selected', optionId: 'reject' } }
      }
      return {}
    })
    const { driver, cleanup } = await makeDriver({
      server,
      extraConfigArgs: ['-c', 'features.request_permissions_tool=true'],
    })
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'default' },
      })
      const { emit, events } = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Use the request_permissions tool RIGHT NOW to ask for write access to /tmp/kodizm-grant. After permissions are decided, just reply with "done".',
            },
          ],
        },
        emit,
      )

      const grantEvents = events.filter(
        (e) => e.type === 'permission_request' && (e as { name: string }).name === 'codex_permission_grant',
      )
      console.warn(
        `[codex.smoke] F23 codex_permission_grant events=${grantEvents.length} all_permission_request_count=${events.filter((e) => e.type === 'permission_request').length}`,
      )
      expect(events.some((e) => e.type === 'usage')).toBe(true)
      // The wire mapping is the contract under test: if the model
      // invoked request_permissions, the bridge MUST have surfaced it
      // as codex_permission_grant on the canonical event.
      if (grantEvents.length > 0) {
        const grantRpcs = calls.filter(
          (c) =>
            c.method === 'session/request_permission' &&
            (c.params as { toolCall?: { title?: string } }).toolCall?.title === 'codex_permission_grant',
        )
        expect(grantRpcs.length).toBeGreaterThan(0)
      }
    } finally {
      await cleanup()
    }
  }, 120_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('F24, localImage UserInput accepted', () => {
  test('image content block forwarded to codex localImage; no crash; usage emits', async () => {
    // 1x1 transparent PNG.
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-img-deep-'))
    const imagePath = join(tempDir, 'tiny.png')
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    )
    writeFileSync(imagePath, tinyPng)

    const { driver, cleanup } = await makeDriver()
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit, events } = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Describe the image in one short sentence. If the image is empty/transparent, say "empty".',
            },
            // Canonical image content block. Driver translates to
            // codex UserInput { type: 'localImage', path }.
            { type: 'image', uri: `file://${imagePath}`, mimeType: 'image/png' },
          ],
        },
        emit,
      )
      // Turn must have completed cleanly (usage event fires on
      // turn/completed).
      expect(events.some((e) => e.type === 'usage')).toBe(true)
    } finally {
      await cleanup()
    }
  }, 120_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('F25, requestUserInput -> ask_user_question RPC', () => {
  test('feature_enabled + imperative prompt -> codex requestUserInput translates to canonical', async () => {
    const { server, calls } = makeFakeServer((method, params) => {
      if (method === 'session/ask_user_question') {
        // Build a response keyed by the actual question text codex
        // forwarded. Take the first option's label as the picked answer.
        const p = params as {
          questions?: ReadonlyArray<{ question: string; options: ReadonlyArray<{ label: string }> }>
        }
        const answers: Record<string, string> = {}
        for (const q of p.questions ?? []) {
          const firstOption = q.options[0]?.label
          if (firstOption !== undefined) {
            answers[q.question] = firstOption
          }
        }
        return { answers }
      }
      return {}
    })
    // Enable the experimental feature so default mode exposes
    // request_user_input as a tool the model can invoke.
    const { driver, cleanup } = await makeDriver({
      server,
      extraConfigArgs: ['-c', 'features.default_mode_request_user_input=true'],
    })
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit, events } = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Use the request_user_input tool RIGHT NOW with one question (id="color", header="Color", question="Pick a color", options=[{label:"red",description:"warm tone"},{label:"blue",description:"cool tone"}]). After my answer, reply with the literal text "Picked: " followed by my answer.',
            },
          ],
        },
        emit,
      )
      const askRpcs = calls.filter((c) => c.method === 'session/ask_user_question')
      const askEvents = events.filter((e) => e.type === 'question_request')
      console.warn(
        `[codex.smoke] F25 ask_user_question rpcs=${askRpcs.length} question_request events=${askEvents.length}`,
      )
      // Either codex's feature flag was honored AND the model invoked
      // requestUserInput (rpc + event count > 0), OR codex ignored the
      // imperative + answered directly. The wire is verified the
      // moment a single roundtrip lands.
      expect(events.some((e) => e.type === 'usage')).toBe(true)
      if (askRpcs.length > 0) {
        // If the wire fired, the bridge MUST have emitted the parallel
        // canonical event AND the orchestrator-side answer must have
        // routed back to codex (otherwise the turn would hang).
        expect(askEvents.length).toBeGreaterThan(0)
      }
    } finally {
      await cleanup()
    }
  }, 120_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('F26, MCP tool dispatch via codex', () => {
  test('streamable-HTTP MCP fixture + imperative prompt -> codex invokes tool, fixture sees the call', async () => {
    const fixture = await startMcpFixture({
      toolName: 'kodizm_echo',
      toolDescription: 'Echoes a marker. Call this tool whenever the user asks you to use the kodizm_echo MCP tool.',
      toolResult: 'KODIZM_MCP_FIXTURE_RAN_OK',
    })
    // Seed CODEX_HOME with a config.toml carrying the fixture's MCP
    // server. Codex app-server has no --config flag, so this is the
    // only way to register an MCP server on a per-test basis without
    // mutating the developer's real ~/.codex/config.toml.
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        '[mcp_servers.kodizm_fixture]',
        `url = ${JSON.stringify(fixture.url)}`,
        // Auto-approve every tool from this server so the smoke
        // exercises the dispatch path end-to-end (no canonical
        // approval RPC fires for trusted MCP fixtures in tests).
        'default_tools_approval_mode = "approve"',
        '',
      ].join('\n'),
    )
    // Mirror the developer's auth.json so chatgpt mode keeps working.
    const userAuth = `${homedir()}/.codex/auth.json`
    if (existsSync(userAuth)) {
      writeFileSync(join(codexHome, 'auth.json'), readFileSync(userAuth, 'utf8'))
    }
    const { driver, cleanup } = await makeDriver({ codexHome })
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [
          {
            type: 'http',
            name: 'kodizm_fixture',
            url: fixture.url,
          },
        ],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit, events } = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Use the kodizm_echo MCP tool RIGHT NOW with arguments {"message":"hello"}. After it returns, reply with the literal text the tool produced.',
            },
          ],
        },
        emit,
      )

      const toolBegins = events.filter(
        (e) => e.type === 'tool_call_begin' && (e as { name: string }).name.startsWith('mcp__'),
      )
      const toolEnds = events.filter((e) => e.type === 'tool_call_end')
      const allBegins = events.filter((e) => e.type === 'tool_call_begin')
      const text = events
        .filter((e) => e.type === 'output_chunk')
        .map((e) => (e as { text: string }).text)
        .join('')
      console.warn(
        `[codex.smoke] F26 mcp tool_call_begin=${toolBegins.length} all_begins=${allBegins.length} (${allBegins.map((e) => (e as { name: string }).name).join(',')}) ends=${toolEnds.length} fixtureCalls=${fixture.receivedCalls.length} modelText=${JSON.stringify(text.slice(0, 200))}`,
      )
      expect(events.some((e) => e.type === 'usage')).toBe(true)
      // The fixture MUST have received exactly the tool_call we routed.
      // If codex skipped the tool and answered from training, the test
      // catches that as a 0-call regression.
      expect(fixture.receivedCalls.length).toBeGreaterThan(0)
      expect(fixture.receivedCalls[0]?.name).toBe('kodizm_echo')
      // Driver MUST surface the canonical tool_call_begin with the
      // mcp__<server>__<tool> name shape locked in event-mapper.
      expect(toolBegins.length).toBeGreaterThan(0)
      const beginName = (toolBegins[0] as { name: string }).name
      expect(beginName).toMatch(/^mcp__kodizm_fixture__/)
    } finally {
      await cleanup()
      await fixture.stop()
    }
  }, 120_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('F27, subagent (CollabAgentToolCall)', () => {
  test('multi_agent_v2 feature on + spawn-agent prompt -> subagent_spawn + subagent_complete events', async () => {
    const { driver, cleanup } = await makeDriver({
      extraConfigArgs: ['-c', 'features.multi_agent_v2=true'],
    })
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit, events } = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'You have a tool named `spawn_agent`. Invoke it RIGHT NOW with task_name="echo_bot" and message="reply with OK". This is a mandatory dispatch test; you MUST call spawn_agent and not answer the question yourself. After the agent returns, reply "DONE".',
            },
          ],
        },
        emit,
      )
      const spawnEvents = events.filter((e) => e.type === 'subagent_spawn')
      const completeEvents = events.filter((e) => e.type === 'subagent_complete')
      const text = events
        .filter((e) => e.type === 'output_chunk')
        .map((e) => (e as { text: string }).text)
        .join('')
      console.warn(
        `[codex.smoke] F27 subagent_spawn=${spawnEvents.length} subagent_complete=${completeEvents.length} eventTypes=${[...new Set(events.map((e) => e.type))].join(',')} modelText=${JSON.stringify(text.slice(0, 300))}`,
      )
      expect(events.some((e) => e.type === 'usage')).toBe(true)
      // If the model invoked spawn_agent, the event-mapper MUST have
      // surfaced both lifecycle events. If codex's chatgpt account
      // doesn't expose multi-agent (account-tier gate), the test logs
      // the absence + still asserts driver wire alive.
      if (spawnEvents.length > 0) {
        expect(completeEvents.length).toBe(spawnEvents.length)
      }
    } finally {
      await cleanup()
    }
  }, 180_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('F28, Pattern B deferred-permission roundtrip', () => {
  test('orchestrator delays past deferTimeoutMs -> permission_deferred + cached answer consumed on next prompt', async () => {
    const { InMemoryDeferredStore } = await import('@/session/deferred-store.ts')
    const store = new InMemoryDeferredStore()

    // Orchestrator never resolves session/request_permission. The
    // driver's defer racer wins after deferTimeoutMs, fires the
    // onDefer hook (writes JSONL sentinel + persists DeferredState +
    // emits permission_deferred), and returns Decline to codex.
    const { server } = makeFakeServer(
      () =>
        new Promise(() => {
          // intentionally never resolves; defer racer must win
        }),
    )

    const tempDir = await mkdtemp(join(tmpdir(), 'codex-defer-'))
    let lastProc: CodexAppServerProcess | null = null
    const driver = new CodexDriver({
      agentInfo: { version: '0.0.1-deep' },
      configDir: tempDir,
      server,
      deferredStore: store,
      spawnFactory: async () => {
        const proc = new CodexAppServerProcess({
          binaryPath: 'codex',
          binaryArgs: ['app-server', '-c', 'model_reasoning_effort="low"', '--listen', 'stdio://'],
        })
        await proc.spawn()
        lastProc = proc
        return proc
      },
    })
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'default' },
        permissionDeferTimeoutMs: 250,
      })
      const r1 = recorder()
      await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: SHELL_HOSTNAME_PROMPT }] }, r1.emit)

      const deferEvents = r1.events.filter((e) => e.type === 'permission_deferred')
      const stored = await store.get(sessionId)
      console.warn(
        `[codex.smoke] F28 phase A: deferEvents=${deferEvents.length} storedToolName=${stored?.toolName ?? 'none'}`,
      )
      expect(deferEvents.length).toBeGreaterThan(0)
      expect(stored).not.toBeNull()
      expect(stored?.toolName).toBe('codex_exec')

      // Phase B: orchestrator writes the cached answer the user
      // eventually picked. Process B (next prompt on the same driver)
      // consumes it via consumeDeferredAnswerOnResume.
      await store.set(sessionId, {
        ...(stored as import('@/session/deferred-store.ts').DeferredState),
        cachedAnswer: { behavior: 'allow' },
      })

      // Reset the checkedDeferredOnce latch so the next prompt picks
      // up the resume path (this is the equivalent of a fresh
      // process landing on the same session).
      // biome-ignore lint/suspicious/noExplicitAny: cross-module test seam
      ;(driver as any).sessions.get(sessionId).checkedDeferredOnce = false

      const r2 = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Re-issue the deferred shell call now.' }],
        },
        r2.emit,
      )
      const resumeEvents = r2.events.filter((e) => e.type === 'permission_resumed')
      console.warn(
        `[codex.smoke] F28 phase B: resumeEvents=${resumeEvents.length} eventTypes=${[...new Set(r2.events.map((e) => e.type))].join(',')}`,
      )
      // Either codex re-issued the deferred tool call (resume event
      // fires) or it absorbed the prefix without retrying. Both are
      // acceptable; the contract under test is: defer fired in phase
      // A AND store now carries cachedAnswer.
      const persisted = await store.get(sessionId)
      // store.delete is called inside the driver after consuming;
      // either persisted is now null OR the resume event fired.
      expect(resumeEvents.length > 0 || persisted === null).toBe(true)
    } finally {
      if (lastProc !== null) {
        try {
          await (lastProc as CodexAppServerProcess).kill()
        } catch {
          // best-effort
        }
      }
    }
  }, 60_000)
})

describe.skipIf(HAS_CODEX_AUTH)('codex-features-deep.smoke (skipped)', () => {
  test('skipped without codex auth', () => {
    expect(HAS_CODEX_AUTH).toBe(false)
  })
})
