import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, test } from 'bun:test'

import { buildCodexUserInputs } from '@/backends/codex/prompt-input.ts'
import type { PromptRequest } from '@/wire/types.ts'

const FAKE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const baseRequest = (prompt: PromptRequest['prompt']): PromptRequest => ({
  sessionId: 'sess-test',
  prompt,
})

const ROOTS: string[] = []

async function makeIsolatedTmpDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kodizm-acp-codex-test-'))
  ROOTS.push(root)
  return root
}

afterAll(async () => {
  for (const root of ROOTS) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('buildCodexUserInputs, text', () => {
  test('text block becomes UserInput.text with empty text_elements', async () => {
    const tmp = await makeIsolatedTmpDir()
    const result = await buildCodexUserInputs(baseRequest([{ type: 'text', text: 'hello' }]), {
      tmpDir: tmp,
      sessionId: 'sess-1',
    })
    expect(result.inputs).toEqual([{ type: 'text', text: 'hello', text_elements: [] }])
    expect(result.cleanupPaths).toEqual([])
  })
})

describe('buildCodexUserInputs, image url', () => {
  test('url image source becomes UserInput.image with no cleanup path', async () => {
    const tmp = await makeIsolatedTmpDir()
    const result = await buildCodexUserInputs(
      baseRequest([{ type: 'image', source: { type: 'url', url: 'https://kodizm.com/logo.png' } }]),
      { tmpDir: tmp, sessionId: 'sess-2' },
    )
    expect(result.inputs).toEqual([{ type: 'image', url: 'https://kodizm.com/logo.png' }])
    expect(result.cleanupPaths).toEqual([])
  })
})

describe('buildCodexUserInputs, image base64 materialisation', () => {
  test('base64 image writes a temp file under <tmpDir>/kodizm-acp-attachments/<sessionId>/<uuid>.png and emits localImage', async () => {
    const tmp = await makeIsolatedTmpDir()
    const result = await buildCodexUserInputs(
      baseRequest([{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_PNG_B64 } }]),
      { tmpDir: tmp, sessionId: 'sess-3' },
    )

    expect(result.inputs.length).toBe(1)
    const input = result.inputs[0]
    expect(input?.type).toBe('localImage')

    const filePath = (input as { type: 'localImage'; path: string }).path
    expect(filePath).toMatch(new RegExp(`${tmp.replace(/\\\\/g, '/')}/kodizm-acp-attachments/sess-3/[0-9a-f-]+\\.png$`))
    expect(result.cleanupPaths).toEqual([filePath])

    const onDisk = await readFile(filePath)
    expect(onDisk.equals(Buffer.from(FAKE_PNG_B64, 'base64'))).toBe(true)

    await unlink(filePath)
    await expect(stat(filePath)).rejects.toThrow()
  })

  test('jpeg mediatype maps to .jpg extension', async () => {
    const tmp = await makeIsolatedTmpDir()
    const result = await buildCodexUserInputs(
      baseRequest([{ type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: FAKE_PNG_B64 } }]),
      { tmpDir: tmp, sessionId: 'sess-jpg' },
    )
    const filePath = (result.inputs[0] as { type: 'localImage'; path: string }).path
    expect(filePath.endsWith('.jpg')).toBe(true)
  })
})

describe('buildCodexUserInputs, document degrade', () => {
  test('base64 document degrades to a text marker including filename + decoded byte count', async () => {
    const tmp = await makeIsolatedTmpDir()
    const result = await buildCodexUserInputs(
      baseRequest([
        {
          type: 'document',
          source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PNG_B64 },
          title: 'spec.pdf',
        },
      ]),
      { tmpDir: tmp, sessionId: 'sess-4' },
    )
    expect(result.inputs.length).toBe(1)
    const input = result.inputs[0] as { type: 'text'; text: string; text_elements: unknown[] }
    expect(input.type).toBe('text')
    expect(input.text).toContain('spec.pdf')
    expect(input.text).toContain('bytes')
    expect(input.text).toContain('codex backend cannot ingest documents directly')
    expect(input.text_elements).toEqual([])
    expect(result.cleanupPaths).toEqual([])
  })

  test('url document degrades to a text marker without size fragment', async () => {
    const tmp = await makeIsolatedTmpDir()
    const result = await buildCodexUserInputs(
      baseRequest([
        {
          type: 'document',
          source: { type: 'url', url: 'https://kodizm.com/spec.pdf' },
          title: 'remote-spec.pdf',
        },
      ]),
      { tmpDir: tmp, sessionId: 'sess-5' },
    )
    const input = result.inputs[0] as { type: 'text'; text: string }
    expect(input.text).toContain('remote-spec.pdf')
    expect(input.text).not.toContain('bytes')
  })
})

describe('buildCodexUserInputs, mixed payload', () => {
  test('preserves order: text → image base64 → document → text', async () => {
    const tmp = await makeIsolatedTmpDir()
    const result = await buildCodexUserInputs(
      baseRequest([
        { type: 'text', text: 'before' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_PNG_B64 } },
        {
          type: 'document',
          source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PNG_B64 },
          title: 'spec.pdf',
        },
        { type: 'text', text: 'after' },
      ]),
      { tmpDir: tmp, sessionId: 'sess-mixed' },
    )

    expect(result.inputs.length).toBe(4)
    expect(result.inputs[0]?.type).toBe('text')
    expect(result.inputs[1]?.type).toBe('localImage')
    expect(result.inputs[2]?.type).toBe('text')
    expect((result.inputs[2] as { text: string }).text).toContain('spec.pdf')
    expect(result.inputs[3]?.type).toBe('text')
    expect((result.inputs[3] as { text: string }).text).toBe('after')
    expect(result.cleanupPaths.length).toBe(1)
  })
})
