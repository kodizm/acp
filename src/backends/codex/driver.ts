/**
 * Codex backend driver.
 *
 * Drives the codex CLI's `codex app-server` JSON-RPC stdio interface.
 * Translates Kodizm canonical wire shapes (NewSessionRequest,
 * PromptRequest, etc.) to codex's native protocol (thread/start,
 * turn/start, etc.). The orchestrator never sees the codex protocol;
 * driver-internal mapping handles every translation.
 *
 * Phase 2 T1: scaffold only. capabilities() advertises the feature
 * surface. initialize() returns the standard handshake. newSession()
 * allocates a Kodizm UUID without spawning subprocess yet (T2 wires
 * spawn + JSON-RPC framing).
 */

import { randomUUID } from 'node:crypto'

import { MethodNotSupportedError } from '../../server/errors.ts'
import type {
  CancelRequest,
  ForkSessionRequest,
  InitializeRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from '../../wire/types.ts'
import type {
  BackendDriver,
  DriverCapabilities,
  EventEmitter,
  InitializeResult,
  NewSessionResult,
  PromptResult,
} from '../driver.ts'

/**
 * Driver dependencies. Construction accepts everything the driver
 * needs to operate; nothing is read from a global scope. Phase 2 T2
 * extends with optional `codexHome` + `codexBinaryPath` overrides for
 * tests; Phase 2 T13 adds `debugSink` + lifecycle hooks.
 */
export interface CodexDriverDeps {
  agentInfo: { version: string }
}

const FULL_CAPABILITIES: DriverCapabilities = {
  resume: true,
  fork: true,
  fileUpload: true,
  thinking: true,
  subagent: true,
  skillEvents: false,
  debug: true,
}

/**
 * Concrete driver implementing every BackendDriver method against the
 * codex app-server protocol. Phase 2 T1 scaffolds capabilities +
 * initialize + newSession. Subsequent tasks layer subprocess spawn
 * (T2), thread lifecycle (T3-T6), event mapping (T7-T9), permission
 * flow (T10), Pattern B (T11), and error classification (T12-T13).
 */
export class CodexDriver implements BackendDriver {
  public constructor(private readonly deps: CodexDriverDeps) {}

  public capabilities(): DriverCapabilities {
    return FULL_CAPABILITIES
  }

  public async initialize(_params: InitializeRequest): Promise<InitializeResult> {
    return {
      protocolVersion: 1,
      agentInfo: this.deps.agentInfo,
      capabilities: FULL_CAPABILITIES,
    }
  }

  public async newSession(_params: NewSessionRequest): Promise<NewSessionResult> {
    return { sessionId: randomUUID() }
  }

  public async prompt(_sessionId: string, _params: PromptRequest, _emit: EventEmitter): Promise<PromptResult> {
    throw new MethodNotSupportedError('session/prompt', ['initialize', 'session/new'])
  }

  public async cancel(_request: CancelRequest): Promise<void> {
    throw new MethodNotSupportedError('session/cancel', ['initialize', 'session/new'])
  }

  public async loadSession(_params: LoadSessionRequest): Promise<NewSessionResult> {
    throw new MethodNotSupportedError('session/load', ['initialize', 'session/new'])
  }

  public async forkSession(_params: ForkSessionRequest): Promise<NewSessionResult> {
    throw new MethodNotSupportedError('session/fork', ['initialize', 'session/new'])
  }
}
