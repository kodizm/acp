import { describe, expect, test } from 'bun:test'

import {
  type BackendDriver,
  type DriverCapabilities,
  type EventEmitter,
  type InitializeResult,
  type NewSessionResult,
  type PromptResult,
  ensureCapability,
} from '@/backends/driver.ts'
import { MethodNotSupportedError } from '@/server/errors.ts'
import type {
  CancelRequest,
  CompactSessionRequest,
  ForkSessionRequest,
  InitializeRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from '@/wire/types.ts'

/**
 * Minimal stub driver used to assert that the BackendDriver contract
 * is implementable end-to-end (every method present, every signature
 * compiles). Capabilities are configurable per test instance.
 */
class StubDriver implements BackendDriver {
  public constructor(public readonly caps: DriverCapabilities) {}

  public capabilities(): DriverCapabilities {
    return this.caps
  }

  public async initialize(_params: InitializeRequest): Promise<InitializeResult> {
    return {
      protocolVersion: 1,
      agentInfo: { version: '0.0.1-stub' },
      capabilities: this.caps,
    }
  }

  public async newSession(_params: NewSessionRequest): Promise<NewSessionResult> {
    return { sessionId: 'stub-session' }
  }

  public async prompt(_sessionId: string, _params: PromptRequest, _emit: EventEmitter): Promise<PromptResult> {
    return { stopReason: 'end_turn' }
  }

  public async cancel(_request: CancelRequest): Promise<void> {
    // no-op
  }

  public async loadSession(_params: LoadSessionRequest): Promise<NewSessionResult> {
    return { sessionId: 'stub-session' }
  }

  public async forkSession(_params: ForkSessionRequest): Promise<NewSessionResult> {
    return { sessionId: 'stub-fork' }
  }

  public async compact(_request: CompactSessionRequest, _emit: EventEmitter): Promise<void> {
    // no-op
  }
}

describe('BackendDriver contract', () => {
  test('a stub implementation satisfies every required method', async () => {
    const driver = new StubDriver({
      resume: true,
      fork: true,
      fileUpload: true,
      thinking: true,
      subagent: true,
      skillEvents: true,
      debug: true,
      askQuestion: true,
    })

    const init = await driver.initialize({ protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)

    const session = await driver.newSession({ cwd: '/x', mcpServers: [] })
    expect(session.sessionId).toBe('stub-session')

    const result = await driver.prompt(
      session.sessionId,
      { sessionId: session.sessionId, prompt: [] },
      {
        send: () => undefined,
      },
    )
    expect(result.stopReason).toBe('end_turn')

    await driver.cancel({ sessionId: session.sessionId })
    await driver.loadSession({ sessionId: 's1', cwd: '/x', mcpServers: [] })
    await driver.forkSession({ sourceSessionId: 's1', cwd: '/x', mcpServers: [] })
    await driver.compact({ sessionId: session.sessionId }, { send: () => undefined })
  })

  test('capabilities() returns the advertised feature set', () => {
    const caps: DriverCapabilities = {
      resume: false,
      fork: false,
      fileUpload: true,
      thinking: false,
      subagent: false,
      skillEvents: false,
      debug: true,
      askQuestion: false,
    }
    const driver = new StubDriver(caps)
    expect(driver.capabilities()).toEqual(caps)
  })
})

describe('Phase 1.7 PromptResult shape', () => {
  test('PromptResult accepts session_failed stopReason with failure metadata', () => {
    const result: PromptResult = {
      stopReason: 'session_failed',
      failureReason: 'sdk_stall',
      failureDetail: 'no SDK message for 60s',
    }
    expect(result.stopReason).toBe('session_failed')
    expect(result.failureReason).toBe('sdk_stall')
    expect(result.failureDetail).toContain('60s')
  })

  test('PromptResult preserves the legacy stopReason values', () => {
    const result: PromptResult = { stopReason: 'end_turn' }
    expect(result.stopReason).toBe('end_turn')
  })
})

describe('Phase 1.7 DriverCapabilities.debug flag', () => {
  test('caps.debug round-trips through capabilities()', () => {
    const caps: DriverCapabilities = {
      resume: true,
      fork: true,
      fileUpload: true,
      thinking: true,
      subagent: true,
      skillEvents: true,
      debug: true,
      askQuestion: true,
    }
    const driver = new StubDriver(caps)
    expect(driver.capabilities().debug).toBe(true)
  })
})

describe('ensureCapability', () => {
  const caps: DriverCapabilities = {
    resume: false,
    fork: true,
    fileUpload: true,
    thinking: false,
    subagent: false,
    skillEvents: false,
    debug: false,
    askQuestion: false,
  }

  test('passes silently when the capability is advertised', () => {
    expect(() => ensureCapability(caps, 'fork', 'session/fork')).not.toThrow()
    expect(() => ensureCapability(caps, 'fileUpload', 'session/prompt')).not.toThrow()
  })

  test('throws MethodNotSupportedError when the capability is not advertised', () => {
    expect(() => ensureCapability(caps, 'resume', 'session/load')).toThrow(MethodNotSupportedError)
  })

  test('the thrown error carries method + supported list in data', () => {
    try {
      ensureCapability(caps, 'subagent', 'sessionUpdate/subagent_spawn')
      throw new Error('expected throw, got pass')
    } catch (error) {
      expect(error).toBeInstanceOf(MethodNotSupportedError)
      const data = (error as MethodNotSupportedError).data as {
        method: string
        supportedMethods: string[]
      }
      expect(data.method).toBe('sessionUpdate/subagent_spawn')
      // supportedMethods is the subset of caps that are true
      expect(data.supportedMethods).toContain('fork')
      expect(data.supportedMethods).toContain('fileUpload')
      expect(data.supportedMethods).not.toContain('subagent')
    }
  })
})
