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
export type SdkMessage = SdkSystemInitMessage | SdkAssistantMessage | SdkUserMessage | SdkResultMessage

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
      return mapSystemInit(sessionId, message)
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
