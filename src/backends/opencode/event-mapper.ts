/**
 * Opencode bus events -> Kodizm canonical SessionUpdateEvent.
 *
 * Phase 3 T6 + locked decisions D6, D7, D8. Stateful mapper: caches
 *   - partID -> partType (so `message.part.delta` resolves text vs reasoning)
 *   - subagent task callID -> Kodizm childId mapping (currently mirrors
 *     opencode child sessionID directly)
 *   - last seen `info.time.compacting` per session (D7 trigger detection)
 *
 * Mapping table:
 *   message.part.delta (TextPart)        -> output_chunk
 *   message.part.delta (ReasoningPart)   -> thinking_chunk
 *   message.part.updated tool/running    -> tool_call_begin (name resolved
 *                                          via reverseToolName + Pascal case)
 *   message.part.updated tool/completed  -> tool_call_end (output)
 *   message.part.updated tool/error      -> tool_call_end (error, isError=true)
 *   message.part.updated task/running    -> subagent_spawn
 *   message.part.updated task/completed  -> subagent_complete
 *   message.part.updated task/error      -> subagent_complete (error sentinel)
 *   session.updated time.compacting set  -> compaction_started
 *   session.compacted                    -> compaction_completed
 *   message.updated role=assistant
 *     with time.completed                -> usage (tokens + cost rollup)
 */

import type { SessionUpdateEvent } from '../../wire/events.ts'
import { reverseToolName } from './mcp-mapper.ts'

/**
 * Construction-time options. The mapper is single-tenant per Kodizm
 * session; one instance per `prompt()` call. The reverse MCP map is
 * built by the driver at session.create + plumbed in here so tool
 * events emit canonical `mcp__<server>__<tool>` names.
 */
export interface OpencodeEventMapperOptions {
  sessionId: string
  emit: (event: SessionUpdateEvent) => void
  mcpReverseMap: Map<string, string>
}

/**
 * Per-tool subagent slot: Kodizm childId is the opencode child
 * sessionID. The slot persists between spawn + complete so completion
 * can reference the same childId. T8 may extend this with token
 * rollups when child message data becomes available.
 */
interface SubagentSlot {
  childId: string
  parentSessionId: string
}

/**
 * Stateful per-session opencode bus -> canonical mapper.
 */
export class OpencodeEventMapper {
  private readonly partTypes: Map<string, string> = new Map()
  private readonly subagents: Map<string, SubagentSlot> = new Map()
  private compactingActive = false

  public constructor(private readonly options: OpencodeEventMapperOptions) {}

  /**
   * Translate one bus event into zero or more canonical sessionUpdate
   * events emitted via {@link OpencodeEventMapperOptions.emit}.
   *
   * @param method - the opencode bus event type string
   * @param payload - the event's properties; loosely typed because
   *                  opencode's effect schemas leak `unknown` over the
   *                  wire
   */
  public handle(method: string, payload: unknown): void {
    if (method === 'message.part.delta') {
      this.handlePartDelta(payload as PartDeltaPayload)
      return
    }
    if (method === 'message.part.updated') {
      this.handlePartUpdated(payload as PartUpdatedPayload)
      return
    }
    if (method === 'message.updated') {
      this.handleMessageUpdated(payload as MessageUpdatedPayload)
      return
    }
    if (method === 'session.updated') {
      this.handleSessionUpdated(payload as SessionUpdatedPayload)
      return
    }
    if (method === 'session.compacted') {
      this.handleSessionCompacted()
      return
    }
    // Unknown method: silent passthrough so future opencode events do
    // not crash the driver.
  }

