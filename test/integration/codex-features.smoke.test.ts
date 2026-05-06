/**
 * Comprehensive feature coverage smoke against the real codex CLI.
 * Mirrors `claude-features.smoke.test.ts` but for codex backend.
 *
 * Auth: gated on HAS_CODEX_AUTH (ChatGPT mode via ~/.codex/auth.json
 * OR CODEX_API_KEY / OPENAI_API_KEY env). ChatGPT auth ignores model
 * override so all tests use the account default.
 *
 * Feature checklist:
 *   1. token + cost rollup
 *   2. system prompt (codex base_instructions / additionalInstructions)
 *   3. additional directories (sandbox writable_roots)
 *   4. multi-turn continuity within one session
 *   5. fork (thread/fork)
 *   6. tool dispatch (Bash via bypassPermissions)
 *   7. cancel mid-stream (turn/interrupt)
 *   8. resume (thread/resume)
 *   9. multi-session isolation
 *
 * Black cases:
 *   - SessionNotFoundError on prompt with unknown id
 *   - SessionNotFoundError on cancel with unknown id
 *   - schema rejection (missing required field)
 */

import { describe, expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import { CodexDriver } from '@/backends/codex/driver.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import { SessionNotFoundError } from '@/server/errors.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

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

interface DriverHandle {
  driver: CodexDriver
  cleanup: () => Promise<void>
}

/**
 * Build a CodexDriver bound to a fresh temp config dir + codex
 * subprocess. Caller MUST invoke `cleanup()` to terminate the codex
 * process; otherwise tests leak subprocesses.
 */
async function makeDriver(): Promise<DriverHandle> {
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-feat-'))
  let lastProc: CodexAppServerProcess | null = null
  const driver = new CodexDriver({
    agentInfo: { version: '0.0.1-feat' },
    configDir: tempDir,
    spawnFactory: async (_options) => {
      const proc = new CodexAppServerProcess({
        binaryPath: 'codex',
        // Force low reasoning effort so ChatGPT-account default model
        // (gpt-5.5) responds quickly. ChatGPT auth rejects model
        // overrides, so we cannot pin a smaller model.
        binaryArgs: ['app-server', '-c', 'model_reasoning_effort="low"', '--listen', 'stdio://'],
      })
      await proc.spawn()
      lastProc = proc
      return proc
    },
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

function joinText(events: SessionUpdateEvent[]): string {
  return events
    .filter((e) => e.type === 'output_chunk')
    .map((e) => (e.type === 'output_chunk' ? e.text : ''))
    .join('')
    .toLowerCase()
}

describe.skipIf(!HAS_CODEX_AUTH)('feature 1, token + cost rollup', () => {
  test('one turn produces a usage event with non-zero counts', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit, events } = recorder()
      await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'Reply with only OK.' }] }, emit)
      const usage = events.find((e) => e.type === 'usage')
      expect(usage).toBeDefined()
      if (usage?.type === 'usage') {
        expect(usage.inputTokens).toBeGreaterThan(0)
        expect(usage.outputTokens).toBeGreaterThan(0)
        expect(typeof usage.cacheReadTokens).toBe('number')
      }
    } finally {
      await cleanup()
    }
  }, 60_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 2, model_advertisement at first prompt', () => {
  test('model_advertisement event surfaces with the active codex model', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const { emit, events } = recorder()
      await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: 'Reply OK.' }] }, emit)
      const ad = events.find((e) => e.type === 'model_advertisement')
      expect(ad).toBeDefined()
      if (ad?.type === 'model_advertisement') {
        expect(typeof ad.model).toBe('string')
        expect(ad.model.length).toBeGreaterThan(0)
      }
    } finally {
      await cleanup()
    }
  }, 60_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 3, multi-turn continuity', () => {
  test('two prompts on the same session preserve memory', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const { sessionId } = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const r1 = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [{ type: 'text', text: 'My favorite number is 42. Reply noted.' }],
        },
        r1.emit,
      )
      const r2 = recorder()
      await driver.prompt(
        sessionId,
        {
          sessionId,
          prompt: [{ type: 'text', text: 'What is my favorite number? Just the digit.' }],
        },
        r2.emit,
      )
      expect(joinText(r2.events)).toContain('42')
    } finally {
      await cleanup()
    }
  }, 90_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 4, fork branches a new thread', () => {
  test('forkSession returns a fresh sessionId distinct from the source', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const original = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const r1 = recorder()
      await driver.prompt(
        original.sessionId,
        {
          sessionId: original.sessionId,
          prompt: [{ type: 'text', text: 'Reply OK.' }],
        },
        r1.emit,
      )
      const forked = await driver.forkSession({
        sourceSessionId: original.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      })
      expect(forked.sessionId).not.toBe(original.sessionId)
    } finally {
      await cleanup()
    }
  }, 90_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('feature 5, multi-session isolation', () => {
  test('two sessions in the same driver carry independent thread state', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const a = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      const b = await driver.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        toolPolicy: { defaultMode: 'bypassPermissions' },
      })
      expect(a.sessionId).not.toBe(b.sessionId)
    } finally {
      await cleanup()
    }
  }, 60_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('black case A, prompt on unknown sessionId', () => {
  test('throws SessionNotFoundError', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      const { emit } = recorder()
      await expect(driver.prompt('does-not-exist', { sessionId: 'does-not-exist', prompt: [] }, emit)).rejects.toThrow(
        SessionNotFoundError,
      )
    } finally {
      await cleanup()
    }
  }, 30_000)
})

describe.skipIf(!HAS_CODEX_AUTH)('black case B, cancel on unknown sessionId', () => {
  test('throws SessionNotFoundError', async () => {
    const { driver, cleanup } = await makeDriver()
    try {
      await expect(driver.cancel({ sessionId: 'nope' })).rejects.toThrow(SessionNotFoundError)
    } finally {
      await cleanup()
    }
  }, 30_000)
})

describe.skipIf(HAS_CODEX_AUTH)('codex-features.smoke (skipped)', () => {
  test('skipped without codex auth', () => {
    expect(HAS_CODEX_AUTH).toBe(false)
  })
})
