/**
 * Codex ServerNotification -> Kodizm canonical SessionUpdateEvent.
 *
 * Phase 2 T7. Stateful mapper: caches the latest token usage from
 * `thread/tokenUsage/updated` so `turn/completed` can emit a final
 * canonical `usage` event + compaction lifecycle can emit pre/post
 * token deltas.
 *
 * Notification mapping (locked decision 11):
 *   item/agentMessage/delta              -> output_chunk
 *   item/agentMessage/delta (reasoning)  -> thinking_chunk
 *   item/started w/ CommandExecution     -> tool_call_begin (Bash)
 *   item/completed w/ CommandExecution   -> tool_call_end
 *   item/started w/ FileChange           -> tool_call_begin (apply_patch)
 *   item/completed w/ FileChange         -> tool_call_end
 *   item/started w/ McpToolCall          -> tool_call_begin (mcp__<s>__<t>)
 *   item/completed w/ McpToolCall        -> tool_call_end
 *   item/started w/ ContextCompaction    -> compaction_started
 *   item/completed w/ ContextCompaction  -> compaction_completed
 *   thread/tokenUsage/updated            -> cache last counts
 *   turn/completed                       -> usage event from cached counts
 *   thread/status/changed                -> driver-internal (no emit)
 *
 * T8 will extend this with CollabAgentToolCall (subagent) handling.
 */

import { randomUUID } from 'node:crypto'

import type { SessionUpdateEvent } from '../../wire/events.ts'

/**
 * Codex `TokenUsageBreakdown` (camelCase per `v2/TokenUsageBreakdown.ts`).
 * Codex doesn't split cached vs cache-creation; we map cached -> cache
 * read and pin cache creation to zero.
 */
interface TokenCounts {
  totalTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
}

/**
 * Codex `ThreadTokenUsageUpdatedNotification.params` shape per
 * `v2/ThreadTokenUsageUpdatedNotification.ts`.
 */
interface TokenUsageNotification {
  threadId?: string
  turnId?: string
  tokenUsage?: { total?: TokenCounts; last?: TokenCounts; modelContextWindow?: number | null }
}

interface CodexItem {
  id: string
  type: string
  // CommandExecution
  cmd?: string
  cwd?: string
  status?: string
  aggregated_output?: string
  exit_code?: number
  // FileChange
  files?: ReadonlyArray<string>
  // McpToolCall
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  // CollabAgentToolCall
  sender_thread_id?: string
  receiver_thread_ids?: ReadonlyArray<string>
  prompt?: string
  model?: string
}

interface ItemNotification {
  thread_id?: string
  turn_id?: string
  item?: CodexItem
}

interface DeltaNotification {
  thread_id?: string
  turn_id?: string
  delta?: string
  subtype?: string
}

interface TurnCompletedNotification {
  thread_id?: string
  turn?: { id: string; status: string }
}

export interface CodexEventMapperOptions {
  sessionId: string
  emit: (event: SessionUpdateEvent) => void
}

/**
 * Stateful per-session mapper. Construct one per `prompt()` call;
 * the cached token counts span a single turn.
 */
export class CodexEventMapper {
  private lastTotalUsage: TokenCounts | undefined
  private preCompactionTotal: TokenCounts | undefined
  /**
   * Subagent map: codex CollabAgentToolCall item id -> Kodizm child UUID.
   * The map ensures spawn / complete events for the same item carry
   * the same childId (orchestrator never sees codex thread ids).
   */
  private readonly subagents: Map<string, string> = new Map()

  public constructor(private readonly options: CodexEventMapperOptions) {}

  /**
   * Translate one codex notification into zero or more canonical
   * sessionUpdate events emitted via {@link CodexEventMapperOptions.emit}.
   *
   * @param method - the codex notification method
   * @param params - the notification params (codex schema; loosely typed)
   */
  public handle(method: string, params: unknown): void {
    if (method === 'item/agentMessage/delta') {
      this.handleAgentMessageDelta(params as DeltaNotification)
      return
    }
    if (method === 'item/started') {
      this.handleItemStarted(params as ItemNotification)
      return
    }
    if (method === 'item/completed') {
      this.handleItemCompleted(params as ItemNotification)
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      this.handleTokenUsage(params as TokenUsageNotification)
      return
    }
    if (method === 'turn/completed') {
      this.handleTurnCompleted(params as TurnCompletedNotification)
      return
    }
    // thread/status/changed + unknown: no canonical equivalent.
  }

