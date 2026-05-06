/**
 * sessionUpdate event types (zod) for the Kodizm-flavored ACP wire.
 *
 * Each event is a notification frame the server emits during a turn.
 * The orchestrator consumes them in real time to update its UI,
 * persist stream events, and roll up tokens / cost.
 *
 * The 12 event types form a discriminated union keyed on `type`. Every
 * variant carries `sessionId` so the orchestrator can route a stream
 * event back to its session row without parsing the payload.
 *
 * This shape is the SOURCE OF TRUTH across all backends: phase 2
 * (codex) and phase 3 (opencode) translate their native stream events
 * into these schemas. Codex/opencode subagent semantics differ but
 * normalize down to this shape via per-backend mappers.
 */

import { z } from 'zod'

/**
 * Common envelope present on every sessionUpdate event.
 */
const SessionEnvelope = z.object({
  sessionId: z.string().min(1),
})

/**
 * `output_chunk`: assistant text streamed back to the orchestrator.
 * Concatenating successive `text` values reconstructs the final
 * assistant message.
 */
export const OutputChunkEventSchema = SessionEnvelope.extend({
  type: z.literal('output_chunk'),
  text: z.string(),
})

/**
 * `thinking_chunk`: reasoning tokens (Claude's `thinking` blocks).
 * Surfaced when the SDK emits internal reasoning; consumers may
 * choose to render or hide them.
 */
export const ThinkingChunkEventSchema = SessionEnvelope.extend({
  type: z.literal('thinking_chunk'),
  text: z.string(),
})

/**
 * `tool_call_begin`: a tool invocation has started. Carries the SDK's
 * `toolUseId` so subsequent progress + end events correlate.
 */
export const ToolCallBeginEventSchema = SessionEnvelope.extend({
  type: z.literal('tool_call_begin'),
  toolUseId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
})

/**
 * `tool_call_progress`: incremental updates while a tool is running.
 * Optional; not every backend emits these.
 */
export const ToolCallProgressEventSchema = SessionEnvelope.extend({
  type: z.literal('tool_call_progress'),
  toolUseId: z.string().min(1),
  delta: z.unknown(),
})

/**
 * `tool_call_end`: the tool call has settled. Carries either a result
 * payload (success) or an error payload (`isError: true`).
 */
export const ToolCallEndEventSchema = SessionEnvelope.extend({
  type: z.literal('tool_call_end'),
  toolUseId: z.string().min(1),
  result: z.unknown(),
  isError: z.boolean(),
})

/**
 * `permission_request`: surfaced when the SDK asks for permission to
 * run a non-edit tool. The orchestrator's mediator picks an option
 * id; the response shape is documented at the AcpServer dispatcher
 * layer, not here.
 */
export const PermissionRequestEventSchema = SessionEnvelope.extend({
  type: z.literal('permission_request'),
  toolUseId: z.string().min(1),
  name: z.string().min(1),
  options: z.array(
    z.object({
      optionId: z.string().min(1),
      label: z.string().min(1),
    }),
  ),
  /**
   * Set when the gated tool call originates from a Claude Task-tool
   * subagent (the SDK's `canUseTool` options carry `agentID`). The
   * orchestrator UI uses this to render "subagent X requesting tool Y
   * (parent: <session-id>)" plus stamp `agent_id` on the audit row.
   */
  agentId: z.string().min(1).optional(),
  /**
   * Echoes the parent session id when the request originates from a
   * subagent. For main-agent calls this is omitted (the envelope's
   * sessionId IS the parent).
   */
  parentSessionId: z.string().min(1).optional(),
})

/**
 * Single question that the model asks the user via the SDK's
 * `AskUserQuestion` tool. Mirrors Claude Code's tool input shape so
 * the orchestrator can render the dialog without re-deriving fields.
 */
export const KodizmQuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1).max(12),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().min(1),
        preview: z.string().optional(),
      }),
    )
    .min(2)
    .max(4),
  multiSelect: z.boolean(),
})

/**
 * `question_request`: emitted alongside the outbound
 * `session/ask_user_question` RPC so the orchestrator's stream-event
 * store rolls forward (live UI, audit) without waiting for the RPC
 * response. Carries 1-4 question rows, each with 2-4 options.
 */
export const QuestionRequestEventSchema = SessionEnvelope.extend({
  type: z.literal('question_request'),
  toolUseId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  parentSessionId: z.string().min(1).optional(),
  questions: z.array(KodizmQuestionSchema).min(1).max(4),
})

