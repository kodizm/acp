/**
 * Claude SDK `AskUserQuestion` tool branch.
 *
 * The SDK's `AskUserQuestion` is a special tool: the model invokes it
 * to ASK THE USER a question, then receives the answer back as
 * tool_result. Upstream `claude-agent-acp` blocks it via
 * `disallowedTools` (`"not a great way to expose this over ACP at the
 * moment"`); kodizm-acp exposes it as a first-class wire RPC.
 *
 * Mechanics:
 *
 *   1. The SDK calls `canUseTool('AskUserQuestion', input, ...)`.
 *   2. We intercept BEFORE the generic permission flow, validate
 *      `input.questions` against {@link KodizmQuestionSchema}, and
 *      issue an outbound `session/ask_user_question` RPC carrying
 *      the question rows.
 *   3. The orchestrator renders a dialog, collects answers, returns
 *      `{ answers: Record<questionText, answer>, annotations? }`.
 *   4. We return `{ behavior: 'allow', updatedInput: {
 *      ...originalInput, answers, annotations? } }`. The SDK populates
 *      the input on the tool's `call()`; tool returns the answers as
 *      a single tool_result text block to the model.
 *
 * Cancellation: orchestrator can return `{ outcome: { outcome:
 * 'cancelled' } }` (mirrors permission); we throw `Tool use aborted`
 * which the SDK absorbs as deny+abort.
 *
 * Composition: this module returns `null` for any tool name other
 * than `AskUserQuestion`, so the driver chains it BEFORE the generic
 * permission-bridge:
 *
 *   const ask = await askUserQuestion(toolName, input, opts)
 *   if (ask !== null) return ask
 *   return await permissionBridge(toolName, input, opts)
 */

import { z } from 'zod'
import { type KodizmQuestion, KodizmQuestionSchema } from '../../wire/events.ts'

import { type AcpServerLike, DEFERRED_SENTINEL, type EmitLike, awaitPermissionResponse } from './permission-bridge.ts'
import type { CanUseToolOptions, PermissionResult } from './permission-bridge.ts'

const QuestionsArraySchema = z.array(KodizmQuestionSchema).min(1).max(4)

/**
 * Subset of the canUseTool args the branch needs. Inlined to keep
 * the module independent of the full SDK contract.
 */
type AskCanUseToolOptions = Pick<CanUseToolOptions, 'toolUseID' | 'agentID'>

/**
 * Outbound RPC payload shape for `session/ask_user_question`.
 */
interface AskUserQuestionPayload {
  sessionId: string
  toolUseId: string
  agentId?: string
  questions: KodizmQuestion[]
}

/**
 * Inbound response shape from the orchestrator.
 *
 * Two valid envelopes:
 *   - `{ answers, annotations? }` for a successful selection.
 *   - `{ outcome: { outcome: 'cancelled' } }` when the user
 *     dismissed the dialog (mirrors permission cancel).
 */
type AskUserQuestionResponse =
  | {
      answers: Record<string, string>
      annotations?: Record<string, { preview?: string; notes?: string }>
    }
  | { outcome: { outcome: 'cancelled' } }

export interface AskUserQuestionDeps {
  server: AcpServerLike
  sessionId: string
  emit: EmitLike
  signal: AbortSignal
  permissionTimeoutMs?: number
}

/**
 * Build the AskUserQuestion canUseTool branch closure.
 *
 * @returns a function that returns `null` for non-AskUserQuestion
 *   tools (passthrough so the caller chains the generic permission
 *   bridge), else a {@link PermissionResult} from the orchestrator.
 */
export function askUserQuestionBranch(
  deps: AskUserQuestionDeps,
): (
  toolName: string,
  input: Record<string, unknown>,
  options: AskCanUseToolOptions,
) => Promise<PermissionResult | null> {
  return async function branch(toolName, input, options) {
    if (toolName !== 'AskUserQuestion') {
      return null
    }

    // 1. Validate the SDK-provided input shape.
    const questionsRaw = (input as { questions?: unknown }).questions
    const questions = QuestionsArraySchema.parse(questionsRaw)

    // 2. Emit the parallel stream event before the RPC fires.
    deps.emit.send({
      sessionId: deps.sessionId,
      type: 'question_request',
      toolUseId: options.toolUseID,
      questions,
      ...(options.agentID === undefined ? {} : { agentId: options.agentID, parentSessionId: deps.sessionId }),
    })

    // 3. Issue the outbound RPC.
    const payload: AskUserQuestionPayload = {
      sessionId: deps.sessionId,
      toolUseId: options.toolUseID,
      questions,
      ...(options.agentID === undefined ? {} : { agentId: options.agentID }),
    }
    const raced = await awaitPermissionResponse<AskUserQuestionResponse>(
      deps.server,
      'session/ask_user_question',
      payload,
      {
        signal: deps.signal,
        ...(deps.permissionTimeoutMs === undefined ? {} : { timeoutMs: deps.permissionTimeoutMs }),
      },
    )

    // 4. AskUserQuestion does NOT participate in defer (Phase 1.6 Pattern B);
    //    narrow for the type checker.
    if (raced === DEFERRED_SENTINEL) {
      throw new Error('Tool use aborted')
    }
    const response = raced

    // 5. Handle cancel envelope.
    if ('outcome' in response && response.outcome.outcome === 'cancelled') {
      throw new Error('Tool use aborted')
    }

    // 5. Map answers into updatedInput.
    if ('answers' in response) {
      return {
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: response.answers,
          ...(response.annotations === undefined ? {} : { annotations: response.annotations }),
        },
      }
    }

    // Unexpected shape: deny defensively.
    return { behavior: 'deny', message: 'AskUserQuestion response did not carry answers' }
  }
}
