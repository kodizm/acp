/**
 * SDK message -> Kodizm canonical sessionUpdate event translation.
 *
 * The Claude SDK yields a stream of typed messages over its `query()`
 * generator. This module is the pure translation layer that converts
 * each message into zero-or-more {@link SessionUpdateEvent} values
 * the orchestrator consumes. Pure function; no IO.
 *
 * Reference: claude-agent-acp's acp-agent.ts handles the same
 * translation against the orchestrator's ACP wire shape; we translate
 * to the Kodizm canonical shape instead.
 */

import type { SessionUpdateEvent } from '../../wire/events.ts'

/**
 * Subset of the SDK's message shape we care about. Defining locally
 * avoids a transitive dep on the SDK's exported types and keeps unit
 * tests free of SDK loading.
 *
 * The SDK actually emits a wider union than this; unknown variants
 * fall through {@link mapSdkMessage} and produce no events.
 */
export type SdkMessage =
  | SdkSystemInitMessage
  | SdkSystemStatusMessage
  | SdkSystemCompactBoundaryMessage
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkResultMessage

interface SdkSystemStatusMessage {
  type: 'system'
  subtype: 'status'
  status: 'compacting' | 'requesting' | null
  compact_result?: 'success' | 'failed'
  compact_error?: string
}

interface SdkSystemCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  compact_metadata: {
    trigger: 'manual' | 'auto'
    pre_tokens: number
    post_tokens?: number
    duration_ms?: number
  }
}

interface SdkSystemInitMessage {
  type: 'system'
  subtype: 'init'
  model?: string
  parent_tool_use_id?: string
  uuid?: string
  /**
   * SDK's own session identifier. Distinct from our orchestrator-side
   * UUID; the SDK persists the transcript JSONL under this id so any
   * resume call must pass it back as the `resume` option. The driver
   * captures this on the first system init and stores it on the
   * session state.
   */
  session_id?: string
  skills?: string[]
}

interface SdkAssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: Array<SdkTextBlock | SdkThinkingBlock | SdkToolUseBlock>
    usage?: SdkUsage
  }
  parent_tool_use_id?: string
}

interface SdkUserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: Array<SdkTextBlock | SdkToolResultBlock>
  }
}

interface SdkResultMessage {
  type: 'result'
  subtype: 'success' | 'error'
  total_cost_usd?: number
  usage?: SdkUsage
  stop_reason?: string
  parent_tool_use_id?: string
}

interface SdkTextBlock {
  type: 'text'
  text: string
}

interface SdkThinkingBlock {
  type: 'thinking'
  thinking: string
}

interface SdkToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

interface SdkToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  /**
   * Tool result payload. The SDK normalises text-only results to a
   * plain string at the wire; structured results land as an array
   * of text blocks. Our mapper accepts either.
   */
  content: string | Array<SdkTextBlock>
  is_error: boolean
}

interface SdkUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * Map a single SDK message to zero-or-more Kodizm canonical events.
 *
 * Most assistant + user messages produce multiple events (one per
 * content block); system + result messages produce zero or one.
 * Unknown variants return an empty list so future SDK extensions
 * fail soft.
 *
 * @param sessionId - the session this message belongs to (envelope)
 * @param message - the raw SDK message
 * @returns array of Kodizm canonical events
 */
export function mapSdkMessage(sessionId: string, message: SdkMessage): SessionUpdateEvent[] {
  switch (message.type) {
    case 'system':
      // Three system subtypes flow through this branch: init, status,
      // and compact_boundary. Each gets its own mapper.
      if (message.subtype === 'init') {
        return mapSystemInit(sessionId, message)
      }
      if (message.subtype === 'status') {
        return mapSystemStatus(sessionId, message)
      }
      if (message.subtype === 'compact_boundary') {
        return mapCompactBoundary(sessionId, message)
      }
      return []
    case 'assistant':
      return mapAssistantMessage(sessionId, message)
    case 'user':
      return mapUserMessage(sessionId, message)
    case 'result':
      return mapResult(sessionId, message)
    default:
      return []
  }
}

/**
 * SDK `system status` -> compaction lifecycle events. The SDK emits
 * status:'compacting' when summarisation begins and status:null with
 * compact_result on success or failure. We surface:
 *
 *   - status:'compacting'                      -> compaction_started
 *   - status:null + compact_result:'success'   -> (no event; the
 *                                                 preceding compact_boundary
 *                                                 already emitted
 *                                                 compaction_completed)
 *   - status:null + compact_result:'failed'    -> compaction_completed
 *                                                 (succeeded:false)
 *
 * Trigger is unknown at status:'compacting' (boundary carries it), so
 * we default to 'auto' on the started event; the completed event
 * carries the authoritative trigger from compact_metadata.
 */