/**
 * `compaction_started`: the SDK has begun compressing the prior
 * conversation transcript. Trigger distinguishes user-invoked
 * `/compact` from the auto-threshold trigger.
 */
export const CompactionStartedEventSchema = SessionEnvelope.extend({
  type: z.literal('compaction_started'),
  trigger: z.enum(['manual', 'auto']),
})

/**
 * `compaction_completed`: the SDK has settled. `succeeded: false`
 * means the summarisation API call failed; the active context is
 * unchanged in that case (SDK absorbs the failure internally and
 * counts toward the `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`
 * circuit breaker).
 */
export const CompactionCompletedEventSchema = SessionEnvelope.extend({
  type: z.literal('compaction_completed'),
  trigger: z.enum(['manual', 'auto']),
  preTokens: z.number().int().nonnegative(),
  postTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  succeeded: z.boolean(),
  error: z.string().optional(),
})

/**
 * `usage`: end-of-turn token + cost rollup. The four token counts
 * mirror Anthropic's SDK usage block. Cost is in USD with up to 6
 * decimals so micro-cost runs do not round to zero.
 */
export const UsageEventSchema = SessionEnvelope.extend({
  type: z.literal('usage'),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
})

/**
 * `subagent_spawn`: a subagent (Claude's `Task` tool, codex's
 * `agent_roles`, opencode's mode swap) has been delegated work.
 * Carries the model + tool surface advertised for the child.
 */
export const SubagentSpawnEventSchema = SessionEnvelope.extend({
  type: z.literal('subagent_spawn'),
  childId: z.string().min(1),
  parentSessionId: z.string().min(1),
  model: z.string().min(1),
  tools: z.array(z.string()),
})

/**
 * `subagent_complete`: the subagent finished. Carries its token
 * slice + cost slice so the parent rollup can attribute costs.
 */
export const SubagentCompleteEventSchema = SessionEnvelope.extend({
  type: z.literal('subagent_complete'),
  childId: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
})

/**
 * `skill_activation`: a skill (file-based, in `~/.claude/skills/`) is
 * now active for the session. `source` distinguishes auto-loaded vs
 * explicit-invoke.
 */
export const SkillActivationEventSchema = SessionEnvelope.extend({
  type: z.literal('skill_activation'),
  skillName: z.string().min(1),
  source: z.enum(['auto', 'invoked']),
})

/**
 * `model_advertisement`: announce the model active for the upcoming
 * turn. Emitted at turn start; the per-turn `model` override on
 * `session/prompt` lands here too.
 */
export const ModelAdvertisementEventSchema = SessionEnvelope.extend({
  type: z.literal('model_advertisement'),
  model: z.string().min(1),
})

/**
 * `process_died`: the spawned backend subprocess exited. Synthetic
 * (not a JSON-RPC error response); the read loop emits this so the
 * orchestrator's stream-event store has a terminal event row.
 */
export const ProcessDiedEventSchema = SessionEnvelope.extend({
  type: z.literal('process_died'),
  exitCode: z.number().int(),
  detail: z.string().optional(),
})

/**
 * `cancelled`: synthetic terminal event after the orchestrator's
 * `session/cancel` flowed through and the grace window expired.
 */
export const CancelledEventSchema = SessionEnvelope.extend({
  type: z.literal('cancelled'),
  reason: z.string().min(1),
})

/**
 * Discriminated union of every sessionUpdate event. Keyed on `type`;
 * adding a new event type here means extending downstream consumers
 * + the per-backend event mappers.
 */
export const SessionUpdateEventSchema = z.discriminatedUnion('type', [
  OutputChunkEventSchema,
  ThinkingChunkEventSchema,
  ToolCallBeginEventSchema,
  ToolCallProgressEventSchema,
  ToolCallEndEventSchema,
  PermissionRequestEventSchema,
  QuestionRequestEventSchema,
  UsageEventSchema,
  SubagentSpawnEventSchema,
  SubagentCompleteEventSchema,
  SkillActivationEventSchema,
  ModelAdvertisementEventSchema,
  ProcessDiedEventSchema,
  CancelledEventSchema,
  CompactionStartedEventSchema,
  CompactionCompletedEventSchema,
])

export type KodizmQuestion = z.infer<typeof KodizmQuestionSchema>

export type SessionUpdateEvent = z.infer<typeof SessionUpdateEventSchema>
