import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { createLogger } from '@/util/logger.ts'

type Capture = {
  stdout: string[]
  stderr: string[]
  restore: () => void
}

function captureOutputs(): Capture {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)

  process.stdout.write = mock((chunk: unknown) => {
    stdoutChunks.push(String(chunk))
    return true
  }) as unknown as typeof process.stdout.write
  process.stderr.write = mock((chunk: unknown) => {
    stderrChunks.push(String(chunk))
    return true
  }) as unknown as typeof process.stderr.write

  return {
    stdout: stdoutChunks,
    stderr: stderrChunks,
    restore: () => {
      process.stdout.write = stdoutWrite
      process.stderr.write = stderrWrite
    },
  }
}

describe('createLogger', () => {
  let capture: Capture

  beforeEach(() => {
    capture = captureOutputs()
  })

  afterEach(() => {
    capture.restore()
  })

  test('emits JSON line on info level', () => {
    const log = createLogger({ env: {} })
    log.info('boot', { backend: 'claude' })

    expect(capture.stdout).toEqual([])
    expect(capture.stderr.length).toBe(1)

    const line = capture.stderr[0]
    expect(line?.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line ?? '')
    expect(parsed.level).toBe('info')
    expect(parsed.message).toBe('boot')
    expect(parsed.backend).toBe('claude')
    expect(typeof parsed.timestamp).toBe('string')
    expect(new Date(parsed.timestamp).toString()).not.toBe('Invalid Date')
  })

  test('emits JSON line on warn level', () => {
    const log = createLogger({ env: {} })
    log.warn('soft fail')

    expect(capture.stderr.length).toBe(1)
    const parsed = JSON.parse(capture.stderr[0] ?? '')
    expect(parsed.level).toBe('warn')
  })

  test('emits JSON line on error level', () => {
    const log = createLogger({ env: {} })
    log.error('hard fail', { code: 'E_TEST' })

    expect(capture.stderr.length).toBe(1)
    const parsed = JSON.parse(capture.stderr[0] ?? '')
    expect(parsed.level).toBe('error')
    expect(parsed.code).toBe('E_TEST')
  })

  test('debug level is suppressed when KODIZM_LOG_LEVEL=info', () => {
    const log = createLogger({ env: { KODIZM_LOG_LEVEL: 'info' } })
    log.debug('verbose noise')

    expect(capture.stderr).toEqual([])
  })

  test('debug level emits when KODIZM_LOG_LEVEL=debug', () => {
    const log = createLogger({ env: { KODIZM_LOG_LEVEL: 'debug' } })
    log.debug('verbose noise')

    expect(capture.stderr.length).toBe(1)
    const parsed = JSON.parse(capture.stderr[0] ?? '')
    expect(parsed.level).toBe('debug')
  })

  test('NEVER writes to stdout, regardless of level', () => {
    const log = createLogger({ env: { KODIZM_LOG_LEVEL: 'debug' } })
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')

    expect(capture.stdout).toEqual([])
    expect(capture.stderr.length).toBe(4)
  })
})