function mapSystemStatus(sessionId: string, message: SdkSystemStatusMessage): SessionUpdateEvent[] {
  if (message.status === 'compacting') {
    return [{ sessionId, type: 'compaction_started', trigger: 'auto' }]
  }
  if (message.status === null && message.compact_result === 'failed') {
    return [
      {
        sessionId,
        type: 'compaction_completed',
        trigger: 'auto',
        preTokens: 0,
        succeeded: false,
        ...(message.compact_error === undefined ? {} : { error: message.compact_error }),
      },
    ]
  }
  return []
}

/**
 * SDK `compact_boundary` -> compaction_completed event. Carries the
 * authoritative metadata (trigger, pre_tokens, post_tokens?,
 * duration_ms?). Always succeeded:true (boundary fires only on
 * success).
 */
function mapCompactBoundary(sessionId: string, message: SdkSystemCompactBoundaryMessage): SessionUpdateEvent[] {
  return [
    {
      sessionId,
      type: 'compaction_completed',
      trigger: message.compact_metadata.trigger,
      preTokens: message.compact_metadata.pre_tokens,
      ...(message.compact_metadata.post_tokens === undefined
        ? {}
        : { postTokens: message.compact_metadata.post_tokens }),
      ...(message.compact_metadata.duration_ms === undefined
        ? {}
        : { durationMs: message.compact_metadata.duration_ms }),
      succeeded: true,
    },
  ]
}

/**
 * `system` init: emits a model_advertisement event when the SDK
 * announces the active model, a skill_activation per pre-loaded skill
 * (source=auto), and a subagent_spawn when the message carries
 * `parent_tool_use_id` (subagent kicked off).
 */
function mapSystemInit(sessionId: string, message: SdkSystemInitMessage): SessionUpdateEvent[] {
  const events: SessionUpdateEvent[] = []

  if (message.model !== undefined && message.model !== '') {
    events.push({ sessionId, type: 'model_advertisement', model: message.model })
  }

  if (message.skills !== undefined) {
    for (const skillName of message.skills) {
      events.push({ sessionId, type: 'skill_activation', skillName, source: 'auto' })
    }
  }

  if (message.parent_tool_use_id !== undefined && message.uuid !== undefined && message.model !== undefined) {
    events.push({
      sessionId,
      type: 'subagent_spawn',
      childId: message.uuid,
      parentSessionId: sessionId,
      model: message.model,
      tools: [],
    })
  }

  return events
}

/**
 * `assistant` message: walks the content blocks, emits an event per
 * block (text -> output_chunk, thinking -> thinking_chunk, tool_use
 * -> tool_call_begin). Usage is rolled into the `result` mapping
 * instead of here so end-of-turn rollup stays single-source.
 */
function mapAssistantMessage(sessionId: string, message: SdkAssistantMessage): SessionUpdateEvent[] {
  const events: SessionUpdateEvent[] = []

  for (const block of message.message.content) {
    if (block.type === 'text') {
      events.push({ sessionId, type: 'output_chunk', text: block.text })
      continue
    }
    if (block.type === 'thinking') {
      events.push({ sessionId, type: 'thinking_chunk', text: block.thinking })
      continue
    }
    if (block.type === 'tool_use') {
      // Surface skill invocations as a dedicated activation event
      // before the generic tool_call_begin. The Skill tool is the
      // SDK's contract for "load this skill mid-session".
      const skillName = extractSkillName(block)
      if (skillName !== undefined) {
        events.push({ sessionId, type: 'skill_activation', skillName, source: 'invoked' })
      }
      // Surface Task tool dispatches (Claude Code's subagent
      // delegation lever) as subagent_spawn before the generic
      // tool_call_begin. Older Anthropic SDK builds named the same
      // tool 'Agent' on the wire; both aliases route here. The
      // tool_use_id is reused as childId because the Task tool
      // does not allocate a separate session uuid; the matching
      // subagent_complete (T370 below) ties back via tool_use_id.
      const subagentType = extractSubagentType(block)
      if (subagentType !== undefined) {
        events.push({
          sessionId,
          type: 'subagent_spawn',
          childId: block.id,
          parentSessionId: sessionId,
          model: subagentType,
          tools: [],
        })
      }
      events.push({
        sessionId,
        type: 'tool_call_begin',
        toolUseId: block.id,
        name: block.name,
        input: block.input,
      })
    }
  }

  return events
}

/**
 * If the tool_use block represents a Skill tool invocation with a
 * non-empty `skill` argument, return the skill name; else undefined.
 *
 * The SDK's Skill tool input shape is `{ skill: string, args?: string }`
 * (see Claude Code SkillTool/SkillTool.ts inputSchema).
 */
