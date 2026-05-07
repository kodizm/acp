/**
 * Fake codex app-server subprocess generator.
 *
 * Builds a Bun script that drives the JSON-RPC stdio protocol with a
 * caller-supplied turn-handler. Used by codex-features-final.smoke to
 * exercise wire paths the real chatgpt-mode model never triggers
 * deterministically (sdk_stall, error classifier branches, subagent
 * spawn, thinking_chunk reasoning subtype, legacy approvals, MCP
 * elicit, dynamic tool call, chatgpt token refresh).
 *
 * The script implements:
 *   - initialize -> static response
 *   - thread/start -> static response with thread.id + thread.path
 *   - thread/resume -> echoes the threadId
 *   - turn/start -> calls the caller-provided `onTurn` JS source which
 *     can emit notifications, RPCs, or error responses.
 *
 * Caller passes the `onTurn` source as a string; the generator inlines
 * it inside the Bun script. The string has access to `frame` (the
 * inbound turn/start frame), `sendResp(result)`, `sendErr(error)`,
 * `notify(method, params)`, and `serverReq(method, params, idCb)`.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeCodexOptions {
  /**
   * JS source executed when a turn/start frame arrives. Has access to
   * `frame`, `sendResp(result)`, `sendErr({code,message})`,
   * `notify(method, params)`, `serverReq(method, params, idCb)`.
   *
   * The body is inlined into the Bun script via template; keep it
   * self-contained (no imports).
   */
  onTurn: string
  /**
   * Optional source for thread/resume handler (cross-process Pattern B).
   */
  onResume?: string
  /**
   * Optional handler for codex-initiated server-request responses
   * (e.g. orchestrator answered an outbound RPC). Body has access to
   * `frame` (the response from orchestrator).
   */
  onServerResponse?: string
}

const SCRIPT_TEMPLATE = (opts: FakeCodexOptions): string => `
'use strict'
let buf = ''
let nextSrvId = 1000
const pending = new Map()

const writeFrame = (obj) => {
  process.stdout.write(JSON.stringify(obj) + '\\n')
}
const sendResp = (id, result) => writeFrame({ id, result })
const sendErr = (id, error) => writeFrame({ id, error })
const notify = (method, params) => writeFrame({ method, params })
const serverReq = (method, params, idCb) => {
  const id = nextSrvId++
  if (idCb) pending.set(id, idCb)
  writeFrame({ id, method, params })
  return id
}

const handleFrame = (frame) => {
  // server-request response from orchestrator
  if (typeof frame.id === 'number' && (frame.result !== undefined || frame.error !== undefined) && pending.has(frame.id)) {
    const cb = pending.get(frame.id)
    pending.delete(frame.id)
    cb(frame)
    ${opts.onServerResponse ?? ''}
    return
  }
  if (frame.method === 'initialize') {
    sendResp(frame.id, { codexHome: '/tmp/.codex', platformFamily: 'mac', userAgent: 'fake' })
    return
  }
  if (frame.method === 'initialized') return
  if (frame.method === 'thread/start') {
    sendResp(frame.id, {
      thread: { id: 't_fake_' + Date.now().toString(36), path: '/tmp/r-fake.jsonl' },
      model: 'gpt-5-codex-fake',
    })
    return
  }
  if (frame.method === 'thread/resume') {
    ${opts.onResume ?? `sendResp(frame.id, { thread: { id: (frame.params && frame.params.threadId) || 't_resume', path: '/tmp/r-fake.jsonl' } })`}
    return
  }
  if (frame.method === 'turn/interrupt') {
    sendResp(frame.id, {})
    notify('turn/completed', { thread_id: 't_fake', turn: { id: 'turn_x', status: 'cancelled' } })
    return
  }
  if (frame.method === 'turn/start') {
    ${opts.onTurn}
    return
  }
  // Default: ignore unknown methods.
}

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  const lines = buf.split('\\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    try { handleFrame(frame) } catch (e) {
      process.stderr.write('[fake-codex] handler err: ' + (e && e.message ? e.message : String(e)) + '\\n')
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`

/**
 * Materialize the fake codex script to disk. Caller passes the path
 * to {@link CodexAppServerProcess} as `binaryArgs: [path]` with
 * `binaryPath: 'node'`. We emit `.cjs` so node treats it as
 * CommonJS without needing a `package.json` next to it.
 */
export async function buildFakeCodex(opts: FakeCodexOptions): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-final-'))
  const path = join(dir, 'fake-codex.cjs')
  await writeFile(path, SCRIPT_TEMPLATE(opts))
  return path
}