  private handlePartDelta(payload: PartDeltaPayload): void {
    if (typeof payload.delta !== 'string') return
    if (payload.field !== 'text') return

    const partType = this.partTypes.get(payload.partID)
    if (partType === 'reasoning') {
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'thinking_chunk',
        text: payload.delta,
      })
      return
    }
    if (partType === 'text') {
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'output_chunk',
        text: payload.delta,
      })
      return
    }
    // Unknown partType: drop silently. The driver always emits
    // message.part.updated before delta in normal flows, so this
    // branch is unusual but defensive.
  }

  private handlePartUpdated(payload: PartUpdatedPayload): void {
    const part = payload.part
    if (part === undefined) return

    // 1. Cache partID -> type so subsequent PartDelta events resolve.
    this.partTypes.set(part.id, part.type)

    const toolPart = isToolPart(part) ? part : undefined
    if (toolPart === undefined) return

    const state = toolPart.state
    if (state === undefined) return

    // 2. Subagent (task tool) lifecycle.
    if (toolPart.tool === 'task') {
      this.handleTaskToolPart(toolPart, state)
      return
    }

    // 3. Generic tool lifecycle. running -> begin; completed/error -> end.
    if (state.status === 'running') {
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'tool_call_begin',
        toolUseId: toolPart.callID,
        name: this.resolveToolName(toolPart.tool),
        input: state.input,
      })
      return
    }

    if (state.status === 'completed' || state.status === 'error') {
      const isError = state.status === 'error'
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'tool_call_end',
        toolUseId: toolPart.callID,
        result: isError ? state.error : state.output,
        isError,
      })
    }
  }

  private handleTaskToolPart(part: ToolPart, state: ToolState): void {
    const meta = state.metadata ?? {}
    const childId = typeof meta.sessionID === 'string' ? meta.sessionID : part.callID

    if (state.status === 'running') {
      this.subagents.set(part.callID, {
        childId,
        parentSessionId: this.options.sessionId,
      })
      const model =
        meta.model !== undefined && typeof meta.model === 'object'
          ? this.formatSubagentModel(meta.model as { providerID?: string; modelID?: string })
          : 'unknown'
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'subagent_spawn',
        childId,
        parentSessionId: this.options.sessionId,
        model,
        tools: [],
      })
      return
    }

    if (state.status === 'completed' || state.status === 'error') {
      const slot = this.subagents.get(part.callID)
      const resolvedChildId = slot?.childId ?? childId
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'subagent_complete',
        childId: resolvedChildId,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      })
      this.subagents.delete(part.callID)
    }
  }

  private handleMessageUpdated(payload: MessageUpdatedPayload): void {
    const info = payload.info
    if (info === undefined) return
    if (info.role !== 'assistant') return
    if (info.time?.completed === undefined) return

    const tokens = info.tokens
    if (tokens === undefined) return

    this.options.emit({
      sessionId: this.options.sessionId,
      type: 'usage',
      inputTokens: tokens.input ?? 0,
      outputTokens: tokens.output ?? 0,
      cacheReadTokens: tokens.cache?.read ?? 0,
      cacheCreationTokens: tokens.cache?.write ?? 0,
      costUsd: typeof info.cost === 'number' ? info.cost : 0,
    })
  }

  private handleSessionUpdated(payload: SessionUpdatedPayload): void {
    const compacting = payload.info?.time?.compacting
    if (typeof compacting === 'number' && !this.compactingActive) {
      this.compactingActive = true
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'compaction_started',
        trigger: 'auto',
      })
    }
  }

  private handleSessionCompacted(): void {
    if (!this.compactingActive) return
    this.compactingActive = false
    this.options.emit({
      sessionId: this.options.sessionId,
      type: 'compaction_completed',
      trigger: 'auto',
      preTokens: 0,
      succeeded: true,
    })
  }

  /**
   * Resolve opencode's tool name to canonical Kodizm wire shape.
   * - MCP tool keys (`<sanitizedServer>_<tool>`) reverse-map to
   *   `mcp__<server>__<tool>` via the reverse map.
   * - Native opencode IDs (`bash`, `edit`, ...) PascalCase to match
   *   Claude / codex conventions on the orchestrator wire.
   */
  private resolveToolName(opencodeName: string): string {
    const canonical = reverseToolName(opencodeName, this.options.mcpReverseMap)
    if (canonical !== null) {
      return canonical
    }
    return this.toPascalCase(opencodeName)
  }

  private toPascalCase(name: string): string {
    if (name.length === 0) return name
    // Single token: capitalize first char (`bash` -> `Bash`).
    // Underscored tokens (`apply_patch` -> `ApplyPatch`).
    return name
      .split('_')
      .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
      .join('')
  }

  private formatSubagentModel(model: { providerID?: string; modelID?: string }): string {
    if (typeof model.providerID === 'string' && typeof model.modelID === 'string') {
      return `${model.providerID}/${model.modelID}`
    }
    if (typeof model.modelID === 'string') {
      return model.modelID
    }
    return 'unknown'
  }
}

interface PartDeltaPayload {
  sessionID?: string
  messageID?: string
  partID: string
  field?: string
  delta?: string
}

interface PartUpdatedPayload {
  sessionID?: string
  part?: Part
  time?: number
}

/**
 * Narrowing predicate: opencode's Part union is structurally
 * discriminated by `type`, but TS does not narrow the union to
 * `ToolPart` after a non-equality guard like `part.type !== 'tool'`
 * because `OtherPart.type` is `string`. This helper makes the
 * narrow explicit.
 */
function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool'
}

type Part = TextPart | ReasoningPart | ToolPart | OtherPart

interface TextPart {
  id: string
  type: 'text'
  text?: string
}

interface ReasoningPart {
  id: string
  type: 'reasoning'
  text?: string
}

interface ToolPart {
  id: string
  type: 'tool'
  callID: string
  tool: string
  state?: ToolState
  metadata?: Record<string, unknown>
}

interface OtherPart {
  id: string
  type: string
}

interface ToolState {
  status: 'pending' | 'running' | 'completed' | 'error'
  input?: unknown
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  time?: { start?: number; end?: number }
}

interface MessageUpdatedPayload {
  info?: {
    id: string
    role: 'user' | 'assistant'
    time?: { created?: number; completed?: number }
    cost?: number
    tokens?: {
      total?: number
      input?: number
      output?: number
      reasoning?: number
      cache?: { read?: number; write?: number }
    }
  }
}

interface SessionUpdatedPayload {
  info?: {
    id?: string
    time?: { compacting?: number; updated?: number }
  }
}