function extractSkillName(block: SdkToolUseBlock): string | undefined {
  if (block.name !== 'Skill') {
    return undefined
  }
  const input = block.input
  if (typeof input !== 'object' || input === null) {
    return undefined
  }
  const skill = (input as { skill?: unknown }).skill
  if (typeof skill !== 'string' || skill.length === 0) {
    return undefined
  }
  return skill
}

/**
 * Detect a Claude Code Task tool dispatch and return the
 * `subagent_type` argument so the mapper can record it as the
 * "model" hint on the subagent_spawn event.
 *
 * Tool name is `Task` on current SDK builds + `Agent` on legacy
 * builds; both surface a `subagent_type` field on the input. When
 * the field is missing we still treat the call as a subagent (the
 * Task tool always does), defaulting to `'general-purpose'` since
 * that is the SDK's default subagent class.
 */
function extractSubagentType(block: SdkToolUseBlock): string | undefined {
  if (block.name !== 'Task' && block.name !== 'Agent') {
    return undefined
  }
  const input = block.input
  if (typeof input !== 'object' || input === null) {
    return 'general-purpose'
  }
  const subagentType = (input as { subagent_type?: unknown }).subagent_type
  if (typeof subagentType === 'string' && subagentType.length > 0) {
    return subagentType
  }
  return 'general-purpose'
}

/**
 * `user` message: usually echoes user input + tool_result blocks. We
 * surface tool_result blocks as tool_call_end events; user text
 * blocks are not re-emitted to the orchestrator (it already knows
 * what it sent).
 */
function mapUserMessage(sessionId: string, message: SdkUserMessage): SessionUpdateEvent[] {
  const events: SessionUpdateEvent[] = []

  for (const block of message.message.content) {
    if (block.type === 'tool_result') {
      // SDK can hand us either a plain string or an array of text blocks.
      const resultText = typeof block.content === 'string' ? block.content : block.content.map((c) => c.text).join('\n')

      // Detect a Task tool subagent return BEFORE the generic
      // tool_call_end so the orchestrator's tree observer pairs the
      // complete with its spawn before the tool lifecycle event
      // closes. Markers: the Task tool stamps `agentId: <hex>` plus a
      // `<usage>total_tokens: N tool_uses: M duration_ms: D</usage>`
      // block on its result string. Both must be present to avoid
      // false-positives on any unrelated tool that mentions the word.
      const subagentUsage = extractTaskToolUsage(resultText)
      if (subagentUsage !== undefined) {
        events.push({
          sessionId,
          type: 'subagent_complete',
          childId: block.tool_use_id,
          inputTokens: subagentUsage.totalTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
        })
      }

      events.push({
        sessionId,
        type: 'tool_call_end',
        toolUseId: block.tool_use_id,
        result: resultText,
        isError: block.is_error,
      })
    }
  }

  return events
}

/**
 * Detect a Claude Code Task tool result by scanning for both the
 * `agentId:` line + the `<usage>total_tokens: N ...</usage>` block.
 * Returns the parsed numeric counts when both markers land, else
 * undefined for any unrelated tool result.
 *
 * The Task tool does not split input vs output tokens; the wire
 * exposes `total_tokens` only. Callers map total -> inputTokens and
 * leave outputTokens at 0; the orchestrator's modal renders both.
 */
function extractTaskToolUsage(resultText: string): { totalTokens: number } | undefined {
  if (!resultText.includes('agentId:')) {
    return undefined
  }

  const usageMatch = resultText.match(/<usage>([\s\S]*?)<\/usage>/)
  if (usageMatch === null) {
    return undefined
  }

  const totalMatch = usageMatch[1]?.match(/total_tokens:\s*(\d+)/)
  if (totalMatch === null || totalMatch === undefined) {
    return undefined
  }

  return {
    totalTokens: Number.parseInt(totalMatch[1] ?? '0', 10),
  }
}

/**
 * `result` message: end-of-turn rollup. Emits a usage event with
 * the four token counts + cost, plus a subagent_complete event
 * when `parent_tool_use_id` indicates this was a subagent turn.
 */
function mapResult(sessionId: string, message: SdkResultMessage): SessionUpdateEvent[] {
  const events: SessionUpdateEvent[] = []

  const usage = message.usage
  if (usage !== undefined) {
    events.push({
      sessionId,
      type: 'usage',
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      costUsd: message.total_cost_usd ?? 0,
    })
  }

  if (message.parent_tool_use_id !== undefined && usage !== undefined) {
    events.push({
      sessionId,
      type: 'subagent_complete',
      childId: message.parent_tool_use_id,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      costUsd: message.total_cost_usd ?? 0,
    })
  }

  return events
}
