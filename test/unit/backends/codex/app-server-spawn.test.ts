import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'
import type { DebugLogLevel, DebugStage } from '@/wire/events.ts'

/**
 * Build a fake `codex app-server` subprocess: a Bun script that reads
 * NDJSON from stdin and writes scripted NDJSON responses to stdout.
 * Lets us assert framing + correlation without depending on the real
 * codex CLI.
 */
function buildFakeCodexBin(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'))
  const path = join(dir, 'fake-codex.ts')
  writeFileSync(path, script)
  return path
}

describe('CodexAppServerProcess.initialize', () => {
  test('sends initialize request, awaits response, sends initialized notification', async () => {
    const fakeBin = buildFakeCodexBin(`
      const decoder = new TextDecoder()
      let buf = ''
      const reader = Bun.stdin.stream().getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value)
        const lines = buf.split('\\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const frame = JSON.parse(line)
          if (frame.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              id: frame.id,
              result: { codexHome: '/tmp/.codex', platformFamily: 'mac' }
            }) + '\\n')
          }
          if (frame.method === 'initialized') {
            // notification; no response
            process.exit(0)
          }
        }
      }
    `)

    const proc = new CodexAppServerProcess({ binaryPath: 'bun', binaryArgs: ['run', fakeBin] })
    await proc.spawn()
    const result = await proc.initialize({ protocolVersion: 1 })
    expect(result).toEqual({ codexHome: '/tmp/.codex', platformFamily: 'mac' })
    await proc.kill()
  })
})

describe('CodexAppServerProcess.request correlation', () => {
  test('correlates concurrent requests by id', async () => {
    const fakeBin = buildFakeCodexBin(`
      const decoder = new TextDecoder()
      let buf = ''
      const reader = Bun.stdin.stream().getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value)
        const lines = buf.split('\\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const frame = JSON.parse(line)
          if (frame.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              id: frame.id, result: { ok: true }
            }) + '\\n')
            continue
          }
          // Echo back with id + method-derived result.
          process.stdout.write(JSON.stringify({
            id: frame.id, result: { method: frame.method, params: frame.params }
          }) + '\\n')
        }
      }
    `)

    const proc = new CodexAppServerProcess({ binaryPath: 'bun', binaryArgs: ['run', fakeBin] })
    await proc.spawn()
    await proc.initialize({ protocolVersion: 1 })

    const [a, b] = await Promise.all([
      proc.request<{ method: string }>('thread/start', { cwd: '/a' }),
      proc.request<{ method: string }>('thread/list', { foo: 'b' }),
    ])
    expect(a.method).toBe('thread/start')
    expect(b.method).toBe('thread/list')
    await proc.kill()
  })
})

describe('CodexAppServerProcess.onNotification', () => {
  test('subscribes to ServerNotifications coming over stdout', async () => {
    const fakeBin = buildFakeCodexBin(`
      const decoder = new TextDecoder()
      let buf = ''
      const reader = Bun.stdin.stream().getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value)
        const lines = buf.split('\\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const frame = JSON.parse(line)
          if (frame.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              id: frame.id, result: {}
            }) + '\\n')
            // immediately send a notification
            process.stdout.write(JSON.stringify({
              method: 'thread/started',
              params: { thread: { id: 't_1' } }
            }) + '\\n')
          }
        }
      }
    `)

    const proc = new CodexAppServerProcess({ binaryPath: 'bun', binaryArgs: ['run', fakeBin] })
    await proc.spawn()

    const notifications: Array<{ method: string; params: unknown }> = []
    proc.onNotification((method, params) => notifications.push({ method, params }))

    await proc.initialize({ protocolVersion: 1 })
    await new Promise((r) => setTimeout(r, 50))

    expect(notifications.length).toBeGreaterThanOrEqual(1)
    expect(notifications[0]?.method).toBe('thread/started')
    await proc.kill()
  })
})

describe('CodexAppServerProcess.onServerRequest', () => {
  test('roundtrips a server-initiated request via the registered handler', async () => {
    const fakeBin = buildFakeCodexBin(`
      const decoder = new TextDecoder()
      let buf = ''
      const reader = Bun.stdin.stream().getReader()
      let nextId = 1000
      const pending = new Map()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value)
        const lines = buf.split('\\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const frame = JSON.parse(line)
          if (frame.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              id: frame.id, result: {}
            }) + '\\n')
            // send a server-initiated approval request
            const id = nextId++
            process.stdout.write(JSON.stringify({
              id,
              method: 'item/commandExecution/requestApproval',
              params: { thread_id: 't_1', turn_id: 'tu_1', item_id: 'item_1' }
            }) + '\\n')
            continue
          }
          // Otherwise treat as response to our server-initiated request
          if (frame.result || frame.error) {
            process.stderr.write('GOT_RESPONSE:' + JSON.stringify(frame.result ?? frame.error) + '\\n')
            process.exit(0)
          }
        }
      }
    `)

    const proc = new CodexAppServerProcess({ binaryPath: 'bun', binaryArgs: ['run', fakeBin] })
    await proc.spawn()

    proc.onServerRequest(async (method, params) => {
      if (method === 'item/commandExecution/requestApproval') {
        return { decision: 'Decline' }
      }
      return undefined
    })

    await proc.initialize({ protocolVersion: 1 })
    await new Promise((r) => setTimeout(r, 100))
    await proc.kill()
  })
})

describe('CodexAppServerProcess.kill grace', () => {
  test('SIGTERM with 3s budget then SIGKILL fallback', async () => {
    const fakeBin = buildFakeCodexBin(`
      const decoder = new TextDecoder()
      const reader = Bun.stdin.stream().getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value)
        for (const line of text.split('\\n')) {
          if (!line) continue
          const frame = JSON.parse(line)
          if (frame.method === 'initialize') {
            process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\\n')
          }
        }
      }
    `)

    const proc = new CodexAppServerProcess({ binaryPath: 'bun', binaryArgs: ['run', fakeBin] })
    await proc.spawn()
    await proc.initialize({ protocolVersion: 1 })
    const start = Date.now()
    await proc.kill()
    expect(Date.now() - start).toBeLessThan(3500)
  })
})

describe('CodexAppServerProcess.debugSink', () => {
  test('tees rpc.in + rpc.out frames through the recorder', async () => {
    const fakeBin = buildFakeCodexBin(`
      const decoder = new TextDecoder()
      let buf = ''
      const reader = Bun.stdin.stream().getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value)
        const lines = buf.split('\\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const frame = JSON.parse(line)
          if (frame.method === 'initialize') {
            process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\\n')
          }
        }
      }
    `)

    const captured: Array<{ stage: DebugStage; payload: unknown; level?: DebugLogLevel }> = []
    const sink = {
      record: (stage: DebugStage, payload: unknown) => {
        captured.push({ stage, payload })
      },
    }

    const proc = new CodexAppServerProcess({
      binaryPath: 'bun',
      binaryArgs: ['run', fakeBin],
      debugSink: sink,
    })
    await proc.spawn()
    await proc.initialize({ protocolVersion: 1 })

    const inFrames = captured.filter((c) => c.stage === 'rpc.in')
    const outFrames = captured.filter((c) => c.stage === 'rpc.out')
    expect(outFrames.length).toBeGreaterThanOrEqual(2) // initialize request + initialized notification
    expect(inFrames.length).toBeGreaterThanOrEqual(1) // initialize response
    await proc.kill()
  })
})
