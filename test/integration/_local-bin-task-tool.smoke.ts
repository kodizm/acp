/**
 * Manual local smoke for the Task tool subagent lifecycle wire.
 *
 * Spawns the locally built bin (`dist/index.js`) over stdio, drives a
 * real Claude session via JSON-RPC, prompts it to delegate via the
 * Task tool, and tails the sessionUpdate notifications for
 * `subagent_spawn` + `subagent_complete` events.
 *
 * NOT registered in the bun:test runner — the bin spawn + real LLM
 * call lives outside the unit-test budget. Run manually via:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *     bun run test/integration/_local-bin-task-tool.smoke.ts
 *
 * Expected output ends with:
 *   ✅ subagent_spawn fired
 *   ✅ subagent_complete fired
 *   ✅ both events carry trigger=Task tool
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const BIN = resolve(__dirname, '../../dist/index.js')

interface JsonRpcResponse {
  jsonrpc: string
  id?: number
  result?: unknown
  error?: { code: number; message: string }
  method?: string
  params?: unknown
}

const child = spawn('bun', [BIN], {
  env: {
    ...process.env,
    KODIZM_BACKEND: 'claude',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
})

let buffer = ''
let nextId = 1
const pending = new Map<number, (resp: JsonRpcResponse) => void>()
const sessionUpdates: Array<{ method: string; params: Record<string, unknown> }> = []

child.stdout?.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''

  for (const line of lines) {
    if (!line) continue
    let frame: JsonRpcResponse
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }

    if (frame.id !== undefined && pending.has(frame.id)) {
      pending.get(frame.id)?.(frame)
      pending.delete(frame.id)
      continue
    }

    if (frame.method === 'sessionUpdate' && typeof frame.params === 'object' && frame.params !== null) {
      const params = frame.params as Record<string, unknown>
      sessionUpdates.push({ method: frame.method, params })
      const type = (params as { type?: string }).type
      if (type === 'subagent_spawn' || type === 'subagent_complete') {
        process.stderr.write(`[wire] ${type}: ${JSON.stringify(params)}\n`)
      }
    }
  }
})

function send<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
  return new Promise((resolveResp, rejectResp) => {
    const id = nextId++
    pending.set(id, (resp) => {
      if (resp.error !== undefined) {
        rejectResp(new Error(`${method} -> ${resp.error.code} ${resp.error.message}`))
        return
      }
      resolveResp(resp.result as T)
    })
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        rejectResp(new Error(`${method} timed out after ${timeoutMs}ms`))
      }
    }, timeoutMs)
  })
}

async function main(): Promise<void> {
  await send('initialize', { protocolVersion: 1 })
  process.stderr.write('initialize ok\n')

  const newSession = await send<{ sessionId: string }>('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
    model: 'claude-haiku-4-5-20251001',
    toolPolicy: { defaultMode: 'bypassPermissions' },
  })
  process.stderr.write(`session/new ok: ${newSession.sessionId}\n`)

  const promptText =
    'You MUST delegate to a subagent via the Task tool with subagent_type=general-purpose. Do NOT use any tool yourself. The subagent should run Bash to count *.md files in the current dir then reply with just the integer. Repeat the integer at the end.'

  await send(
    'session/prompt',
    {
      sessionId: newSession.sessionId,
      prompt: [{ type: 'text', text: promptText }],
    },
    240_000,
  )
  process.stderr.write('session/prompt ok\n')

  child.kill('SIGTERM')

  const spawnEvents = sessionUpdates.filter((u) => (u.params as { type?: string }).type === 'subagent_spawn')
  const completeEvents = sessionUpdates.filter((u) => (u.params as { type?: string }).type === 'subagent_complete')

  process.stderr.write(`\n=== summary ===\n`)
  process.stderr.write(`total sessionUpdates: ${sessionUpdates.length}\n`)
  process.stderr.write(`subagent_spawn count: ${spawnEvents.length}\n`)
  process.stderr.write(`subagent_complete count: ${completeEvents.length}\n`)

  if (spawnEvents.length === 0) {
    process.stderr.write('❌ no subagent_spawn fired\n')
    process.exit(1)
  }
  if (completeEvents.length === 0) {
    process.stderr.write('❌ no subagent_complete fired\n')
    process.exit(1)
  }
  process.stderr.write('✅ subagent_spawn fired\n')
  process.stderr.write('✅ subagent_complete fired\n')

  process.exit(0)
}

main().catch((error) => {
  process.stderr.write(`❌ ${(error as Error).message}\n`)
  child.kill('SIGTERM')
  process.exit(1)
})