  private handleAgentMessageDelta(params: DeltaNotification): void {
    if (typeof params.delta !== 'string') return
    if (params.subtype === 'reasoning') {
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'thinking_chunk',
        text: params.delta,
      })
      return
    }
    this.options.emit({
      sessionId: this.options.sessionId,
      type: 'output_chunk',
      text: params.delta,
    })
  }

  private handleItemStarted(params: ItemNotification): void {
    const item = params.item
    if (item === undefined) return

    // codex v2 emits item.type in camelCase ('commandExecution',
    // 'fileChange', 'mcpToolCall', 'contextCompaction', 'collabAgentToolCall').
    // Older builds used PascalCase; we accept both for forward + backward compat.
    if (item.type === 'CommandExecution' || item.type === 'commandExecution') {
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'tool_call_begin',
        toolUseId: item.id,
        name: 'Bash',
        input: { command: item.cmd, cwd: item.cwd },
      })
      return
    }
    if (item.type === 'FileChange' || item.type === 'fileChange') {
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'tool_call_begin',
        toolUseId: item.id,
        name: 'apply_patch',
        input: { files: item.files },
      })
      return
    }
    if (item.type === 'McpToolCall' || item.type === 'mcpToolCall') {
      const name = `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'unknown'}`
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'tool_call_begin',
        toolUseId: item.id,
        name,
        input: item.arguments,
      })
      return
    }
    if (item.type === 'ContextCompaction' || item.type === 'contextCompaction') {
      this.preCompactionTotal = this.lastTotalUsage
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'compaction_started',
        trigger: 'auto',
      })
      return
    }
    if ((item.type === 'CollabAgentToolCall' || item.type === 'collabAgentToolCall') && item.tool === 'SpawnAgent') {
      const childId = randomUUID()
      this.subagents.set(item.id, childId)
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'subagent_spawn',
        childId,
        parentSessionId: this.options.sessionId,
        model: item.model ?? 'unknown',
        tools: [],
      })
      return
    }
  }

  private handleItemCompleted(params: ItemNotification): void {
    const item = params.item
    if (item === undefined) return

    if (
      item.type === 'CommandExecution' ||
      item.type === 'commandExecution' ||
      item.type === 'FileChange' ||
      item.type === 'fileChange' ||
      item.type === 'McpToolCall' ||
      item.type === 'mcpToolCall'
    ) {
      const isError = item.status === 'error' || item.status === 'failed'
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'tool_call_end',
        toolUseId: item.id,
        result: item.aggregated_output ?? item.result ?? null,
        isError,
      })
      return
    }
    if (item.type === 'ContextCompaction' || item.type === 'contextCompaction') {
      const preTokens = this.preCompactionTotal?.inputTokens ?? 0
      const postTokens = this.lastTotalUsage?.inputTokens ?? 0
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'compaction_completed',
        trigger: 'auto',
        preTokens,
        postTokens,
        succeeded: true,
      })
      this.preCompactionTotal = undefined
      return
    }
    if (item.type === 'CollabAgentToolCall' || item.type === 'collabAgentToolCall') {
      const childId = this.subagents.get(item.id)
      if (childId === undefined) return
      this.options.emit({
        sessionId: this.options.sessionId,
        type: 'subagent_complete',
        childId,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      })
      this.subagents.delete(item.id)
      return
    }
  }

  private handleTokenUsage(params: TokenUsageNotification): void {
    const total = params.tokenUsage?.total
    if (total !== undefined) {
      this.lastTotalUsage = total
    }
  }

  private handleTurnCompleted(_params: TurnCompletedNotification): void {
    if (this.lastTotalUsage === undefined) return
    this.options.emit({
      sessionId: this.options.sessionId,
      type: 'usage',
      inputTokens: this.lastTotalUsage.inputTokens ?? 0,
      outputTokens: this.lastTotalUsage.outputTokens ?? 0,
      cacheReadTokens: this.lastTotalUsage.cachedInputTokens ?? 0,
      cacheCreationTokens: 0, // codex does not split cache creation
      costUsd: 0,
    })
  }
}
